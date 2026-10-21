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

// DefaultHome is the Codex home the bridge's own environment selects:
// $CODEX_HOME, else ~/.codex.
func DefaultHome() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return home
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// DefaultSessionsDir is DefaultHome's sessions folder: $CODEX_HOME/sessions,
// else ~/.codex/sessions.
func DefaultSessionsDir() string { return filepath.Join(DefaultHome(), "sessions") }

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
// a rollout that is no root session (Meta.Subagent).
func readMeta(path string) (id, cwd string, sub, ok bool) {
	m, _, ok := ReadMeta(path)
	return m.ID, m.Cwd, m.Subagent(), ok && m.ID != "" && m.Cwd != ""
}

// Meta is what a rollout's first line, its session_meta, says of its thread
// (#25: docs/research/codex-subagents.md). Only the first line is the
// thread's own: a forked subagent's rollout copies its parent's
// session_meta on its second line.
type Meta struct {
	// ID is the thread's id; Session the root session's (a subagent's, at
	// any depth, is its root's; a root's is its own or none).
	ID, Session, Cwd string
	// ThreadSource is "user", "subagent", "guardian_review", … ("": not
	// written).
	ThreadSource string
	// Parent is the top-level parent_thread_id: a spawned subagent's
	// immediate parent, also set on a guardian reviewer.
	Parent string
	// Source is source.subagent: set for every thread another one made.
	Source *SubagentSource
	// HistoryStart is subagent_history_start_ordinal: the records of a
	// forked subagent before it are its parent's copied history (0: none).
	HistoryStart int64
	CLIVersion   string
}

// SubagentSource is a session_meta's source.subagent: a spawned child
// (ThreadSpawn) or another kind (Other: "guardian", …).
type SubagentSource struct {
	ThreadSpawn *ThreadSpawn
	Other       string
}

// ThreadSpawn is source.subagent.thread_spawn: the subagent a
// spawn_agent call made.
type ThreadSpawn struct {
	// Parent is the immediate parent's thread id (the root session's at
	// depth 1).
	Parent   string
	Depth    int
	Path     string // agent_path, /root/<task>[/<task>…] (v2; null on v1)
	Nickname string
	Role     string // agent_role (agent_type)
}

// Subagent reports whether the thread is no root session: a spawned child
// (thread_source "subagent"), a guardian reviewer (a parent thread), or any
// other subagent source.
func (m Meta) Subagent() bool {
	return m.ThreadSource == "subagent" || m.Parent != "" || m.Source != nil
}

// Child reports whether the thread is a spawned child agent: thread_source
// "subagent" with a thread_spawn source (a guardian reviewer is none).
func (m Meta) Child() bool {
	return m.ThreadSource == "subagent" && m.Source != nil && m.Source.ThreadSpawn != nil && m.ID != "" && m.Session != ""
}

// metaJSON is a session_meta line as persisted.
type metaJSON struct {
	Type    string `json:"type"`
	Payload struct {
		ID             string          `json:"id"`
		SessionID      string          `json:"session_id"`
		Cwd            string          `json:"cwd"`
		ThreadSource   string          `json:"thread_source"`
		ParentThreadID string          `json:"parent_thread_id"`
		Source         json.RawMessage `json:"source"`
		HistoryStart   int64           `json:"subagent_history_start_ordinal"`
		CLIVersion     string          `json:"cli_version"`
	} `json:"payload"`
}

