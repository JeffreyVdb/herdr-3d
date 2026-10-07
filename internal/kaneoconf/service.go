package kaneoconf

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Defaults.
const (
	// DefaultTimeout bounds one call to Kaneo.
	DefaultTimeout = 15 * time.Second
	// DefaultCooldown is how long Kaneo floors stop polling after the key
	// was refused at run time (a 401 may be the key's request quota).
	DefaultCooldown = 5 * time.Minute
	// TestTTL is how long a passing test lets the same draft be saved.
	TestTTL = 30 * time.Minute
	// listTTL is how long a workspace or project list of the saved
	// connection is answered from memory (a floor's dropdowns switched back
	// and forth do not call Kaneo each time).
	listTTL = 30 * time.Second
	// maxConcurrent bounds the calls in flight at once.
	maxConcurrent = 2
	maxMsg        = 200
)

// States of the connection (View.State).
const (
	StateOff    = "off"    // nothing saved
	StateReady  = "ready"  // saved and usable
	StatePaused = "paused" // saved, but Kaneo refused the key at run time: re-test, or wait for the cooldown
)

// Options configure a Service.
type Options struct {
	// File is the settings file ("": kept in memory only, for tests).
	File string
	// Connector reaches Kaneo (nil: the bridge has no client; tests and
	// lists answer unsupported, saved settings still load).
	Connector Connector
	Timeout   time.Duration // per call (default DefaultTimeout)
	Cooldown  time.Duration // after a run-time 401 (default DefaultCooldown)
	Now       func() time.Time
}

// LastError is the last run-time failure that paused the connection.
type LastError struct {
	Kind    Kind   `json:"kind"`
	Message string `json:"message"`
	At      int64  `json:"at"` // unix ms
	Runtime bool   `json:"runtime,omitempty"`
}

// View is the connection as the protocol shows it: never the key, only
// whether one is saved.
type View struct {
	State string `json:"state"`
	// Available: the bridge can call Kaneo at all (it has a client).
	Available        bool       `json:"available"`
	URL              string     `json:"url"`
	APIBase          string     `json:"api_base"`
	WebOrigin        string     `json:"web_origin"`
	KeySet           bool       `json:"key_set"`
	DefaultWorkspace *Workspace `json:"default_workspace"`
	Generation       int64      `json:"generation"`
	// PausedUntil (unix ms) is when Kaneo floors poll again after the key
	// was refused; absent unless paused.
	PausedUntil int64      `json:"paused_until,omitempty"`
	LastError   *LastError `json:"last_error,omitempty"`
}

// Link is what a floor's board names of the connection: no key.
type Link struct {
	Instance
	Generation int64
}

// Draft is the connection a test or a save is about: a nil field is the
// saved one. A blank key is the saved key, and only for the saved instance.
type Draft struct {
	URL *string
	Key *string
}

// DefaultArg is kaneo.set's default workspace: Set false keeps the saved
// one (when the test still found it), ID nil clears it.
type DefaultArg struct {
	Set bool
	ID  *string
}

// Tested is what a passing test answers.
type Tested struct {
	Instance
	URL        string
	LatencyMS  int64
	Workspaces []Workspace
	User       string
}

// passedTest is the last passing test: what it tested (the key by its
// hash, in memory only) and the workspaces it found.
type passedTest struct {
	apiBase    string
	key        [32]byte
	workspaces []Workspace
	at         time.Time
}

type listEntry struct {
	at         time.Time
	workspaces []Workspace
	projects   []Project
}

// Service holds the connection. Safe for concurrent use.
type Service struct {
	opts   Options
	file   fileStore
	slots  chan struct{}
	change chan struct{}

	mu     sync.Mutex
	stored Stored
	passed *passedTest
	last   *LastError
	paused time.Time
	lists  map[string]listEntry
}

