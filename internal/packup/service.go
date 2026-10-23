package packup

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// DefaultThreshold is the score at which a prompt is taken to ask the worker
// to leave. High on purpose: a false positive costs a dismiss of the confirm
// dialog, a false negative is the behaviour without the feature. The live
// calibration against real models (the samples below) may move it.
const DefaultThreshold = 0.85

// Bounds of the threshold.
const (
	MinThreshold = 0.05
	MaxThreshold = 0.99
)

// DetectTimeout bounds a detect on the bridge, both models: past it the
// prompt goes as written. The game's own bound is 1.5 s from Send (it drops
// a later answer); this leaves the answer 0.3 s to reach it.
const DetectTimeout = 1200 * time.Millisecond

// testValidity is how long a passing packup.test allows enabling.
const testValidity = 30 * time.Minute

// States of the feature (View.State).
const (
	StateOff        = "off"        // switched off
	StateIncomplete = "incomplete" // on, but a role is not ready: nothing runs
	StateReady      = "ready"      // on, both roles ready: the pipeline runs
)

// Error codes (Error.Code), the protocol's too.
const (
	CodeIncomplete   = "incomplete"    // a role the feature needs is not ready
	CodeTestRequired = "test_required" // enabling without a passing packup.test
	CodeEnvLocked    = "env_locked"    // the bridge environment sets enabled
	CodeBadRequest   = "bad_request"
)

// Error is an error of the settings commands.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// Roles is what the feature needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	// Fingerprint identifies a role's config in use (a passing test covers
	// exactly the configs it ran with).
	Fingerprint(r ai.Role) string
	Classifier() ai.Classifier
	LLM() ai.LLM
}

// Settings are persisted together so a saved extraction policy survives restart.
type Settings struct {
	Enabled   bool
	Threshold float64
	Params
}

// Reasoner is the existing AI capability catalog, optional for test doubles.
type Reasoner interface {
	ModelReasoning(context.Context) ai.Reasoning
	KnownReasoning() ai.Reasoning
}

// Store keeps the feature's settings (the bridge's database).
type Store interface {
	LoadPackupSettings(ctx context.Context) (Settings, bool, error)
	SavePackupSettings(ctx context.Context, settings Settings) error
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvEnabled is HERDR_WORLD_PACKUP_ENABLED (nil: not set): while set it
	// wins over the stored toggle, and the panel shows it read-only.
	EnvEnabled *bool
	// Timeout bounds Detect (default DetectTimeout).
	Timeout time.Duration
	Now     func() time.Time
}

// Service holds the feature's settings and runs its pipeline.
type Service struct {
	opts Options

	mu        sync.Mutex
	enabled   bool
	threshold float64
	passed    *passedTest
	params    Params
}

// passedTest is the last passing packup.test: the role configs it ran with,
// and when.
type passedTest struct {
	classifier, llm string
	at              time.Time
	params          Params
	threshold       float64
}

// New loads the settings.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DetectTimeout
	}
	s := &Service{opts: opts, threshold: DefaultThreshold}
	if opts.Store != nil {
		saved, ok, err := opts.Store.LoadPackupSettings(ctx)
		en, th := saved.Enabled, saved.Threshold
		if err != nil {
			return nil, err
		}
		if ok {
			s.enabled = en
			s.params = saved.Params
			if th >= MinThreshold && th <= MaxThreshold {
				s.threshold = th
			}
		}
	}
	return s, nil
}

// RoleStates are both roles' states, for the status line.
type RoleStates struct {
	Classifier string `json:"classifier"`
	LLM        string `json:"llm"`
}

// View is the feature as clients see it (packup.get, packup.update).
type View struct {
	Enabled   bool    `json:"enabled"`
	Threshold float64 `json:"threshold"`
	State     string  `json:"state"`
	// Missing lists the roles that are not ready ("classifier", "llm").
	Missing []string   `json:"missing,omitempty"`
	Roles   RoleStates `json:"roles"`
	// Env lists the fields the bridge environment sets ("enabled").
	Env []string `json:"env"`
	// Tested: a passing packup.test covers the models in use (enabling is
	// allowed).
	Tested          bool         `json:"tested"`
	ReasoningEffort string       `json:"reasoning_effort"`
	MaxTokens       int          `json:"max_tokens"`
	Reasoning       ai.Reasoning `json:"reasoning"`
	EffortStale     bool         `json:"effort_stale"`
	TimeoutMS       int64        `json:"timeout_ms"`
}

func (s *Service) enabledLocked() bool {
	if e := s.opts.EnvEnabled; e != nil {
		return *e
	}
	return s.enabled
}

