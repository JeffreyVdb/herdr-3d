package digest

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Defaults and bounds of the settings.
const (
	DefaultDailyCap = 300
	MaxDailyCap     = 10_000
	// CacheSize is how many inputs' lines are kept.
	CacheSize = 2000
)

// testValidity is how long a passing digest.test allows enabling.
const testValidity = 30 * time.Minute

// States of the feature (View.State).
const (
	StateOff        = "off"        // switched off
	StateIncomplete = "incomplete" // on, but the LLM is not ready: nothing is sent
	StateReady      = "ready"      // on, the LLM ready: lines are written (until the daily cap)
)

// Error codes (Error.Code), the protocol's too.
const (
	CodeIncomplete   = "incomplete"    // the LLM is not ready
	CodeTestRequired = "test_required" // enabling without a passing digest.test
	CodeEnvLocked    = "env_locked"    // the bridge environment sets enabled
	CodeBadRequest   = "bad_request"
)

// Error is an error of the settings commands.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// ErrBusy is a Summarize while another call of the feature is out: it makes
// one call at a time, so the AI integration's other slot is always free for
// the follow-up questions and pack up.
var ErrBusy = errors.New("a line is being written already")

// ErrCapped is a Summarize past the daily cap: fallbacks until tomorrow.
var ErrCapped = errors.New("the daily cap of floor overview summaries is reached")

// Roles is what the feature needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	// Fingerprint identifies the LLM's config in use (a passing test covers
	// exactly the config it ran with).
	Fingerprint(r ai.Role) string
	LLM() ai.LLM
}

// Settings are what the store keeps.
type Settings struct {
	Enabled  bool
	DailyCap int
	// CallsDay (YYYY-MM-DD, the bridge's local time) and CallsToday count
	// the calls of that day.
	CallsDay   string
	CallsToday int
}

// CacheEntry is one input's line: its key (Key) and the line, never the
// input.
type CacheEntry struct {
	Key, Line string
}

// Store keeps the settings and the cache (the bridge's database).
type Store interface {
	LoadDigestSettings(ctx context.Context) (Settings, bool, error)
	// SaveDigestSettings stores Enabled and DailyCap, never the call count
	// (it too only when nothing is stored yet).
	SaveDigestSettings(ctx context.Context, s Settings) error
	// SaveDigestCalls stores the call count, never the settings (they too
	// only when nothing is stored yet).
	SaveDigestCalls(ctx context.Context, s Settings) error
	// LoadDigestCache returns the newest entries, newest first.
	LoadDigestCache(ctx context.Context, limit int) ([]CacheEntry, error)
	// SaveDigestCache records an entry, keeping the newest limit.
	SaveDigestCache(ctx context.Context, e CacheEntry, limit int) error
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvEnabled is HERDR_WORLD_DIGEST_ENABLED (nil: not set): while set it
	// wins over the stored toggle, and the panel shows it read-only. It
	// still needs the LLM ready.
	EnvEnabled *bool
	Now        func() time.Time
}

// Service holds the settings, the cache and the budget, and asks the LLM:
// at most one call at a time (ErrBusy). Switching the feature off cancels a
// call that is out and returns once it is over: nothing is sent after. Safe
// for concurrent use.
type Service struct {
	opts Options
	busy chan struct{} // the one call in flight

	mu     sync.Mutex
	set    Settings
	passed *passedTest
	cache  map[string]*list.Element
	lru    *list.List // of CacheEntry, newest first
	call   *call
}

// passedTest is the last passing digest.test: the LLM config it ran with,
// and when.
type passedTest struct {
	llm string
	at  time.Time
}