// New opens the settings file and returns the service. A malformed file is
// an error, never overwritten.
func New(opts Options) (*Service, error) {
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.Cooldown <= 0 {
		opts.Cooldown = DefaultCooldown
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, file: fileStore{opts.File}, slots: make(chan struct{}, maxConcurrent),
		change: make(chan struct{}, 1), lists: map[string]listEntry{}}
	st, err := s.file.load()
	if err != nil {
		return nil, err
	}
	s.stored = st
	return s, nil
}

// Changes signals (coalesced) that the View changed, from any goroutine:
// the hub publishes it and looks at the Kaneo floors again.
func (s *Service) Changes() <-chan struct{} { return s.change }

func (s *Service) notify() {
	select {
	case s.change <- struct{}{}:
	default:
	}
}

// View is the current connection.
func (s *Service) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stored
	v := View{State: s.stateLocked(), Available: s.opts.Connector != nil, Generation: st.Generation}
	if st.configured() {
		v.URL, v.APIBase, v.WebOrigin, v.KeySet = st.URL, st.Instance.APIBase, st.Instance.WebOrigin, true
		if st.Default != nil {
			d := *st.Default
			v.DefaultWorkspace = &d
		}
	}
	if v.State == StatePaused {
		v.PausedUntil = s.paused.UnixMilli()
	}
	if s.last != nil {
		l := *s.last
		v.LastError = &l
	}
	return v
}

func (s *Service) stateLocked() string {
	switch {
	case !s.stored.configured():
		return StateOff
	case s.last != nil && s.last.Runtime:
		return StatePaused
	}
	return StateReady
}

// Link is the saved connection without its key (ok false: none saved).
func (s *Service) Link() (Link, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stored.configured() {
		return Link{}, false
	}
	return Link{Instance: s.stored.Instance, Generation: s.stored.Generation}, true
}

// Credentials are the saved instance and key while gen is still the saved
// generation: what the app's board factory builds a floor's client from.
// The key goes nowhere else.
func (s *Service) Credentials(gen int64) (Instance, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stored.configured() || s.stored.Generation != gen {
		return Instance{}, "", false
	}
	return s.stored.Instance, s.stored.Key, true
}

// PausedUntil is when Kaneo floors may poll again after a run-time 401
// (zero: not paused).
func (s *Service) PausedUntil() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stateLocked() != StatePaused {
		return time.Time{}
	}
	return s.paused
}

// Unauthorized records that Kaneo refused the saved key (generation gen) at
// run time: the connection is paused for the cooldown, and stays marked
// paused until a poll works again, a test of the saved connection passes or
// a new one is saved. It returns when polling may resume.
func (s *Service) Unauthorized(gen int64) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stored.configured() || s.stored.Generation != gen {
		return time.Time{}
	}
	now := s.opts.Now()
	if s.last != nil && s.last.Runtime && now.Before(s.paused) {
		return s.paused
	}
	s.paused = now.Add(s.opts.Cooldown)
	s.last = &LastError{Kind: KindUnauthorized, Message: msgUnauthorized, At: now.UnixMilli(), Runtime: true}
	s.notify()
	return s.paused
}

// Recovered records that a call with the saved key (generation gen) worked
// again: a pause ends.
func (s *Service) Recovered(gen int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stored.Generation != gen || s.last == nil {
		return
	}
	s.last, s.paused = nil, time.Time{}
	s.notify()
}

const msgUnauthorized = "Kaneo refused the API key. It may be wrong or revoked, or out of its request quota: wait a minute and test again."

