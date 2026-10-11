package server_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

const (
	aiJevKey = "jev-key-0123456789-secret"
	aiLLMKey = "sk-llm-key-abcdefghij-secret"
)

type aiFakes struct {
	jev, llm *httptest.Server
	revoked  atomic.Bool
	calls    atomic.Int32
	svc      *ai.Service
}

func newAIFakes(t *testing.T, env ai.Overrides) *aiFakes {
	t.Helper()
	f := &aiFakes{}
	f.jev = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if f.revoked.Load() || r.Header.Get("Authorization") != "Bearer "+aiJevKey {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":"unauthorized"}`)
			return
		}
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, `{"models":[{"name":"jev-latest","description":"d"}]}`)
			return
		}
		io.WriteString(w, `{"answers":{"question":{"noul":0.9}}}`)
	}))
	f.llm = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+aiLLMKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/models") {
			io.WriteString(w, `{"data":[{"id":"m1"}]}`)
			return
		}
		io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
	}))
	t.Cleanup(f.jev.Close)
	t.Cleanup(f.llm.Close)
	svc, err := ai.New(ai.Options{File: filepath.Join(t.TempDir(), "ai.json"), ClassifierURL: f.jev.URL, Env: env})
	if err != nil {
		t.Fatal(err)
	}
	f.svc = svc
	return f
}

// raw sends a command and returns every frame up to its reply, as text.
func rawCommand(c *client, typ string, args any) (frames string, reply msg) {
	c.t.Helper()
	evs, m := c.command(typ, typ, args)
	var sb strings.Builder
	for _, e := range evs {
		b, _ := json.Marshal(e)
		sb.Write(b)
	}
	sb.Write(m.raw)
	return sb.String(), m
}

