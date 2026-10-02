package activity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// roles plays the AI integration's classifier role.
type roles struct {
	mu    sync.Mutex
	state ai.State
	cls   ai.Classifier
}

func (r *roles) State(ai.Role) ai.State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}
func (r *roles) Classifier() ai.Classifier { return r.cls }

// memStore is the store in memory.
type memStore struct {
	mu    sync.Mutex
	set   *Settings
	cache []CacheEntry // newest first
}

func (m *memStore) LoadActivitySettings(context.Context) (Settings, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.set == nil {
		return Settings{}, false, nil
	}
	return *m.set, true, nil
}

// SaveActivitySettings and SaveActivityCalls each save their own fields, as
// the bridge's store does (all of them when nothing is stored yet).
func (m *memStore) SaveActivitySettings(_ context.Context, s Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.set != nil {
		s.CallsDay, s.CallsToday = m.set.CallsDay, m.set.CallsToday
	}
	m.set = &s
	return nil
}
func (m *memStore) SaveActivityCalls(_ context.Context, s Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.set != nil {
		c := *m.set
		c.CallsDay, c.CallsToday = s.CallsDay, s.CallsToday
		s = c
	}
	m.set = &s
	return nil
}
func (m *memStore) LoadActivityCache(_ context.Context, limit int) ([]CacheEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]CacheEntry(nil), m.cache[:min(limit, len(m.cache))]...), nil
}
func (m *memStore) SaveActivityCache(_ context.Context, e CacheEntry, limit int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []CacheEntry{e}
	for _, x := range m.cache {
		if x.Key != e.Key {
			out = append(out, x)
		}
	}
	m.cache = out[:min(limit, len(out))]
	return nil
}

