// Package codex finds Codex CLI session ids from its rollout files, for
// panes where Codex did not report its session to herdr (so the bridge
// can backfill it before a floor sleeps; docs/research/herdr-followup.md
// §2c). It only reads files.
package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// DefaultSessionsDir is $CODEX_HOME/sessions, else ~/.codex/sessions.
func DefaultSessionsDir() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return filepath.Join(home, "sessions")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

// MaxScan bounds how many rollout files one lookup reads.
const MaxScan = 2000

// maxMetaLine bounds the first (session_meta) line of a rollout; it holds
// the base instructions, ~20 KB today.
const maxMetaLine = 4 << 20

var (
	datePart  = regexp.MustCompile(`^[0-9]+$`)
	rolloutRe = regexp.MustCompile(`^rollout-.+\.jsonl$`)
	idRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,127}$`)
)

// FindSession returns the session id of the newest rollout under root
// (root/YYYY/MM/DD/rollout-*-<id>.jsonl, newest by start time) whose
// recorded cwd is cwd, skipping ids for which skip returns true and
// subagent rollouts (a pane's Codex spawns them in its own cwd; they are
// never the pane's session). It returns "" when there is none (or root
// does not exist).
func FindSession(root, cwd string, skip func(id string) bool) (string, error) {
	return (&Finder{Root: root}).Find(cwd, skip)
}

// Finder is FindSession for a caller that looks often (the usage of Codex
// workers herdr knows no session of): it remembers each rollout's
// session_meta, which never changes, so a lookup only lists directories
// and reads the first lines of new files (and of ones it could not read
// yet, e.g. still being written). Not safe for concurrent use.
type Finder struct {
	Root  string
	metas map[string]rolloutMeta // path → its session_meta
}

type rolloutMeta struct {
	id, cwd string
	sub, ok bool
}

// maxMetas bounds what a Finder remembers; past it, it starts afresh.
const maxMetas = 4 * MaxScan

// Find is FindSession under f.Root.
func (f *Finder) Find(cwd string, skip func(id string) bool) (string, error) {
	if cwd == "" {
		return "", nil
	}
	if f.metas == nil || len(f.metas) > maxMetas {
		f.metas = map[string]rolloutMeta{}
	}
	cwd = filepath.Clean(cwd)
	scanned := 0
	var found string
	errStop := errors.New("stop")
	err := walkNewest(f.Root, 3, func(path string) error {
		if scanned++; scanned > MaxScan {
			return errStop
		}
		m, seen := f.metas[path]
		if !seen {
			if m.id, m.cwd, m.sub, m.ok = readMeta(path); m.ok {
				f.metas[path] = m
			}
		}
		if !m.ok || m.sub || filepath.Clean(m.cwd) != cwd || !idRe.MatchString(m.id) || (skip != nil && skip(m.id)) {
			return nil
		}
		found = m.id
		return errStop
	})
	if err != nil && !errors.Is(err, errStop) {
		return "", err
	}
	return found, nil
}

// walkNewest visits rollout files under dir, date directories (depth
// levels of numeric names) and files in descending name order.
func walkNewest(dir string, depth int, visit func(string) error) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	slices.Reverse(entries) // ReadDir sorts by name
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		switch {
		case depth > 0 && e.IsDir() && datePart.MatchString(e.Name()):
			if err := walkNewest(path, depth-1, visit); err != nil {
				return err
			}
		case depth == 0 && e.Type().IsRegular() && rolloutRe.MatchString(e.Name()):
			if err := visit(path); err != nil {
				return err
			}
		}
	}
	return nil
}

// readMeta reads a rollout's first line, its session_meta. sub is true for
// a subagent's rollout (thread_source "subagent", or a parent thread).
func readMeta(path string) (id, cwd string, sub, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", false, false
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxMetaLine {
			return "", "", false, false
		}
		if err == nil || !errors.Is(err, bufio.ErrBufferFull) {
			break
		}
	}
	var meta struct {
		Type    string `json:"type"`
		Payload struct {
			ID             string `json:"id"`
			Cwd            string `json:"cwd"`
			ThreadSource   string `json:"thread_source"`
			ParentThreadID string `json:"parent_thread_id"`
		} `json:"payload"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(string(line))), &meta) != nil || meta.Type != "session_meta" {
		return "", "", false, false
	}
	p := meta.Payload
	return p.ID, p.Cwd, p.ThreadSource == "subagent" || p.ParentThreadID != "", p.ID != "" && p.Cwd != ""
}

// maxRolloutNames bounds how many rollout file names one FindRollout
// looks at (it reads only the file whose name matches).
const maxRolloutNames = 50000

// FindRollout returns the rollout file of session id under root
// (root/YYYY/MM/DD/rollout-*-<id>.jsonl, newest first), a regular file
// whose first line's session_meta has that id; "" when there is none.
func FindRollout(root, id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", nil
	}
	suffix := "-" + id + ".jsonl"
	scanned := 0
	var found string
	errStop := errors.New("stop")
	err := walkNewest(root, 3, func(path string) error {
		if scanned++; scanned > maxRolloutNames {
			return errStop
		}
		if !strings.HasSuffix(path, suffix) {
			return nil
		}
		if metaID, _, _, ok := readMeta(path); ok && metaID == id {
			found = path
			return errStop
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return "", err
	}
	return found, nil
}

// NewestRollouts returns the paths of the newest rollouts under root
// (root/YYYY/MM/DD/rollout-*.jsonl, newest first by name), at most limit.
// It only lists directories; a missing root is no rollouts.
func NewestRollouts(root string, limit int) []string {
	var out []string
	errStop := errors.New("stop")
	_ = walkNewest(root, 3, func(path string) error {
		if out = append(out, path); len(out) >= limit {
			return errStop
		}
		return nil
	})
	return out
}
