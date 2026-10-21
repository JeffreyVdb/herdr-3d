package usage

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Roots are where transcripts are found.
type Roots struct {
	// ClaudeProjects holds Claude Code's <project>/<session>.jsonl.
	ClaudeProjects string
	// CodexSessions holds Codex's YYYY/MM/DD/rollout-*-<session>.jsonl.
	CodexSessions string
}

// DefaultClaudeProjects is $CLAUDE_CONFIG_DIR/projects, else
// ~/.claude/projects.
func DefaultClaudeProjects() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "projects")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}

// Rescans.
const (
	// MissRescan is how long a session whose transcript was not found waits
	// before it is looked for again.
	MissRescan = 30 * time.Second
	// SubagentRescan is how often a Claude session's subagents directory is
	// listed for new files.
	SubagentRescan = 10 * time.Second
)

type parser interface {
	line(main bool, b []byte)
	usage(p *Pricing) proto.Usage
}

// Session reads one agent session's usage from its transcript files,
// found once (then cached) and read incrementally.
type Session struct {
	harness, id string
	roots       Roots
	pricing     *Pricing

	parse  parser
	main   *jsonl.Tail
	subDir string
	subs   map[string]*jsonl.Tail // Claude subagents (#25: Codex child rollouts), by path
	missAt time.Time              // when a lookup last found nothing
	subAt  time.Time              // when the subagents were last listed
	auth   string                 // Codex's auth_mode, read once (NewSession)
	found  bool
	rescan time.Duration // how long a miss waits (MissRescan)
	tap    Tap
	lines  Lines
	// #23: kids gets the subagents' evidence; metas are their meta files
	// as last read, by agent id.
	kids  Children
	metas map[string]metaStamp
	// #25: a Codex session's child rollouts are found by children (set
	// with kids), and threads is each one's thread id, by path.
	children *codex.ChildFinder
	threads  map[string]string
	// #26: the children whose transcripts are watched (WantChildren), the
	// taps of their lines, and each Codex child rollout's history start, by
	// path.
	want   map[string]bool
	taps   map[string]Tap
	starts map[string]int64
}

// Children gets what a Claude session's files show of its subagents (#23,
// internal/claudechild): the main transcript's lines, each subagent's
// transcript lines and meta file, by agent id (the file's agent-<id>), from
// the same reads as the usage, so every file has one reader. A Codex
// session's (#25, internal/codexchild): the root rollout's lines and each
// child rollout's (codex.ChildFinder), by the child's thread id; Codex has
// no meta files, and a child rollout's tokens are not the worker's usage.
type Children interface {
	// Main is one complete line of the main transcript and the offset it
	// starts at.
	Main(off int64, line []byte)
	// Child is one complete line of the subagent's transcript.
	Child(agentID string, off int64, line []byte)
	// Meta is the subagent's agent-<id>.meta.json, each time it changed
	// (Claude replaces it whole), and when it was written. A meta not
	// written yet is not sent.
	Meta(agentID string, b []byte, mtime time.Time)
	// Gone says the subagent's transcript went (cleaned up).
	Gone(agentID string)
	// Reset says everything sent is void: the files are read again from
	// their start (or the main transcript went).
	Reset()
	// WantList asks for the subagents directory to be listed in this poll,
	// not only every SubagentRescan (a subagent was started and its file
	// is not seen yet). Asked after the main transcript's lines.
	WantList() bool
	// Polled ends a Poll: everything it read was sent.
	Polled(now time.Time)
}

// metaStamp is a meta file as last read.
type metaStamp struct {
	ino         uint64
	size, mtime int64 // mtime in ns
}

// MaxMeta bounds a subagent's meta file (it is a few hundred bytes).
const MaxMeta = 64 << 10

// SetChildren sends the session's subagent evidence to c (nil: none). Set
// it before the first Poll.
func (s *Session) SetChildren(c Children) { s.kids = c }

// Tap gets the main transcript's lines as the session reads them, so the
// transcript view shares the one read of the file (internal/transcript).
type Tap interface {
	// Line is one complete line and the byte offset it starts at.
	Line(off int64, line []byte)
	// Void says the lines sent are void: the file was truncated or
	// replaced (read again from its start), or it went (gone). The tap
	// gets nothing more.
	Void(gone bool)
}