func TestAICommandsEndToEndAndKeysNeverOnTheWire(t *testing.T) {
	t.Parallel()
	f := newAIFakes(t, ai.Overrides{})
	b := startBridge(t, "", server.Options{AI: f.svc})
	c := b.connect(proto.Hello{Client: "ai-test"})
	other := b.connect(proto.Hello{Client: "other"})
	snap := c.snapshot()
	other.snapshot()
	if snap.World.AI == nil || snap.World.AI.Classifier.State != ai.StateOff || snap.World.AI.LLM.State != ai.StateOff {
		t.Fatalf("snapshot ai = %+v", snap.World.AI)
	}
	if f.calls.Load() != 0 {
		t.Fatal("a call before anyone asked")
	}
	var wire strings.Builder
	cmd := func(typ string, args any) msg {
		frames, m := rawCommand(c, typ, args)
		wire.WriteString(frames)
		return m
	}
	ackOf := func(m msg, v any) {
		t.Helper()
		if m.env.T != proto.TAck {
			t.Fatalf("%s", m.raw)
		}
		var a struct {
			Data json.RawMessage `json:"data"`
		}
		json.Unmarshal(m.raw, &a)
		if err := json.Unmarshal(a.Data, v); err != nil {
			t.Fatal(err)
		}
	}
	codeOf := func(m msg) string {
		var e proto.Error
		json.Unmarshal(m.raw, &e)
		if m.env.T != proto.TError {
			t.Fatalf("not an error: %s", m.raw)
		}
		return e.Code
	}

	var view proto.AI
	ackOf(cmd(proto.CmdAIGet, nil), &view)
	if view.Classifier.State != ai.StateOff {
		t.Fatalf("%+v", view)
	}

	// Models: a rejected key is auth_failed; the right one lists.
	if code := codeOf(cmd(proto.CmdAIModels, proto.AIFieldsArgs{Role: "classifier", Key: ptr("wrong-key-0123456789")})); code != proto.ErrAuthFailed {
		t.Fatalf("code %s", code)
	}
	var models proto.AIModelsResult
	ackOf(cmd(proto.CmdAIModels, proto.AIFieldsArgs{Role: "classifier", Key: ptr(aiJevKey)}), &models)
	if len(models.Models) != 1 || models.Models[0].ID != "jev-latest" {
		t.Fatalf("%+v", models)
	}

	// Set needs a passing test first.
	set := proto.AIFieldsArgs{Role: "classifier", Key: ptr(aiJevKey), Model: ptr("jev-latest")}
	if code := codeOf(cmd(proto.CmdAISet, set)); code != proto.ErrTestRequired {
		t.Fatalf("code %s", code)
	}
	var tr proto.AITestResult
	ackOf(cmd(proto.CmdAITest, set), &tr)
	if !tr.OK || tr.Score == nil || *tr.Score != 0.9 {
		t.Fatalf("%+v", tr)
	}
	ackOf(cmd(proto.CmdAISet, set), &view)
	if view.Classifier.State != ai.StateReady || !view.Classifier.KeySet || view.Classifier.KeyHint != "cret" {
		t.Fatalf("%+v", view.Classifier)
	}
	// The other client heard it as one ai.update, flat.
	ev := other.until(proto.EvAIUpdate)
	if ev.AI == nil || ev.Classifier.State != ai.StateReady || ev.LLM.State != ai.StateOff {
		t.Fatalf("%+v", ev)
	}

	// LLM with a base URL that needs /v1 added... the fake serves /models anywhere; set it plainly.
	llm := proto.AIFieldsArgs{Role: "llm", BaseURL: ptr(f.llm.URL + "/"), Key: ptr(aiLLMKey), Model: ptr("m1"), ExtraBody: json.RawMessage(`{"thinking":{"type":"disabled"}}`)}
	if code := codeOf(cmd(proto.CmdAITest, proto.AIFieldsArgs{Role: "llm", BaseURL: ptr("ftp://x"), Model: ptr("m")})); code != proto.ErrBadRequest {
		t.Fatalf("bad base url: %s", code)
	}
	ackOf(cmd(proto.CmdAITest, llm), &tr)
	if tr.JSONMode == nil || !*tr.JSONMode || tr.BaseURL != f.llm.URL {
		t.Fatalf("%+v", tr)
	}
	ackOf(cmd(proto.CmdAISet, llm), &view)
	if view.LLM.State != ai.StateReady || view.LLM.BaseURL != f.llm.URL || string(view.LLM.ExtraBody) != `{"thinking":{"type":"disabled"}}` {
		t.Fatalf("%+v", view.LLM)
	}
	if code := codeOf(cmd(proto.CmdAIClear, proto.AIRoleArgs{Role: "nobody"})); code != proto.ErrBadRequest {
		t.Fatalf("code %s", code)
	}
	if code := codeOf(cmd(proto.CmdAIGet, map[string]any{"x": 1})); code != proto.ErrBadRequest {
		t.Fatalf("code %s", code)
	}

	// A runtime 401 pauses the role for everyone and is announced.
	f.revoked.Store(true)
	if _, err := f.svc.Classifier().Classify(context.Background(), nil, "q"); ai.KindOf(err) != ai.KindAuthFailed {
		t.Fatal(err)
	}
	for ev = other.until(proto.EvAIUpdate); ev.Classifier.State != ai.StateInvalid; ev = other.until(proto.EvAIUpdate) {
	}
	if ev.Classifier.State != ai.StateInvalid || ev.LastError == nil || !ev.LastError.Runtime || ev.LastError.Role != ai.RoleClassifier {
		t.Fatalf("%+v", ev)
	}
	before := f.calls.Load()
	if _, err := f.svc.Classifier().Classify(context.Background(), nil, "q"); err == nil {
		t.Fatal("a paused role answered")
	}
	if f.calls.Load() != before {
		t.Fatal("a paused role called out")
	}

	// Clear.
	ackOf(cmd(proto.CmdAIClear, proto.AIRoleArgs{Role: "llm"}), &view)
	if view.LLM.State != ai.StateOff || view.LLM.KeySet {
		t.Fatalf("%+v", view.LLM)
	}

	// A late client sees the state in its snapshot.
	late := b.connect(proto.Hello{})
	if s := late.snapshot(); s.World.AI == nil || s.World.AI.Classifier.State != ai.StateInvalid {
		t.Fatalf("%+v", s.World.AI)
	}

	// Nothing the bridge sent, or wrote to the audit log, holds a key.
	for _, k := range []string{aiJevKey, aiLLMKey, "wrong-key-0123456789"} {
		if strings.Contains(wire.String(), k) {
			t.Errorf("the key %q is on the wire", k)
		}
	}
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range log {
		if !strings.HasPrefix(e.Cmd, "ai.") {
			continue
		}
		n++
		blob, _ := json.Marshal(e)
		for _, k := range []string{aiJevKey, aiLLMKey, "wrong-key-0123456789"} {
			if strings.Contains(string(blob), k) {
				t.Errorf("the key %q is in the audit log: %s", k, blob)
			}
		}
	}
	if n < 8 {
		t.Fatalf("%d ai rows in the audit log", n)
	}
}

func TestAIEnvironmentIsShownReadOnly(t *testing.T) {
	t.Parallel()
	keyFile := filepath.Join(t.TempDir(), "k")
	if err := writeFile(keyFile, aiJevKey); err != nil {
		t.Fatal(err)
	}
	f := newAIFakes(t, ai.Overrides{ClassifierKeyFile: keyFile, ClassifierModel: "jev-latest"})
	b := startBridge(t, "", server.Options{AI: f.svc})
	c := b.connect(proto.Hello{})
	snap := c.snapshot()
	cl := snap.World.AI.Classifier
	if cl.State != ai.StateReady || len(cl.Env) != 2 || !cl.KeySet || cl.KeyHint != "cret" {
		t.Fatalf("%+v", cl)
	}
	c.mustError(proto.CmdAISet, proto.AIFieldsArgs{Role: "classifier", Model: ptr("jev-preview")}, proto.ErrEnvLocked)
}

func TestAICommandsAreUnsupportedWithoutTheService(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	if s := c.snapshot(); s.World.AI != nil {
		t.Fatalf("%+v", s.World.AI)
	}
	c.mustError(proto.CmdAIGet, nil, proto.ErrUnsupported)
	c.mustError(proto.CmdAITest, proto.AIFieldsArgs{Role: "llm"}, proto.ErrUnsupported)
}

func writeFile(path, s string) error { return os.WriteFile(path, []byte(s+"\n"), 0o600) }
