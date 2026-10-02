package activity

// The classification model (#92's Jev) for the commands the rules cannot
// place, opt-in ("Classify unknown commands"): one call per command asks one
// noul question per candidate kind, the top score wins only over the
// threshold and by the margin. A command is normalised before anything: its
// heredoc bodies dropped, VAR= values, absolute paths, numbers and run ids
// taken out, scrubbed and clipped; that text is both the cache key (by its
// SHA-256, persisted) and all the model is sent, with the tool's name.

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Question is what the model is asked for one kind.
type Question struct {
	Kind Kind
	Text string
}

// Questions are asked of every unplaced command, all in one call. Their
// wording is part of the feature (TestQuestionWording): "writing" is about
// the project's source files, so a screenshot tool does not read as writing.
var Questions = []Question{
	{KindInvestigating, "The command only reads or inspects files, logs, processes or state, without changing anything."},
	{KindWriting, "The command edits source files in the project: it creates, changes, moves or deletes them."},
	{KindTesting, "The command runs tests, linters or type checks, or drives the app or a browser to check that it works."},
	{KindBuilding, "The command builds or compiles the project, installs its dependencies, or starts a dev server."},
	{KindShipping, "The command commits, pushes, merges, releases, publishes or deploys work."},
	{KindWaiting, "The command waits or polls for something else to finish: it sleeps, watches a log or waits for results."},
	{KindResearching, "The command looks something up on the web or in external documentation."},
}

// Defaults and bounds of the settings.
const (
	DefaultThreshold = 0.6
	DefaultMargin    = 0.2
	DefaultDailyCap  = 2000
	MinThreshold     = 0.05
	MaxThreshold     = 0.99
	MaxMargin        = 0.9
	MaxDailyCap      = 100_000
	// CacheSize is how many normalised commands' answers are kept.
	CacheSize = 2000
	// MaxCommand is the most of a command the model is sent, in bytes.
	MaxCommand = 400
)

// States of the feature (State.State).
const (
	StateOff        = "off"        // switched off
	StateIncomplete = "incomplete" // on, but the classifier role is not ready: nothing is sent
	StateReady      = "ready"      // on and classifying
	StateCapped     = "capped"     // the daily cap is reached: rules only until tomorrow
)

// Error codes of activity.set.
const (
	CodeEnvLocked  = "env_locked"
	CodeBadRequest = "bad_request"
)

// ErrBusy is a Classify while another runs: the feature makes one call at a
// time.
var ErrBusy = errors.New("a command is being classified already")

// Error is an error of the settings command.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// State is the feature as clients see it (activity.get, activity.update,
// World.activity).
type State struct {
	ModelEnabled bool    `json:"model_enabled"`
	Threshold    float64 `json:"threshold"`
	Margin       float64 `json:"margin"`
	DailyCap     int     `json:"daily_cap"`
	CallsToday   int     `json:"calls_today"`
	CacheSize    int     `json:"cache_size"`
	State        string  `json:"state"`
	// Classifier is the #92 classifier role's state.
	Classifier string `json:"classifier"`
	// Env lists the fields the bridge environment sets ("model_enabled").
	Env []string `json:"env"`
}

// Settings are what the store keeps.
type Settings struct {
	ModelEnabled bool
	Threshold    float64
	Margin       float64
	DailyCap     int
	// CallsDay (YYYY-MM-DD, bridge's local time) and CallsToday count the
	// calls of that day.
	CallsDay   string
	CallsToday int
}

// CacheEntry is one normalised command's answer.
type CacheEntry struct {
	Key  string // the hex SHA-256 of the tool and the normalised command
	Kind Kind
}

// Store keeps the settings and the cache (the bridge's database).
type Store interface {
	LoadActivitySettings(ctx context.Context) (Settings, bool, error)
	SaveActivitySettings(ctx context.Context, s Settings) error
	// LoadActivityCache returns the newest entries, newest first.
	LoadActivityCache(ctx context.Context, limit int) ([]CacheEntry, error)
	// SaveActivityCache records an entry, keeping the newest limit.
	SaveActivityCache(ctx context.Context, e CacheEntry, limit int) error
}

// Roles is what the feature needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	Classifier() ai.Classifier
}

// Options configure a Service.
type Options struct {
	Roles Roles
	Store Store
	// EnvModel is HERDR_WORLD_ACTIVITY_MODEL (nil: not set): while set it
	// wins over the stored toggle, and the panel shows it read-only.
	EnvModel *bool
	Now      func() time.Time
}

// Service holds the settings, the cache and the budget, and asks the model:
// at most one call at a time (ErrBusy), so the feature never takes both of
// the AI integration's slots and #90's turn-end classification always finds
// one. Safe for concurrent use.
type Service struct {
	opts Options
	busy chan struct{} // the one call in flight

	mu    sync.Mutex
	set   Settings
	cache map[string]*list.Element
	lru   *list.List // of CacheEntry, newest first
}

