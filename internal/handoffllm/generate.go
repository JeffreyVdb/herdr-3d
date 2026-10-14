package handoffllm

// The feature of LLM handoffs (#9): its switch (off by default), its limits
// (the transcript budget, the completion budget, the reasoning effort) and
// the one call it makes per handoff, through the AI integration's LLM role
// (ai.LLM, never a vendor client and never the classifier).
//
// The gate is the floor overview summaries' (#118): switching it on needs
// the LLM ready and a passing handoff_llm.test of it, run within 30 minutes
// with the effort and budget in use; configuring the AI alone sends
// nothing. The switch is bound to the config the test ran with: once the
// LLM's config (its fingerprint), the effort or the budget changes, the
// feature is "untested" and sends nothing until a test passes again. The
// bridge environment can set the switch instead (HERDR_WORLD_HANDOFF_LLM_ENABLED,
// headless: no test then), and still needs the LLM ready.
//
// One call at a time over the whole bridge (ErrBusy): a handoff may run for
// up to Timeout, and it never holds both of the AI integration's shared
// slots, so the follow-up questions keep one. A call has its own timeout,
// no automatic second attempt after an outcome the provider may have
// processed (a timeout, a 5xx), the configured key kept out of its
// messages, and an answer cut off at the budget is an error (never a
// clipped document). Switching the feature off cancels a call that is out.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Timeout bounds one handoff call. Provisional: the spike
// (docs/research/handoff-summarizer.md) measures it; the AI integration's
// shared 15 s stays for every other feature.
const Timeout = 90 * time.Second

// Bounds of the settings.
const (
	// DefaultInputBytes is the transcript budget (Payload.Text): about
	// 32k tokens of English at the conservative estimate, room left for
	// the instructions and the answer in any model with a 64k window.
	DefaultInputBytes = 96 << 10
	MinInputBytes     = 16 << 10
	MaxInputBytes     = 768 << 10
	// DefaultMaxTokens is the completion budget, reasoning included.
	DefaultMaxTokens = 4096
	MinMaxTokens     = 1024
	MaxMaxTokens     = 32768
)

// testValidity is how long a passing test allows switching it on.
const testValidity = 30 * time.Minute

// States of the feature (View.State).
const (
	StateOff        = "off"        // switched off
	StateIncomplete = "incomplete" // on, but the LLM is not ready
	StateUntested   = "untested"   // on, but the LLM, the effort or the budget changed since the test: run it again
	StateReady      = "ready"
)

// Error codes (Error.Code), the protocol's too.
const (
	CodeIncomplete   = "incomplete"
	CodeTestRequired = "test_required"
	CodeEnvLocked    = "env_locked"
	CodeBadRequest   = "bad_request"
	// CodeUnavailable: a handoff asked for while the feature is not ready;
	// nothing was sent.
	CodeUnavailable = "handoff_llm_unavailable"
	// CodeInvalid: the model's answer is not a handoff of the agreed shape;
	// nothing was filed.
	CodeInvalid = "handoff_llm_invalid"
)

// Error is an error of the feature's commands.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// ErrBusy is a handoff while another is being written: one at a time.
var ErrBusy = errors.New("another LLM handoff is being written: one at a time")

// Categories are what a handoff sends the configured endpoint, for the
// settings and the dialog to say.
var Categories = []string{
	"your prompts to the worker",
	"the worker's replies and explanations",
	"tool names and their inputs (commands, paths)",
	"bounded tool evidence (test results, errors, commit and PR references)",
	"your handoff instruction",
	"the bridge's facts (worker, branch, git status now)",
}

// Roles is what the feature needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	Fingerprint(r ai.Role) string
	LLM() ai.LLM
}

// Reasoner is what a Roles may also be (*ai.Service is): the LLM model's
// reasoning effort, from its catalog.
type Reasoner interface {
	ModelReasoning(ctx context.Context) ai.Reasoning
	KnownReasoning() ai.Reasoning
}

// Settings are what the store keeps. Bound is the config the switch was
// turned on for (BoundKey: the LLM's fingerprint, the effort, the budget;
// a hash, never a key).
type Settings struct {
	Enabled         bool
	InputBytes      int
	MaxTokens       int
	ReasoningEffort string
	Bound           string
}

