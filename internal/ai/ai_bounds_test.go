package ai_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Tests of the bounds every call is under (secrecy, slots, timeouts) and of
// the state a config and a request share.

func TestScrubRemovesEveryKnownKeyHoweverShort(t *testing.T) {
	if out := ai.Scrub("Unsupported account key abc", "abc"); strings.Contains(out, "abc") {
		t.Fatalf("%q", out)
	}
	if out := ai.Scrub("nothing to hide", ""); out != "nothing to hide" {
		t.Fatalf("an empty key must remove nothing: %q", out)
	}
	// End to end: a key the settings accept never comes back in an error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"Unsupported account key abc"}}`)
	}))
	defer srv.Close()
	s := newSvc(t, nil, ai.Options{})
	f := ai.Fields{BaseURL: str(srv.URL), Key: str("abc"), Model: str("m")}
	_, err := s.Test(context.Background(), ai.RoleLLM, f)
	if err == nil || strings.Contains(err.Error(), "abc") {
		t.Fatalf("error %v", err)
	}
	_, err = s.Models(context.Background(), ai.RoleLLM, f)
	if err == nil || strings.Contains(err.Error(), "abc") {
		t.Fatalf("error %v", err)
	}
}

func TestModelListsNeverEchoTheKey(t *testing.T) {
	const key = "secret-0123456789"
	bearer := func(r *http.Request) string { return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") }
	openai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"data":[{"id":"model-%s"},{"id":"plain-and-very-long-model-id-0123456789-abcdef"}]}`, bearer(r))
	}))
	defer openai.Close()
	jev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"models":[{"name":"jev-%s","description":"your key is %s"}]}`, bearer(r), bearer(r))
	}))
	defer jev.Close()
	s := newSvc(t, nil, ai.Options{ClassifierURL: jev.URL})
	for role, f := range map[ai.Role]ai.Fields{
		ai.RoleLLM:        {BaseURL: str(openai.URL), Key: str(key)},
		ai.RoleClassifier: {Key: str(key)},
	} {
		res, err := s.Models(context.Background(), role, f)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(res)
		if strings.Contains(string(b), key) || !strings.Contains(string(b), "[key]") {
			t.Fatalf("%s: %s", role, b)
		}
		// Only the key goes: a long id that is no key stays whole.
		if role == ai.RoleLLM && !strings.Contains(string(b), "plain-and-very-long-model-id-0123456789-abcdef") {
			t.Fatalf("a model id was altered: %s", b)
		}
	}
}

func TestTestThenSaveOfAnUnresolvedBaseURL(t *testing.T) {
	endpoint := newOpenAI(t, "/v1")
	s := newSvc(t, nil, ai.Options{})
	f := ai.Fields{BaseURL: str(endpoint.URL), Model: str("alpha"), Key: str(llmKey)}
	tested, err := s.Test(context.Background(), ai.RoleLLM, f)
	if err != nil {
		t.Fatal(err)
	}
	if tested.BaseURL != endpoint.URL+"/v1" {
		t.Fatalf("resolved %q", tested.BaseURL)
	}
	// What the panel submits next (the resolved URL) and what was typed (the
	// bare one) are both what the test passed.
	resolved := ai.Fields{BaseURL: &tested.BaseURL, Model: f.Model, Key: f.Key}
	if err := s.Set(ai.RoleLLM, resolved); err != nil {
		t.Fatalf("saving the resolved config: %v", err)
	}
	if v := s.View().LLM; v.BaseURL != tested.BaseURL || v.State != ai.StateReady {
		t.Fatalf("%+v", v)
	}
	if err := s.Clear(ai.RoleLLM); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Test(context.Background(), ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleLLM, f); err != nil {
		t.Fatalf("saving the config as typed: %v", err)
	}
	if v := s.View().LLM; v.BaseURL != tested.BaseURL {
		t.Fatalf("saved %q, want the resolved base", v.BaseURL)
	}
	// Any other config is still refused.
	other := ai.Fields{BaseURL: str(endpoint.URL), Model: str("beta"), Key: f.Key}
	if err := s.Set(ai.RoleLLM, other); kind(t, err) != ai.KindTestRequired {
		t.Fatalf("%v", err)
	}
}