// NewService loads the settings and the cache.
func NewService(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Service{opts: opts, busy: make(chan struct{}, 1), set: Settings{Threshold: DefaultThreshold, Margin: DefaultMargin, DailyCap: DefaultDailyCap},
		cache: map[string]*list.Element{}, lru: list.New()}
	if opts.Store == nil {
		return s, nil
	}
	st, ok, err := opts.Store.LoadActivitySettings(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		s.set.ModelEnabled, s.set.CallsDay, s.set.CallsToday = st.ModelEnabled, st.CallsDay, st.CallsToday
		if validThreshold(st.Threshold) {
			s.set.Threshold = st.Threshold
		}
		if validMargin(st.Margin) {
			s.set.Margin = st.Margin
		}
		if st.DailyCap >= 1 && st.DailyCap <= MaxDailyCap {
			s.set.DailyCap = st.DailyCap
		}
	}
	es, err := opts.Store.LoadActivityCache(ctx, CacheSize)
	if err != nil {
		return nil, err
	}
	for i := len(es) - 1; i >= 0; i-- { // oldest first, so the newest ends in front
		s.putLocked(es[i])
	}
	return s, nil
}

func validThreshold(v float64) bool { return v >= MinThreshold && v <= MaxThreshold && v == v }
func validMargin(v float64) bool    { return v >= 0 && v <= MaxMargin && v == v }

func (s *Service) day() string { return s.opts.Now().Format("2006-01-02") }

// callsLocked is the calls made today.
func (s *Service) callsLocked() int {
	if s.set.CallsDay != s.day() {
		return 0
	}
	return s.set.CallsToday
}

func (s *Service) enabledLocked() bool {
	if e := s.opts.EnvModel; e != nil {
		return *e
	}
	return s.set.ModelEnabled
}

func (s *Service) classifierState() ai.State {
	if s.opts.Roles == nil {
		return ai.StateOff
	}
	return s.opts.Roles.State(ai.RoleClassifier)
}

func (s *Service) viewLocked() State {
	v := State{ModelEnabled: s.enabledLocked(), Threshold: s.set.Threshold, Margin: s.set.Margin, DailyCap: s.set.DailyCap,
		CallsToday: s.callsLocked(), CacheSize: s.lru.Len(), Classifier: string(s.classifierState()), Env: []string{}}
	if s.opts.EnvModel != nil {
		v.Env = append(v.Env, "model_enabled")
	}
	switch {
	case !v.ModelEnabled:
		v.State = StateOff
	case v.Classifier != string(ai.StateReady):
		v.State = StateIncomplete
	case v.CallsToday >= v.DailyCap:
		v.State = StateCapped
	default:
		v.State = StateReady
	}
	return v
}

// View is the current state.
func (s *Service) View() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked()
}

// Ready reports whether a call may be made now: switched on, the classifier
// ready, under the daily cap.
func (s *Service) Ready() bool { return s.View().State == StateReady }

// Applies reports whether cached answers are shown: switched on and the
// classifier ready (capped too: a cached answer costs nothing).
func (s *Service) Applies() bool {
	st := s.View().State
	return st == StateReady || st == StateCapped
}

