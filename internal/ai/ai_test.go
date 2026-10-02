package ai_test

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

const (
	jevKey    = "jev-secret-key-0123456789"
	llmKey    = "sk-llm-secret-abcdef123456"
	jevModels = `{"models":[{"name":"jev-latest","description":"the latest"},{"name":"jev-preview","description":"preview"}]}`
)

// fakeJev plays Jev: a Bearer key, /v1/models and /v1/systemone.
type fakeJev struct {
	*httptest.Server
	hits  atomic.Int32
	score float64
	delay time.Duration
	mu    sync.Mutex
	last  map[string]any
}

func newJev(t *testing.T) *fakeJev {
	f := &fakeJev{score: 0.96}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+jevKey {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":"bad key `+strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")+`"}`)
			return
		}
		time.Sleep(f.delay)
		switch r.URL.Path {
		case "/v1/models":
			io.WriteString(w, jevModels)
		case "/v1/systemone":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.last = body
			f.mu.Unlock()
			answers := map[string]any{}
			qs, _ := body["questions"].(map[string]any)
			for k := range qs {
				answers[k] = map[string]any{"noul": f.score}
			}
			json.NewEncoder(w).Encode(map[string]any{"answers": answers})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

// fakeOpenAI plays an OpenAI-compatible endpoint under prefix ("" or "/v1").
type fakeOpenAI struct {
	*httptest.Server
	prefix      string
	hits        atomic.Int32
	chats       atomic.Int32
	inflight    atomic.Int32
	maxInflight atomic.Int32
	rejectJSON  bool // answers 400 when response_format is sent
	noModels    bool
	fail5xx     atomic.Int32 // fails this many chat calls with 500 first
	delay       time.Duration
	mu          sync.Mutex
	bodies      []map[string]any
}

func newOpenAI(t *testing.T, prefix string) *fakeOpenAI {
	f := &fakeOpenAI{prefix: prefix}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		n := f.inflight.Add(1)
		defer f.inflight.Add(-1)
		for {
			m := f.maxInflight.Load()
			if n <= m || f.maxInflight.CompareAndSwap(m, n) {
				break
			}
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+llmKey {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":{"message":"Incorrect API key provided: `+strings.TrimPrefix(got, "Bearer ")+`"}}`)
			return
		}
		switch r.URL.Path {
		case f.prefix + "/models":
			if f.noModels {
				http.NotFound(w, r)
				return
			}
			io.WriteString(w, `{"object":"list","data":[{"id":"mimo-v2.6-flash"},{"id":"alpha"}]}`)
		case f.prefix + "/chat/completions":
			f.chats.Add(1)
			time.Sleep(f.delay)
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.bodies = append(f.bodies, body)
			f.mu.Unlock()
			if f.fail5xx.Load() > 0 {
				f.fail5xx.Add(-1)
				w.WriteHeader(http.StatusInternalServerError)
				io.WriteString(w, `{"error":"boom"}`)
				return
			}
			if _, ok := body["response_format"]; ok && f.rejectJSON {
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, `{"error":{"message":"response_format is not supported"}}`)
				return
			}
			io.WriteString(w, `{"choices":[{"message":{"content":"Sure: {\"ok\": true} done"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeOpenAI) bodyAt(i int) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[i]
}

func str(s string) *string { return &s }

func newSvc(t *testing.T, jev *fakeJev, opts ai.Options) *ai.Service {
	t.Helper()
	if opts.File == "" {
		opts.File = filepath.Join(t.TempDir(), "state", "ai.json")
	}
	if jev != nil {
		opts.ClassifierURL = jev.URL
	}
	s, err := ai.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func configureClassifier(t *testing.T, s *ai.Service) {
	t.Helper()
	f := ai.Fields{Key: str(jevKey), Model: str("jev-latest")}
	if _, err := s.Test(context.Background(), ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
}

func configureLLM(t *testing.T, s *ai.Service, base string) {
	t.Helper()
	f := ai.Fields{BaseURL: str(base), Key: str(llmKey), Model: str("mimo-v2.6-flash")}
	if _, err := s.Test(context.Background(), ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
}

func kind(t *testing.T, err error) ai.Kind {
	t.Helper()
	if err == nil {
		t.Fatal("no error")
	}
	return ai.KindOf(err)
}

func TestNothingIsSentUnlessAskedFor(t *testing.T) {
	jev, llm := newJev(t), newOpenAI(t, "")
	s := newSvc(t, jev, ai.Options{})
	ctx := context.Background()
	if v := s.View(); v.Classifier.State != ai.StateOff || v.LLM.State != ai.StateOff {
		t.Fatalf("a new service is %+v", v)
	}
	// Off, then incomplete: consumers get ErrNotReady, nothing is called.
	for _, step := range []func(){
		func() {},
		func() {
			// Incomplete can only come from the environment: a model without a key.
			s2 := newSvc(t, jev, ai.Options{Env: ai.Overrides{ClassifierModel: "jev-latest", LLMBaseURL: llm.URL}})
			s = s2
		},
	} {
		step()
		if _, err := s.Classifier().Classify(ctx, nil, "q"); !errors.Is(err, ai.ErrNotReady) {
			t.Fatalf("classify: %v", err)
		}
		if _, err := s.LLM().Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "user", Content: "hi"}}}); !errors.Is(err, ai.ErrNotReady) {
			t.Fatalf("complete: %v", err)
		}
	}
	if v := s.View(); v.Classifier.State != ai.StateIncomplete || v.LLM.State != ai.StateIncomplete {
		t.Fatalf("env without keys is %+v", v)
	}
	// Setting, clearing and reading never call out either.
	if err := s.Set(ai.RoleClassifier, ai.Fields{Key: str(jevKey)}); kind(t, err) != ai.KindTestRequired {
		t.Fatalf("set untested: %v", err)
	}
	if err := s.Clear(ai.RoleLLM); err != nil {
		t.Fatal(err)
	}
	if jev.hits.Load() != 0 || llm.hits.Load() != 0 {
		t.Fatalf("calls without being asked: jev %d, llm %d", jev.hits.Load(), llm.hits.Load())
	}
}

func TestClassifierModelsAndAuth(t *testing.T) {
	jev := newJev(t)
	s := newSvc(t, jev, ai.Options{})
	res, err := s.Models(context.Background(), ai.RoleClassifier, ai.Fields{Key: str(jevKey)})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Models) != 2 || res.Models[0].ID != "jev-latest" || res.Models[1].ID != "jev-preview" {
		t.Fatalf("models %+v", res.Models)
	}
	_, err = s.Models(context.Background(), ai.RoleClassifier, ai.Fields{Key: str("wrong-key-1234567")})
	if kind(t, err) != ai.KindAuthFailed {
		t.Fatalf("bad key: %v", err)
	}
	if strings.Contains(err.Error(), "wrong-key") {
		t.Fatalf("the key is in the error: %v", err)
	}
	if _, err := s.Models(context.Background(), ai.RoleClassifier, ai.Fields{}); kind(t, err) != ai.KindIncomplete {
		t.Fatalf("no key: %v", err)
	}
}

func TestLLMModelsNormalisesTheBaseURL(t *testing.T) {
	ctx := context.Background()
	// The endpoint lives under /v1; the user typed the host with a slash.
	v1 := newOpenAI(t, "/v1")
	s := newSvc(t, nil, ai.Options{})
	res, err := s.Models(ctx, ai.RoleLLM, ai.Fields{BaseURL: str(v1.URL + "/"), Key: str(llmKey)})
	if err != nil {
		t.Fatal(err)
	}
	if res.BaseURL != v1.URL+"/v1" || len(res.Models) != 2 || res.Models[0].ID != "alpha" {
		t.Fatalf("%+v", res)
	}
	// Already right: no /v1 is added, the slash goes.
	plain := newOpenAI(t, "")
	res, err = s.Models(ctx, ai.RoleLLM, ai.Fields{BaseURL: str(plain.URL + "/"), Key: str(llmKey)})
	if err != nil || res.BaseURL != plain.URL {
		t.Fatalf("%+v %v", res, err)
	}
	// Neither works: a typed error, so the panel offers a typed model id.
	none := newOpenAI(t, "")
	none.noModels = true
	if _, err = s.Models(ctx, ai.RoleLLM, ai.Fields{BaseURL: str(none.URL), Key: str(llmKey)}); kind(t, err) != ai.KindNoModels {
		t.Fatalf("no /models: %v", err)
	}
	// A rejected key is auth_failed and never echoed.
	_, err = s.Models(ctx, ai.RoleLLM, ai.Fields{BaseURL: str(plain.URL), Key: str("sk-wrong-key-abcdef")})
	if kind(t, err) != ai.KindAuthFailed || strings.Contains(err.Error(), "sk-wrong") {
		t.Fatalf("bad key: %v", err)
	}
	for _, bad := range []string{"ftp://x", "http://user:pw@host/v1", "http://h/v1?key=1", "nonsense", "http://"} {
		if _, err := s.Models(ctx, ai.RoleLLM, ai.Fields{BaseURL: str(bad)}); kind(t, err) != ai.KindBadConfig {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestSetNeedsAPassingTestOfExactlyThatConfig(t *testing.T) {
	jev := newJev(t)
	s := newSvc(t, jev, ai.Options{})
	ctx := context.Background()
	f := ai.Fields{Key: str(jevKey), Model: str("jev-latest")}
	if err := s.Set(ai.RoleClassifier, f); kind(t, err) != ai.KindTestRequired {
		t.Fatalf("set before test: %v", err)
	}
	if s.State(ai.RoleClassifier) != ai.StateOff {
		t.Fatal("an untested set changed the state")
	}
	res, err := s.Test(ctx, ai.RoleClassifier, f)
	if err != nil || res.Score == nil || *res.Score != 0.96 {
		t.Fatalf("%+v %v", res, err)
	}
	// Another model than the tested one is not allowed.
	if err := s.Set(ai.RoleClassifier, ai.Fields{Key: str(jevKey), Model: str("jev-preview")}); kind(t, err) != ai.KindTestRequired {
		t.Fatalf("set of another model: %v", err)
	}
	if err := s.Set(ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	v := s.View()
	if v.Classifier.State != ai.StateReady || v.Classifier.Model != "jev-latest" || !v.Classifier.KeySet || v.Classifier.KeyHint != "6789" {
		t.Fatalf("%+v", v.Classifier)
	}
	// A blank key keeps the current one: the next test and set use the stored key.
	g := ai.Fields{Key: str(""), Model: str("jev-preview")}
	if _, err := s.Test(ctx, ai.RoleClassifier, g); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, g); err != nil {
		t.Fatal(err)
	}
	if v := s.View().Classifier; v.Model != "jev-preview" || v.KeyHint != "6789" {
		t.Fatalf("%+v", v)
	}
	// A failing test passes nothing.
	if _, err := s.Test(ctx, ai.RoleClassifier, ai.Fields{Key: str("wrong-key-1234567")}); kind(t, err) != ai.KindAuthFailed {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, ai.Fields{Key: str("wrong-key-1234567")}); kind(t, err) != ai.KindTestRequired {
		t.Fatal(err)
	}
	// The failed test was of a draft, not of the config in use: still ready.
	if s.State(ai.RoleClassifier) != ai.StateReady {
		t.Fatal("a failed draft test stopped the role in use")
	}
	// Clear removes it.
	if err := s.Clear(ai.RoleClassifier); err != nil {
		t.Fatal(err)
	}
	if v := s.View().Classifier; v.State != ai.StateOff || v.KeySet || v.Model != "" {
		t.Fatalf("%+v", v)
	}
}

func TestRuntimeAuthFailureStopsEveryConsumerUntilFixed(t *testing.T) {
	jev := newJev(t)
	s := newSvc(t, jev, ai.Options{})
	configureClassifier(t, s)
	ctx := context.Background()
	score, err := s.Classifier().Classify(ctx, map[string]any{"text": "hi"}, "Is it a greeting?")
	if err != nil || score != 0.96 {
		t.Fatalf("%v %v", score, err)
	}
	jev.mu.Lock()
	body := jev.last
	jev.mu.Unlock()
	qs := body["questions"].(map[string]any)["question"].(map[string]any)
	if body["model"] != "jev-latest" || qs["type"] != "noul" || qs["instructions"] != "Is it a greeting?" || body["state"].(map[string]any)["text"] != "hi" {
		t.Fatalf("request %v", body)
	}
	// The key is revoked at the provider: simulate by changing what the fake accepts.
	jev.Close()
	revoked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"message":"key `+jevKey+` revoked"}`)
	}))
	defer revoked.Close()
	var hits atomic.Int32
	rev2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		revoked.Config.Handler.ServeHTTP(w, r)
	}))
	defer rev2.Close()
	s2 := newSvc(t, nil, ai.Options{File: filepath.Join(t.TempDir(), "ai.json"), ClassifierURL: rev2.URL, Env: ai.Overrides{ClassifierModel: "jev-latest", ClassifierKeyFile: writeKey(t, jevKey)}})
	if s2.State(ai.RoleClassifier) != ai.StateReady {
		t.Fatalf("env config is %v", s2.State(ai.RoleClassifier))
	}
	_, err = s2.Classifier().Classify(ctx, nil, "q")
	if kind(t, err) != ai.KindAuthFailed || strings.Contains(err.Error(), jevKey) {
		t.Fatalf("%v", err)
	}
	if s2.State(ai.RoleClassifier) != ai.StateInvalid {
		t.Fatal("the role is not invalid")
	}
	select {
	case <-s2.Changes():
	default:
		t.Fatal("no change was signalled")
	}
	le := s2.View().LastError
	if le == nil || le.Role != ai.RoleClassifier || le.Kind != ai.KindAuthFailed || !le.Runtime {
		t.Fatalf("last error %+v", le)
	}
	// Every consumer is paused: no more calls.
	before := hits.Load()
	for range 5 {
		if _, err := s2.Classifier().Classify(ctx, nil, "q"); !errors.Is(err, ai.ErrNotReady) {
			t.Fatalf("%v", err)
		}
	}
	if hits.Load() != before {
		t.Fatal("a paused role called out")
	}
}