// call is a call handed to the LLM: cancel stops it, done is closed once it
// returned.
type call struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// New loads the settings and the cache.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, busy: make(chan struct{}, 1), set: Settings{DailyCap: DefaultDailyCap},
		cache: map[string]*list.Element{}, lru: list.New()}
	if opts.Store == nil {
		return s, nil
	}
	st, ok, err := opts.Store.LoadDigestSettings(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		s.set.Enabled, s.set.CallsDay, s.set.CallsToday = st.Enabled, st.CallsDay, st.CallsToday
		if validCap(st.DailyCap) {
			s.set.DailyCap = st.DailyCap
		}
	}
	es, err := opts.Store.LoadDigestCache(ctx, CacheSize)
	if err != nil {
		return nil, err
	}
	for i := len(es) - 1; i >= 0; i-- { // oldest first, so the newest ends in front
		s.putLocked(es[i])
	}
	return s, nil
}

func validCap(n int) bool { return n >= 1 && n <= MaxDailyCap }

// RoleStates is the LLM's state, for the status line.
type RoleStates struct {
	LLM string `json:"llm"`
}

// View is the feature as clients see it (digest.get, digest.update,
// World.digest).
type View struct {
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`
	// Missing lists the roles that are not ready ("llm").
	Missing []string   `json:"missing,omitempty"`
	Roles   RoleStates `json:"roles"`
	// Env lists the fields the bridge environment sets ("enabled").
	Env []string `json:"env"`
	// Tested: a passing digest.test covers the LLM in use (enabling is
	// allowed).
	Tested     bool `json:"tested"`
	DailyCap   int  `json:"daily_cap"`
	CallsToday int  `json:"calls_today"`
}

func (s *Service) day() string { return s.opts.Now().Format("2006-01-02") }

func (s *Service) callsLocked() int {
	if s.set.CallsDay != s.day() {
		return 0
	}
	return s.set.CallsToday
}

func (s *Service) enabledLocked() bool {
	if e := s.opts.EnvEnabled; e != nil {
		return *e
	}
	return s.set.Enabled
}

func (s *Service) llmState() ai.State {
	if s.opts.Roles == nil {
		return ai.StateOff
	}
	return s.opts.Roles.State(ai.RoleLLM)
}

func (s *Service) testedLocked() bool {
	p := s.passed
	return p != nil && s.opts.Now().Sub(p.at) <= testValidity && p.llm == s.opts.Roles.Fingerprint(ai.RoleLLM)
}

func (s *Service) viewLocked() View {
	llm := s.llmState()
	v := View{Enabled: s.enabledLocked(), Roles: RoleStates{LLM: string(llm)}, Env: []string{}, Tested: s.testedLocked(),
		DailyCap: s.set.DailyCap, CallsToday: s.callsLocked()}
	if llm != ai.StateReady {
		v.Missing = []string{string(ai.RoleLLM)}
	}
	if s.opts.EnvEnabled != nil {
		v.Env = append(v.Env, "enabled")
	}
	switch {
	case !v.Enabled:
		v.State = StateOff
	case len(v.Missing) > 0:
		v.State = StateIncomplete
	default:
		v.State = StateReady
	}
	return v
}

// View is the current state.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked()
}

// Ready reports whether the model's lines apply: switched on and the LLM
// ready (past the daily cap too: a cached line costs nothing).
func (s *Service) Ready() bool { return s.View().State == StateReady }

// Capped reports whether today's calls reached the daily cap.
func (s *Service) Capped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.callsLocked() >= s.set.DailyCap
}

// Set changes the settings (nil: kept). Switching it on needs the LLM ready
// and a passing digest.test of it; the environment's toggle cannot be
// changed. Switched off, it returns once a call that is out is cancelled and
// over.
func (s *Service) Set(ctx context.Context, enabled *bool, dailyCap *int) error {
	if dailyCap != nil && !validCap(*dailyCap) {
		return &Error{CodeBadRequest, fmt.Sprintf("daily_cap must be 1-%d", MaxDailyCap)}
	}
	over, err := s.change(ctx, enabled, dailyCap)
	if err != nil || over == nil {
		return err
	}
	select {
	case <-over:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) change(ctx context.Context, enabled *bool, dailyCap *int) (<-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.set
	if enabled != nil {
		if e := s.opts.EnvEnabled; e != nil {
			if *enabled != *e {
				return nil, &Error{CodeEnvLocked, "floor overview summaries are switched by the bridge environment (HERDR_WORLD_DIGEST_ENABLED)"}
			}
		} else {
			if *enabled && !s.set.Enabled {
				if s.llmState() != ai.StateReady {
					return nil, &Error{CodeIncomplete, "floor overview summaries need the LLM to be ready"}
				}
				if !s.testedLocked() {
					return nil, &Error{CodeTestRequired, "run the summaries test first: it must pass with the LLM in use"}
				}
			}
			next.Enabled = *enabled
		}
	}
	if dailyCap != nil {
		next.DailyCap = *dailyCap
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SaveDigestSettings(ctx, next); err != nil {
			return nil, fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.set = next
	if s.enabledLocked() || s.call == nil {
		return nil, nil
	}
	s.call.cancel()
	return s.call.done, nil
}

// Cached is the line known for an input.
func (s *Service) Cached(in Input) (string, bool) {
	k := Key(in)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cachedLocked(k)
}

func (s *Service) cachedLocked(k string) (string, bool) {
	e, ok := s.cache[k]
	if !ok {
		return "", false
	}
	s.lru.MoveToFront(e)
	return e.Value.(CacheEntry).Line, true
}

func (s *Service) putLocked(e CacheEntry) {
	if el, ok := s.cache[e.Key]; ok {
		el.Value = e
		s.lru.MoveToFront(el)
		return
	}
	s.cache[e.Key] = s.lru.PushFront(e)
	for s.lru.Len() > CacheSize {
		old := s.lru.Back()
		s.lru.Remove(old)
		delete(s.cache, old.Value.(CacheEntry).Key)
	}
}

// Result is a line Summarize wrote or found.
type Result struct {
	Line string
	// Cached: the line was known for this input, no call was made.
	Cached bool
	// Sent and Answer are the sizes (bytes) of what went and came back,
	// for the audit.
	Sent, Answer int
}

// lineMax is the line's bound for an input's kind.
func lineMax(kind string) int {
	if kind == KindTask {
		return TaskMax
	}
	return NowMax
}

// Summarize writes the line of an input: the cached one when it is known
// (no call, nothing counted), else one call to the LLM, counted toward the
// daily cap whatever its outcome. Unless the feature is ready it makes no
// call (ai.ErrNotReady), nor once it is switched off while the call is out;
// ErrBusy while another call is out, ErrCapped past the cap, ErrNoLine for
// an answer without a line. Only Prepare's text is sent.
func (s *Service) Summarize(ctx context.Context, in Input) (Result, error) {
	if in.Kind != KindTask && in.Kind != KindNow {
		return Result{}, fmt.Errorf("unknown kind %q", in.Kind)
	}
	key := Key(in)
	s.mu.Lock()
	if s.viewLocked().State != StateReady {
		s.mu.Unlock()
		return Result{}, ai.ErrNotReady
	}
	if line, ok := s.cachedLocked(key); ok {
		s.mu.Unlock()
		return Result{Line: line, Cached: true}, nil
	}
	if Empty(in) {
		s.mu.Unlock()
		return Result{}, ErrNoLine
	}
	if s.callsLocked() >= s.set.DailyCap {
		s.mu.Unlock()
		return Result{}, ErrCapped
	}
	select {
	case s.busy <- struct{}{}:
	default:
		s.mu.Unlock()
		return Result{}, ErrBusy
	}
	defer func() { <-s.busy }()
	s.set.CallsToday, s.set.CallsDay = s.callsLocked()+1, s.day()
	counted := s.set
	s.mu.Unlock()
	if s.opts.Store != nil {
		_ = s.opts.Store.SaveDigestCalls(ctx, counted) // the count is best effort
	}
	req := Request(in)
	res := Result{Sent: len(req.Messages[1].Content)}
	out, err := s.ask(ctx, req)
	res.Answer = len(out)
	if err != nil {
		return res, err
	}
	line, err := Clean(out, lineMax(in.Kind))
	if err != nil {
		return res, err
	}
	res.Line = line
	e := CacheEntry{Key: key, Line: line}
	s.mu.Lock()
	s.putLocked(e)
	s.mu.Unlock()
	if s.opts.Store != nil {
		_ = s.opts.Store.SaveDigestCache(ctx, e, CacheSize) // kept in memory; the next restart asks again
	}
	return res, nil
}

// ask hands the request to the LLM unless the feature was switched off
// meanwhile; from then until it returns, Set switching it off cancels it
// (ai.ErrNotReady) and waits for it.
func (s *Service) ask(ctx context.Context, req ai.Request) (string, error) {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := &call{cancel: cancel, done: make(chan struct{})}
	defer close(c.done)
	s.mu.Lock()
	if s.viewLocked().State != StateReady {
		s.mu.Unlock()
		return "", ai.ErrNotReady
	}
	s.call = c
	s.mu.Unlock()
	out, err := s.opts.Roles.LLM().Complete(cctx, req)
	s.mu.Lock()
	s.call = nil
	s.mu.Unlock()
	if err != nil && cctx.Err() != nil && ctx.Err() == nil {
		return "", ai.ErrNotReady // switched off while it was out
	}
	return out, err
}

// The test's samples: a first prompt and a turn's steps.
const SampleTaskPrompt = "The login test in e2e/auth.spec.ts fails about one run in five on CI. Find out why, fix it, " +
	"and open a PR with the fix. Don't touch the session loader."

// SampleSteps are the test's now sample.
var SampleSteps = []Step{
	{Texts: []string{"I'll look at the flaky login test first."}, Tools: []Tool{{Name: "Read", Summary: "e2e/auth.spec.ts"}}},
	{Texts: []string{"The test clicks Login before the form is hydrated. I'll wait for the form to be ready."},
		Tools: []Tool{{Name: "Edit", Summary: "e2e/auth.spec.ts"}}},
	{Tools: []Tool{{Name: "Bash", Summary: "pnpm exec playwright test e2e/auth.spec.ts --repeat-each 20"}}},
}

// Sample is one sample's outcome.
type Sample struct {
	Kind  string `json:"kind"`
	Line  string `json:"line,omitempty"`
	Error string `json:"error,omitempty"`
}

// TestResult is digest.test's answer. A test that ran but did not pass (an
// answer without a line) has OK false and Reason; a call that failed is an
// error.
type TestResult struct {
	OK        bool     `json:"ok"`
	Reason    string   `json:"reason,omitempty"`
	Samples   []Sample `json:"samples"`
	LatencyMS int64    `json:"latency_ms"`
}

// Test writes both samples' lines with the LLM in use, one call at a time
// (it waits for the feature's call that is out). It is not counted toward
// the daily cap nor cached. A pass allows switching the feature on for 30
// minutes, while the LLM stays the same.
func (s *Service) Test(ctx context.Context) (*TestResult, error) {
	if s.llmState() != ai.StateReady {
		return nil, &Error{CodeIncomplete, "the summaries test needs the LLM to be ready"}
	}
	select {
	case s.busy <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.busy }()
	fp := s.opts.Roles.Fingerprint(ai.RoleLLM)
	start := s.opts.Now()
	res := &TestResult{}
	for _, in := range []Input{{Kind: KindTask, Prompt: SampleTaskPrompt}, {Kind: KindNow, Context: "Task: Fix the flaky login test", Steps: SampleSteps}} {
		out, err := s.opts.Roles.LLM().Complete(ctx, Request(in))
		if err != nil {
			return nil, err
		}
		smp := Sample{Kind: in.Kind}
		if line, err := Clean(out, lineMax(in.Kind)); err != nil {
			smp.Error = err.Error()
			if res.Reason == "" {
				res.Reason = fmt.Sprintf("the LLM's %s line was empty", in.Kind)
			}
		} else {
			smp.Line = line
		}
		res.Samples = append(res.Samples, smp)
	}
	res.LatencyMS = s.opts.Now().Sub(start).Milliseconds()
	res.OK = res.Reason == ""
	if res.OK {
		s.mu.Lock()
		s.passed = &passedTest{llm: fp, at: s.opts.Now()}
		s.mu.Unlock()
	}
	return res, nil
}