// Store keeps the settings (the bridge's database).
type Store interface {
	LoadHandoffLLMSettings(ctx context.Context) (Settings, bool, error)
	SaveHandoffLLMSettings(ctx context.Context, s Settings) error
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvEnabled is HERDR_WORLD_HANDOFF_LLM_ENABLED (nil: not set): while
	// set it wins over the stored switch, needs no test, and the panel shows
	// it read-only. It still needs the LLM ready.
	EnvEnabled *bool
	Now        func() time.Time
}

// Service holds the settings and makes the feature's calls, one at a time.
// Safe for concurrent use.
type Service struct {
	opts Options
	busy chan struct{}

	mu     sync.Mutex
	set    Settings
	passed *passedTest
	call   *call
}

type passedTest struct {
	key string
	at  time.Time
}

type call struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// New loads the settings.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, busy: make(chan struct{}, 1), set: Settings{InputBytes: DefaultInputBytes, MaxTokens: DefaultMaxTokens}}
	if opts.Store == nil {
		return s, nil
	}
	st, ok, err := opts.Store.LoadHandoffLLMSettings(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		s.set.Enabled, s.set.Bound = st.Enabled, st.Bound
		if validInput(st.InputBytes) {
			s.set.InputBytes = st.InputBytes
		}
		if validTokens(st.MaxTokens) {
			s.set.MaxTokens = st.MaxTokens
		}
		if ai.ValidEffort(st.ReasoningEffort) {
			s.set.ReasoningEffort = st.ReasoningEffort
		}
	}
	return s, nil
}

func validInput(n int) bool  { return n >= MinInputBytes && n <= MaxInputBytes }
func validTokens(n int) bool { return n >= MinMaxTokens && n <= MaxMaxTokens }

// RoleStates is the LLM's state, for the status line.
type RoleStates struct {
	LLM string `json:"llm"`
}