func newService(t *testing.T, r *roles, st Store, env *bool) *Service {
	t.Helper()
	s, err := NewService(context.Background(), Options{Roles: r, Store: st, EnvModel: env})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func on(s *Service, t *testing.T) {
	t.Helper()
	v := true
	if err := s.Set(context.Background(), &v, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestQuestionWording(t *testing.T) {
	want := []Kind{KindInvestigating, KindWriting, KindTesting, KindBuilding, KindShipping, KindWaiting, KindResearching}
	if len(Questions) != len(want) {
		t.Fatalf("%d questions", len(Questions))
	}
	for i, q := range Questions {
		if q.Kind != want[i] || strings.TrimSpace(q.Text) == "" {
			t.Fatalf("%d: %+v", i, q)
		}
	}
	// "writing" is about the project's source files, not about creating a
	// file (a screenshot tool did read as writing in the probe).
	if w := QuestionMap()["writing"]; !strings.Contains(w, "edits source files in the project") {
		t.Fatalf("%q", w)
	}
	if len(QuestionMap()) > ai.MaxQuestions {
		t.Fatal("more questions than one call takes")
	}
}

func TestPrepare(t *testing.T) {
	cases := map[string]string{
		"python3 /home/u/.agents/skills/write-code/scripts/wait_for_results.py /home/u/.local/state/write-code/runs/20261002-0603-activity --timeout 600": "python3 wait_for_results.py RUN --timeout N",
		"GH_TOKEN=ghp_abcdefghijklmnop1234 FOO='a b' herdr agent get x":                                                                                   "GH_TOKEN= FOO= herdr agent get x",
		"python3 - <<'PY'\nimport os\nos.remove('/etc/passwd')\nPY":                                                                                       "python3 - <<'PY'",
		"curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com/x":                                                                      "curl -H 'Authorization: Bearer [key]' https://api.example.com/x",
		"herdr agent get code-wrapup-r1 --id 0e330bf4-b2d9-4b20-9e39-c209e9f8056a":                                                                        "herdr agent get code-wrapup-r1 --id ID",
		"tool --file=/abs/dir/file.txt": "tool --file=file.txt",
	}
	for in, want := range cases {
		if got := Prepare(in); got != want {
			t.Errorf("Prepare(%q)\n = %q\nwant %q", in, got, want)
		}
	}
	if got := Prepare(strings.Repeat("x ", 400)); len(got) > MaxCommand {
		t.Fatalf("%d bytes", len(got))
	}
	// The same command with other numbers, paths and run ids is one key.
	if Key("Bash", "python3 /a/b/wait_for_results.py /r/20261001-2108-settings --timeout 600") !=
		Key("Bash", "python3 /c/wait_for_results.py /s/20261002-0603-activity --timeout 900") {
		t.Fatal("not normalised")
	}
	if Key("Bash", "x") == Key("exec_command", "x") {
		t.Fatal("the tool is part of the key")
	}
}

func TestDecide(t *testing.T) {
	cases := []struct {
		scores map[string]float64
		want   Kind
	}{
		{map[string]float64{"waiting": 0.93, "investigating": 0.66}, KindWaiting},
		{map[string]float64{"investigating": 0.56, "writing": 0.53}, KindWorking}, // under the threshold, no margin
		{map[string]float64{"investigating": 0.9, "writing": 0.8}, KindWorking},   // no margin
		{map[string]float64{"testing": 0.61, "building": 0.3}, KindTesting},
		{map[string]float64{"testing": 0.59}, KindWorking},
		{map[string]float64{}, KindWorking},
	}
	for _, c := range cases {
		if got := Decide(c.scores, DefaultThreshold, DefaultMargin); got != c.want {
			t.Errorf("%v: %q, want %q", c.scores, got, c.want)
		}
	}
}

// probeAnswers are the recorded answers of the #98 probe (Jev, 2026-10-02):
// what the model scored for the commands shaped like the rules' tail.
var probeAnswers = map[string]map[string]float64{
	"python3 wait_for_results.py": {"waiting": 0.93, "investigating": 0.66, "testing": 0.1, "writing": 0.05, "building": 0.04, "shipping": 0.01, "researching": 0.02},
	"herdr agent get":             {"investigating": 0.85, "waiting": 0.27, "testing": 0.05, "writing": 0.02, "building": 0.02, "shipping": 0.01, "researching": 0.03},
	"agent-browser":               {"writing": 0.82, "investigating": 0.22, "testing": 0.2, "waiting": 0.05, "building": 0.03, "shipping": 0.01, "researching": 0.04},
	"parallel-cli extract":        {"investigating": 0.56, "writing": 0.53, "researching": 0.3, "testing": 0.04, "waiting": 0.03, "building": 0.02, "shipping": 0.01},
	"portlease run":               {"waiting": 0.77, "building": 0.29, "testing": 0.1, "investigating": 0.1, "writing": 0.02, "shipping": 0.01, "researching": 0.01},
}

// The probe's commands through the whole path: the rules first, the model
// (with its recorded answers) only for what they leave, the threshold and the
// margin. Its misses never show: agent-browser is testing and the dev server
// building by rule, parallel-cli falls back to Working.
func TestRecordedProbeAnswers(t *testing.T) {
	fc := &ai.FakeClassifier{ManyFunc: func(_ context.Context, state map[string]any, _ map[string]string) (map[string]float64, error) {
		cmd := state["command"].(string)
		for k, v := range probeAnswers {
			if strings.HasPrefix(cmd, k) {
				return v, nil
			}
		}
		return nil, errors.New("no recorded answer for " + cmd)
	}}
	s := newService(t, &roles{state: ai.StateReady, cls: fc}, nil, nil)
	on(s, t)
	cases := []struct {
		cmd   string
		want  Kind
		calls int
	}{
		{"python3 /home/u/.agents/skills/write-code/scripts/wait_for_results.py /home/u/runs/r1 --timeout 600", KindWaiting, 1},
		{"python3 - <<'PY'\nimport json\nprint(json.load(open('report.json'))['ok'])\nPY", KindInvestigating, 0},
		{"herdr agent get code-wrapup-r1", KindInvestigating, 1},
		{"sed -n 700,800p internal/transcript/codex.go", KindInvestigating, 0},
		{"uv run pytest -n auto tests/", KindTesting, 0},
		{"agent-browser --session ux-r1 screenshot /tmp/shot.png", KindTesting, 0},
		{"portlease run --project herdr-3d --name preview -- npm run dev", KindBuilding, 0},
		{"parallel-cli extract https://example.com/docs", KindWorking, 1},
	}
	for _, c := range cases {
		before := len(fc.Calls())
		call := Analyze(Claude, "Bash", bash(c.cmd))
		got := call.Kind
		if !call.OK && call.Command != "" {
			k, err := s.Classify(context.Background(), call.Tool, call.Command)
			if err != nil {
				t.Fatalf("%s: %v", c.cmd, err)
			}
			got = k
		}
		if got != c.want || len(fc.Calls())-before != c.calls {
			t.Errorf("%s: %q after %d calls, want %q after %d", c.cmd, got, len(fc.Calls())-before, c.want, c.calls)
		}
	}
	// Only the tool and the prepared command were sent; every question at once.
	for _, c := range fc.Calls() {
		if len(c.State) != 2 || c.State["tool"] != "Bash" || len(c.Questions) != len(Questions) {
			t.Fatalf("%+v", c)
		}
		if cmd := c.State["command"].(string); strings.Contains(cmd, "/home/u") {
			t.Fatalf("an absolute path was sent: %q", cmd)
		}
	}
}

// Off, or the classifier not ready: nothing is sent, ever.
func TestNothingIsSentUnlessOnAndReady(t *testing.T) {
	ctx := context.Background()
	fc := &ai.FakeClassifier{Score: 0.9}
	r := &roles{state: ai.StateReady, cls: fc}
	s := newService(t, r, nil, nil)
	if s.View().State != StateOff || s.Applies() {
		t.Fatalf("%+v", s.View())
	}
	if _, err := s.Classify(ctx, "Bash", "mytool --x"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("%v", err)
	}
	on(s, t)
	r.mu.Lock()
	r.state = ai.StateIncomplete
	r.mu.Unlock()
	if v := s.View(); v.State != StateIncomplete || v.Classifier != "incomplete" {
		t.Fatalf("%+v", v)
	}
	if _, err := s.Classify(ctx, "Bash", "mytool --x"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("%v", err)
	}
	if n := len(fc.Calls()); n != 0 {
		t.Fatalf("%d calls", n)
	}
}

func TestCacheAndDailyCap(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.Local)
	fc := &ai.FakeClassifier{ManyFunc: func(context.Context, map[string]any, map[string]string) (map[string]float64, error) {
		return map[string]float64{"waiting": 0.9, "investigating": 0.1}, nil
	}}
	st := &memStore{}
	s, err := NewService(ctx, Options{Roles: &roles{state: ai.StateReady, cls: fc}, Store: st, Now: func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}})
	if err != nil {
		t.Fatal(err)
	}
	on(s, t)
	two := 2
	if err := s.Set(ctx, nil, nil, nil, &two); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []string{"python3 /a/wait.py /runs/20261001-2108-settings --t 600", "python3 /b/wait.py /x/20261002-0603-activity --t 900"} {
		if k, err := s.Classify(ctx, "Bash", cmd); err != nil || k != KindWaiting {
			t.Fatalf("%q %v", k, err)
		}
	}
	if n := len(fc.Calls()); n != 1 {
		t.Fatalf("%d calls: the same normalised command must be a cache hit", n)
	}
	if k, ok := s.Cached("Bash", "python3 /c/wait.py /y/20261003-1200-other --t 1"); !ok || k != KindWaiting {
		t.Fatal("not cached")
	}
	if _, err := s.Classify(ctx, "Bash", "other-tool one"); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); v.State != StateCapped || v.CallsToday != 2 || v.CacheSize != 2 || !s.Applies() {
		t.Fatalf("%+v", v)
	}
	if _, err := s.Classify(ctx, "Bash", "third-tool"); !errors.Is(err, ai.ErrNotReady) || len(fc.Calls()) != 2 {
		t.Fatalf("over the cap: %v, %d calls", err, len(fc.Calls()))
	}
	// A restart keeps the count and the cache.
	s2, err := NewService(ctx, Options{Roles: &roles{state: ai.StateReady, cls: fc}, Store: st, Now: s.opts.Now})
	if err != nil {
		t.Fatal(err)
	}
	if v := s2.View(); v.State != StateCapped || v.CallsToday != 2 || v.CacheSize != 2 || v.DailyCap != 2 || !v.ModelEnabled {
		t.Fatalf("%+v", v)
	}
	if _, ok := s2.Cached("Bash", "other-tool one"); !ok {
		t.Fatal("cache not restored")
	}
	// Tomorrow the budget is back.
	mu.Lock()
	now = now.Add(24 * time.Hour)
	mu.Unlock()
	if v := s2.View(); v.State != StateReady || v.CallsToday != 0 {
		t.Fatalf("%+v", v)
	}
}

