// Package runs reads write-code runs for the bridge (M6): the freelancers'
// reports in the runs directory, the links between freelancers and their
// orchestrator, and where a freelancer sits.
package runs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Report limits.
const (
	MaxReportSize = 256 << 10
	// MaxInputRequired is the most of a report's input_required the bridge
	// keeps (#215: 500 bytes cut real requests mid-word); a longer one is
	// cut UTF-8-safely and flagged input_truncated.
	MaxInputRequired = 8 << 10
	MaxSummary       = 300
)

// Resolution sidecar (#215): the orchestrator accepts a report's
// input_required without resuming the freelancer by writing
// <run>/<stem>.resolved.json next to <run>/<stem>.json.
const (
	// ResolvedSuffix replaces a report name's ".json" (or is appended to a
	// name without it). A report name that ends in it has no sidecar.
	ResolvedSuffix = ".resolved.json"
	// MaxResolveSize is the biggest sidecar read; a larger one is ignored.
	MaxResolveSize = 4 << 10
	// MaxResolveNote and MaxResolveBy cut a sidecar's note and resolved_by.
	MaxResolveNote = 300
	MaxResolveBy   = 40
	// ResolvedByDefault is who resolved it when the sidecar does not say.
	ResolvedByDefault = "orchestrator"
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)

// ValidName reports whether s may be a run id or a report file name.
func ValidName(s string) bool { return nameRe.MatchString(s) }

// ResolvedName is the sidecar file name of report name: `coder-r1.json` →
// `coder-r1.resolved.json`. ok is false for a name that has none: one that
// is a sidecar name itself, or whose sidecar name is no valid name.
func ResolvedName(name string) (string, bool) {
	if !ValidName(name) || strings.HasSuffix(name, ResolvedSuffix) {
		return "", false
	}
	side := strings.TrimSuffix(name, ".json") + ResolvedSuffix
	return side, ValidName(side)
}

// Initial is a report's state before its file was looked at: invalid for a
// bad run id or report name, else pending.
func Initial(run, name string) proto.RunReport {
	switch {
	case !ValidName(run):
		return proto.RunReport{State: proto.ReportInvalid, Error: "bad run id"}
	case !ValidName(name):
		return proto.RunReport{State: proto.ReportInvalid, Error: "bad report name"}
	}
	return proto.RunReport{State: proto.ReportPending}
}

// Stamp is what tells a report file's versions apart without reading it.
type Stamp struct {
	Size    int64
	ModTime int64 // unix ns
}

// Stat looks at a report file (never following a symlink): ok is false
// when it does not exist (yet).
func Stat(dir, run, name string) (st Stamp, ok bool, err error) {
	fi, err := os.Lstat(filepath.Join(dir, run, name))
	if errors.Is(err, fs.ErrNotExist) {
		return Stamp{}, false, nil
	}
	if err != nil {
		return Stamp{}, false, err
	}
	return Stamp{Size: fi.Size(), ModTime: fi.ModTime().UnixNano()}, true, nil
}

// StatResolved is Stat of a report's resolution sidecar; ok is false when
// there is none (or the report has no sidecar name).
func StatResolved(dir, run, name string) (st Stamp, ok bool, err error) {
	side, has := ResolvedName(name)
	if !has {
		return Stamp{}, false, nil
	}
	return Stat(dir, run, side)
}

// readRegular reads a regular file of at most max bytes without following a
// symlink or blocking on a FIFO. missing: it does not exist; else why is
// "" or what is wrong with it; mod is its mtime (zero when unknown).
func readRegular(path string, max int64) (data []byte, mod time.Time, missing bool, why string) {
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, time.Time{}, true, ""
	}
	if err != nil {
		return nil, time.Time{}, false, "unreadable"
	}
	mod = fi.ModTime()
	if !fi.Mode().IsRegular() {
		return nil, mod, false, "not a regular file"
	}
	if fi.Size() > max {
		return nil, mod, false, "too large"
	}
	// O_NOFOLLOW: no symlink swapped in since the Lstat; O_NONBLOCK: nor a
	// FIFO that would block the open.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, time.Time{}, true, ""
		}
		return nil, mod, false, "not a regular file"
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, mod, false, "not a regular file"
	}
	mod = fi.ModTime()
	data, err = io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, mod, false, "unreadable"
	}
	if int64(len(data)) > max {
		return nil, mod, false, "too large"
	}
	return data, mod, false, ""
}