// View is the feature as clients see it (handoff_llm.get, handoff_llm.update,
// World.handoff_llm).
type View struct {
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`
	// Missing lists the roles that are not ready ("llm").
	Missing []string   `json:"missing,omitempty"`
	Roles   RoleStates `json:"roles"`
	// Env lists the fields the bridge environment sets ("enabled").
	Env []string `json:"env"`
	// Tested: a passing test, within 30 minutes, covers the LLM, effort and
	// budget in use (switching on is allowed).
	Tested bool `json:"tested"`
	// InputBytes is the transcript budget, MaxTokens the completion budget,
	// ReasoningEffort the effort sent ("": the provider's default).
	InputBytes      int    `json:"input_bytes"`
	MaxTokens       int    `json:"max_tokens"`
	ReasoningEffort string `json:"reasoning_effort"`
	// Reasoning is what the model's catalog says of its effort; EffortStale:
	// the chosen one is not the model's, so it is not sent.
	Reasoning   ai.Reasoning `json:"reasoning"`
	EffortStale bool         `json:"effort_stale"`
	// TimeoutS bounds a handoff call; PromptVersion is the bridge's prompt;
	// Categories are what a handoff sends.
	TimeoutS      int      `json:"timeout_s"`
	PromptVersion string   `json:"prompt_version"`
	Categories    []string `json:"categories"`
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

// keyOf names the config a test covers under settings st: the LLM's
// fingerprint, the effort and the completion budget.
func (s *Service) keyOf(st Settings) string {
	return fmt.Sprintf("%s|%s|%d", s.Fingerprint(), st.ReasoningEffort, st.MaxTokens)
}

func (s *Service) keyLocked() string { return s.keyOf(s.set) }

// testedLocked: a passing test within testValidity covers settings st.
func (s *Service) testedLocked(st Settings) bool {
	p := s.passed
	return p != nil && s.opts.Now().Sub(p.at) <= testValidity && p.key == s.keyOf(st)
}

func (s *Service) known() ai.Reasoning {
	if rs, ok := s.opts.Roles.(Reasoner); ok && rs != nil {
		return rs.KnownReasoning()
	}
	return ai.UnknownReasoning()
}

func (s *Service) reasoning(ctx context.Context) ai.Reasoning {
	if rs, ok := s.opts.Roles.(Reasoner); ok && rs != nil {
		return rs.ModelReasoning(ctx)
	}
	return ai.UnknownReasoning()
}

func sentEffort(effort string, r ai.Reasoning) string {
	if effort == "" || !r.Allows(effort) {
		return ""
	}
	return effort
}

func (s *Service) viewLocked() View {
	llm := s.llmState()
	r := ai.UnknownReasoning()
	if s.opts.Roles != nil {
		r = s.known()
	}
	v := View{Enabled: s.enabledLocked(), Roles: RoleStates{LLM: string(llm)}, Env: []string{}, Tested: s.testedLocked(s.set),
		InputBytes: s.set.InputBytes, MaxTokens: s.set.MaxTokens, ReasoningEffort: s.set.ReasoningEffort, Reasoning: r,
		EffortStale: s.set.ReasoningEffort != "" && sentEffort(s.set.ReasoningEffort, r) == "",
		TimeoutS:    int(Timeout / time.Second), PromptVersion: PromptVersion, Categories: append([]string(nil), Categories...)}
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
	case s.opts.EnvEnabled == nil && s.set.Bound != s.keyOf(s.set):
		v.State = StateUntested
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

// Unready says why a handoff cannot be written now ("": it can).
func (s *Service) Unready() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return unreadyWhy(s.viewLocked())
}

func unreadyWhy(v View) string {
	switch v.State {
	case StateReady:
		return ""
	case StateOff:
		return "LLM handoffs are switched off in Settings"
	case StateIncomplete:
		return "the LLM is not ready: set it up in Settings, AI integration"
	case StateUntested:
		return "the LLM or the handoff limits changed since the test: run the LLM handoffs test in Settings again"
	}
	return "LLM handoffs are not available"
}

// Fingerprint is the LLM config in use ("" without one): a handoff is filed
// only under the config it was written with.
func (s *Service) Fingerprint() string {
	if s.opts.Roles == nil {
		return ""
	}
	return s.opts.Roles.Fingerprint(ai.RoleLLM)
}

// InputBytes is the transcript budget in effect.
func (s *Service) InputBytes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.set.InputBytes
}

// Update is a change of the settings: a nil field is kept.
type Update struct {
	Enabled         *bool
	InputBytes      *int
	MaxTokens       *int
	ReasoningEffort *string
}

// Apply changes the settings. Switching on needs the LLM ready and a passing
// test of the config then in use; the environment's switch cannot be
// changed; an effort must be one the model takes. Switched off, it returns
// once a call that is out is cancelled and over.
func (s *Service) Apply(ctx context.Context, u Update) error {
	if u.InputBytes != nil && !validInput(*u.InputBytes) {
		return &Error{CodeBadRequest, fmt.Sprintf("input_bytes must be %d-%d", MinInputBytes, MaxInputBytes)}
	}
	if u.MaxTokens != nil && !validTokens(*u.MaxTokens) {
		return &Error{CodeBadRequest, fmt.Sprintf("max_tokens must be %d-%d", MinMaxTokens, MaxMaxTokens)}
	}
	if e := u.ReasoningEffort; e != nil && *e != "" {
		if !ai.ValidEffort(*e) {
			return &Error{CodeBadRequest, fmt.Sprintf("reasoning_effort %q is not an effort", *e)}
		}
		if r := s.reasoning(ctx); !r.Allows(*e) {
			return &Error{CodeBadRequest, fmt.Sprintf("this model does not take the reasoning effort %q", *e)}
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

func (s *Service) change(ctx context.Context, u Update) (<-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.set
	if u.InputBytes != nil {
		next.InputBytes = *u.InputBytes
	}
	if u.MaxTokens != nil {
		next.MaxTokens = *u.MaxTokens
	}
	if u.ReasoningEffort != nil {
		next.ReasoningEffort = *u.ReasoningEffort
	}
	if enabled := u.Enabled; enabled != nil {
		if e := s.opts.EnvEnabled; e != nil {
			if *enabled != *e {
				return nil, &Error{CodeEnvLocked, "LLM handoffs are switched by the bridge environment (HERDR_WORLD_HANDOFF_LLM_ENABLED)"}
			}
		} else {
			// Switching on (or on again, once untested) binds the switch to
			// the config as it will be, which a test must cover.
			if *enabled && (!s.set.Enabled || s.set.Bound != s.keyOf(next)) {
				if s.llmState() != ai.StateReady {
					return nil, &Error{CodeIncomplete, "LLM handoffs need the LLM to be ready"}
				}
				if !s.testedLocked(next) {
					return nil, &Error{CodeTestRequired, "run the LLM handoffs test first: it must pass with the LLM and the limits in use"}
				}
				next.Bound = s.keyOf(next)
			}
			if !*enabled {
				next.Bound = ""
			}
			next.Enabled = *enabled
		}
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SaveHandoffLLMSettings(ctx, next); err != nil {
			return nil, fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.set = next
	if s.viewLocked().State == StateReady || s.call == nil {
		return nil, nil
	}
	s.call.cancel()
	return s.call.done, nil
}

// Refresh reads the model's reasoning from its catalog unless that was done
// lately: the next View carries it.
func (s *Service) Refresh(ctx context.Context) {
	if s.llmState() == ai.StateReady {
		s.reasoning(ctx)
	}
}

// Result is one call's outcome: the document (validated), and for the audit
// the sizes, the config it ran with and the sanitized diagnostics.
type Result struct {
	Doc          string
	Sent, Answer int
	Diag         *ai.Diagnostics
	Effort       string
	MaxTokens    int
	// Fingerprint is the LLM config the call was made with.
	Fingerprint string
	Elapsed     time.Duration
}

// Generate makes the one call of a handoff with the prompt's messages and
// validates the answer. Unless the feature is ready it makes no call
// (&Error{CodeUnavailable}); ErrBusy while another call is out; switched off
// while it is out, it is cancelled (CodeUnavailable). An answer that is not
// a handoff is &Error{CodeInvalid} (it never says what the answer was).
func (s *Service) Generate(ctx context.Context, msgs []ai.Message) (Result, error) {
	select {
	case s.busy <- struct{}{}:
	default:
		return Result{}, ErrBusy
	}
	defer func() { <-s.busy }()
	return s.ask(ctx, msgs, true)
}

func (s *Service) request(ctx context.Context, msgs []ai.Message) ai.Request {
	s.mu.Lock()
	effort, tokens := s.set.ReasoningEffort, s.set.MaxTokens
	s.mu.Unlock()
	if effort != "" {
		effort = sentEffort(effort, s.reasoning(ctx))
	}
	return ai.Request{Messages: msgs, MaxTokens: tokens, BudgetWins: true, ReasoningEffort: effort, NoPartial: true,
		Timeout: Timeout, NoUncertainRetry: true, RedactKey: true}
}

// ask runs one call; gated: only while the feature is ready (a test runs
// while it is not, and is not cancelled by the switch).
func (s *Service) ask(ctx context.Context, msgs []ai.Message, gated bool) (Result, error) {
	req := s.request(ctx, msgs)
	res := Result{Effort: req.ReasoningEffort, MaxTokens: req.MaxTokens}
	for _, m := range msgs {
		res.Sent += len(m.Content)
	}
	req.Report = func(d ai.Diagnostics) { res.Diag = &d }
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := &call{cancel: cancel, done: make(chan struct{})}
	defer close(c.done)
	s.mu.Lock()
	if v := s.viewLocked(); gated && v.State != StateReady {
		s.mu.Unlock()
		return res, &Error{CodeUnavailable, unreadyWhy(v)}
	}
	res.Fingerprint = s.Fingerprint()
	if gated {
		s.call = c
	}
	s.mu.Unlock()
	start := s.opts.Now()
	out, err := s.opts.Roles.LLM().Complete(cctx, req)
	res.Elapsed = s.opts.Now().Sub(start)
	res.Answer = len(out)
	s.mu.Lock()
	if s.call == c {
		s.call = nil
	}
	s.mu.Unlock()
	if err != nil {
		if cctx.Err() != nil && ctx.Err() == nil {
			return res, &Error{CodeUnavailable, "LLM handoffs were switched off while the handoff was being written"}
		}
		return res, err
	}
	doc, err := Validate(out, outputCap(req.MaxTokens))
	if err != nil {
		return res, &Error{CodeInvalid, strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": ")}
	}
	if d := res.Diag; d != nil && d.CompletionTokens != nil && *d.CompletionTokens > req.MaxTokens {
		return res, &Error{CodeInvalid, fmt.Sprintf("the answer used %d tokens, above the budget of %d", *d.CompletionTokens, req.MaxTokens)}
	}
	res.Doc = doc
	return res, nil
}

// outputCap bounds an answer's bytes by its token budget (a token is rarely
// more than 8 bytes of Markdown), within MaxBody.
func outputCap(tokens int) int {
	return min(MaxBody, tokens*8)
}

// Reason is a failure as a short code, for the job state and the audit: the
// feature's code, the AI error's kind, "busy", "failed" for anything else.
func Reason(err error) string {
	var fe *Error
	switch {
	case errors.As(err, &fe):
		return fe.Code
	case ai.KindOf(err) != "":
		return string(ai.KindOf(err))
	case errors.Is(err, ErrBusy):
		return "busy"
	case errors.Is(err, ErrTooLarge):
		return "too_large"
	case errors.Is(err, ErrChanged):
		return "source_changed"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return string(ai.KindTimeout)
	}
	return "failed"
}

// TestResult is handoff_llm.test's answer. A test whose answer was not a
// handoff has OK false and Reason; a call that failed is an error.
type TestResult struct {
	OK        bool            `json:"ok"`
	Reason    string          `json:"reason,omitempty"`
	Title     string          `json:"title,omitempty"`
	Bytes     int             `json:"bytes"`
	LatencyMS int64           `json:"latency_ms"`
	Diag      *ai.Diagnostics `json:"diag,omitempty"`
}

// Test writes a handoff of a short synthetic session (SampleFacts,
// SamplePayload: never a real transcript) with the LLM, effort and budget
// in use, one call at a time (it waits for a handoff that is out). A pass
// allows switching on for 30 minutes while they stay the same; it also
// binds a switch that is on to them again.
func (s *Service) Test(ctx context.Context) (*TestResult, error) {
	if s.llmState() != ai.StateReady {
		return nil, &Error{CodeIncomplete, "the LLM handoffs test needs the LLM to be ready"}
	}
	select {
	case s.busy <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.busy }()
	s.mu.Lock()
	key := s.keyLocked()
	s.mu.Unlock()
	p, err := Build(SampleFacts(s.opts.Now()), SamplePayload(), "")
	if err != nil {
		return nil, err
	}
	res, err := s.ask(ctx, p.Messages, false)
	out := &TestResult{Bytes: res.Answer, LatencyMS: res.Elapsed.Milliseconds(), Diag: res.Diag}
	var fe *Error
	switch {
	case errors.As(err, &fe) && fe.Code == CodeInvalid:
		out.Reason = "the LLM's handoff was not of the agreed shape: " + fe.Msg
		return out, nil
	case err != nil:
		return nil, err
	}
	out.OK = true
	out.Title, _ = heading(strings.SplitN(res.Doc, "\n", 2)[0], 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.keyLocked() != key {
		out.OK, out.Reason = false, "the LLM or the limits changed while the test ran: run it again"
		return out, nil
	}
	s.passed = &passedTest{key: key, at: s.opts.Now()}
	if s.set.Enabled && s.opts.EnvEnabled == nil && s.set.Bound != key {
		next := s.set
		next.Bound = key
		if s.opts.Store == nil || s.opts.Store.SaveHandoffLLMSettings(ctx, next) == nil {
			s.set = next
		}
	}
	return out, nil
}

// SampleFacts and SamplePayload are the test's synthetic session.
func SampleFacts(now time.Time) Facts {
	return Facts{Now: now, Floor: "sample", Worker: "Sample", Harness: "claude", Model: "sample-model", Session: "sample-session",
		Candidate: "0000000000000000", Through: 1, Cwd: "/work/sample", ReportedBranch: "fix/flaky-login", GitBranch: "fix/flaky-login",
		GitKnown: true, GitStatus: []string{" M e2e/auth.spec.ts"}}
}

// SamplePayload is a reduced transcript the test sends.
func SamplePayload() Payload {
	t := "[1 user] The login test in e2e/auth.spec.ts fails about one run in five on CI. Find out why and fix it. Don't touch the session loader.\n" +
		"[2 assistant] The test clicks Login before the form is hydrated. I'll wait for the form to be ready.\n" +
		"[3 tool Edit] e2e/auth.spec.ts (applied)\n" +
		"[4 tool Bash] pnpm exec playwright test e2e/auth.spec.ts --repeat-each 20 → 20 passed\n" +
		"[5 assistant] Fixed: the test now waits for the form. 20 repeated runs passed locally; CI not run yet.\n"
	return Payload{Text: t, Bytes: len(t), EstTokens: EstimateTokens(t),
		Coverage:  Coverage{Messages: 5, Kept: 5, Compaction: "none", Complete: true},
		Artifacts: []Artifact{{Kind: "file", Ref: "e2e/auth.spec.ts", Verified: true}, {Kind: "test", Ref: "e2e/auth.spec.ts", Verified: true}}}
}