func TestSettingsValidationAndEnvironment(t *testing.T) {
	ctx := context.Background()
	s := newService(t, &roles{state: ai.StateReady, cls: &ai.FakeClassifier{}}, nil, nil)
	bad, big, zero := 1.5, 0.95, 0
	var e *Error
	if err := s.Set(ctx, nil, &bad, nil, nil); !errors.As(err, &e) || e.Code != CodeBadRequest {
		t.Fatalf("%v", err)
	}
	if err := s.Set(ctx, nil, nil, &big, nil); !errors.As(err, &e) || e.Code != CodeBadRequest {
		t.Fatalf("%v", err)
	}
	if err := s.Set(ctx, nil, nil, nil, &zero); !errors.As(err, &e) || e.Code != CodeBadRequest {
		t.Fatalf("%v", err)
	}
	if v := s.View(); v.Threshold != DefaultThreshold || v.Margin != DefaultMargin || v.DailyCap != DefaultDailyCap || len(v.Env) != 0 {
		t.Fatalf("%+v", v)
	}
	off := false
	env := newService(t, &roles{state: ai.StateReady, cls: &ai.FakeClassifier{}}, nil, &off)
	yes := true
	if err := env.Set(ctx, &yes, nil, nil, nil); !errors.As(err, &e) || e.Code != CodeEnvLocked {
		t.Fatalf("%v", err)
	}
	if err := env.Set(ctx, &off, nil, nil, nil); err != nil {
		t.Fatalf("setting what the environment says is fine: %v", err)
	}
	if v := env.View(); v.ModelEnabled || v.State != StateOff || len(v.Env) != 1 || v.Env[0] != "model_enabled" {
		t.Fatalf("%+v", v)
	}
	b, _ := json.Marshal(env.View())
	for _, k := range []string{`"model_enabled"`, `"threshold"`, `"margin"`, `"daily_cap"`, `"calls_today"`, `"cache_size"`, `"state"`, `"classifier"`, `"env"`} {
		if !strings.Contains(string(b), k) {
			t.Fatalf("%s has no %s", b, k)
		}
	}
}