// Read reads and parses the report of a worker of role (names already
// valid), and, when it asks for input, whether its sidecar resolves it. A
// report that does not exist is pending.
func Read(dir, run, name, role string) proto.RunReport {
	data, mod, missing, why := readRegular(filepath.Join(dir, run, name), MaxReportSize)
	switch {
	case missing:
		return proto.RunReport{State: proto.ReportPending}
	case why == "too large":
		return invalid(mod.UnixMilli(), "report too large")
	case why != "":
		return invalid(mod.UnixMilli(), why)
	}
	r := Parse(data, role, mod.UnixMilli())
	if r.State == proto.ReportReady && r.InputRequired != nil {
		r.InputResolved = readResolved(dir, run, name, mod)
	}
	return r
}

// readResolved reads the sidecar of report name (whose file has mtime
// reportMod): nil unless it is a valid sidecar at least as new as the
// report, so a report rewritten after its resolution asks again.
func readResolved(dir, run, name string, reportMod time.Time) *proto.InputResolved {
	side, ok := ResolvedName(name)
	if !ok {
		return nil
	}
	data, mod, missing, why := readRegular(filepath.Join(dir, run, side), MaxResolveSize)
	if missing || why != "" || mod.Before(reportMod) {
		return nil
	}
	var obj struct {
		By   *string `json:"resolved_by"`
		Note *string `json:"note"`
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil || raw == nil || json.Unmarshal(data, &obj) != nil {
		return nil
	}
	res := &proto.InputResolved{By: ResolvedByDefault, At: mod.UnixMilli()}
	if obj.By != nil {
		if by := strings.TrimSpace(*obj.By); by != "" {
			res.By = world.CutUTF8(by, MaxResolveBy)
		}
	}
	if obj.Note != nil {
		res.Note = world.CutUTF8(strings.TrimSpace(*obj.Note), MaxResolveNote)
	}
	return res
}

func invalid(at int64, why string) proto.RunReport {
	return proto.RunReport{State: proto.ReportInvalid, At: at, Error: why}
}

// Parse reads a report of a worker of role: reviewers (review, ux) have a
// verdict and counted issues, coders and researchers a summary, and anyone
// may need input.
func Parse(data []byte, role string, at int64) proto.RunReport {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil || obj == nil {
		return invalid(at, "not a JSON object")
	}
	r := proto.RunReport{State: proto.ReportReady, At: at}
	if raw, ok := obj["input_required"]; ok && !isNull(raw) {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return invalid(at, "input_required is not a string")
		}
		if s != "" {
			if cut := world.CutUTF8(s, MaxInputRequired); len(cut) < len(s) {
				s, r.InputTruncated = cut, true
			}
			r.InputRequired = &s
		}
	}
	if raw, ok := obj["input_for"]; ok && r.InputRequired != nil {
		var f string
		if json.Unmarshal(raw, &f) == nil {
			switch f = strings.ToLower(strings.TrimSpace(f)); f {
			case proto.InputForOrchestrator, proto.InputForUser:
				r.InputFor = f
			}
		}
	}
	switch role {
	case "review", "ux":
		raw, ok := obj["verdict"]
		if !ok || isNull(raw) {
			if r.InputRequired == nil {
				return invalid(at, "no verdict")
			}
			break
		}
		var v string
		_ = json.Unmarshal(raw, &v)
		switch v {
		case proto.VerdictPass, proto.VerdictChangesRequired, proto.VerdictIncomplete:
			r.Verdict = v
		default:
			return invalid(at, "bad verdict")
		}
		var found []json.RawMessage
		if raw, ok := obj["issues_found"]; ok && !isNull(raw) {
			if json.Unmarshal(raw, &found) != nil {
				return invalid(at, "issues_found is not an array")
			}
		}
		blockers := 0
		for _, raw := range found {
			var issue struct {
				Priority any `json:"priority"`
			}
			if json.Unmarshal(raw, &issue) == nil && issue.Priority == "BLOCKER" {
				blockers++
			}
		}
		issues := len(found)
		r.Blockers, r.Issues = &blockers, &issues
	case "code", "ground":
		var s string
		if raw, ok := obj["summary"]; ok && json.Unmarshal(raw, &s) == nil {
			r.Summary = world.CutUTF8(s, MaxSummary)
		}
	}
	return r
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }
