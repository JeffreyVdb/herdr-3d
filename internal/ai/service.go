package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Defaults of the shared bounds.
const (
	DefaultClassifierTimeout = 3 * time.Second
	DefaultLLMTimeout        = 15 * time.Second
	// DefaultListTimeout bounds a model-list load. A test is bounded by its
	// role's request timeout.
	DefaultListTimeout = 15 * time.Second
	// DefaultConcurrency is the global limit of calls in flight, over every
	// feature and both roles.
	DefaultConcurrency = 2
	// testValidity is how long a passing test allows its config to be saved.
	testValidity = 30 * time.Minute
)

// Overrides are the settings the bridge's environment fixes (the headless
// setup): while set they win over the stored ones and the panel shows them
// read-only. The keys are files, so a key never sits in the environment.
type Overrides struct {
	ClassifierKeyFile string
	ClassifierModel   string
	LLMBaseURL        string
	LLMKeyFile        string
	LLMModel          string
}

// Options configure a Service.
type Options struct {
	// File is the 0600 file of the settings and keys ("": kept in memory only).
	File string
	Env  Overrides
	// HTTP is the client every call goes through (default: no redirects, a
	// pooled transport). Tests pass the fake servers' client.
	HTTP *http.Client
	// ClassifierURL is Jev's API (default DefaultClassifierURL).
	ClassifierURL string
	// Timeouts of one attempt (defaults above) and the concurrency limit.
	ClassifierTimeout, LLMTimeout, ListTimeout time.Duration
	MaxConcurrent                              int
	Now                                        func() time.Time
}

// Service holds both roles' configuration and state, and hands features the
// Classifier and the LLM.
type Service struct {
	opts   Options
	hc     *http.Client
	file   fileStore
	jev    jev
	openAI openAI
	slots  chan struct{}
	change chan struct{}

	mu      sync.Mutex
	stored  Stored
	invalid map[Role]*LastError
	last    *LastError
	passed  map[Role]passedTest
	reason  map[string]reasonEntry // #174: the LLM's models' reasoning, by base URL and model
}

// passedTest is the last passing test of a role: what it tested (the
// fingerprints of the whole config, key included, as submitted and, for an
// LLM whose base URL was resolved, as resolved) and what it learned.
type passedTest struct {
	fps      []string
	at       time.Time
	baseURL  string // the LLM's base URL as resolved (/v1 added)
	jsonMode *bool
}

// New opens the settings file and returns the service. A malformed file is
// an error, never overwritten.
func New(opts Options) (*Service, error) {
	if opts.ClassifierTimeout <= 0 {
		opts.ClassifierTimeout = DefaultClassifierTimeout
	}
	if opts.LLMTimeout <= 0 {
		opts.LLMTimeout = DefaultLLMTimeout
	}
	if opts.ListTimeout <= 0 {
		opts.ListTimeout = DefaultListTimeout
	}
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = DefaultConcurrency
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ClassifierURL == "" {
		opts.ClassifierURL = DefaultClassifierURL
	}
	hc := opts.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport}
	}
	// Never follow a redirect: the Bearer key would go along.
	c := *hc
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	s := &Service{
		opts: opts, hc: &c, file: fileStore{opts.File},
		jev:     jev{hc: &c, base: trimSlash(opts.ClassifierURL)},
		openAI:  openAI{hc: &c},
		slots:   make(chan struct{}, opts.MaxConcurrent),
		change:  make(chan struct{}, 1),
		invalid: map[Role]*LastError{},
		passed:  map[Role]passedTest{},
		reason:  map[string]reasonEntry{},
	}
	st, err := s.file.load()
	if err != nil {
		return nil, err
	}
	s.stored = st
	return s, nil
}

// Changes signals (coalesced) that a role's state or settings changed, from
// any goroutine: the hub publishes the new View.
func (s *Service) Changes() <-chan struct{} { return s.change }

func (s *Service) notify() {
	select {
	case s.change <- struct{}{}:
	default:
	}
}

// Classifier is the classification model as features use it.
func (s *Service) Classifier() Classifier { return classifierHandle{s} }