func writeKey(t *testing.T, key string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(p, []byte(key+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAPassingTestOfTheConfigInUseLiftsInvalid(t *testing.T) {
	jev := newJev(t)
	s := newSvc(t, jev, ai.Options{})
	configureClassifier(t, s)
	// A runtime failure (the server answers 401 once), then the test passes again.
	var reject atomic.Bool
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reject.Load() {
			w.WriteHeader(401)
			return
		}
		jev.Config.Handler.ServeHTTP(w, r)
	}))
	defer flaky.Close()
	s = newSvc(t, nil, ai.Options{ClassifierURL: flaky.URL})
	configureClassifier(t, s)
	reject.Store(true)
	if _, err := s.Classifier().Classify(context.Background(), nil, "q"); kind(t, err) != ai.KindAuthFailed {
		t.Fatal(err)
	}
	if s.State(ai.RoleClassifier) != ai.StateInvalid {
		t.Fatal("not invalid")
	}
	reject.Store(false)
	if _, err := s.Test(context.Background(), ai.RoleClassifier, ai.Fields{}); err != nil {
		t.Fatal(err)
	}
	if s.State(ai.RoleClassifier) != ai.StateReady || s.View().LastError != nil {
		t.Fatalf("%+v", s.View())
	}
}

func TestResponseFormatFallbackToPlainText(t *testing.T) {
	llm := newOpenAI(t, "")
	llm.rejectJSON = true
	s := newSvc(t, nil, ai.Options{})
	configureLLM(t, s, llm.URL)
	if jm := s.View().LLM.JSONMode; jm == nil || *jm {
		t.Fatalf("json_mode after the test: %v", jm)
	}
	chatsAfterSetup := llm.chats.Load()
	ctx := context.Background()
	text, err := s.LLM().Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "user", Content: "give json"}}, JSON: true})
	if err != nil {
		t.Fatal(err)
	}
	obj, ok := ai.FirstJSONObject(text)
	if !ok || obj != `{"ok": true}` {
		t.Fatalf("%q %q", text, obj)
	}
	// json_mode is remembered: one call, and it carries no response_format.
	if n := llm.chats.Load() - chatsAfterSetup; n != 1 {
		t.Fatalf("%d calls", n)
	}
	if _, ok := llm.bodyAt(int(llm.chats.Load()) - 1)["response_format"]; ok {
		t.Fatal("response_format was sent after it was rejected")
	}
}

func TestResponseFormatFallbackLearnedAtRuntime(t *testing.T) {
	// A config whose json_mode is unknown (the file has none): the first
	// call tries, falls back once, and remembers.
	llm := newOpenAI(t, "")
	llm.rejectJSON = true
	file := filepath.Join(t.TempDir(), "ai.json")
	os.WriteFile(file, []byte(`{"llm":{"base_url":"`+llm.URL+`","model":"m","key":"`+llmKey+`"}}`), 0o600)
	s := newSvc(t, nil, ai.Options{File: file})
	if s.State(ai.RoleLLM) != ai.StateReady {
		t.Fatal(s.View())
	}
	req := ai.Request{Messages: []ai.Message{{Role: "user", Content: "j"}}, JSON: true, MaxTokens: 50}
	if _, err := s.LLM().Complete(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if llm.chats.Load() != 2 {
		t.Fatalf("%d calls, want the rejected one and the plain one", llm.chats.Load())
	}
	first, second := llm.bodyAt(0), llm.bodyAt(1)
	if _, ok := first["response_format"]; !ok {
		t.Fatal("first call without response_format")
	}
	if _, ok := second["response_format"]; ok || second["max_tokens"] != float64(50) {
		t.Fatalf("second call %v", second)
	}
	if _, err := s.LLM().Complete(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if llm.chats.Load() != 3 {
		t.Fatalf("%d calls", llm.chats.Load())
	}
	b, _ := os.ReadFile(file)
	if !strings.Contains(string(b), `"json_mode": false`) {
		t.Fatalf("not persisted: %s", b)
	}
}

func TestJSONModeIsUsedWhenTheEndpointHasIt(t *testing.T) {
	llm := newOpenAI(t, "")
	s := newSvc(t, nil, ai.Options{})
	configureLLM(t, s, llm.URL)
	if jm := s.View().LLM.JSONMode; jm == nil || !*jm {
		t.Fatalf("json_mode %v", jm)
	}
	n := int(llm.chats.Load())
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "x"}}, JSON: true}); err != nil {
		t.Fatal(err)
	}
	rf, _ := llm.bodyAt(n)["response_format"].(map[string]any)
	if rf["type"] != "json_object" {
		t.Fatalf("%v", llm.bodyAt(n))
	}
}