// Set changes the settings (nil: kept). The environment's toggle cannot be
// changed.
func (s *Service) Set(ctx context.Context, enabled *bool, threshold, margin *float64, dailyCap *int) error {
	switch {
	case threshold != nil && !validThreshold(*threshold):
		return &Error{CodeBadRequest, fmt.Sprintf("threshold must be %.2f-%.2f", MinThreshold, MaxThreshold)}
	case margin != nil && !validMargin(*margin):
		return &Error{CodeBadRequest, fmt.Sprintf("margin must be 0-%.2f", MaxMargin)}
	case dailyCap != nil && (*dailyCap < 1 || *dailyCap > MaxDailyCap):
		return &Error{CodeBadRequest, fmt.Sprintf("daily_cap must be 1-%d", MaxDailyCap)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.set
	if enabled != nil {
		if e := s.opts.EnvModel; e != nil {
			if *enabled != *e {
				return &Error{CodeEnvLocked, "classifying unknown commands is switched by the bridge environment (HERDR_WORLD_ACTIVITY_MODEL)"}
			}
		} else {
			next.ModelEnabled = *enabled
		}
	}
	if threshold != nil {
		next.Threshold = *threshold
	}
	if margin != nil {
		next.Margin = *margin
	}
	if dailyCap != nil {
		next.DailyCap = *dailyCap
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SaveActivitySettings(ctx, next); err != nil {
			return fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	s.set = next
	return nil
}

// Key is a command's cache key: the hex SHA-256 of the tool and the
// normalised command.
func Key(tool, command string) string {
	sum := sha256.Sum256([]byte(tool + "\x00" + Prepare(command)))
	return hex.EncodeToString(sum[:])
}

// Cached is the answer known for a command.
func (s *Service) Cached(tool, command string) (Kind, bool) {
	k := Key(tool, command)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cache[k]
	if !ok {
		return "", false
	}
	s.lru.MoveToFront(e)
	return e.Value.(CacheEntry).Kind, true
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

// Classify asks the model about a command the rules could not place, and
// caches the answer: KindWorking when no kind wins. Unless the feature is
// ready it makes no call (ai.ErrNotReady); a call counts toward the daily
// cap whatever its outcome. Only the tool's name and the prepared command
// are sent.
func (s *Service) Classify(ctx context.Context, tool, command string) (Kind, error) {
	text := Prepare(command)
	key := Key(tool, command)
	s.mu.Lock()
	if s.viewLocked().State != StateReady {
		s.mu.Unlock()
		return "", ai.ErrNotReady
	}
	if e, ok := s.cache[key]; ok {
		s.mu.Unlock()
		return e.Value.(CacheEntry).Kind, nil
	}
	select {
	case s.busy <- struct{}{}:
	default:
		s.mu.Unlock()
		return "", ErrBusy
	}
	defer func() { <-s.busy }()
	next := s.set
	next.CallsToday, next.CallsDay = s.callsLocked()+1, s.day()
	th, margin := s.set.Threshold, s.set.Margin
	s.set = next
	s.mu.Unlock()
	if s.opts.Store != nil {
		_ = s.opts.Store.SaveActivitySettings(ctx, next) // the count is best effort
	}
	scores, err := s.opts.Roles.Classifier().ClassifyMany(ctx, map[string]any{"tool": tool, "command": text}, QuestionMap())
	if err != nil {
		return "", err
	}
	kind := Decide(scores, th, margin)
	e := CacheEntry{Key: key, Kind: kind}
	s.mu.Lock()
	s.putLocked(e)
	s.mu.Unlock()
	if s.opts.Store != nil {
		if err := s.opts.Store.SaveActivityCache(ctx, e, CacheSize); err != nil {
			return kind, nil // kept in memory; the next restart asks again
		}
	}
	return kind, nil
}

// QuestionMap is Questions as ClassifyMany takes them: kind → question.
func QuestionMap() map[string]string {
	m := make(map[string]string, len(Questions))
	for _, q := range Questions {
		m[string(q.Kind)] = q.Text
	}
	return m
}

// Decide is the model's answer: the top kind when it scores at least
// threshold and beats the runner-up by margin, else KindWorking.
func Decide(scores map[string]float64, threshold, margin float64) Kind {
	type kv struct {
		k string
		v float64
	}
	var all []kv
	for _, q := range Questions {
		if v, ok := scores[string(q.Kind)]; ok {
			all = append(all, kv{string(q.Kind), v})
		}
	}
	if len(all) == 0 {
		return KindWorking
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].v > all[j].v })
	second := 0.0
	if len(all) > 1 {
		second = all[1].v
	}
	if all[0].v >= threshold && all[0].v-second >= margin {
		return Kind(all[0].k)
	}
	return KindWorking
}

var (
	heredocRe = regexp.MustCompile(`<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?[^\n]*`)
	// assignAnyRe is a VAR=value word anywhere in a command (its value goes).
	assignAnyRe = regexp.MustCompile(`(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]*)`)
	absPathRe   = regexp.MustCompile(`(^|[\s='"(])((?:~|/)[^\s'"(),;|&<>]*)`)
	uuidRe      = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	hexIDRe     = regexp.MustCompile(`(?i)\b[0-9a-f]*[0-9][0-9a-f]*[a-f][0-9a-f]*\b|\b[0-9a-f]*[a-f][0-9a-f]*[0-9][0-9a-f]*\b`)
	numberRe    = regexp.MustCompile(`\b\d+(?:\.\d+)?\b`)
	// runIDRe is a write-code run id (20261002-0603-activity).
	runIDRe = regexp.MustCompile(`\b\d{8}-\d{4}(?:-[A-Za-z0-9]+)*`)
	spaceRe = regexp.MustCompile(`[ \t]+`)
)

// Prepare is a command as the model may see it and the cache keys it:
// anything after a heredoc marker dropped, VAR= values, absolute paths (to
// their basenames), run ids, hex ids and numbers taken out, scrubbed, at
// most MaxCommand bytes.
func Prepare(cmd string) string {
	s := cmd
	if loc := heredocRe.FindStringIndex(s); loc != nil {
		s = s[:loc[1]]
	}
	s = assignAnyRe.ReplaceAllString(s, "$1$2=")
	s = absPathRe.ReplaceAllStringFunc(s, func(m string) string {
		lead := ""
		if m != "" && strings.IndexByte(" \t\n='\"(", m[0]) >= 0 {
			lead, m = m[:1], m[1:]
		}
		return lead + path.Base(m)
	})
	s = runIDRe.ReplaceAllString(s, "RUN")
	s = uuidRe.ReplaceAllString(s, "ID")
	s = hexIDRe.ReplaceAllStringFunc(s, func(m string) string {
		if len(m) >= 7 {
			return "ID"
		}
		return m
	})
	s = Scrub(s)
	s = numberRe.ReplaceAllString(s, "N")
	s = spaceRe.ReplaceAllString(strings.TrimSpace(s), " ")
	if len(s) > MaxCommand {
		s = cut(s, MaxCommand)
	}
	return s
}

// cut shortens s to at most n bytes, at a rune boundary.
func cut(s string, n int) string {
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}