func (s *Service) missing() []string {
	var m []string
	if s.opts.Roles.State(ai.RoleClassifier) != ai.StateReady {
		m = append(m, string(ai.RoleClassifier))
	}
	if s.opts.Roles.State(ai.RoleLLM) != ai.StateReady {
		m = append(m, string(ai.RoleLLM))
	}
	return m
}

func (s *Service) testedLocked() bool { return s.passedForLocked(s.policyLocked(), s.threshold) }

func (s *Service) passedForLocked(params Params, threshold float64) bool {
	p := s.passed
	return p != nil && s.opts.Now().Sub(p.at) <= testValidity &&
		p.params == params && p.threshold == threshold && !s.staleLocked() &&
		p.classifier == s.opts.Roles.Fingerprint(ai.RoleClassifier) && p.llm == s.opts.Roles.Fingerprint(ai.RoleLLM)
}

// View is the current state.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Enabled: s.enabledLocked(), Threshold: s.threshold, Missing: s.missing(), Env: []string{},
		Roles:  RoleStates{Classifier: string(s.opts.Roles.State(ai.RoleClassifier)), LLM: string(s.opts.Roles.State(ai.RoleLLM))},
		Tested: s.testedLocked(), ReasoningEffort: s.params.ReasoningEffort, MaxTokens: s.params.tokens(),
		Reasoning: s.known(), EffortStale: s.staleLocked(), TimeoutMS: s.opts.Timeout.Milliseconds()}
	if s.opts.EnvEnabled != nil {
		v.Env = append(v.Env, "enabled")
	}
	switch {
	case !v.Enabled:
		v.State = StateOff
	case len(v.Missing) > 0 || v.EffortStale:
		v.State = StateIncomplete
	default:
		v.State = StateReady
	}
	return v
}

// Ready reports whether the pipeline runs: switched on, both roles ready.
func (s *Service) Ready() bool { return s.View().State == StateReady }

// Threshold is the score at which a prompt is a match.
func (s *Service) Threshold() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.threshold
}

func badThreshold(th float64) bool { return th < MinThreshold || th > MaxThreshold || th != th }

// Set changes the settings (nil: kept). Switching it on needs a passing
// packup.test of the models in use; the environment's toggle cannot be
// changed.
func (s *Service) Set(ctx context.Context, enabled *bool, threshold *float64) error {
	return s.Apply(ctx, Update{Enabled: enabled, Threshold: threshold})
}

// Update changes only fields supplied by the client.
type Update struct {
	Enabled         *bool    `json:"enabled,omitempty"`
	Threshold       *float64 `json:"threshold,omitempty"`
	ReasoningEffort *string  `json:"reasoning_effort,omitempty"`
	MaxTokens       *int     `json:"max_tokens,omitempty"`
}

func (s *Service) known() ai.Reasoning {
	if r, ok := s.opts.Roles.(Reasoner); ok {
		return r.KnownReasoning()
	}
	return ai.UnknownReasoning()
}
func (s *Service) Refresh(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	if r, ok := s.opts.Roles.(Reasoner); ok && s.opts.Roles.State(ai.RoleLLM) == ai.StateReady {
		r.ModelReasoning(ctx)
	}
}
func (s *Service) staleLocked() bool {
	return s.params.ReasoningEffort != "" && !s.known().Allows(s.params.ReasoningEffort)
}
func (s *Service) policyLocked() Params {
	return Params{ReasoningEffort: s.params.ReasoningEffort, MaxTokens: s.params.tokens()}
}