// draft resolves a draft against the saved connection: the URL (the saved
// one when nil) and the key (a blank one is the saved key, and only for the
// saved instance: it is never sent anywhere else).
func (s *Service) draft(d Draft) (Instance, string, string, error) {
	conn := s.opts.Connector
	if conn == nil {
		return Instance{}, "", "", newErr(KindUnsupported, "This bridge cannot reach Kaneo: it has no Kaneo client.")
	}
	s.mu.Lock()
	st := s.stored
	s.mu.Unlock()
	url := st.URL
	if d.URL != nil {
		url = strings.TrimSpace(*d.URL)
	}
	if url == "" {
		return Instance{}, "", "", newErr(KindBadURL, "Enter the Kaneo instance URL, e.g. https://kaneo.example.com.")
	}
	in, err := conn.Resolve(url)
	if err != nil {
		return Instance{}, "", "", newErr(KindBadURL, clip("Not a Kaneo instance URL: "+err.Error()))
	}
	var key string
	if d.Key != nil {
		key = strings.TrimSpace(*d.Key)
	}
	if key == "" {
		switch {
		case st.configured() && st.Instance.APIBase == in.APIBase:
			key = st.Key
		case st.configured():
			return Instance{}, "", "", newErr(KindKeyRequired, "Enter the API key for this instance: the saved key is only ever sent to "+st.Instance.APIBase+".")
		default:
			return Instance{}, "", "", newErr(KindKeyRequired, "Enter the API key.")
		}
	}
	return in, key, url, nil
}