// Lines gets every line of the main transcript the session reads, from the
// file's start, with the byte offset it starts at (#57: the worker's ask is
// read from them; #83: its wrap-up verdict), and Reset when the lines it got
// are void: the file was replaced (it gets them all again) or went.
type Lines interface {
	Line(off int64, line []byte)
	Reset()
}

// SetLines sends the main transcript's lines to l (nil: none). Set it before
// the first Poll, so l reads the file from its start.
func (s *Session) SetLines(l Lines) { s.lines = l }

// Delivered is where the next main transcript line the session hands out
// starts (0 before it was found): every line before it was read already.
func (s *Session) Delivered() int64 {
	if s.main == nil {
		return 0
	}
	return s.main.Delivered()
}

// Found reports whether the main transcript is found now (not gone).
func (s *Session) Found() bool { return s.main != nil }

func (s *Session) resetLines() {
	if s.lines != nil {
		s.lines.Reset()
	}
	if s.kids != nil {
		s.kids.Reset()
		clear(s.metas)
	}
}

// SetTap sends the main transcript's lines read from now on to t (nil:
// none).
func (s *Session) SetTap(t Tap) { s.tap = t }

// Tap is the main transcript's tap (nil: none).
func (s *Session) Tap() Tap { return s.tap }

// Main is the main transcript found (path "" until then), the file as last
// read (nil before) and where the next line the tap gets starts: every
// line before it was read already.
func (s *Session) Main() (path string, fi fs.FileInfo, next int64) {
	if s.main == nil {
		return "", nil, 0
	}
	return s.main.Path, s.main.File(), s.main.Delivered()
}

// SetRescan sets how long a transcript not found waits before it is looked
// for again (0: MissRescan).
func (s *Session) SetRescan(d time.Duration) { s.rescan = d }

// Rescan is what SetRescan set.
func (s *Session) Rescan() time.Duration { return s.rescan }

func (s *Session) void(gone bool) {
	if s.tap != nil {
		s.tap.Void(gone)
		s.tap = nil
	}
}