func TestExtraBodyIsMergedAndChecked(t *testing.T) {
	llm := newOpenAI(t, "")
	s := newSvc(t, nil, ai.Options{})
	f := ai.Fields{BaseURL: str(llm.URL), Key: str(llmKey), Model: str("m"), ExtraBody: json.RawMessage(`{"thinking":{"type":"disabled"}}`)}
	if _, err := s.Test(context.Background(), ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	body := llm.bodyAt(0)
	if th, _ := body["thinking"].(map[string]any); th["type"] != "disabled" || body["model"] != "m" {
		t.Fatalf("%v", body)
	}
	if err := s.Set(ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	if string(s.View().LLM.ExtraBody) != `{"thinking":{"type":"disabled"}}` {
		t.Fatalf("%s", s.View().LLM.ExtraBody)
	}
	for _, bad := range []string{`[1]`, `"x"`, `{"messages":[]}`, `{"model":"x"}`, `{"stream":true}`, `{` + strings.Repeat(`"a":1,`, 1000) + `"b":2}`} {
		g := f
		g.ExtraBody = json.RawMessage(bad)
		if _, err := s.Test(context.Background(), ai.RoleLLM, g); kind(t, err) != ai.KindBadConfig {
			t.Errorf("%.30s: %v", bad, err)
		}
	}
	// null clears it.
	g := f
	g.ExtraBody = json.RawMessage(`null`)
	if _, err := s.Test(context.Background(), ai.RoleLLM, g); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleLLM, g); err != nil {
		t.Fatal(err)
	}
	if s.View().LLM.ExtraBody != nil {
		t.Fatal("extra_body not cleared")
	}
}

func TestKeysNeverLeave(t *testing.T) {
	jev, llm := newJev(t), newOpenAI(t, "")
	file := filepath.Join(t.TempDir(), "sub", "ai.json")
	s := newSvc(t, jev, ai.Options{File: file})
	configureClassifier(t, s)
	configureLLM(t, s, llm.URL)
	// The view, in every form, holds a hint and nothing more.
	b, _ := json.Marshal(s.View())
	for _, k := range []string{jevKey, llmKey} {
		if strings.Contains(string(b), k) {
			t.Fatalf("a key is in the view: %s", b)
		}
	}
	if v := s.View(); v.Classifier.KeyHint != "6789" || v.LLM.KeyHint != "3456" || !v.Classifier.KeySet || !v.LLM.KeySet {
		t.Fatalf("%s", b)
	}
	// The file holds them, 0600, in a 0700 directory.
	fi, err := os.Stat(file)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", fi, err)
	}
	if di, _ := os.Stat(filepath.Dir(file)); di.Mode().Perm() != 0o700 {
		t.Fatalf("dir %v", di.Mode())
	}
	// No temporary file is left behind.
	ents, _ := os.ReadDir(filepath.Dir(file))
	if len(ents) != 1 {
		t.Fatalf("%v", ents)
	}
	// A restart reads it back.
	s2 := newSvc(t, jev, ai.Options{File: file})
	if v := s2.View(); v.Classifier.State != ai.StateReady || v.LLM.State != ai.StateReady || v.LLM.BaseURL != llm.URL {
		t.Fatalf("%+v", v)
	}
	// A provider that prints the key back into an error never gets it out.
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"bad request from `+llmKey+` with Bearer `+llmKey+` and sk-other-secret-key-123"}}`)
	}))
	defer echo.Close()
	f := ai.Fields{BaseURL: str(echo.URL), Key: str(llmKey), Model: str("m")}
	_, err = s.Test(context.Background(), ai.RoleLLM, f)
	if err == nil || strings.Contains(err.Error(), llmKey) || strings.Contains(err.Error(), "sk-other") {
		t.Fatalf("error %v", err)
	}
	for _, in := range []string{"Authorization: Bearer abcdefghijkl", "key sk-abcdefghijklmnop failed", "x " + strings.Repeat("a", 40)} {
		if out := ai.Scrub(in); strings.Contains(out, "abcdefgh") || strings.Contains(out, "aaaa") {
			t.Errorf("Scrub(%q) = %q", in, out)
		}
	}
}

func TestMalformedFileIsAnErrorNotOverwritten(t *testing.T) {
	file := filepath.Join(t.TempDir(), "ai.json")
	os.WriteFile(file, []byte(`{"llm": {`), 0o600)
	if _, err := ai.New(ai.Options{File: file}); err == nil {
		t.Fatal("a malformed file was accepted")
	}
	if b, _ := os.ReadFile(file); string(b) != `{"llm": {` {
		t.Fatal("the file was touched")
	}
	// A readable-by-others file is tightened.
	os.WriteFile(file, []byte(`{}`), 0o644)
	if _, err := ai.New(ai.Options{File: file}); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v", fi.Mode())
	}
}

func TestEnvironmentOverridesAndIsReadOnly(t *testing.T) {
	jev, llm := newJev(t), newOpenAI(t, "")
	file := filepath.Join(t.TempDir(), "ai.json")
	s := newSvc(t, jev, ai.Options{File: file})
	configureClassifier(t, s) // stored: jev-latest
	env := ai.Overrides{ClassifierModel: "jev-preview", LLMBaseURL: llm.URL + "/", LLMModel: "env-model", LLMKeyFile: writeKey(t, llmKey)}
	s = newSvc(t, jev, ai.Options{File: file, Env: env})
	v := s.View()
	if v.Classifier.Model != "jev-preview" || len(v.Classifier.Env) != 1 || v.Classifier.Env[0] != "model" || v.Classifier.State != ai.StateReady {
		t.Fatalf("%+v", v.Classifier)
	}
	if v.LLM.BaseURL != llm.URL || v.LLM.Model != "env-model" || !v.LLM.KeySet || v.LLM.KeyHint != "3456" || len(v.LLM.Env) != 3 || v.LLM.State != ai.StateReady {
		t.Fatalf("%+v", v.LLM)
	}
	if v.LLM.Env == nil || v.Classifier.Env == nil {
		t.Fatal("env must be [], not null")
	}
	// A locked field cannot be set or tested; the others can.
	if err := s.Set(ai.RoleClassifier, ai.Fields{Model: str("jev-latest")}); kind(t, err) != ai.KindEnvLocked {
		t.Fatalf("%v", err)
	}
	if _, err := s.Test(context.Background(), ai.RoleLLM, ai.Fields{BaseURL: str("http://x")}); kind(t, err) != ai.KindEnvLocked {
		t.Fatalf("%v", err)
	}
	// Env wins even for the key the file holds: clearing removes the stored copy, the env stays.
	if err := s.Clear(ai.RoleClassifier); err != nil {
		t.Fatal(err)
	}
	if v := s.View().Classifier; v.Model != "jev-preview" || v.KeySet {
		t.Fatalf("%+v", v)
	}
	// A key file that is not there is a missing key, not a crash.
	s = newSvc(t, jev, ai.Options{File: file, Env: ai.Overrides{LLMBaseURL: llm.URL, LLMModel: "m", LLMKeyFile: "/nonexistent/key"}})
	if v := s.View().LLM; v.KeySet || v.State != ai.StateReady {
		t.Fatalf("keyless LLM is %+v", v) // a keyless endpoint (Ollama) is complete without a key
	}
}

// ---- features are not known to the package -------------------------------

// titleFeature is a made-up feature: it classifies a text, and asks the LLM
// for a title. It compiles against the two interfaces only.
type titleFeature struct {
	cls ai.Classifier
	llm ai.LLM
}

func (f titleFeature) Title(ctx context.Context, text string) (string, error) {
	score, err := f.cls.Classify(ctx, map[string]any{"text": text}, "Does the text need a title?")
	if err != nil {
		return "", err
	}
	if score < 0.5 {
		return "", nil
	}
	out, err := f.llm.Complete(ctx, ai.Request{Messages: []ai.Message{
		{Role: "system", Content: "Answer as JSON."}, {Role: "user", Content: text}}, JSON: true})
	if err != nil {
		return "", err
	}
	obj, _ := ai.FirstJSONObject(out)
	var t struct {
		Title string `json:"title"`
	}
	json.Unmarshal([]byte(obj), &t)
	return t.Title, nil
}

func TestAFeatureUsesTheInterfacesWithoutChangesToThePackage(t *testing.T) {
	ctx := context.Background()
	// With the fakes.
	fc, fl := &ai.FakeClassifier{Score: 0.9}, &ai.FakeLLM{Text: `Here: {"title":"Hello"}`}
	got, err := titleFeature{fc, fl}.Title(ctx, "a long text")
	if err != nil || got != "Hello" {
		t.Fatalf("%q %v", got, err)
	}
	if c := fc.Calls(); len(c) != 1 || c[0].State["text"] != "a long text" || c[0].Question == "" {
		t.Fatalf("%+v", c)
	}
	if c := fl.Calls(); len(c) != 1 || !c[0].JSON || len(c[0].Messages) != 2 {
		t.Fatalf("%+v", c)
	}
	fc.Score = 0.1
	if got, _ := (titleFeature{fc, fl}).Title(ctx, "x"); got != "" || len(fl.Calls()) != 1 {
		t.Fatal("the LLM was asked for a text that needs no title")
	}
	// With the real clients, against the fake servers.
	jev, llm := newJev(t), newOpenAI(t, "")
	s := newSvc(t, jev, ai.Options{})
	configureClassifier(t, s)
	configureLLM(t, s, llm.URL)
	llm2 := titleFeature{s.Classifier(), s.LLM()}
	if _, err := llm2.Title(ctx, "text"); err != nil {
		t.Fatal(err)
	}
	// Not ready: the feature gets ErrNotReady and nothing else.
	if err := s.Clear(ai.RoleLLM); err != nil {
		t.Fatal(err)
	}
	if _, err := llm2.Title(ctx, "text"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("%v", err)
	}
}

// #98: several questions in one call: one request, every key scored, and the
// same bounds (not ready: no call; a missing answer: bad_response).
func TestClassifyManyAsksAllQuestionsInOneCall(t *testing.T) {
	ctx := context.Background()
	jev := newJev(t)
	s := newSvc(t, jev, ai.Options{})
	qs := map[string]string{"testing": "runs tests?", "writing": "edits files?"}
	if _, err := s.Classifier().ClassifyMany(ctx, nil, qs); !errors.Is(err, ai.ErrNotReady) || jev.hits.Load() != 0 {
		t.Fatalf("not ready: %v, %d requests", err, jev.hits.Load())
	}
	configureClassifier(t, s)
	before := jev.hits.Load()
	jev.score = 0.42
	got, err := s.Classifier().ClassifyMany(ctx, map[string]any{"tool": "Bash", "command": "make it"}, qs)
	if err != nil || len(got) != 2 || got["testing"] != 0.42 || got["writing"] != 0.42 {
		t.Fatalf("%v %v", got, err)
	}
	if n := jev.hits.Load() - before; n != 1 {
		t.Fatalf("%d requests for two questions, want one", n)
	}
	jev.mu.Lock()
	sent, _ := jev.last["questions"].(map[string]any)
	jev.mu.Unlock()
	if q, _ := sent["writing"].(map[string]any); len(sent) != 2 || q["type"] != "noul" || q["instructions"] != "edits files?" {
		t.Fatalf("%v", sent)
	}
	if _, err := s.Classifier().ClassifyMany(ctx, nil, map[string]string{}); err == nil {
		t.Fatal("no questions accepted")
	}
	// The fake classifier records the call with its questions.
	fc := &ai.FakeClassifier{Score: 0.3}
	if got, _ := fc.ClassifyMany(ctx, nil, qs); got["testing"] != 0.3 || len(fc.Calls()) != 1 || len(fc.Calls()[0].Questions) != 2 {
		t.Fatalf("%v %+v", got, fc.Calls())
	}
}

// #98 review B-R3: a retry checks the classifier again, for Classify (#90's
// path) as for ClassifyMany. Its key file gone while the first attempt
// failed: the role is incomplete and no second request goes. Its key
// changed instead: the retry carries the key in use now.
func TestClassifierRetryChecksTheRoleAgain(t *testing.T) {
	ctx := context.Background()
	calls := map[string]func(ai.Classifier) error{
		"Classify": func(c ai.Classifier) error { _, err := c.Classify(ctx, nil, "asks?"); return err },
		"ClassifyMany": func(c ai.Classifier) error {
			_, err := c.ClassifyMany(ctx, nil, map[string]string{"a": "a?", "b": "b?"})
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			for _, gone := range []bool{true, false} {
				keyFile := filepath.Join(t.TempDir(), "jev.key")
				if err := os.WriteFile(keyFile, []byte("old-key-0123456789"), 0o600); err != nil {
					t.Fatal(err)
				}
				var mu sync.Mutex
				var keys []string
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					mu.Lock()
					keys = append(keys, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
					first := len(keys) == 1
					mu.Unlock()
					if !first {
						var body struct {
							Questions map[string]any `json:"questions"`
						}
						json.NewDecoder(r.Body).Decode(&body)
						answers := map[string]any{}
						for k := range body.Questions {
							answers[k] = map[string]any{"noul": 0.5}
						}
						json.NewEncoder(w).Encode(map[string]any{"answers": answers})
						return
					}
					if gone {
						os.Remove(keyFile)
					} else {
						os.WriteFile(keyFile, []byte("new-key-0123456789"), 0o600)
					}
					w.WriteHeader(http.StatusBadGateway)
				}))
				defer srv.Close()
				s, err := ai.New(ai.Options{ClassifierURL: srv.URL, HTTP: srv.Client(),
					Env: ai.Overrides{ClassifierKeyFile: keyFile, ClassifierModel: "jev-latest"}})
				if err != nil {
					t.Fatal(err)
				}
				err = call(s.Classifier())
				mu.Lock()
				got := append([]string(nil), keys...)
				mu.Unlock()
				switch {
				case gone && (err == nil || len(got) != 1 || s.State(ai.RoleClassifier) != ai.StateIncomplete):
					t.Fatalf("key file gone: %v, requests with %v, role %s", err, got, s.State(ai.RoleClassifier))
				case !gone && (err != nil || len(got) != 2 || got[1] != "new-key-0123456789"):
					t.Fatalf("key changed: %v, requests with %v", err, got)
				}
			}
		})
	}
}

// ---- bounds ----------------------------------------------------------------

func TestConcurrencyIsLimitedAcrossConsumersAndRoles(t *testing.T) {
	jev, llm := newJev(t), newOpenAI(t, "")
	jev.delay, llm.delay = 60*time.Millisecond, 60*time.Millisecond
	var maxSeen, inflight atomic.Int32
	// Count what is in flight over both servers together.
	track := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/systemone" || strings.HasSuffix(r.URL.Path, "/chat/completions") {
				n := inflight.Add(1)
				defer inflight.Add(-1)
				for {
					m := maxSeen.Load()
					if n <= m || maxSeen.CompareAndSwap(m, n) {
						break
					}
				}
			}
			h.ServeHTTP(w, r)
		})
	}
	jev.Config.Handler = track(jev.Config.Handler)
	llm.Config.Handler = track(llm.Config.Handler)
	s := newSvc(t, jev, ai.Options{})
	configureClassifier(t, s)
	configureLLM(t, s, llm.URL)
	maxSeen.Store(0)
	var wg sync.WaitGroup
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				if _, err := s.Classifier().Classify(context.Background(), nil, "q"); err != nil {
					t.Error(err)
				}
			} else if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "x"}}}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if got := maxSeen.Load(); got != 2 {
		t.Fatalf("at most %d calls at once, want exactly the limit of 2 reached and not passed", got)
	}
	// A waiter gives up with its context and holds no slot.
	jev.delay = 300 * time.Millisecond
	go s.Classifier().Classify(context.Background(), nil, "q")
	go s.Classifier().Classify(context.Background(), nil, "q")
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := s.Classifier().Classify(ctx, nil, "q"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("%v", err)
	}
}

func TestTimeoutsAndAtMostOneRetry(t *testing.T) {
	jev, llm := newJev(t), newOpenAI(t, "")
	s := newSvc(t, jev, ai.Options{ClassifierTimeout: 80 * time.Millisecond, LLMTimeout: 80 * time.Millisecond})
	configureClassifier(t, s)
	configureLLM(t, s, llm.URL)
	// A classifier slower than its timeout: two attempts, then a timeout error.
	jev.delay = 400 * time.Millisecond
	jev.hits.Store(0)
	start := time.Now()
	_, err := s.Classifier().Classify(context.Background(), nil, "q")
	if kind(t, err) != ai.KindTimeout {
		t.Fatalf("%v", err)
	}
	if d := time.Since(start); d > 350*time.Millisecond {
		t.Fatalf("took %v: the timeout is per attempt, two at most", d)
	}
	time.Sleep(500 * time.Millisecond) // let the abandoned handlers finish
	if n := jev.hits.Load(); n != 2 {
		t.Fatalf("%d attempts, want 2", n)
	}
	// A timeout is not a rejected key.
	if s.State(ai.RoleClassifier) != ai.StateReady {
		t.Fatal("a timeout stopped the role")
	}
	// A 5xx is retried once and then succeeds; two 5xx fail after two attempts; an auth failure is not retried.
	llm.delay = 0
	base := llm.chats.Load()
	llm.fail5xx.Store(1)
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "x"}}}); err != nil {
		t.Fatal(err)
	}
	if n := llm.chats.Load() - base; n != 2 {
		t.Fatalf("%d calls", n)
	}
	base = llm.chats.Load()
	llm.fail5xx.Store(5)
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "x"}}}); kind(t, err) != ai.KindFailed {
		t.Fatalf("%v", err)
	}
	if n := llm.chats.Load() - base; n != 2 {
		t.Fatalf("%d calls, want 2 at most", n)
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Store(true)
	}))
	defer other.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusFound)
	}))
	defer redir.Close()
	s := newSvc(t, nil, ai.Options{})
	_, err := s.Models(context.Background(), ai.RoleLLM, ai.Fields{BaseURL: str(redir.URL), Key: str(llmKey)})
	if err == nil || leaked.Load() {
		t.Fatalf("%v leaked=%v", err, leaked.Load())
	}
}

func TestFirstJSONObject(t *testing.T) {
	for in, want := range map[string]string{
		`{"a":1}`:                               `{"a":1}`,
		"```json\n{\"a\": {\"b\": \"}\"}}\n```": "{\"a\": {\"b\": \"}\"}}",
		`no {braces here} but {"x":2} later`:    `{"x":2}`,
		`nothing`:                               "",
		`{"unclosed": 1`:                        "",
	} {
		got, ok := ai.FirstJSONObject(in)
		if got != want || ok != (want != "") {
			t.Errorf("%q: got %q %v", in, got, ok)
		}
	}
}
