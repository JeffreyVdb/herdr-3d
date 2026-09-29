package usage

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
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
	main   *tail
	subDir string
	subs   map[string]*tail // Claude subagents, by path
	missAt time.Time        // when a lookup last found nothing
	subAt  time.Time        // when the subagents were last listed
	found  bool
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
	return &Session{harness: harness, id: id, roots: roots, pricing: p, subs: map[string]*tail{}, parse: newParser(harness)}
}

func newParser(harness string) parser {
	if harness == Claude {
		return newClaudeUsage()
	}
	return newCodexUsage()
}

// Poll reads what the session's files gained since the last Poll and
// returns its usage; ok is false until its transcript was found.
func (s *Session) Poll(now time.Time) (u proto.Usage, ok bool) {
	if s.main == nil {
		if !s.missAt.IsZero() && now.Sub(s.missAt) < MissRescan && !now.Before(s.missAt) {
			return s.usage()
		}
		path := s.find()
		if path == "" {
			s.missAt = now
			return s.usage()
		}
		s.main, s.found = &tail{path: path}, true
		if s.harness == Claude {
			s.subDir = filepath.Join(filepath.Dir(path), s.id, "subagents")
		}
	}
	err := s.read(now)
	if errors.Is(err, errReplaced) {
		// A file was truncated or replaced: forget everything, read it all.
		s.parse = newParser(s.harness)
		s.main.restart()
		for _, t := range s.subs {
			t.restart()
		}
		err = s.read(now)
	}
	if err != nil && !errors.Is(err, errReplaced) && s.main != nil {
		if _, serr := os.Lstat(s.main.path); errors.Is(serr, fs.ErrNotExist) {
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
	if err := s.main.next(func(b []byte) { s.parse.line(true, b) }); err != nil {
		return err
	}
	if s.subDir == "" {
		return nil
	}
	if s.subAt.IsZero() || now.Sub(s.subAt) >= SubagentRescan || now.Before(s.subAt) {
		s.subAt = now
		entries, _ := os.ReadDir(s.subDir)
		for _, e := range entries {
			name := e.Name()
			if e.Type().IsRegular() && strings.HasPrefix(name, "agent-") && strings.HasSuffix(name, ".jsonl") {
				if p := filepath.Join(s.subDir, name); s.subs[p] == nil {
					s.subs[p] = &tail{path: p}
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
		err := s.subs[p].next(func(b []byte) { s.parse.line(false, b) })
		switch {
		case errors.Is(err, errReplaced):
			return err
		case errors.Is(err, fs.ErrNotExist):
			delete(s.subs, p) // what it had stays counted
		}
	}
	return nil
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
		n += s.main.read
	}
	for _, t := range s.subs {
		n += t.read
	}
	return n
}