// ParseMeta reads a session_meta line (false: the line is none).
func ParseMeta(line []byte) (Meta, bool) {
	var mj metaJSON
	if json.Unmarshal(line, &mj) != nil || mj.Type != "session_meta" {
		return Meta{}, false
	}
	p := mj.Payload
	m := Meta{ID: p.ID, Session: p.SessionID, Cwd: p.Cwd, ThreadSource: p.ThreadSource, Parent: p.ParentThreadID,
		HistoryStart: max(p.HistoryStart, 0), CLIVersion: p.CLIVersion}
	// source is a string ("cli", "exec", …) or {"subagent": …}, where
	// subagent is {"thread_spawn": {…}} or a string ("review", …) or
	// {"other": "guardian"}.
	var src struct {
		Subagent json.RawMessage `json:"subagent"`
	}
	if len(p.Source) > 0 && p.Source[0] == '{' && json.Unmarshal(p.Source, &src) == nil && len(src.Subagent) > 0 && string(src.Subagent) != "null" {
		m.Source = &SubagentSource{}
		var sub struct {
			ThreadSpawn *struct {
				ParentThreadID string `json:"parent_thread_id"`
				Depth          int    `json:"depth"`
				AgentPath      string `json:"agent_path"`
				AgentNickname  string `json:"agent_nickname"`
				AgentRole      string `json:"agent_role"`
			} `json:"thread_spawn"`
			Other string `json:"other"`
		}
		var kind string
		switch {
		case json.Unmarshal(src.Subagent, &kind) == nil:
			m.Source.Other = kind
		case json.Unmarshal(src.Subagent, &sub) == nil:
			m.Source.Other = sub.Other
			if ts := sub.ThreadSpawn; ts != nil {
				m.Source.ThreadSpawn = &ThreadSpawn{Parent: ts.ParentThreadID, Depth: ts.Depth, Path: ts.AgentPath,
					Nickname: ts.AgentNickname, Role: ts.AgentRole}
			}
		}
	}
	return m, true
}

// ReadMeta reads a rollout's first line. complete says the line was read
// whole (ended by a newline): a line still being written is not, and
// neither is a missing file. ok says it is a session_meta.
func ReadMeta(path string) (m Meta, complete, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return Meta{}, false, false
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxMetaLine {
			return Meta{}, true, false // never one we read
		}
		if err == nil {
			complete = true
		}
		if err == nil || !errors.Is(err, bufio.ErrBufferFull) {
			break
		}
	}
	m, ok = ParseMeta([]byte(strings.TrimSpace(string(line))))
	return m, complete, ok
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

// ChildFinder finds the rollouts of one root session's spawned child agents
// (#25), nested ones included: Codex writes them as flat siblings of the
// root's rollout in the date directories, so a child is found by its first
// line (Meta.Child, Meta.Session the root's), never by its cwd or name. It
// remembers each first line read whole, which never changes; a file whose
// first line is still being written is read again by the next Find. Not
// safe for concurrent use.
type ChildFinder struct {
	Root, Session string
	// From is the first date directory looked in, "YYYY/MM/DD" (the root
	// rollout's: a child starts after its root); "": all.
	From  string
	metas map[string]childMeta // path → its first line
}

type childMeta struct {
	m     Meta
	child bool
}

// ChildRollout is one child's rollout and its first line.
type ChildRollout struct {
	Path string
	Meta Meta
}

// Find returns the session's child rollouts, newest first, looking at most
// at the MaxScan newest rollouts from f.From on.
func (f *ChildFinder) Find() []ChildRollout {
	if f.metas == nil || len(f.metas) > maxMetas {
		f.metas = map[string]childMeta{}
	}
	var out []ChildRollout
	scanned := 0
	errStop := errors.New("stop")
	_ = walkDates(f.Root, "", f.From, func(path string) error {
		if scanned++; scanned > MaxScan {
			return errStop
		}
		cm, seen := f.metas[path]
		if !seen {
			m, complete, ok := ReadMeta(path)
			cm = childMeta{m: m, child: ok && m.Child() && m.Session == f.Session && m.ID != f.Session && idRe.MatchString(m.ID)}
			if !complete && !cm.child {
				return nil // read again next time: still being written (or gone)
			}
			f.metas[path] = cm
		}
		if cm.child {
			out = append(out, ChildRollout{Path: path, Meta: cm.m})
		}
		return nil
	})
	return out
}

// DateDir is the date directory, "YYYY/MM/DD", of a rollout under root
// ("": none).
func DateDir(root, path string) string {
	rel, err := filepath.Rel(root, filepath.Dir(path))
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if strings.Count(rel, "/") != 2 {
		return ""
	}
	return rel
}

// walkDates is walkNewest from the date directory from on (date names
// compare as strings: Codex writes them zero-padded).
func walkDates(dir, rel, from string, visit func(string) error) error {
	depth := 3 - strings.Count(rel, "/") - min(len(rel), 1)
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
			sub := e.Name()
			if rel != "" {
				sub = rel + "/" + sub
			}
			if from != "" && sub < from[:min(len(from), len(sub))] {
				return nil // older: so are the rest
			}
			if err := walkDates(path, sub, from, visit); err != nil {
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
