// Package childagentstest is #22's fake child-agent source and fixture
// scripts (../testdata/*.json, read by the Go tests and by Vitest): test
// code only, imported by no production path.
package childagentstest

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Script is a fixture (../testdata/*.json, read by the Go tests and by
// Vitest): workers with their root sessions, the steps that happen to them
// in order, and the trees each worker must end with.
type Script struct {
	Description string         `json:"description"`
	Workers     []ScriptWorker `json:"workers"`
	Steps       []Step         `json:"steps"`
	// Expect is each worker's tree at the end, by worker name.
	Expect map[string][]Node `json:"expect"`
}

// ScriptWorker is a worker of a script: its name (the test's workspace
// id) and root agent session.
type ScriptWorker struct {
	Name         string `json:"name"`
	AgentSession string `json:"agent_session"`
}

// Step is one step of a script, exactly one of: evidence the source
// observes; a worker's root session replaced (herdr reports a new
// agent_session); a worker removed.
type Step struct {
	Note         string                `json:"note,omitempty"`
	Evidence     *childagents.Evidence `json:"evidence,omitempty"`
	Session      *ScriptWorker         `json:"session,omitempty"`
	RemoveWorker string                `json:"remove_worker,omitempty"`
}

// LoadScript reads a fixture strictly: an unknown key is an error.
func LoadScript(path string) (*Script, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	var s Script
	if err := d.Decode(&s); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for i, st := range s.Steps {
		n := 0
		if st.Evidence != nil {
			n++
		}
		if st.Session != nil {
			n++
		}
		if st.RemoveWorker != "" {
			n++
		}
		if n != 1 {
			return nil, fmt.Errorf("%s: step %d has %d actions, want 1", path, i, n)
		}
	}
	return &s, nil
}

// Scripts are the fixtures of a directory, by name (the file name without
// .json).
func Scripts(dir string) (map[string]*Script, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	out := map[string]*Script{}
	for _, p := range paths {
		s, err := LoadScript(p)
		if err != nil {
			return nil, err
		}
		out[strings.TrimSuffix(filepath.Base(p), ".json")] = s
	}
	return out, nil
}

// Play runs a script against a registry with no hub, the worker names
// standing for worker ids, and returns every event in order and every
// piece of evidence the registry dropped.
func Play(s *Script, r *childagents.Registry) (evs []proto.Event, dropped []childagents.Evidence) {
	for _, w := range s.Workers {
		r.Worker(w.Name, w.AgentSession)
	}
	for _, st := range s.Steps {
		switch {
		case st.Evidence != nil:
			out, err := r.Apply(*st.Evidence)
			if err != nil {
				dropped = append(dropped, *st.Evidence)
			}
			evs = append(evs, out...)
		case st.Session != nil:
			r.Worker(st.Session.Name, st.Session.AgentSession)
		case st.RemoveWorker != "":
			r.Remove(st.RemoveWorker)
		}
	}
	return evs, dropped
}

// Node is one child in a tree: what a client shows of it, without the row
// ids (a fresh registry fed the same evidence makes the same graph; the ids
// it gives the rows are no part of that). Children are its own children.
type Node struct {
	NativeID       string `json:"native_id,omitempty"`
	Provider       string `json:"provider"`
	Parent         string `json:"parent"`
	Name           string `json:"name,omitempty"`
	Type           string `json:"type,omitempty"`
	Description    string `json:"description,omitempty"`
	State          string `json:"state"`
	Source         string `json:"source"`
	StartedAt      int64  `json:"started_at,omitempty"`
	LastActivityAt int64  `json:"last_activity_at,omitempty"`
	EndedAt        int64  `json:"ended_at,omitempty"`
	Transcript     string `json:"transcript"`
	Children       []Node `json:"children,omitempty"`
}

// Tree is one worker's children as a tree: the root's children and the
// unresolved ones at the top (a client shows those under the root worker),
// each child under its parent; siblings by start, native id, name. A row
// whose parent chain comes back to it (the registry makes none) is at the
// top too, never lost with its descendants.
// game/src/world/children.ts childTree builds the same.
func Tree(cs []proto.Child) []Node {
	ids := map[string]bool{}
	for _, c := range cs {
		ids[c.ID] = true
	}
	up := map[string]string{}
	for _, c := range cs {
		if c.Parent == proto.ParentChild && ids[c.ParentID] {
			up[c.ID] = c.ParentID
		}
	}
	cyclic := func(id string) bool {
		for p, n := up[id], 0; p != "" && n < len(up); p, n = up[p], n+1 {
			if p == id {
				return true
			}
		}
		return false
	}
	kids := map[string][]proto.Child{}
	for _, c := range cs {
		p := up[c.ID]
		if cyclic(c.ID) {
			p = ""
		}
		kids[p] = append(kids[p], c)
	}
	var build func(p string) []Node
	build = func(p string) []Node {
		list := kids[p]
		slices.SortStableFunc(list, func(a, b proto.Child) int {
			return cmp.Or(cmp.Compare(a.StartedAt, b.StartedAt), cmp.Compare(a.NativeID, b.NativeID), cmp.Compare(a.Name, b.Name), cmp.Compare(a.ID, b.ID))
		})
		var out []Node
		for _, c := range list {
			out = append(out, Node{NativeID: c.NativeID, Provider: c.Provider, Parent: c.Parent, Name: c.Name, Type: c.Type,
				Description: c.Description, State: c.State, Source: c.Source, StartedAt: c.StartedAt, LastActivityAt: c.LastActivityAt,
				EndedAt: c.EndedAt, Transcript: c.Transcript, Children: build(c.ID)})
		}
		return out
	}
	return build("")
}

// FixtureSource is a childagents.Source driven by a test (or a fixture): Emit is an
// observation, and everything emitted (with what it was made with: a
// provider's evidence on disk after a restart) is what a Replay sends
// again.
type FixtureSource struct {
	ready chan struct{} // closed once Run has its emit
	kick  chan struct{}
	busy  sync.WaitGroup // replays asked for and not done

	mu      sync.Mutex
	emit    func(childagents.Evidence)
	seen    []childagents.Evidence
	replays []string
}

// NewFixtureSource returns a source that has already observed known.
func NewFixtureSource(known ...childagents.Evidence) *FixtureSource {
	return &FixtureSource{ready: make(chan struct{}), kick: make(chan struct{}, 1), seen: slices.Clone(known)}
}

// Run serves the replays until ctx ends.
func (s *FixtureSource) Run(ctx context.Context, emit func(childagents.Evidence)) error {
	s.mu.Lock()
	s.emit = emit
	s.mu.Unlock()
	close(s.ready)
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			for range s.replays {
				s.busy.Done()
			}
			s.replays = nil
			s.mu.Unlock()
			return nil
		case <-s.kick:
			s.serveReplays()
		}
	}
}

func (s *FixtureSource) serveReplays() {
	for {
		s.mu.Lock()
		if len(s.replays) == 0 {
			s.mu.Unlock()
			return
		}
		session := s.replays[0]
		s.replays = s.replays[1:]
		var evs []childagents.Evidence
		for _, e := range s.seen {
			if e.Session == session {
				evs = append(evs, e)
			}
		}
		emit := s.emit
		s.mu.Unlock()
		for _, e := range evs {
			emit(e)
		}
		s.busy.Done()
	}
}

// Replay queues a replay of session (never blocks).
func (s *FixtureSource) Replay(session string) {
	s.mu.Lock()
	s.replays = append(s.replays, session)
	s.busy.Add(1)
	s.mu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Emit observes e: it is recorded, then passed to Run's emit (waiting for
// Run to start).
func (s *FixtureSource) Emit(e childagents.Evidence) {
	<-s.ready
	s.mu.Lock()
	s.seen = append(s.seen, e)
	emit := s.emit
	s.mu.Unlock()
	emit(e)
}

// Wait returns once every replay asked for so far was sent.
func (s *FixtureSource) Wait() { s.busy.Wait() }

// Seen is everything observed so far, in order.
func (s *FixtureSource) Seen() []childagents.Evidence {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.seen)
}