// The feature holds at most one of the AI integration's two slots: with its
// call stuck at the provider, another feature's classification (#90's) still
// goes through.
func TestActivityHoldsAtMostOneSlot(t *testing.T) {
	const key = "jev-test-key-0123456789"
	release := make(chan struct{})
	var inflight, maxInflight atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, `{"models":[{"name":"jev-latest"}]}`)
			return
		}
		var body struct {
			Questions map[string]any `json:"questions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		answers := map[string]any{}
		for k := range body.Questions {
			answers[k] = map[string]any{"noul": 0.1}
		}
		if len(body.Questions) > 1 { // the activity's call: held until released
			n := inflight.Add(1)
			defer inflight.Add(-1)
			for m := maxInflight.Load(); n > m && !maxInflight.CompareAndSwap(m, n); m = maxInflight.Load() {
			}
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"answers": answers})
	}))
	defer srv.Close()
	svc, err := ai.New(ai.Options{File: filepath.Join(t.TempDir(), "ai.json"), ClassifierURL: srv.URL, ClassifierTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	k, m := key, "jev-latest"
	if _, err := svc.Test(context.Background(), ai.RoleClassifier, ai.Fields{Key: &k, Model: &m}); err != nil {
		t.Fatal(err)
	}
	if err := svc.Set(ai.RoleClassifier, ai.Fields{Key: &k, Model: &m}); err != nil {
		t.Fatal(err)
	}
	s := newService(t, &roles{state: ai.StateReady, cls: svc.Classifier()}, nil, nil)
	on(s, t)
	var wg sync.WaitGroup
	busy := atomic.Int32{}
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Classify(context.Background(), "Bash", "tool-"+string(rune('a'+i))); errors.Is(err, ErrBusy) {
				busy.Add(1)
			}
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for inflight.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// #90's call gets the other slot.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := svc.Classifier().Classify(ctx, map[string]any{"last_agent_message": "x?"}, "asks?"); err != nil {
		t.Fatalf("another feature's call was starved: %v", err)
	}
	close(release)
	wg.Wait()
	if maxInflight.Load() != 1 || busy.Load() != 3 {
		t.Fatalf("%d activity calls at once, %d refused busy", maxInflight.Load(), busy.Load())
	}
}

// jevAnswering is a Jev that scores every question it is asked 0.5 and
// counts the requests; hold (nil: none) decides which of them wait for
// release first.
func jevAnswering(t *testing.T, calls *atomic.Int32, hold func(n int32) bool, release <-chan struct{}, entered chan<- int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if entered != nil {
			entered <- n
		}
		if hold != nil && hold(n) {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		var body struct {
			Questions map[string]any `json:"questions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		answers := map[string]any{}
		for k := range body.Questions {
			answers[k] = map[string]any{"noul": 0.5}
		}
		json.NewEncoder(w).Encode(map[string]any{"answers": answers})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// readyAI is the AI integration with its classifier set by the environment
// (a key file, which the test may take away) against srv.
func readyAI(t *testing.T, srv *httptest.Server) (*ai.Service, string) {
	t.Helper()
	keyFile := filepath.Join(t.TempDir(), "jev.key")
	if err := os.WriteFile(keyFile, []byte("jev-test-key-0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := ai.New(ai.Options{ClassifierURL: srv.URL, HTTP: srv.Client(), Env: ai.Overrides{ClassifierKeyFile: keyFile, ClassifierModel: "jev-latest"}})
	if err != nil {
		t.Fatal(err)
	}
	if a.State(ai.RoleClassifier) != ai.StateReady {
		t.Fatal("the classifier is not ready")
	}
	return a, keyFile
}

// Switched off while its call waits for one of the AI integration's slots
// (both held by other features): the call is never sent, and Set returns
// once it is over (review B-R1).
func TestSwitchedOffWhileWaitingForASlotSendsNothing(t *testing.T) {
	var calls atomic.Int32
	release, entered := make(chan struct{}), make(chan int32, 8)
	srv := jevAnswering(t, &calls, func(n int32) bool { return n <= 2 }, release, entered)
	a, _ := readyAI(t, srv)
	var others sync.WaitGroup
	var once sync.Once
	free := func() { once.Do(func() { close(release) }) }
	defer others.Wait()
	defer free()  // a failure frees the slots too
	for range 2 { // #90's calls hold both slots
		others.Add(1)
		go func() {
			defer others.Done()
			_, _ = a.Classifier().Classify(context.Background(), nil, "asks?")
		}()
	}
	<-entered
	<-entered
	s, err := NewService(context.Background(), Options{Roles: a, Store: &memStore{}})
	if err != nil {
		t.Fatal(err)
	}
	on(s, t)
	res := make(chan error, 1)
	go func() {
		_, err := s.Classify(context.Background(), "Bash", "mystery-tool --flag")
		res <- err
	}()
	// Wait for the call to be handed to the classifier: it waits for a slot.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		s.mu.Lock()
		handed := s.call != nil
		s.mu.Unlock()
		if handed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the call was never handed to the classifier")
		}
	}
	off := false
	if err := s.Set(context.Background(), &off, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	// Set waited for the call: it is over before the slots free.
	select {
	case err := <-res:
		if !errors.Is(err, ai.ErrNotReady) {
			t.Fatalf("Classify: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Set returned with the call still waiting")
	}
	free()
	others.Wait()
	if n := calls.Load(); n != 2 {
		t.Fatalf("%d requests: the activity's was sent after it was switched off", n)
	}
}

// slowCount is a store whose first save of a counted call (by whichever
// method) returns only on resume.
type slowCount struct {
	memStore
	held            atomic.Bool
	entered, resume chan struct{}
}

func (m *slowCount) hold(s Settings) {
	if s.CallsToday == 1 && m.held.CompareAndSwap(false, true) {
		close(m.entered)
		<-m.resume
	}
}

func (m *slowCount) SaveActivitySettings(ctx context.Context, s Settings) error {
	m.hold(s)
	return m.memStore.SaveActivitySettings(ctx, s)
}

func (m *slowCount) SaveActivityCalls(ctx context.Context, s Settings) error {
	m.hold(s)
	return m.memStore.SaveActivityCalls(ctx, s)
}

// Switched off, and the threshold changed, while a call's count is being
// saved: the call is not made, and the count saved after does not undo
// either change, after a restart too (review B-R2).
func TestSettingsChangedWhileACountIsSavedStay(t *testing.T) {
	ctx := context.Background()
	st := &slowCount{entered: make(chan struct{}), resume: make(chan struct{})}
	fc := &ai.FakeClassifier{}
	r := &roles{state: ai.StateReady, cls: fc}
	s := newService(t, r, st, nil)
	on(s, t)
	res := make(chan error, 1)
	go func() {
		_, err := s.Classify(ctx, "Bash", "mystery-tool")
		res <- err
	}()
	<-st.entered
	off, th := false, 0.75
	if err := s.Set(ctx, &off, &th, nil, nil); err != nil {
		t.Fatal(err)
	}
	close(st.resume)
	if err := <-res; !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("Classify: %v", err)
	}
	if n := len(fc.Calls()); n != 0 {
		t.Fatalf("%d calls after it was switched off", n)
	}
	again := newService(t, r, st, nil)
	if v := again.View(); v.ModelEnabled || v.Threshold != 0.75 || v.CallsToday != 1 {
		t.Fatalf("after a restart: %+v", v)
	}
}

// The classifier's key file goes while its first attempt fails: the role is
// incomplete, and the retry is never sent (review B-R3).
func TestNoRetryOnceTheClassifierIsNotReady(t *testing.T) {
	var calls atomic.Int32
	var keyFile string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = os.Remove(keyFile)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	a, kf := readyAI(t, srv)
	keyFile = kf
	s, err := NewService(context.Background(), Options{Roles: a})
	if err != nil {
		t.Fatal(err)
	}
	on(s, t)
	if _, err := s.Classify(context.Background(), "Bash", "mystery-tool"); err == nil {
		t.Fatal("no error")
	}
	if a.State(ai.RoleClassifier) != ai.StateIncomplete {
		t.Fatalf("classifier %s", a.State(ai.RoleClassifier))
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("%d requests: retried with the key that is gone", n)
	}
}

// Whatever the heredoc's delimiter, its body never reaches the model; a <<
// that is no heredoc marker (a here-string, an open quote, a delimiter too
// long to keep) drops all after it (review B-R4).
func TestHeredocBodiesAreDropped(t *testing.T) {
	cases := map[string]string{
		"mystery <<'!'\nprivate customer contents\n!":                          "mystery <<'!'",
		"mystery <<123\nprivate customer contents\n123":                        "mystery <<N",
		"mystery <<-\"E O F\"\n\tprivate customer contents\n\tE O F":           `mystery <<-"E O F"`,
		"mystery <<\\EOF\nprivate customer contents\nEOF":                      `mystery <<\EOF`,
		"mystery << 'x-y.z'\nprivate customer contents\nx-y.z":                 "mystery << 'x-y.z'",
		"mystery <<EOF > out.txt\nprivate customer contents\nEOF":              "mystery <<EOF",
		"mystery <<'EOF\nprivate customer contents\nEOF":                       "mystery <<",
		"mystery <<< 'private customer contents'":                              "mystery <<<",
		"mystery <<" + strings.Repeat("A", 40) + "\nprivate customer contents": "mystery <<",
		"mystery <<%%\nprivate customer contents\n%%":                          "mystery <<%%",
	}
	for in, want := range cases {
		if got := Prepare(in); got != want {
			t.Errorf("Prepare(%q)\n = %q\nwant %q", in, got, want)
		}
		if c := Analyze(Claude, "Bash", bash(in)); !c.OK && strings.Contains(Prepare(c.Command), "private") {
			t.Errorf("%q: the body goes to the model: %q", in, Prepare(c.Command))
		}
	}
}
