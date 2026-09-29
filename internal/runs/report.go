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
	"syscall"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Report limits.
const (
	MaxReportSize    = 256 << 10
	MaxInputRequired = 500
	MaxSummary       = 300
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)

// ValidName reports whether s may be a run id or a report file name.
func ValidName(s string) bool { return nameRe.MatchString(s) }

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

// Read reads and parses the report of a worker of role (names already
// valid). A report that does not exist is pending.
func Read(dir, run, name, role string) proto.RunReport {
	path := filepath.Join(dir, run, name)
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return proto.RunReport{State: proto.ReportPending}
	}
	if err != nil {
		return invalid(0, "unreadable")
	}
	at := fi.ModTime().UnixMilli()
	if !fi.Mode().IsRegular() {
		return invalid(at, "not a regular file")
	}
	if fi.Size() > MaxReportSize {
		return invalid(at, "report too large")
	}
	// O_NOFOLLOW: no symlink swapped in since the Lstat; O_NONBLOCK: nor a
	// FIFO that would block the open.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return proto.RunReport{State: proto.ReportPending}
		}
		return invalid(at, "not a regular file")
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return invalid(at, "not a regular file")
	}
	at = fi.ModTime().UnixMilli()
	data, err := io.ReadAll(io.LimitReader(f, MaxReportSize+1))
	if err != nil {
		return invalid(at, "unreadable")
	}
	if len(data) > MaxReportSize {
		return invalid(at, "report too large")
	}
	return Parse(data, role, at)
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
			s = world.CutUTF8(s, MaxInputRequired)
			r.InputRequired = &s
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