// LLM is the language model as features use it.
func (s *Service) LLM() LLM { return llmHandle{s} }

// ---- the effective config ------------------------------------------------

// config is a role's settings as used: the environment over the stored.
type config struct {
	baseURL, model, key string
	extra               json.RawMessage
	jsonMode            *bool
}

func readKeyFile(path string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// locked lists the fields the environment sets.
func (s *Service) locked(r Role) []string {
	e := s.opts.Env
	var out []string
	add := func(name, v string) {
		if v != "" {
			out = append(out, name)
		}
	}
	switch r {
	case RoleClassifier:
		add("key", e.ClassifierKeyFile)
		add("model", e.ClassifierModel)
	case RoleLLM:
		add("base_url", e.LLMBaseURL)
		add("key", e.LLMKeyFile)
		add("model", e.LLMModel)
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func (s *Service) effectiveLocked(r Role) config {
	e := s.opts.Env
	var c config
	switch r {
	case RoleClassifier:
		if v := s.stored.Classifier; v != nil {
			c.model, c.key = v.Model, v.Key
		}
		if e.ClassifierModel != "" {
			c.model = e.ClassifierModel
		}
		if e.ClassifierKeyFile != "" {
			c.key = readKeyFile(e.ClassifierKeyFile)
		}
	case RoleLLM:
		if v := s.stored.LLM; v != nil {
			c = config{baseURL: v.BaseURL, model: v.Model, key: v.Key, extra: v.ExtraBody, jsonMode: v.JSONMode}
		}
		if e.LLMBaseURL != "" {
			c.baseURL = trimSlash(e.LLMBaseURL)
			// What a passing test resolved it to (/v1 added) is what calls use.
			if rb := s.stored.EnvBase; rb != nil && rb.From == c.baseURL {
				c.baseURL = rb.To
			}
		}
		if e.LLMModel != "" {
			c.model = e.LLMModel
		}
		if e.LLMKeyFile != "" {
			c.key = readKeyFile(e.LLMKeyFile)
		}
	}
	return c
}

func (c config) fingerprint(r Role) string {
	h := sha256.New()
	for _, part := range []string{string(r), c.baseURL, c.model, c.key, string(c.extra)} {
		fmt.Fprintf(h, "%d:%s|", len(part), part)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Service) stateLocked(r Role) State {
	c := s.effectiveLocked(r)
	var configured, complete bool
	switch r {
	case RoleClassifier:
		configured = c.model != "" || c.key != ""
		complete = c.model != "" && c.key != ""
	case RoleLLM:
		// A key is optional: Ollama and vLLM run without one.
		configured = c.baseURL != "" || c.model != "" || c.key != ""
		complete = c.baseURL != "" && c.model != ""
	}
	switch {
	case !configured:
		return StateOff
	case !complete:
		return StateIncomplete
	case s.invalid[r] != nil:
		return StateInvalid
	}
	return StateReady
}

// ---- the view ------------------------------------------------------------

// LastError is the latest failure of a role, for the panel and the toast.
type LastError struct {
	Role    Role   `json:"role"`
	Kind    Kind   `json:"kind"`
	Message string `json:"message"`
	At      int64  `json:"at"` // unix ms
	// Runtime is set when a feature's call hit it (not a test or a load).
	Runtime bool `json:"runtime,omitempty"`
}

// ClassifierView is the classifier as clients see it. It never holds the key.
type ClassifierView struct {
	State   State    `json:"state"`
	Model   string   `json:"model"`
	KeySet  bool     `json:"key_set"`
	KeyHint string   `json:"key_hint"`
	Env     []string `json:"env"` // the fields the bridge environment sets
}

// LLMView is the LLM as clients see it. It never holds the key.
type LLMView struct {
	State     State           `json:"state"`
	BaseURL   string          `json:"base_url"`
	Model     string          `json:"model"`
	KeySet    bool            `json:"key_set"`
	KeyHint   string          `json:"key_hint"`
	JSONMode  *bool           `json:"json_mode"`
	ExtraBody json.RawMessage `json:"extra_body,omitempty"`
	Env       []string        `json:"env"`
}

// View is what ai.get answers and ai.update carries.
type View struct {
	Classifier ClassifierView `json:"classifier"`
	LLM        LLMView        `json:"llm"`
	LastError  *LastError     `json:"last_error,omitempty"`
}

// KeyHint is the last four characters of a key long enough to show them.
func KeyHint(key string) string {
	if len(key) < 8 {
		return ""
	}
	return key[len(key)-4:]
}

// View is the current state of both roles.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	cc, lc := s.effectiveLocked(RoleClassifier), s.effectiveLocked(RoleLLM)
	v := View{
		Classifier: ClassifierView{State: s.stateLocked(RoleClassifier), Model: cc.model, KeySet: cc.key != "", KeyHint: KeyHint(cc.key), Env: s.locked(RoleClassifier)},
		LLM: LLMView{State: s.stateLocked(RoleLLM), BaseURL: lc.baseURL, Model: lc.model, KeySet: lc.key != "", KeyHint: KeyHint(lc.key),
			JSONMode: lc.jsonMode, ExtraBody: lc.extra, Env: s.locked(RoleLLM)},
	}
	if s.last != nil {
		l := *s.last
		v.LastError = &l
	}
	return v
}

// State is one role's state.
func (s *Service) State(r Role) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stateLocked(r)
}

// Fingerprint identifies a role's config in use (base URL, model, key and
// extra_body, hashed: it never reveals the key). A feature that gates on a
// test of its own remembers the fingerprints the test ran against.
func (s *Service) Fingerprint(r Role) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effectiveLocked(r).fingerprint(r)
}

// ---- failures ------------------------------------------------------------

// fail records that a role's config failed (a test or a call): it is invalid
// until a test passes, it is saved again or cleared. c is the config the
// failed request used: when the role has been given another one since (a new
// key tested and saved while the request was out), the failure belongs to the
// old config and the new one is left alone.
func (s *Service) fail(r Role, c config, err error, runtime bool) {
	s.mu.Lock()
	if s.effectiveLocked(r).fingerprint(r) != c.fingerprint(r) {
		s.mu.Unlock()
		return
	}
	le := &LastError{Role: r, Kind: KindOf(err), Message: err.Error(), At: s.opts.Now().UnixMilli(), Runtime: runtime}
	s.invalid[r] = le
	s.last = le
	s.mu.Unlock()
	s.notify()
}

// recover clears a role's failure.
func (s *Service) recoverLocked(r Role) {
	delete(s.invalid, r)
	if s.last != nil && s.last.Role == r {
		s.last = nil
	}
}

// ---- running calls ---------------------------------------------------------

// acquire takes one of the global slots, waiting for one or ctx.
func (s *Service) acquire(ctx context.Context) (release func(), err error) {
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ready is a role's config in use and whether the role is ready.
func (s *Service) ready(r Role) (config, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effectiveLocked(r), s.stateLocked(r) == StateReady
}

// begin checks a role is ready and takes a slot; it then checks again, since
// a call that waited may have been overtaken by a rejected key or given up
// (its ctx done while it waited: it is not sent). It returns the config to
// use.
func (s *Service) begin(ctx context.Context, r Role) (config, func(), error) {
	if _, ok := s.ready(r); !ok {
		return config{}, nil, ErrNotReady
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return config{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		release()
		return config{}, nil, err
	}
	c, ok := s.ready(r)
	if !ok {
		release()
		return config{}, nil, ErrNotReady
	}
	return c, release, nil
}

// attempts runs fn with a timeout per attempt, and once more when the first
// failed in a way worth a second try and again (nil: always) allows it.
// Never more than two.
func attempts[T any](ctx context.Context, timeout time.Duration, again func() bool, fn func(context.Context, int) (T, error)) (T, error) {
	var v T
	var err error
	for i := 0; i < 2; i++ {
		if i > 0 && again != nil && !again() {
			break
		}
		actx, cancel := context.WithTimeout(ctx, timeout)
		v, err = fn(actx, i)
		cancel()
		if err == nil || ctx.Err() != nil || !transient(err) {
			break
		}
	}
	return v, err
}

type classifierHandle struct{ s *Service }

func (h classifierHandle) Classify(ctx context.Context, state map[string]any, question string) (float64, error) {
	scores, err := h.ask(ctx, state, map[string]string{questionKey: question})
	if err != nil {
		return 0, err
	}
	return scores[questionKey], nil
}

func (h classifierHandle) ClassifyMany(ctx context.Context, state map[string]any, questions map[string]string) (map[string]float64, error) {
	if len(questions) == 0 || len(questions) > MaxQuestions {
		return nil, newErr(KindBadConfig, fmt.Sprintf("a call asks 1-%d questions", MaxQuestions))
	}
	return h.ask(ctx, state, questions)
}

// ask is one call of the classifier, Classify's and ClassifyMany's. A retry
// checks the role again and uses its config as it is then: a role no longer
// ready (its key file gone, the config cleared or rejected by another call)
// gets no second request, and the first attempt's error stands.
func (h classifierHandle) ask(ctx context.Context, state map[string]any, questions map[string]string) (map[string]float64, error) {
	s := h.s
	c, release, err := s.begin(ctx, RoleClassifier)
	if err != nil {
		return nil, err
	}
	defer release()
	again := func() bool {
		next, ok := s.ready(RoleClassifier)
		if ok {
			c = next
		}
		return ok
	}
	scores, err := attempts(ctx, s.opts.ClassifierTimeout, again, func(ctx context.Context, _ int) (map[string]float64, error) {
		return s.jev.classifyMany(ctx, c.key, c.model, state, questions)
	})
	if err != nil {
		err = s.scrubbed(err, c.key)
		if KindOf(err) == KindAuthFailed {
			s.fail(RoleClassifier, c, err, true)
		}
		return nil, err
	}
	return scores, nil
}

type llmHandle struct{ s *Service }

func (h llmHandle) Complete(ctx context.Context, req Request) (string, error) {
	s := h.s
	c, release, err := s.begin(ctx, RoleLLM)
	if err != nil {
		return "", err
	}
	defer release()
	timeout := s.opts.LLMTimeout
	if req.Timeout > 0 {
		timeout = req.Timeout
	}
	if req.RedactKey && c.key != "" {
		msgs := make([]Message, len(req.Messages))
		for i, m := range req.Messages {
			msgs[i] = Message{Role: m.Role, Content: redact(m.Content, c.key)}
		}
		req.Messages = msgs
	}
	text, err := s.complete(ctx, c, req, timeout)
	if err != nil {
		err = s.scrubbed(err, c.key)
		if KindOf(err) == KindAuthFailed {
			s.fail(RoleLLM, c, err, true)
		}
		return "", err
	}
	return text, nil
}

// scrubbed makes sure no error leaves with the key in it.
func (s *Service) scrubbed(err error, key string) error {
	var e *Error
	if errors.As(err, &e) {
		if m := Scrub(e.Msg, key); m != e.Msg {
			c := *e
			c.Msg = m
			return &c
		}
		return err
	}
	if err == context.Canceled || err == context.DeadlineExceeded {
		return err
	}
	return newErr(KindFailed, clip(Scrub(err.Error(), key), 160))
}

// complete runs a completion with the response_format fallback: an endpoint
// that rejects it with a 400 is called again without it, once, and
// remembered. That second call is the one retry a call gets. With
// req.NoUncertainRetry a first attempt the provider may have processed gets
// none (uncertain).
func (s *Service) complete(ctx context.Context, c config, req Request, timeout time.Duration) (string, error) {
	jsonMode := c.jsonMode == nil || *c.jsonMode
	sent := req.JSON && jsonMode
	fellBack := false
	var last error
	var again func() bool
	if req.NoUncertainRetry {
		again = func() bool { return !uncertain(last) }
	}
	text, err := attempts(ctx, timeout, again, func(actx context.Context, i int) (string, error) {
		t, rejected, err := s.openAI.complete(actx, c.baseURL, c.key, c.model, c.extra, req, jsonMode)
		if rejected && i == 0 {
			jsonMode, fellBack = false, true
			last = errRetryPlain
			return "", errRetryPlain
		}
		last = err
		return t, err
	})
	switch {
	case err == nil && fellBack:
		s.rememberJSONMode(false)
	case err == nil && sent && c.jsonMode == nil:
		s.rememberJSONMode(true)
	}
	return text, err
}

// errRetryPlain makes attempts run a completion again without response_format.
var errRetryPlain = newErr(KindUnreachable, "retrying without response_format")

// rememberJSONMode stores what the endpoint was seen to accept.
func (s *Service) rememberJSONMode(on bool) {
	s.mu.Lock()
	if s.stored.LLM == nil || (s.stored.LLM.JSONMode != nil && *s.stored.LLM.JSONMode == on) {
		s.mu.Unlock()
		return
	}
	next := s.stored.clone()
	next.LLM.JSONMode = &on
	err := s.file.save(next)
	if err == nil {
		s.stored = next
	}
	s.mu.Unlock()
	if err == nil {
		s.notify()
	}
}

// ---- #174: what the catalog says of the LLM's reasoning ---------------------

const (
	// reasoningTTL is how long a catalog read is trusted, reasoningRetry how
	// long before a failed one (no /models, a timeout) is tried again.
	reasoningTTL   = 30 * time.Minute
	reasoningRetry = 2 * time.Minute
)

// reasonEntry is one model's reasoning as last read.
type reasonEntry struct {
	r  Reasoning
	at time.Time
	ok bool // a read that worked
}

func reasonKey(c config) string { return c.baseURL + "\x00" + c.model }

// KnownReasoning is what is known of the LLM in use's reasoning effort, from
// the last catalog read and with no call (Support unknown until one was made).
func (s *Service) KnownReasoning() Reasoning {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.knownLocked(s.effectiveLocked(RoleLLM))
}

func (s *Service) knownLocked(c config) Reasoning {
	r := UnknownReasoning()
	if e, ok := s.reason[reasonKey(c)]; ok {
		r = e.r
	}
	r.Model = c.model
	return r
}

// ModelReasoning is the LLM in use's reasoning effort: the last catalog read
// while it is fresh, else the catalog read again ({base}/models, one call
// under one slot). A catalog that cannot be read, or has no entry of the
// model, is Support unknown (tried again after a while). It is called by a
// feature that asks for an effort, and by its settings.
func (s *Service) ModelReasoning(ctx context.Context) Reasoning {
	s.mu.Lock()
	c := s.effectiveLocked(RoleLLM)
	ready := s.stateLocked(RoleLLM) == StateReady
	e, have := s.reason[reasonKey(c)]
	ttl := reasoningRetry
	if e.ok {
		ttl = reasoningTTL
	}
	fresh := have && s.opts.Now().Sub(e.at) < ttl
	known := s.knownLocked(c)
	s.mu.Unlock()
	if fresh || !ready {
		return known
	}
	r, ok := s.readReasoning(ctx, c)
	s.mu.Lock()
	prev, had := s.reason[reasonKey(c)]
	s.reason[reasonKey(c)] = reasonEntry{r: r, at: s.opts.Now(), ok: ok}
	changed := !had || prev.r.Support != r.Support || prev.r.Default != r.Default || prev.r.Mandatory != r.Mandatory || prev.r.Listed != r.Listed || !equalStrings(prev.r.Efforts, r.Efforts)
	s.mu.Unlock()
	if changed {
		s.notify()
	}
	r.Model = c.model
	return r
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// readReasoning reads the catalog's entry of c's model; ok false when the
// catalog could not be read.
func (s *Service) readReasoning(ctx context.Context, c config) (Reasoning, bool) {
	release, err := s.acquire(ctx)
	if err != nil {
		return UnknownReasoning(), false
	}
	defer release()
	lctx, cancel := context.WithTimeout(ctx, s.opts.ListTimeout)
	defer cancel()
	_, models, err := s.resolveBase(lctx, c.baseURL, c.key, 0)
	if err != nil {
		return UnknownReasoning(), false
	}
	for _, m := range models {
		if m.ID == c.model && m.Reasoning != nil {
			return *m.Reasoning, true
		}
	}
	return UnknownReasoning(), true // a catalog that does not describe the model
}