// Apply saves an explicitly selected policy; unsupported saved choices pause detection, never downgrade it.
func (s *Service) Apply(ctx context.Context, u Update) error {
	enabled, threshold := u.Enabled, u.Threshold
	if u.MaxTokens != nil && (*u.MaxTokens < MinMaxTokens || *u.MaxTokens > MaxMaxTokens) {
		return &Error{CodeBadRequest, "max_tokens must be 64-16384"}
	}
	if u.ReasoningEffort != nil && *u.ReasoningEffort != "" {
		s.Refresh(ctx)
		if !s.known().Allows(*u.ReasoningEffort) {
			return &Error{CodeBadRequest, "this model does not support that reasoning effort; choose a listed effort or Provider default"}
		}
	}
	if threshold != nil && badThreshold(*threshold) {
		return &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	en, th := s.enabled, s.threshold
	next := s.policyLocked()
	if u.ReasoningEffort != nil {
		next.ReasoningEffort = *u.ReasoningEffort
	}
	if u.MaxTokens != nil {
		next.MaxTokens = *u.MaxTokens
	}
	if threshold != nil {
		th = *threshold
	}
	if enabled != nil {
		if s.opts.EnvEnabled != nil {
			if *enabled != *s.opts.EnvEnabled {
				return &Error{CodeEnvLocked, "pack up on request is switched by the bridge environment (HERDR_WORLD_PACKUP_ENABLED)"}
			}
		} else if *enabled && !s.enabled {
			if m := s.missing(); len(m) > 0 {
				return &Error{CodeIncomplete, "pack up on request needs the classification model and the LLM to be ready"}
			}
			if !s.passedForLocked(next, th) {
				return &Error{CodeTestRequired, "run the pack-up test first: it must pass with the models in use"}
			}
		}
		if s.opts.EnvEnabled == nil {
			en = *enabled
		}
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SavePackupSettings(ctx, Settings{Enabled: en, Threshold: th, Params: next}); err != nil {
			return fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.enabled, s.threshold, s.params = en, th, next
	return nil
}

// Detect runs the pipeline on a prompt, within the Timeout. Unless the
// feature is ready it makes no call at all (ai.ErrNotReady), and readiness
// is checked again before the extraction: switched off or a role invalid
// meanwhile, the prompt never goes to the LLM. Any error means the prompt
// goes as written.
func (s *Service) Detect(ctx context.Context, prompt string) (*Result, error) {
	if !s.Ready() {
		return nil, ai.ErrNotReady
	}
	ctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	s.Refresh(ctx)
	if !s.Ready() {
		return nil, ai.ErrNotReady
	}
	s.mu.Lock()
	p, th := s.policyLocked(), s.threshold
	s.mu.Unlock()
	res, err := run(ctx, s.opts.Roles.Classifier(), s.opts.Roles.LLM(), prompt, th, s.Ready, p, false)
	if err == nil && ctx.Err() != nil {
		// The LLM's answer came, but too late to wait on: no match.
		err = &ai.Error{Kind: ai.KindTimeout, Msg: "pack-up detection timed out"}
	}
	if err != nil {
		return nil, err
	}
	return res, nil
}

// Sample is one result of the test.
type Sample struct {
	Text string `json:"text"`
	// Expect is "match" (it asks the worker to leave) or "skip".
	Expect string `json:"expect"`
	// Core: one of the four the test must get right (the ticket's examples).
	Core    bool    `json:"core,omitempty"`
	Score   float64 `json:"score"`
	Matched bool    `json:"matched"`
	// Task is what is left; extraction samples must preserve WantTask.
	Task     string `json:"task,omitempty"`
	WantTask string `json:"want_task,omitempty"`
	// Right: it came out as expected.
	Right            bool            `json:"right"`
	Error            string          `json:"error,omitempty"`
	Code             string          `json:"code,omitempty"`
	Stage            string          `json:"stage,omitempty"`
	ExtractionTested bool            `json:"extraction_tested"`
	ClassifierMS     int64           `json:"classifier_ms"`
	ExtractionMS     int64           `json:"extraction_ms"`
	Diag             *ai.Diagnostics `json:"diag,omitempty"`
}

// TestResult is packup.test's answer. A test that ran but did not pass (a
// core sample on the wrong side, a task not cut as expected) has OK false
// and Reason. Per-sample call failures are reported by stage; cancellation
// of the whole test is an error. GateRight calibrates the classifier independently
// of Verified extractions. Right counts each sample against its own expectation.
type TestResult struct {
	OK              bool     `json:"ok"`
	Reason          string   `json:"reason,omitempty"`
	Threshold       float64  `json:"threshold"`
	Samples         []Sample `json:"samples"`
	Right           int      `json:"right"`
	Total           int      `json:"total"`
	LatencyMS       int64    `json:"latency_ms"`
	Model           string   `json:"model,omitempty"`
	ReasoningEffort string   `json:"reasoning_effort"`
	MaxTokens       int      `json:"max_tokens"`
	TimeoutMS       int64    `json:"timeout_ms"`
	Extractions     int      `json:"extractions"`
	Verified        int      `json:"verified"`
	GateRight       int      `json:"gate_right"`
}

// testParallel is how many samples the test classifies at once.
const testParallel = 4

// Test runs every labelled sample through the classifier and positives with
// expected tasks through extraction, with the saved request policy and the
// threshold (nil: the current one). It passes when every core sample comes
// out as expected (the others are reported, for the threshold). A pass
// allows switching the feature on for 30 minutes, while the models stay the
// same.
func (s *Service) Test(ctx context.Context, threshold *float64) (*TestResult, error) {
	th := s.Threshold()
	if threshold != nil {
		if badThreshold(*threshold) {
			return nil, &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
		}
		th = *threshold
	}
	s.mu.Lock()
	m := s.missing()
	s.mu.Unlock()
	if len(m) > 0 {
		return nil, &Error{CodeIncomplete, "the pack-up test needs the classification model and the LLM to be ready"}
	}
	s.Refresh(ctx)
	s.mu.Lock()
	p := s.policyLocked()
	stale := s.staleLocked()
	// A failed retest revokes an earlier pass, including one for these same settings.
	s.passed = nil
	s.mu.Unlock()
	if stale {
		return nil, &Error{CodeBadRequest, "the saved reasoning effort is unsupported by this model; choose another or Provider default"}
	}
	r := s.opts.Roles
	cfp, lfp := r.Fingerprint(ai.RoleClassifier), r.Fingerprint(ai.RoleLLM)
	start := time.Now()
	res := &TestResult{Threshold: th, Samples: make([]Sample, len(Samples)), Total: len(Samples),
		Model: s.known().Model, ReasoningEffort: p.ReasoningEffort, MaxTokens: p.tokens(), TimeoutMS: s.opts.Timeout.Milliseconds()}
	var wg sync.WaitGroup
	slots := make(chan struct{}, testParallel)
	for i, smp := range Samples {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			// As in Detect, the deadline includes waiting for the shared AI call slots.
			sampleCtx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
			defer cancel()
			out := Sample{Text: smp.Text, Expect: "skip", Core: smp.Core, WantTask: smp.Task}
			if smp.Match {
				out.Expect = "match"
			}
			extract := smp.Match && smp.Task != ""
			got, err := run(sampleCtx, r.Classifier(), r.LLM(), smp.Text, th, nil, p, !extract)
			if got != nil {
				out.Score, out.ClassifierMS, out.ExtractionMS = got.Score, got.ClassifierMS, got.ExtractionMS
				out.ExtractionTested, out.Diag = got.Extracted, got.Diag
				out.Matched, out.Task, out.Error, out.Code = got.Matched, got.Task, got.ExtractErr, got.ExtractCode
			}
			switch {
			case sampleCtx.Err() != nil:
				out.Stage, out.Code, out.Error = "timing", "llm_timeout", extractionError("llm_timeout")
				out.Matched, out.Task = false, ""
			case err != nil:
				out.Stage, out.Code, out.Error = "classifier", "classifier_"+string(ai.KindOf(err)), "the classifier call failed"
			case !smp.Match:
				out.Right = out.Score < th
				if !out.Right {
					out.Stage = "score"
					out.Error = "the classifier score is at or over the threshold"
				}
			case out.Score < th:
				out.Stage, out.Error = "score", "the classifier score is under the threshold"
			case extract:
				out.Right = out.Matched && sameTask(out.Task, smp.Task)
				if !out.Right {
					out.Stage = "extraction"
					if out.Error == "" {
						out.Error = "the remaining task differs from the expected task"
					}
				}
			default:
				out.Right = true
			}
			res.Samples[i] = out
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	res.LatencyMS = time.Since(start).Milliseconds()
	for _, smp := range res.Samples {
		if smp.Right {
			res.Right++
		}
		if (smp.Score >= th) == (smp.Expect == "match") && smp.Stage != "classifier" && !(smp.Stage == "timing" && !smp.ExtractionTested) {
			res.GateRight++
		}
		if smp.ExtractionTested {
			res.Extractions++
			if smp.Right {
				res.Verified++
			}
		}
		if !smp.Core || smp.Right || res.Reason != "" {
			continue
		}
		res.Reason = fmt.Sprintf("core sample failed at %s: %s", smp.Stage, smp.Error)
	}
	res.OK = res.Reason == ""
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfp != r.Fingerprint(ai.RoleClassifier) || lfp != r.Fingerprint(ai.RoleLLM) || p != s.policyLocked() || s.staleLocked() {
		res.OK, res.Reason = false, "settings changed during the test; run it again"
	}
	if res.OK {
		s.passed = &passedTest{classifier: cfp, llm: lfp, at: s.opts.Now(), params: p, threshold: th}
	}
	return res, nil
}

// sameTask compares a cut task with the expected one, its case and a final
// full stop aside.
func sameTask(got, want string) bool {
	norm := func(s string) string { return strings.TrimRight(strings.ToLower(strings.TrimSpace(s)), ".!") }
	return norm(got) == norm(want)
}
