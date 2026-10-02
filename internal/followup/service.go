package followup

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// DefaultThreshold is the score at which a message is taken to ask something.
const DefaultThreshold = 0.7

// Bounds of the threshold.
const (
	MinThreshold = 0.05
	MaxThreshold = 0.99
)

// testValidity is how long a passing followups.test allows enabling.
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
	CodeTestRequired = "test_required" // enabling without a passing followups.test
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
	LoadFollowupSettings(ctx context.Context) (enabled bool, threshold float64, ok bool, err error)
	SaveFollowupSettings(ctx context.Context, enabled bool, threshold float64) error
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvEnabled is HERDR_WORLD_FOLLOWUPS_ENABLED (nil: not set): while set
	// it wins over the stored toggle, and the panel shows it read-only.
	EnvEnabled *bool
	Now        func() time.Time
}

// Service holds the feature's settings and runs its pipeline.
type Service struct {
	opts Options

	mu        sync.Mutex
	enabled   bool
	threshold float64
	passed    *passedTest
}

// passedTest is the last passing followups.test: the role configs it ran
// with, and when.
type passedTest struct {
	classifier, llm string
	at              time.Time
}

// New loads the settings.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, threshold: DefaultThreshold}
	if opts.Store != nil {
		en, th, ok, err := opts.Store.LoadFollowupSettings(ctx)
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

// View is the feature as clients see it (followups.get, followups.update).
type View struct {
	Enabled   bool    `json:"enabled"`
	Threshold float64 `json:"threshold"`
	State     string  `json:"state"`
	// Missing lists the roles that are not ready ("classifier", "llm").
	Missing []string   `json:"missing,omitempty"`
	Roles   RoleStates `json:"roles"`
	// Env lists the fields the bridge environment sets ("enabled").
	Env []string `json:"env"`
	// Tested: a passing followups.test covers the models in use (enabling
	// is allowed).
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

// Threshold is the score at which a message is flagged.
func (s *Service) Threshold() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.threshold
}

// Set changes the settings (nil: kept). Switching it on needs a passing
// followups.test of the models in use; the environment's toggle cannot be
// changed.
func (s *Service) Set(ctx context.Context, enabled *bool, threshold *float64) error {
	if threshold != nil && (*threshold < MinThreshold || *threshold > MaxThreshold || *threshold != *threshold) {
		return &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	en, th := s.enabled, s.threshold
	if enabled != nil {
		if s.opts.EnvEnabled != nil {
			if *enabled != *s.opts.EnvEnabled {
				return &Error{CodeEnvLocked, "follow-up questions are switched by the bridge environment (HERDR_WORLD_FOLLOWUPS_ENABLED)"}
			}
		} else if *enabled && !s.enabled {
			if m := s.missing(); len(m) > 0 {
				return &Error{CodeIncomplete, "follow-up questions need the classification model and the LLM to be ready"}
			}
			if !s.testedLocked() {
				return &Error{CodeTestRequired, "run the follow-up test first: it must pass with the models in use"}
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
		if err := s.opts.Store.SaveFollowupSettings(ctx, en, th); err != nil {
			return fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.enabled, s.threshold = en, th
	return nil
}

// Detect runs the pipeline on a message. Unless the feature is ready it
// makes no call at all (ai.ErrNotReady), and readiness is checked again
// before the extraction: switched off or a role invalid meanwhile, the
// message never goes to the LLM.
func (s *Service) Detect(ctx context.Context, text string) (*Result, error) {
	if !s.Ready() {
		return nil, ai.ErrNotReady
	}
	return run(ctx, s.opts.Roles.Classifier(), s.opts.Roles.LLM(), text, s.Threshold(), s.Ready)
}

// The test's samples: the messages of the probe (#90 "API check").
const (
	SampleQuestions = "I refactored the session loader and all tests pass.\n\n" +
		"## Open questions for you\n" +
		"- Does the legacy importer still need the v1 format?\n" +
		"- Do you want to ship this already, or wait for the e2e-live run?"
	SampleDone = "Done, PR merged. CI is green and the branch is deleted."
)

// Sample is one sample's outcome.
type Sample struct {
	Name string `json:"name"` // "questions" or "done"
	// Expect is "flag" (questions) or "skip" (done).
	Expect    string     `json:"expect"`
	Score     float64    `json:"score"`
	Flagged   bool       `json:"flagged"`
	Questions []Question `json:"questions,omitempty"`
	Source    string     `json:"source,omitempty"`
	Error     string     `json:"error,omitempty"` // why the extraction fell back
}

// TestResult is followups.test's answer. A test that ran but did not pass
// (a score on the wrong side, an extraction that fell back) has OK false
// and Reason; a call that failed is an error.
type TestResult struct {
	OK        bool     `json:"ok"`
	Reason    string   `json:"reason,omitempty"`
	Threshold float64  `json:"threshold"`
	Samples   []Sample `json:"samples"`
	LatencyMS int64    `json:"latency_ms"`
}

// Test runs both samples through the whole pipeline with the models in use
// and the threshold (nil: the current one). A pass allows switching the
// feature on for 30 minutes, while the models stay the same.
func (s *Service) Test(ctx context.Context, threshold *float64) (*TestResult, error) {
	th := s.Threshold()
	if threshold != nil {
		if *threshold < MinThreshold || *threshold > MaxThreshold || *threshold != *threshold {
			return nil, &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
		}
		th = *threshold
	}
	s.mu.Lock()
	m := s.missing()
	s.mu.Unlock()
	if len(m) > 0 {
		return nil, &Error{CodeIncomplete, "the follow-up test needs the classification model and the LLM to be ready"}
	}
	r := s.opts.Roles
	cfp, lfp := r.Fingerprint(ai.RoleClassifier), r.Fingerprint(ai.RoleLLM)
	start := s.opts.Now()
	res := &TestResult{Threshold: th}
	for _, smp := range []struct{ name, expect, text string }{
		{"questions", "flag", SampleQuestions},
		{"done", "skip", SampleDone},
	} {
		out, err := Run(ctx, r.Classifier(), r.LLM(), smp.text, th)
		if err != nil {
			return nil, err
		}
		res.Samples = append(res.Samples, Sample{Name: smp.name, Expect: smp.expect, Score: out.Score, Flagged: out.Flag,
			Questions: out.Questions, Source: out.Source, Error: out.ExtractErr})
	}
	res.LatencyMS = s.opts.Now().Sub(start).Milliseconds()
	q, d := res.Samples[0], res.Samples[1]
	switch {
	case !q.Flagged:
		res.Reason = fmt.Sprintf("the message with questions scored %.2f, under the threshold %.2f", q.Score, th)
	case d.Flagged:
		res.Reason = fmt.Sprintf("the message without questions scored %.2f, at or over the threshold %.2f", d.Score, th)
	case q.Source != SourceModel:
		res.Reason = "the LLM did not extract the questions: " + q.Error
	default:
		res.OK = true
	}
	if res.OK {
		s.mu.Lock()
		s.passed = &passedTest{classifier: cfp, llm: lfp, at: s.opts.Now()}
		s.mu.Unlock()
	}
	return res, nil
}
