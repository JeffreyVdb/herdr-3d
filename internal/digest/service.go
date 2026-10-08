package digest

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"strings"
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

// ErrCapped is a Summarize past the daily cap: no call until tomorrow (or a
// higher cap); the lines written and cached stay.
var ErrCapped = errors.New("the daily cap of floor overview summaries is reached")

// Roles is what the feature needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	// Fingerprint identifies the LLM's config in use (a passing test covers
	// exactly the config it ran with).
	Fingerprint(r ai.Role) string
	LLM() ai.LLM
}

// Reasoner is what a Roles may also be (*ai.Service is): what the LLM
// model's catalog says of its reasoning effort (#174). Without it the model's
// reasoning is unknown: any effort the gateway knows may be tried.
type Reasoner interface {
	// ModelReasoning reads it, the catalog at most once in a while.
	ModelReasoning(ctx context.Context) ai.Reasoning
	// KnownReasoning is what the last read said, with no call.
	KnownReasoning() ai.Reasoning
}

// Settings are what the store keeps.
type Settings struct {
	Enabled  bool
	DailyCap int
	// ReasoningEffort is the effort sent with each line's request ("": the
	// provider's default, nothing sent); MaxTokens the completion budget
	// (0: DefaultMaxTokens). (#174) They are this feature's only: the other
	// features of the LLM keep their own.
	ReasoningEffort string
	MaxTokens       int
	// CallsDay (YYYY-MM-DD, the bridge's local time) and CallsToday count
	// the calls of that day.
	CallsDay   string
	CallsToday int
}

// CacheEntry is one input's line: its key (Key), the line and when the
// model wrote it (At, #198: a later hit on the line keeps it; zero: not
// known), never the input.
type CacheEntry struct {
	Key, Line string
	At        time.Time
}

// Store keeps the settings and the cache (the bridge's database).
type Store interface {
	LoadDigestSettings(ctx context.Context) (Settings, bool, error)
	// SaveDigestSettings stores Enabled, DailyCap, ReasoningEffort and
	// MaxTokens, never the call count
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
	// tests counts the passing tests (ConfigKey).
	tests int
}