// NewSession reads the usage of agent session id of harness (claude or
// codex); nil for another harness or an invalid id.
func NewSession(harness, id string, roots Roots, p *Pricing) *Session {
	if !herdr.ValidAgentSessionID(id) || strings.ContainsAny(id, `/\`) {
		return nil
	}
	if harness != Claude && harness != Codex {
		return nil
	}
	s := &Session{harness: harness, id: id, roots: roots, pricing: p, subs: map[string]*jsonl.Tail{}, metas: map[string]metaStamp{},
		threads: map[string]string{}, want: map[string]bool{}, taps: map[string]Tap{}, starts: map[string]int64{}}
	if harness == Codex {
		s.auth = codexAuthMode(roots.CodexSessions)
	}
	s.parse = s.newParser()
	return s
}

func (s *Session) newParser() parser {
	if s.harness == Claude {
		return newClaudeUsage()
	}
	return newCodexUsage(s.auth)
}

// Poll reads what the session's files gained since the last Poll and
// returns its usage; ok is false until its transcript was found.
func (s *Session) Poll(now time.Time) (u proto.Usage, ok bool) {
	u, ok = s.poll(now)
	if s.kids != nil {
		s.kids.Polled(now)
	}
	return u, ok
}

func (s *Session) poll(now time.Time) (u proto.Usage, ok bool) {
	if s.main == nil {
		rescan := s.rescan
		if rescan <= 0 {
			rescan = MissRescan
		}
		if !s.missAt.IsZero() && now.Sub(s.missAt) < rescan && !now.Before(s.missAt) {
			return s.usage()
		}
		path := s.find()
		if path == "" {
			s.missAt = now
			return s.usage()
		}
		if s.found { // found again after it went: count it all afresh
			s.parse = s.newParser()
			s.resetLines()
			s.voidChildren()
			for _, t := range s.subs {
				t.Restart()
			}
		}
		s.main, s.found = jsonl.NewTail(path), true
		if s.harness == Claude {
			s.subDir = filepath.Join(filepath.Dir(path), s.id, "subagents")
		}
	}
	if s.harness == Codex && (s.kids != nil || len(s.want) > 0) && s.children == nil { // #25: the children start after the root (#26: also a watched one's)
		s.children = &codex.ChildFinder{Root: s.roots.CodexSessions, Session: s.id, From: codex.DateDir(s.roots.CodexSessions, s.main.Path)}
	}
	err := s.read(now)
	if errors.Is(err, jsonl.ErrReplaced) {
		// A file was truncated or replaced: forget everything, read it all.
		s.void(false)
		s.voidChildren()
		s.resetLines()
		s.parse = s.newParser()
		s.main.Restart()
		for _, t := range s.subs {
			t.Restart()
		}
		err = s.read(now)
	}
	if err != nil && !errors.Is(err, jsonl.ErrReplaced) && s.main != nil {
		if _, serr := os.Lstat(s.main.Path); errors.Is(serr, fs.ErrNotExist) {
			s.void(true)
			s.resetLines()
			s.main, s.missAt = nil, now // gone: look again later, keep what was counted
		}
	}
	return s.usage()
}

func (s *Session) usage() (proto.Usage, bool) {
	if !s.found {
		return proto.Usage{}, false
	}
	return s.parse.usage(s.pricing), true
}

// read reads the main transcript, then the subagents'.
func (s *Session) read(now time.Time) error {
	if err := s.main.Next(func(off int64, b []byte) {
		s.parse.line(true, b)
		if s.lines != nil {
			s.lines.Line(off, b)
		}
		if s.kids != nil {
			s.kids.Main(off, b)
		}
		if s.tap != nil {
			s.tap.Line(off, b)
		}
	}); err != nil {
		return err
	}
	if s.children != nil {
		return s.readChildren(now)
	}
	if s.subDir == "" {
		return nil
	}
	if s.listDue(now) {
		s.subAt = now
		entries, _ := os.ReadDir(s.subDir)
		for _, e := range entries {
			name := e.Name()
			if e.Type().IsRegular() && strings.HasPrefix(name, "agent-") && strings.HasSuffix(name, ".jsonl") {
				if p := filepath.Join(s.subDir, name); s.subs[p] == nil {
					s.subs[p] = jsonl.NewTail(p)
				}
			}
		}
	}
	paths := make([]string, 0, len(s.subs))
	for p := range s.subs {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		id := subagentID(p)
		err := s.subs[p].Next(func(off int64, b []byte) {
			s.parse.line(false, b)
			if s.kids != nil {
				s.kids.Child(id, off, b)
			}
			if t := s.taps[id]; t != nil { // #26
				t.Line(off, b)
			}
		})
		switch {
		case errors.Is(err, jsonl.ErrReplaced):
			return err
		case errors.Is(err, fs.ErrNotExist):
			delete(s.subs, p) // what it had stays counted
			s.voidChild(id, true)
			if s.kids != nil {
				delete(s.metas, id)
				s.kids.Gone(id)
			}
			continue
		}
		if s.kids != nil {
			s.readMeta(id, strings.TrimSuffix(p, ".jsonl")+".meta.json")
		}
	}
	return nil
}

// listDue reports whether the subagents are listed in this read.
func (s *Session) listDue(now time.Time) bool {
	return s.subAt.IsZero() || now.Sub(s.subAt) >= SubagentRescan || now.Before(s.subAt) || (s.kids != nil && s.kids.WantList()) || s.wantMissing()
}

// wantMissing reports whether a watched child's transcript is not read yet
// (#26: looked for in every poll until it is).
func (s *Session) wantMissing() bool {
	for id := range s.want {
		if s.childPath(id) == "" {
			return true
		}
	}
	return false
}

// readChildren reads a Codex session's child rollouts (#25): found every
// SubagentRescan (or when the children ask), each read for the children
// only.
func (s *Session) readChildren(now time.Time) error {
	if s.listDue(now) {
		s.subAt = now
		for _, c := range s.children.Find() {
			// #26: without Children, only the watched ones are read.
			if s.subs[c.Path] == nil && (s.kids != nil || s.want[c.Meta.ID]) {
				s.subs[c.Path], s.threads[c.Path], s.starts[c.Path] = jsonl.NewTail(c.Path), c.Meta.ID, c.Meta.HistoryStart
			}
		}
	}
	paths := make([]string, 0, len(s.subs))
	for p := range s.subs {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		thread := s.threads[p]
		err := s.subs[p].Next(func(off int64, b []byte) {
			if s.kids != nil {
				s.kids.Child(thread, off, b)
			}
			if t := s.taps[thread]; t != nil { // #26
				t.Line(off, b)
			}
		})
		switch {
		case errors.Is(err, jsonl.ErrReplaced):
			return err
		case errors.Is(err, fs.ErrNotExist):
			delete(s.subs, p)
			delete(s.threads, p)
			delete(s.starts, p)
			s.voidChild(thread, true)
			if s.kids != nil {
				s.kids.Gone(thread)
			}
		}
	}
	return nil
}

// ChildFile is a child's transcript as a session reads it (#26): its path,
// the file as last read, where the next line handed out starts (every line
// before it was read already) and, a Codex child's, the history start of
// its rollout (the records before it are its parent's, copied).
type ChildFile struct {
	Path         string
	File         fs.FileInfo
	Next         int64
	HistoryStart int64
}

// WantChildren names the children whose transcripts are watched (#26, by
// Claude agent id or Codex thread id): one not read yet is looked for in
// every Poll, not only every SubagentRescan, and a Codex session reads their
// rollouts also without Children. A tap of a child not named is dropped.
func (s *Session) WantChildren(ids []string) {
	clear(s.want)
	for _, id := range ids {
		s.want[id] = true
	}
	for id := range s.taps {
		if !s.want[id] {
			delete(s.taps, id)
		}
	}
}

// Child is child id's transcript as the session reads it; false while it
// reads none (not found yet, gone, not read once yet).
func (s *Session) Child(id string) (ChildFile, bool) {
	p := s.childPath(id)
	t := s.subs[p]
	if p == "" || t == nil || t.File() == nil {
		return ChildFile{}, false
	}
	return ChildFile{Path: p, File: t.File(), Next: t.Delivered(), HistoryStart: s.starts[p]}, true
}

// SetChildTap sends child id's transcript lines read from now on to t (nil:
// none), and Void as SetTap's: once its lines are void the tap is dropped.
func (s *Session) SetChildTap(id string, t Tap) {
	if t == nil {
		delete(s.taps, id)
		return
	}
	s.taps[id] = t
}

// ChildTap is child id's tap (nil: none).
func (s *Session) ChildTap(id string) Tap { return s.taps[id] }

// childPath is the path child id's transcript is read from ("": none).
func (s *Session) childPath(id string) string {
	if s.harness == Claude {
		if s.subDir == "" {
			return ""
		}
		p := filepath.Join(s.subDir, "agent-"+id+".jsonl")
		if s.subs[p] == nil {
			return ""
		}
		return p
	}
	for p, thread := range s.threads {
		if thread == id {
			return p
		}
	}
	return ""
}

func (s *Session) voidChild(id string, gone bool) {
	if t := s.taps[id]; t != nil {
		delete(s.taps, id)
		t.Void(gone)
	}
}

// voidChildren voids every child tap: the files are read again from their
// start.
func (s *Session) voidChildren() {
	for id := range s.taps {
		s.voidChild(id, false)
	}
}

// subagentID is the agent id of a subagent's transcript, agent-<id>.jsonl.
func subagentID(path string) string {
	return strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl")
}

// readMeta sends a subagent's meta file when it changed since it was last
// read (Claude renames a new one over it, so its identity changes): never
// through a symlink, at most MaxMeta. A meta not there (not written yet) or
// unreadable is not sent.
func (s *Session) readMeta(id, path string) {
	f, fi, err := jsonl.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	st := metaStamp{size: fi.Size(), mtime: fi.ModTime().UnixNano()}
	if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
		st.ino = sys.Ino
	}
	if old, ok := s.metas[id]; ok && old == st {
		return
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxMeta+1))
	if err != nil || len(b) > MaxMeta {
		return
	}
	s.metas[id] = st
	s.kids.Meta(id, b, fi.ModTime())
}

// find returns the session's main transcript, "" when there is none.
func (s *Session) find() string {
	switch s.harness {
	case Claude:
		if s.roots.ClaudeProjects == "" {
			return ""
		}
		entries, _ := os.ReadDir(s.roots.ClaudeProjects)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			p := filepath.Join(s.roots.ClaudeProjects, e.Name(), s.id+".jsonl")
			if fi, err := os.Lstat(p); err == nil && fi.Mode().IsRegular() {
				return p
			}
		}
	case Codex:
		if s.roots.CodexSessions == "" {
			return ""
		}
		p, _ := codex.FindRollout(s.roots.CodexSessions, s.id)
		return p
	}
	return ""
}

// BytesRead is how many bytes the session read from its files in all.
func (s *Session) BytesRead() int64 {
	var n int64
	if s.main != nil {
		n += s.main.BytesRead()
	}
	for _, t := range s.subs {
		n += t.BytesRead()
	}
	return n
}