func TestEnvironmentBaseURLIsUsedAsResolved(t *testing.T) {
	endpoint := newOpenAI(t, "/v1")
	file := filepath.Join(t.TempDir(), "ai.json")
	env := ai.Overrides{LLMBaseURL: endpoint.URL, LLMModel: "alpha"}
	key := llmKey
	s := newSvc(t, nil, ai.Options{File: file, Env: env})
	f := ai.Fields{Key: &key}
	tested, err := s.Test(context.Background(), ai.RoleLLM, f)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	if v := s.View().LLM; v.BaseURL != tested.BaseURL || v.State != ai.StateReady || len(v.Env) != 2 {
		t.Fatalf("%+v", v)
	}
	call := func(s *ai.Service) {
		t.Helper()
		if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "hi"}}}); err != nil {
			t.Fatalf("a runtime call after Test and Save: %v", err)
		}
	}
	call(s)
	// The resolution survives a restart, and Clear.
	s = newSvc(t, nil, ai.Options{File: file, Env: env})
	call(s)
	if err := s.Clear(ai.RoleLLM); err != nil {
		t.Fatal(err)
	}
	if v := s.View().LLM; v.BaseURL != tested.BaseURL {
		t.Fatalf("%+v", v)
	}
	// A different environment URL is not given somebody else's resolution.
	other := newOpenAI(t, "")
	s = newSvc(t, nil, ai.Options{File: file, Env: ai.Overrides{LLMBaseURL: other.URL, LLMModel: "alpha"}})
	if v := s.View().LLM; v.BaseURL != other.URL {
		t.Fatalf("%+v", v)
	}
}

// gated is a Jev and OpenAI endpoint in one that holds every request until
// released, and counts what is in flight.
type gated struct {
	*httptest.Server
	gate        chan struct{}
	inflight    atomic.Int32
	peak        atomic.Int32
	hits        atomic.Int32
	hold        atomic.Bool
	releaseOnce sync.Once
}

func newGated(t *testing.T) *gated {
	g := &gated{gate: make(chan struct{})}
	g.hold.Store(true)
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.hits.Add(1)
		n := g.inflight.Add(1)
		defer g.inflight.Add(-1)
		for {
			m := g.peak.Load()
			if n <= m || g.peak.CompareAndSwap(m, n) {
				break
			}
		}
		if g.hold.Load() {
			select {
			case <-g.gate:
			case <-r.Context().Done():
				return
			}
		}
		switch {
		case r.URL.Path == "/v1/systemone":
			io.WriteString(w, `{"answers":{"question":{"noul":0.9}}}`)
		case r.URL.Path == "/v1/models":
			io.WriteString(w, `{"models":[{"name":"jev-latest"}]}`)
		case strings.HasSuffix(r.URL.Path, "/models"):
			io.WriteString(w, `{"data":[{"id":"m"}]}`)
		default:
			io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
		}
	}))
	t.Cleanup(func() { g.release(); g.Close() })
	return g
}

func (g *gated) release() { g.releaseOnce.Do(func() { close(g.gate) }) }

func TestTestsAndModelLoadsShareTheGlobalSlots(t *testing.T) {
	g := newGated(t)
	s := newSvc(t, nil, ai.Options{ClassifierURL: g.URL})
	// Consumers need a ready role: pass the tests ungated first.
	g.hold.Store(false)
	cf := ai.Fields{Key: str("valid-key"), Model: str("jev-latest")}
	lf := ai.Fields{BaseURL: str(g.URL), Key: str("valid-key"), Model: str("m")}
	for _, step := range []func() error{
		func() error { _, err := s.Test(context.Background(), ai.RoleClassifier, cf); return err },
		func() error { return s.Set(ai.RoleClassifier, cf) },
		func() error { _, err := s.Test(context.Background(), ai.RoleLLM, lf); return err },
		func() error { return s.Set(ai.RoleLLM, lf) },
	} {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	g.hold.Store(true)
	g.peak.Store(0)
	var wg sync.WaitGroup
	run := func(f func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f(); err != nil {
				t.Error(err)
			}
		}()
	}
	for range 3 {
		run(func() error { _, err := s.Test(context.Background(), ai.RoleClassifier, cf); return err })
		run(func() error { _, err := s.Test(context.Background(), ai.RoleLLM, lf); return err })
		run(func() error { _, err := s.Models(context.Background(), ai.RoleClassifier, cf); return err })
		run(func() error { _, err := s.Models(context.Background(), ai.RoleLLM, lf); return err })
		run(func() error { _, err := s.Classifier().Classify(context.Background(), nil, "q"); return err })
		run(func() error {
			_, err := s.LLM().Complete(context.Background(), ai.Request{Messages: []ai.Message{{Role: "user", Content: "x"}}})
			return err
		})
	}
	// Let the first two reach the server and the rest queue behind them.
	deadline := time.Now().Add(2 * time.Second)
	for g.inflight.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if n := g.inflight.Load(); n != 2 {
		t.Fatalf("%d in flight with all slots taken, want exactly 2", n)
	}
	// Open the gate: the queue drains two at a time.
	g.release()
	wg.Wait()
	if p := g.peak.Load(); p > 2 {
		t.Fatalf("%d calls at once, the limit is 2", p)
	}
}

