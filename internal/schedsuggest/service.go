package schedsuggest

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// DefaultThreshold is the score at which a message is taken to defer a step.
const DefaultThreshold = 0.7

// Bounds of the threshold (the follow-up questions' own).
const (
	MinThreshold = 0.05
	MaxThreshold = 0.99
)

// States of the feature (View.State).
const (
	StateOff        = "off"        // switched off
	StateIncomplete = "incomplete" // on, but a role is not ready: nothing runs
	StateReady      = "ready"      // on, both roles ready: the pipeline runs
)

// Error codes (Error.Code), the protocol's too.
const (
	CodeIncomplete = "incomplete" // a role the feature needs is not ready
	CodeEnvLocked  = "env_locked" // the bridge environment sets enabled
	CodeBadRequest = "bad_request"
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
	Classifier() ai.Classifier
	LLM() ai.LLM
}

// Reasoner is what the AI integration knows of the LLM's reasoning efforts
// (*ai.Service); Roles may implement it.
type Reasoner interface {
	ModelReasoning(ctx context.Context) ai.Reasoning
}

// Store keeps the feature's settings (the bridge's database): the toggle,
// the threshold and the user's time zone ("": not known).
type Store interface {
	LoadScheduleSuggestSettings(ctx context.Context) (enabled bool, threshold float64, zone string, ok bool, err error)
	SaveScheduleSuggestSettings(ctx context.Context, enabled bool, threshold float64, zone string) error
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvEnabled is HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED (nil: not set):
	// while set it wins over the stored toggle, and the panel shows it
	// read-only.
	EnvEnabled *bool
	Now        func() time.Time
}

// Service holds the feature's settings and runs its pipeline.
type Service struct {
	opts Options

	mu        sync.Mutex
	enabled   bool
	threshold float64
	zone      string
}

// New loads the settings.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, threshold: DefaultThreshold}
	if opts.Store != nil {
		en, th, zone, ok, err := opts.Store.LoadScheduleSuggestSettings(ctx)
		if err != nil {
			return nil, err
		}
		if ok {
			s.enabled = en
			if th >= MinThreshold && th <= MaxThreshold {
				s.threshold = th
			}
			if _, err := LoadZone(zone); err == nil {
				s.zone = zone
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

// View is the feature as clients see it (schedule_suggestions.get,
// schedule_suggestions.set, World.ScheduleSuggestions).
type View struct {
	Enabled   bool    `json:"enabled"`
	Threshold float64 `json:"threshold"`
	State     string  `json:"state"`
	// Missing lists the roles that are not ready ("classifier", "llm").
	Missing []string   `json:"missing,omitempty"`
	Roles   RoleStates `json:"roles"`
	// Env lists the fields the bridge environment sets ("enabled").
	Env []string `json:"env"`
	// Zone is the user's time zone the extraction reads clock times in ("":
	// not known, UTC), as a client last sent it (schedule_suggestions.zone).
	Zone string `json:"zone,omitempty"`
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

// View is the current state.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Enabled: s.enabledLocked(), Threshold: s.threshold, Missing: s.missing(), Env: []string{}, Zone: s.zone,
		Roles: RoleStates{Classifier: string(s.opts.Roles.State(ai.RoleClassifier)), LLM: string(s.opts.Roles.State(ai.RoleLLM))}}
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

// Zone is the user's time zone ("": not known).
func (s *Service) Zone() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.zone
}

// Set changes the settings (nil: kept). Switching it on needs both roles
// ready (no test: the follow-up questions' test gate is theirs); the
// environment's toggle cannot be changed.
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
				return &Error{CodeEnvLocked, "schedule suggestions are switched by the bridge environment (HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED)"}
			}
		} else if *enabled && !s.enabled {
			if m := s.missing(); len(m) > 0 {
				return &Error{CodeIncomplete, "schedule suggestions need the classification model and the LLM to be ready"}
			}
		}
		if s.opts.EnvEnabled == nil {
			en = *enabled
		}
	}
	if threshold != nil {
		th = *threshold
	}
	if err := s.save(ctx, en, th, s.zone); err != nil {
		return err
	}
	s.enabled, s.threshold = en, th
	return nil
}

// SetZone stores the user's time zone (an IANA name, LoadZone): the last
// client to send one wins. It reports whether it changed.
func (s *Service) SetZone(ctx context.Context, zone string) (bool, error) {
	if _, err := LoadZone(zone); err != nil {
		return false, &Error{CodeBadRequest, err.Error()}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if zone == s.zone {
		return false, nil
	}
	if err := s.save(ctx, s.enabled, s.threshold, zone); err != nil {
		return false, err
	}
	s.zone = zone
	return true, nil
}

func (s *Service) save(ctx context.Context, enabled bool, threshold float64, zone string) error {
	if s.opts.Store == nil {
		return nil
	}
	if err := s.opts.Store.SaveScheduleSuggestSettings(ctx, enabled, threshold, zone); err != nil {
		return fmt.Errorf("the settings could not be saved: %w", err)
	}
	return nil
}

// Detect runs the pipeline on a message: the classifier alone on
// GateQuestion, then (flagged) the extraction. Unless the feature is ready it
// makes no call at all (ai.ErrNotReady), and readiness is checked again
// before the extraction.
func (s *Service) Detect(ctx context.Context, text string) (*Result, error) {
	if !s.Ready() {
		return nil, ai.ErrNotReady
	}
	return run(ctx, s.opts.Roles.Classifier(), s.opts.Roles.LLM(), text, s.Threshold(), s.Ready, s.opts.Now, s.Zone(), s.reasoning(ctx))
}

// Scored is Detect for a score the caller already has (one ClassifyMany for
// this feature's and the follow-up questions' gates): below the threshold no
// call, else the extraction, while the feature is ready.
func (s *Service) Scored(ctx context.Context, text string, score float64) (*Result, error) {
	res := &Result{Score: score}
	if score < s.Threshold() {
		return res, nil
	}
	if !s.Ready() {
		return nil, ai.ErrNotReady
	}
	res.Flag = true
	res.Extraction = Extract(ctx, s.opts.Roles.LLM(), text, s.opts.Now, s.Zone(), s.reasoning(ctx))
	return res, nil
}

// reasoning is what is known of the LLM's reasoning efforts (unknown when the
// roles do not say: none is sent).
func (s *Service) reasoning(ctx context.Context) ai.Reasoning {
	if rs, ok := s.opts.Roles.(Reasoner); ok {
		return rs.ModelReasoning(ctx)
	}
	return ai.UnknownReasoning()
}