// acquire takes a call slot.
func (s *Service) acquire(ctx context.Context) (func(), error) {
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// call runs one call to Kaneo in a slot, with the timeout, its error
// classified and scrubbed of key.
func call[T any](s *Service, ctx context.Context, key string, fn func(context.Context) (T, error)) (T, error) {
	var zero T
	release, err := s.acquire(ctx)
	if err != nil {
		return zero, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	v, err := fn(ctx)
	if err != nil {
		return zero, classify(err, key)
	}
	return v, nil
}

// Test checks a draft connection (read only: an authenticated workspace
// list). A pass is remembered, so the same draft can be saved; a test of the
// saved connection that passes ends a pause.
func (s *Service) Test(ctx context.Context, d Draft) (Tested, error) {
	in, key, url, err := s.draft(d)
	if err != nil {
		return Tested{}, err
	}
	start := s.opts.Now()
	res, err := call(s, ctx, key, func(ctx context.Context) (TestResult, error) { return s.opts.Connector.Test(ctx, in, key) })
	if err != nil {
		return Tested{}, err
	}
	latency := s.opts.Now().Sub(start).Milliseconds()
	ws := cleanWorkspaces(res.Workspaces)
	s.mu.Lock()
	s.passed = &passedTest{apiBase: in.APIBase, key: sha256.Sum256([]byte(key)), workspaces: ws, at: s.opts.Now()}
	if s.stored.configured() && s.stored.Instance.APIBase == in.APIBase && s.stored.Key == key && s.last != nil {
		s.last, s.paused = nil, time.Time{}
		s.notify()
	}
	s.mu.Unlock()
	return Tested{Instance: in, URL: url, LatencyMS: max(latency, 0), Workspaces: slices.Clone(ws), User: clip(res.User)}, nil
}

// Save stores a draft connection that a test passed (the same instance and
// key, within TestTTL) with its default workspace, which must be one that
// test found. Nothing changes when anything fails: the saved connection
// keeps working. The generation moves when the instance or the key did.
func (s *Service) Save(d Draft, def DefaultArg) (View, error) {
	in, key, url, err := s.draft(d)
	if err != nil {
		return View{}, err
	}
	s.mu.Lock()
	p := s.passed
	now := s.opts.Now()
	if p == nil || p.apiBase != in.APIBase || p.key != sha256.Sum256([]byte(key)) || now.Sub(p.at) > TestTTL {
		s.mu.Unlock()
		return View{}, newErr(KindTestRequired, "Test the connection first: only a connection whose test passed is saved.")
	}
	cur := s.stored
	next := cur
	next.URL, next.Instance, next.Key = url, in, key
	find := func(id string) *Workspace {
		for _, w := range p.workspaces {
			if w.ID == id {
				c := w
				return &c
			}
		}
		return nil
	}
	switch {
	case !def.Set:
		next.Default = nil
		if cur.Default != nil {
			next.Default = find(cur.Default.ID) // kept while the key still reaches it
		}
	case def.ID == nil || *def.ID == "":
		next.Default = nil
	default:
		if next.Default = find(*def.ID); next.Default == nil {
			s.mu.Unlock()
			return View{}, newErr(KindBadInput, "The default workspace is not one this key reaches: test again and pick it from the list.")
		}
	}
	if !cur.configured() || cur.Instance != in || cur.Key != key {
		next.Generation = cur.Generation + 1
	}
	if err := s.file.save(next); err != nil {
		s.mu.Unlock()
		return View{}, fmt.Errorf("saving the Kaneo settings failed: %w", err)
	}
	s.stored = next
	s.last, s.paused = nil, time.Time{}
	if next.Generation != cur.Generation {
		clear(s.lists)
	}
	s.mu.Unlock()
	s.notify()
	return s.View(), nil
}

// Clear disconnects: the instance, the key and the default are removed (the
// file keeps only the generation, moved on).
func (s *Service) Clear() (View, error) {
	s.mu.Lock()
	next := Stored{Generation: s.stored.Generation + 1}
	if err := s.file.save(next); err != nil {
		s.mu.Unlock()
		return View{}, fmt.Errorf("saving the Kaneo settings failed: %w", err)
	}
	s.stored, s.passed, s.last, s.paused = next, nil, nil, time.Time{}
	clear(s.lists)
	s.mu.Unlock()
	s.notify()
	return s.View(), nil
}

// saved is the saved connection for a call (not_configured without one).
func (s *Service) saved() (Instance, string, int64, error) {
	if s.opts.Connector == nil {
		return Instance{}, "", 0, newErr(KindUnsupported, "This bridge cannot reach Kaneo: it has no Kaneo client.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stored.configured() {
		return Instance{}, "", 0, newErr(KindNotConfigured, "Kaneo is not connected: set it up in Settings first.")
	}
	return s.stored.Instance, s.stored.Key, s.stored.Generation, nil
}

func (s *Service) cached(k string) (listEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.lists[k]
	if ok && s.opts.Now().Sub(e.at) < listTTL {
		return e, true
	}
	return listEntry{}, false
}

func (s *Service) remember(gen int64, k string, e listEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stored.Generation == gen { // not a list of a connection replaced meanwhile
		e.at = s.opts.Now()
		s.lists[k] = e
	}
}

// Workspaces lists the workspaces the saved key reaches (a floor's
// dropdown).
func (s *Service) Workspaces(ctx context.Context) ([]Workspace, int64, error) {
	in, key, gen, err := s.saved()
	if err != nil {
		return nil, 0, err
	}
	k := fmt.Sprintf("w\x00%d", gen)
	if e, ok := s.cached(k); ok {
		return slices.Clone(e.workspaces), gen, nil
	}
	ws, err := call(s, ctx, key, func(ctx context.Context) ([]Workspace, error) { return s.opts.Connector.Workspaces(ctx, in, key) })
	if err != nil {
		return nil, gen, err
	}
	ws = cleanWorkspaces(ws)
	s.remember(gen, k, listEntry{workspaces: ws})
	return slices.Clone(ws), gen, nil
}

// Projects lists a workspace's projects with the saved key (archived ones
// left out).
func (s *Service) Projects(ctx context.Context, workspaceID string) ([]Project, int64, error) {
	if !validID(workspaceID) {
		return nil, 0, newErr(KindBadInput, "workspace_id must be 1-200 bytes without control characters")
	}
	in, key, gen, err := s.saved()
	if err != nil {
		return nil, 0, err
	}
	k := fmt.Sprintf("p\x00%d\x00%s", gen, workspaceID)
	if e, ok := s.cached(k); ok {
		return slices.Clone(e.projects), gen, nil
	}
	ps, err := call(s, ctx, key, func(ctx context.Context) ([]Project, error) {
		return s.opts.Connector.Projects(ctx, in, key, workspaceID)
	})
	if err != nil {
		return nil, gen, err
	}
	out := make([]Project, 0, len(ps))
	for _, p := range ps {
		if p.ID == "" || p.Archived || (p.WorkspaceID != "" && p.WorkspaceID != workspaceID) {
			continue
		}
		p.WorkspaceID, p.Name = workspaceID, clip(p.Name)
		out = append(out, p)
	}
	s.remember(gen, k, listEntry{projects: out})
	return slices.Clone(out), gen, nil
}

// VerifyProject checks with the saved key, freshly, that project is a live
// project of workspace (a floor's save): not_found when it is gone,
// bad_request when it is archived or another workspace's. The generation
// is the connection's that vouched for it.
func (s *Service) VerifyProject(ctx context.Context, workspaceID, projectID string) (Project, int64, error) {
	if !validID(workspaceID) || !validID(projectID) {
		return Project{}, 0, newErr(KindBadInput, "workspace and project ids must be 1-200 bytes without control characters")
	}
	in, key, gen, err := s.saved()
	if err != nil {
		return Project{}, 0, err
	}
	p, err := call(s, ctx, key, func(ctx context.Context) (Project, error) {
		return s.opts.Connector.Project(ctx, in, key, projectID)
	})
	if err != nil {
		if KindOf(err) == KindNotFound {
			return Project{}, 0, newErr(KindNotFound, "That Kaneo project is gone (deleted, or this key cannot see it): pick another.")
		}
		return Project{}, 0, err
	}
	switch {
	case p.WorkspaceID != workspaceID:
		return Project{}, 0, newErr(KindBadInput, "That Kaneo project belongs to another workspace: pick the project again.")
	case p.Archived:
		return Project{}, 0, newErr(KindBadInput, "That Kaneo project is archived: pick another.")
	}
	p.Name = clip(p.Name)
	return p, gen, nil
}

func cleanWorkspaces(ws []Workspace) []Workspace {
	out := make([]Workspace, 0, len(ws))
	for _, w := range ws {
		if w.ID == "" {
			continue
		}
		w.Name = clip(w.Name)
		out = append(out, w)
	}
	return out
}

func validID(id string) bool {
	if id == "" || len(id) > 200 {
		return false
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// classify turns a Connector error into an Error, its message scrubbed of
// key.
func classify(err error, key string) error {
	var e *Error
	if errors.As(err, &e) {
		return &Error{Kind: e.Kind, Msg: Scrub(e.Msg, key)}
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	detail := func(prefix string) string { return clip(prefix + Scrub(err.Error(), key)) }
	var rl *provider.RateLimitError
	var ne net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return newErr(KindTimeout, "Kaneo did not answer in time.")
	case errors.As(err, &rl):
		msg := "Kaneo is rate limiting this key"
		if !rl.ResetAt.IsZero() {
			msg += " until " + rl.ResetAt.Format(time.Kitchen)
		}
		return newErr(KindRateLimited, msg+".")
	case errors.Is(err, provider.ErrUnauthorized):
		return newErr(KindUnauthorized, msgUnauthorized)
	case errors.Is(err, provider.ErrForbidden):
		return newErr(KindForbidden, "This key may not reach that Kaneo workspace or project.")
	case errors.Is(err, provider.ErrNotFound):
		return newErr(KindNotFound, detail("Kaneo does not know it: "))
	case errors.Is(err, provider.ErrBadInput):
		return newErr(KindBadInput, detail("Kaneo refused the request: "))
	case errors.Is(err, ErrUnreachable), errors.As(err, &ne):
		return newErr(KindUnreachable, detail("Kaneo could not be reached: "))
	}
	return newErr(KindFailed, detail("Kaneo failed: "))
}

// Scrub replaces every occurrence of key in s.
func Scrub(s, key string) string {
	if len(key) < 4 {
		return s
	}
	return strings.ReplaceAll(s, key, "[key]")
}

func clip(s string) string {
	if len(s) <= maxMsg {
		return s
	}
	n := maxMsg
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}