func TestAWaitingTestGivesUpWithItsContext(t *testing.T) {
	g := newGated(t)
	s := newSvc(t, nil, ai.Options{ClassifierURL: g.URL, MaxConcurrent: 1})
	cf := ai.Fields{Key: str("valid-key"), Model: str("jev-latest")}
	go s.Test(context.Background(), ai.RoleClassifier, cf) // holds the only slot
	for g.inflight.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	hits := g.hits.Load()
	if _, err := s.Test(ctx, ai.RoleClassifier, cf); err == nil || ctx.Err() == nil {
		t.Fatalf("%v", err)
	}
	if _, err := s.Models(ctx, ai.RoleClassifier, cf); err == nil {
		t.Fatal("no error")
	}
	if g.hits.Load() != hits {
		t.Fatal("a call that never got a slot reached the provider")
	}
}

func TestTestsUseTheRolesRequestTimeouts(t *testing.T) {
	var delay atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(time.Duration(delay.Load()))
		switch {
		case r.URL.Path == "/v1/systemone":
			io.WriteString(w, `{"answers":{"question":{"noul":0.9}}}`)
		case r.URL.Path == "/v1/models":
			io.WriteString(w, `{"models":[{"name":"jev-latest"}]}`)
		case r.URL.Path == "/llm/models":
			io.WriteString(w, `{"data":[{"id":"m"}]}`)
		default:
			io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
		}
	}))
	defer srv.Close()
	s := newSvc(t, nil, ai.Options{ClassifierURL: srv.URL, ClassifierTimeout: 30 * time.Millisecond, LLMTimeout: 30 * time.Millisecond, ListTimeout: 5 * time.Second})
	cf := ai.Fields{Key: str("valid-key"), Model: str("jev-latest")}
	lf := ai.Fields{BaseURL: str(srv.URL + "/llm"), Key: str("valid-key"), Model: str("m")}
	delay.Store(int64(150 * time.Millisecond))
	for role, f := range map[ai.Role]ai.Fields{ai.RoleClassifier: cf, ai.RoleLLM: lf} {
		start := time.Now()
		_, err := s.Test(context.Background(), role, f)
		if kind(t, err) != ai.KindTimeout {
			t.Fatalf("%s: %v", role, err)
		}
		if d := time.Since(start); d > 130*time.Millisecond {
			t.Fatalf("%s test took %v: it is bounded by the role's request timeout, not the list timeout", role, d)
		}
		if err := s.Set(role, f); kind(t, err) != ai.KindTestRequired {
			t.Fatalf("a timed-out test saved %s: %v", role, err)
		}
	}
	// A model-list load keeps its own, longer bound.
	if _, err := s.Models(context.Background(), ai.RoleClassifier, cf); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Models(context.Background(), ai.RoleLLM, lf); err != nil {
		t.Fatal(err)
	}
}

func TestALateFailureOfAnOldConfigLeavesTheNewOneAlone(t *testing.T) {
	entered, gate := make(chan struct{}), make(chan struct{})
	var block atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if block.Load() && r.Header.Get("Authorization") == "Bearer old-key" {
			close(entered)
			<-gate
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"answers":{"question":{"noul":0.9}}}`)
	}))
	defer srv.Close()
	s := newSvc(t, nil, ai.Options{ClassifierURL: srv.URL})
	ctx := context.Background()
	f := ai.Fields{Key: str("old-key"), Model: str("jev-latest")}
	if _, err := s.Test(ctx, ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	block.Store(true)
	done := make(chan error, 1)
	go func() { _, err := s.Classifier().Classify(ctx, nil, "q"); done <- err }()
	<-entered
	f.Key = str("new-key")
	if _, err := s.Test(ctx, ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, f); err != nil {
		t.Fatal(err)
	}
	close(gate)
	if err := <-done; kind(t, err) != ai.KindAuthFailed {
		t.Fatalf("the old request still reports its own failure: %v", err)
	}
	if st := s.State(ai.RoleClassifier); st != ai.StateReady {
		t.Fatalf("the new key is %s", st)
	}
	if v := s.View(); v.LastError != nil {
		t.Fatalf("a toast for the new key: %+v", v.LastError)
	}
	// While the failing config is still the current one, it does count.
	block.Store(false)
	g := ai.Fields{Key: str("rejected"), Model: str("jev-latest")}
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer rejected" && block.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"answers":{"question":{"noul":0.9}}}`)
	})
	if _, err := s.Test(ctx, ai.RoleClassifier, g); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleClassifier, g); err != nil {
		t.Fatal(err)
	}
	block.Store(true)
	if _, err := s.Classifier().Classify(ctx, nil, "q"); kind(t, err) != ai.KindAuthFailed {
		t.Fatalf("%v", err)
	}
	if st := s.State(ai.RoleClassifier); st != ai.StateInvalid {
		t.Fatalf("the current config's own failure: %s", st)
	}
}
