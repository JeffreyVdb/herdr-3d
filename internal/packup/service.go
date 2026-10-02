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

// DetectTimeout bounds a whole detect, both models: past it the prompt goes
// as written.
const DetectTimeout = 1500 * time.Millisecond

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

// Store keeps the feature's settings (the bridge's database).
type Store interface {
	LoadPackupSettings(ctx context.Context) (enabled bool, threshold float64, ok bool, err error)
	SavePackupSettings(ctx context.Context, enabled bool, threshold float64) error
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
}

// passedTest is the last passing packup.test: the role configs it ran with,
// and when.
type passedTest struct {
	classifier, llm string
	at              time.Time
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
		en, th, ok, err := opts.Store.LoadPackupSettings(ctx)
		if err != nil {
			return nil, err
		}
		if ok {
			s.enabled = en
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
	Tested bool `json:"tested"`
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

func (s *Service) testedLocked() bool {
	p := s.passed
	return p != nil && s.opts.Now().Sub(p.at) <= testValidity &&
		p.classifier == s.opts.Roles.Fingerprint(ai.RoleClassifier) && p.llm == s.opts.Roles.Fingerprint(ai.RoleLLM)
}

// View is the current state.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Enabled: s.enabledLocked(), Threshold: s.threshold, Missing: s.missing(), Env: []string{},
		Roles:  RoleStates{Classifier: string(s.opts.Roles.State(ai.RoleClassifier)), LLM: string(s.opts.Roles.State(ai.RoleLLM))},
		Tested: s.testedLocked()}
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
	if threshold != nil && badThreshold(*threshold) {
		return &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	en, th := s.enabled, s.threshold
	if enabled != nil {
		if s.opts.EnvEnabled != nil {
			if *enabled != *s.opts.EnvEnabled {
				return &Error{CodeEnvLocked, "pack up on request is switched by the bridge environment (HERDR_WORLD_PACKUP_ENABLED)"}
			}
		} else if *enabled && !s.enabled {
			if m := s.missing(); len(m) > 0 {
				return &Error{CodeIncomplete, "pack up on request needs the classification model and the LLM to be ready"}
			}
			if !s.testedLocked() {
				return &Error{CodeTestRequired, "run the pack-up test first: it must pass with the models in use"}
			}
		}
		if s.opts.EnvEnabled == nil {
			en = *enabled
		}
	}
	if threshold != nil {
		th = *threshold
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SavePackupSettings(ctx, en, th); err != nil {
			return fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.enabled, s.threshold = en, th
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
	res, err := run(ctx, s.opts.Roles.Classifier(), s.opts.Roles.LLM(), prompt, s.Threshold(), s.Ready)
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
	// Task is what is left (core matches: it must be WantTask).
	Task     string `json:"task,omitempty"`
	WantTask string `json:"want_task,omitempty"`
	// Right: it came out as expected.
	Right bool   `json:"right"`
	Error string `json:"error,omitempty"` // why an extraction was no match
}

// TestResult is packup.test's answer. A test that ran but did not pass (a
// core sample on the wrong side, a task not cut as expected) has OK false
// and Reason; a call that failed is an error. Right of Total is how many
// samples came out as expected at the threshold, for choosing it.
type TestResult struct {
	OK        bool     `json:"ok"`
	Reason    string   `json:"reason,omitempty"`
	Threshold float64  `json:"threshold"`
	Samples   []Sample `json:"samples"`
	Right     int      `json:"right"`
	Total     int      `json:"total"`
	LatencyMS int64    `json:"latency_ms"`
}

// testParallel is how many samples the test classifies at once.
const testParallel = 4

// Test runs every labelled sample through the classifier, and the core
// matches through the extraction too, with the models in use and the
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
	r := s.opts.Roles
	cfp, lfp := r.Fingerprint(ai.RoleClassifier), r.Fingerprint(ai.RoleLLM)
	start := s.opts.Now()
	res := &TestResult{Threshold: th, Samples: make([]Sample, len(Samples)), Total: len(Samples)}
	errs := make([]error, len(Samples))
	var wg sync.WaitGroup
	slots := make(chan struct{}, testParallel)
	for i, smp := range Samples {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			out := Sample{Text: smp.Text, Expect: "skip", Core: smp.Core, WantTask: smp.Task}
			if smp.Match {
				out.Expect = "match"
			}
			cls := r.Classifier()
			var llm ai.LLM = noLLM{}
			if smp.Core && smp.Match {
				llm = r.LLM()
			}
			got, err := Run(ctx, cls, llm, smp.Text, th)
			if err != nil {
				errs[i] = err
				return
			}
			out.Score = got.Score
			if smp.Core {
				out.Matched, out.Task, out.Error = got.Matched, got.Task, got.ExtractErr
			}
			gated := got.Score >= th
			switch {
			case !smp.Match:
				out.Right = !gated
			case smp.Core:
				out.Right = got.Matched && sameTask(got.Task, smp.Task)
			default:
				out.Right = gated
			}
			res.Samples[i] = out
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	res.LatencyMS = s.opts.Now().Sub(start).Milliseconds()
	for _, smp := range res.Samples {
		if smp.Right {
			res.Right++
		}
		if !smp.Core || smp.Right || res.Reason != "" {
			continue
		}
		switch {
		case smp.Expect == "skip":
			res.Reason = fmt.Sprintf("%q scored %.2f, at or over the threshold %.2f", smp.Text, smp.Score, th)
		case smp.Score < th:
			res.Reason = fmt.Sprintf("%q scored %.2f, under the threshold %.2f", smp.Text, smp.Score, th)
		case !smp.Matched:
			res.Reason = fmt.Sprintf("the LLM did not cut %q: %s", smp.Text, smp.Error)
		default:
			res.Reason = fmt.Sprintf("the LLM cut %q to %q, not %q", smp.Text, smp.Task, smp.WantTask)
		}
	}
	res.OK = res.Reason == ""
	if res.OK {
		s.mu.Lock()
		s.passed = &passedTest{classifier: cfp, llm: lfp, at: s.opts.Now()}
		s.mu.Unlock()
	}
	return res, nil
}

// noLLM stands in for the LLM where the test only needs the gate: a passing
// gate's extraction fails without a call.
type noLLM struct{}

func (noLLM) Complete(context.Context, ai.Request) (string, error) {
	return "", fmt.Errorf("the test does not extract this sample")
}

// sameTask compares a cut task with the expected one, its case and a final
// full stop aside.
func sameTask(got, want string) bool {
	norm := func(s string) string { return strings.TrimRight(strings.ToLower(strings.TrimSpace(s)), ".!") }
	return norm(got) == norm(want)
}