// passedTest is the last passing digest.test: what it ran with (the LLM's
// config, the reasoning effort and the completion budget), and when.
type passedTest struct {
	llm    string
	effort string
	tokens int
	at     time.Time
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
		if ai.ValidEffort(st.ReasoningEffort) {
			s.set.ReasoningEffort = st.ReasoningEffort
		}
		if validTokens(st.MaxTokens) {
			s.set.MaxTokens = st.MaxTokens
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

func validTokens(n int) bool { return n >= MinMaxTokens && n <= MaxMaxTokens }

// tokens is the completion budget in effect.
func (st Settings) tokens() int {
	if validTokens(st.MaxTokens) {
		return st.MaxTokens
	}
	return DefaultMaxTokens
}

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
	// ReasoningEffort is the effort chosen ("": the provider's default,
	// nothing sent), MaxTokens the completion budget in effect (the default
	// when none was chosen). (#174) Both are the feature's only.
	ReasoningEffort string `json:"reasoning_effort"`
	MaxTokens       int    `json:"max_tokens"`
	// Reasoning is what the LLM model's catalog says of its reasoning effort
	// (Support "unknown" until it was read); EffortStale: the chosen effort is
	// one the model does not take, so it is not sent.
	Reasoning   ai.Reasoning `json:"reasoning"`
	EffortStale bool         `json:"effort_stale"`
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

// testedLocked: a passing test covers what is in use: the LLM's config, the
// effort and the budget it ran with.
func (s *Service) testedLocked() bool {
	p := s.passed
	return p != nil && s.opts.Now().Sub(p.at) <= testValidity && p.llm == s.opts.Roles.Fingerprint(ai.RoleLLM) &&
		p.effort == s.set.ReasoningEffort && p.tokens == s.set.tokens()
}

// known is what is known of the LLM model's reasoning, with no call.
func (s *Service) known() ai.Reasoning {
	if rs, ok := s.opts.Roles.(Reasoner); ok && rs != nil {
		return rs.KnownReasoning()
	}
	return ai.UnknownReasoning()
}

// reasoning reads the model's reasoning (the catalog, when it was not read
// lately), with no lock held.
func (s *Service) reasoning(ctx context.Context) ai.Reasoning {
	if rs, ok := s.opts.Roles.(Reasoner); ok && rs != nil {
		return rs.ModelReasoning(ctx)
	}
	return ai.UnknownReasoning()
}

// sent is the effort a request carries: the chosen one, unless the model is
// known not to take it.
func sent(effort string, r ai.Reasoning) string {
	if effort == "" || !r.Allows(effort) {
		return ""
	}
	return effort
}

// ConfigKey names what a line's success or failure was of: the LLM's config,
// the effort, the budget, whether the feature is on, and the passing tests so
// far. When it changes the failures a line had no longer count: the next
// attempt may succeed.
func (s *Service) ConfigKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	fp := ""
	if s.opts.Roles != nil {
		fp = s.opts.Roles.Fingerprint(ai.RoleLLM)
	}
	return fmt.Sprintf("%s|%s|%d|%v|%d", fp, s.set.ReasoningEffort, s.set.tokens(), s.enabledLocked(), s.tests)
}

func (s *Service) viewLocked() View {
	llm := s.llmState()
	r := ai.UnknownReasoning()
	if s.opts.Roles != nil {
		r = s.known()
	}
	v := View{Enabled: s.enabledLocked(), Roles: RoleStates{LLM: string(llm)}, Env: []string{}, Tested: s.testedLocked(),
		DailyCap: s.set.DailyCap, CallsToday: s.callsLocked(), ReasoningEffort: s.set.ReasoningEffort, MaxTokens: s.set.tokens(),
		Reasoning: r, EffortStale: s.set.ReasoningEffort != "" && sent(s.set.ReasoningEffort, r) == ""}
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

// Update is a change of the settings: a nil field is kept.
type Update struct {
	Enabled  *bool
	DailyCap *int
	// ReasoningEffort: "" is the provider's default (nothing sent), else one
	// of the model's efforts. MaxTokens is the completion budget.
	ReasoningEffort *string
	MaxTokens       *int
}

// Set changes the switch and the cap (nil: kept); see Apply.
func (s *Service) Set(ctx context.Context, enabled *bool, dailyCap *int) error {
	return s.Apply(ctx, Update{Enabled: enabled, DailyCap: dailyCap})
}

// Apply changes the settings (nil: kept). Switching it on needs the LLM
// ready and a passing digest.test of it, with the effort and budget then in
// use; the environment's toggle cannot be changed. An effort must be one the
// model takes: the model's catalog is read for it (an unlisted one is
// bad_request, as is any for a model without reasoning). Switched off, it
// returns once a call that is out is cancelled and over.
func (s *Service) Apply(ctx context.Context, u Update) error {
	if u.DailyCap != nil && !validCap(*u.DailyCap) {
		return &Error{CodeBadRequest, fmt.Sprintf("daily_cap must be 1-%d", MaxDailyCap)}
	}
	if u.MaxTokens != nil && !validTokens(*u.MaxTokens) {
		return &Error{CodeBadRequest, fmt.Sprintf("max_tokens must be %d-%d", MinMaxTokens, MaxMaxTokens)}
	}
	if e := u.ReasoningEffort; e != nil && *e != "" {
		if !ai.ValidEffort(*e) {
			return &Error{CodeBadRequest, fmt.Sprintf("reasoning_effort %q is not an effort: use one of none, minimal, low, medium, high, xhigh, max, or \"\" for the provider's default", *e)}
		}
		if r := s.reasoning(ctx); !r.Allows(*e) {
			return &Error{CodeBadRequest, effortRefusal(*e, r)}
		}
	}
	over, err := s.change(ctx, u)
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

// effortRefusal says why a model does not take an effort.
func effortRefusal(e string, r ai.Reasoning) string {
	switch {
	case r.Support == ai.SupportNo:
		return "this model has no reasoning effort: use the provider's default"
	case r.Mandatory && e == "none":
		return "this model's reasoning cannot be turned off: choose " + strings.Join(r.Efforts, ", ") + ", or the provider's default"
	}
	return fmt.Sprintf("this model does not take the reasoning effort %q: it takes %s, or the provider's default", e, strings.Join(r.Efforts, ", "))
}

func (s *Service) change(ctx context.Context, u Update) (<-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.set
	if enabled := u.Enabled; enabled != nil {
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
	if u.DailyCap != nil {
		next.DailyCap = *u.DailyCap
	}
	if u.ReasoningEffort != nil {
		next.ReasoningEffort = *u.ReasoningEffort
	}
	if u.MaxTokens != nil {
		next.MaxTokens = *u.MaxTokens
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

// Refresh reads the LLM model's reasoning from its catalog unless that was
// done lately (the settings window's open): the next View carries it.
func (s *Service) Refresh(ctx context.Context) {
	if s.llmState() == ai.StateReady {
		s.reasoning(ctx)
	}
}

// Cached is the line known for an input.
func (s *Service) Cached(in Input) (string, bool) {
	k := Key(in)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cachedLocked(k)
	return e.Line, ok
}

func (s *Service) cachedLocked(k string) (CacheEntry, bool) {
	e, ok := s.cache[k]
	if !ok {
		return CacheEntry{}, false
	}
	s.lru.MoveToFront(e)
	return e.Value.(CacheEntry), true
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
	// At is when the model wrote the line (#198): this call's time, or the
	// cached line's (zero: not known).
	At time.Time
	// Sent and Answer are the sizes (bytes) of what went and came back,
	// for the audit.
	Sent, Answer int
	// Diag is the sanitized account of the call's last HTTP answer (nil: no
	// call, or none came back); Effort the reasoning effort the request
	// carried ("": none), MaxTokens its completion budget. (#174)
	Diag      *ai.Diagnostics
	Effort    string
	MaxTokens int
}

// Reason is a failure of a line as a short code, for the overview and the
// audit: the AI error's kind (truncated, empty_answer, bad_response,
// provider_failed, timeout, rate_limited, auth_failed, unreachable,
// bad_config …), "no_line" for an answer that holds no line, "failed" for
// anything else.
func Reason(err error) string {
	switch k := ai.KindOf(err); {
	case k != "":
		return string(k)
	case errors.Is(err, ErrNoLine):
		return "no_line"
	}
	return "failed"
}

// Attempts bounds the retries of a failed task line (#174): a prompt's line
// is asked for at most MaxAttempts times, the next after the delay RetryDelay
// says; a manual retry, a new prompt, a changed setting or a passing test
// start the count again. A failed call costs the daily cap like any call.
const MaxAttempts = 4

// RetryDelay is how long after its n-th failed attempt (n from 1) the next
// goes; ok false when n reached MaxAttempts: no more by itself.
func RetryDelay(n int) (d time.Duration, ok bool) {
	delays := [...]time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}
	if n < 1 || n >= MaxAttempts {
		return 0, false
	}
	return delays[n-1], true
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
	if e, ok := s.cachedLocked(key); ok {
		s.mu.Unlock()
		return Result{Line: e.Line, Cached: true, At: e.At}, nil
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
	req := s.request(ctx, in)
	res := Result{Sent: len(req.Messages[1].Content), Effort: req.ReasoningEffort, MaxTokens: req.MaxTokens}
	req.Report = func(d ai.Diagnostics) { res.Diag = &d }
	out, err := s.ask(ctx, req)
	res.Answer = len(out)
	if err != nil {
		return res, err
	}
	line, err := Clean(out, lineMax(in.Kind))
	if err != nil {
		return res, err
	}
	res.Line, res.At = line, s.opts.Now()
	e := CacheEntry{Key: key, Line: line, At: res.At}
	s.mu.Lock()
	s.putLocked(e)
	s.mu.Unlock()
	if s.opts.Store != nil {
		_ = s.opts.Store.SaveDigestCache(ctx, e, CacheSize) // kept in memory; the next restart asks again
	}
	return res, nil
}

// request is an input's completion under the settings now: the budget, and
// the chosen effort unless the model is known not to take it (a stale
// choice: it is shown as such, and not sent).
func (s *Service) request(ctx context.Context, in Input) ai.Request {
	s.mu.Lock()
	effort, tokens := s.set.ReasoningEffort, s.set.tokens()
	s.mu.Unlock()
	if effort != "" {
		effort = sent(effort, s.reasoning(ctx))
	}
	return RequestWith(in, Params{MaxTokens: tokens, ReasoningEffort: effort})
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

// Sample is one sample's outcome. Diag is how the call ended and what it
// spent (never any text), for tuning the budget.
type Sample struct {
	Kind  string          `json:"kind"`
	Line  string          `json:"line,omitempty"`
	Error string          `json:"error,omitempty"`
	Diag  *ai.Diagnostics `json:"diag,omitempty"`
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
	s.mu.Lock()
	effort, tokens := s.set.ReasoningEffort, s.set.tokens()
	s.mu.Unlock()
	start := s.opts.Now()
	res := &TestResult{}
	for _, in := range []Input{{Kind: KindTask, Prompt: SampleTaskPrompt}, {Kind: KindNow, Context: "Task: Fix the flaky login test", Steps: SampleSteps}} {
		req := s.request(ctx, in)
		var diag *ai.Diagnostics
		req.Report = func(d ai.Diagnostics) { diag = &d }
		out, err := s.opts.Roles.LLM().Complete(ctx, req)
		if err != nil {
			return nil, err
		}
		smp := Sample{Kind: in.Kind, Diag: diag}
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
		s.passed = &passedTest{llm: fp, effort: effort, tokens: tokens, at: s.opts.Now()}
		s.tests++
		s.mu.Unlock()
	}
	return res, nil
}
