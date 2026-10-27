package server_test

// #213 (contract D1): the reply the bridge missed, through the real settled
// turn path and the real ai.Service, with httptest servers standing in for
// the classifier (Jev) and the OpenAI-compatible LLM.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
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
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

const missedCommand = "sudo -k python3 tools/hello_world_server.py 80"

// missedReply is the fixture of internal/cmdrequest: the 27 October reply.
func missedReply(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "cmdrequest", "testdata", "reply-213-first.txt"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if !strings.HasPrefix(hex.EncodeToString(sum[:]), "e3b2b1db2819") {
		t.Fatal("fixture is not the reply")
	}
	return string(b)
}

// modelServers are the classifier and the LLM over HTTP.
type modelServers struct {
	jev, llm   *httptest.Server
	score      atomic.Value // float64: the command_request gate's score
	jevFail    atomic.Int32 // the next n classifications fail with 500
	llmFail    atomic.Int32 // the next n extractions fail with 500
	answer     atomic.Value // string: the extraction's answer
	mu         sync.Mutex
	classified []string // the classifications' bodies
	extracted  []string // the extractions' user messages
}

const extractionPrompt = "Extract only shell commands"

func newModelServers(t *testing.T) (*modelServers, *ai.Service) {
	t.Helper()
	m := &modelServers{}
	m.score.Store(0.52)
	m.answer.Store(`{"commands":[]}`)
	m.jev = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+aiJevKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, `{"models":[{"name":"jev-latest","description":"d"}]}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Questions map[string]string `json:"questions"`
		}
		_ = json.Unmarshal(body, &req)
		if _, ok := req.Questions["command_request"]; ok {
			m.mu.Lock()
			m.classified = append(m.classified, string(body))
			m.mu.Unlock()
			if m.jevFail.Load() > 0 {
				m.jevFail.Add(-1)
				w.WriteHeader(http.StatusInternalServerError)
				io.WriteString(w, `{"error":"boom"}`)
				return
			}
		}
		answers := map[string]any{}
		for k := range req.Questions {
			score := 0.05
			if k == "command_request" {
				score = m.score.Load().(float64)
			}
			answers[k] = map[string]any{"noul": score}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"answers": answers})
	}))
	m.llm = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+aiLLMKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/models") {
			io.WriteString(w, `{"data":[{"id":"m1"}]}`)
			return
		}
		var req struct {
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		content := `{"ok":true}`
		if len(req.Messages) == 2 && strings.HasPrefix(req.Messages[0].Content, extractionPrompt) {
			m.mu.Lock()
			m.extracted = append(m.extracted, req.Messages[1].Content)
			m.mu.Unlock()
			if m.llmFail.Load() > 0 {
				m.llmFail.Add(-1)
				w.WriteHeader(http.StatusInternalServerError)
				io.WriteString(w, `{"error":"boom"}`)
				return
			}
			content = m.answer.Load().(string)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}, "finish_reason": "stop"}}})
	}))
	t.Cleanup(m.jev.Close)
	t.Cleanup(m.llm.Close)
	svc, err := ai.New(ai.Options{File: filepath.Join(t.TempDir(), "ai.json"), ClassifierURL: m.jev.URL})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	str := func(s string) *string { return &s }
	for role, f := range map[ai.Role]ai.Fields{
		ai.RoleClassifier: {Key: str(aiJevKey), Model: str("jev-latest")},
		ai.RoleLLM:        {BaseURL: str(m.llm.URL), Key: str(aiLLMKey), Model: str("m1")},
	} {
		if _, err := svc.Test(ctx, role, f); err != nil {
			t.Fatal(role, err)
		}
		if err := svc.Set(role, f); err != nil {
			t.Fatal(role, err)
		}
	}
	return m, svc
}

func (m *modelServers) calls() (classified, extracted []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.classified...), append([]string(nil), m.extracted...)
}

// turnLines are the log's command request diagnostics.
func (s *syncBuffer) turnLines() []string {
	var out []string
	for _, l := range strings.Split(s.String(), "\n") {
		if strings.Contains(l, `msg="command request turn"`) || strings.Contains(l, `msg="command request closed"`) {
			out = append(out, l)
		}
	}
	return out
}

type pipelineBridge struct {
	*fuBridge
	models *modelServers
	log    *syncBuffer
	c      *client
	id     string
	dir    string
}

// startPipelineBridge is w1 (Claude) on the real ai.Service, follow-up
// questions and schedule suggestions off, manual processes launchable.
func startPipelineBridge(t *testing.T, tweaks ...func(*server.Options)) *pipelineBridge {
	t.Helper()
	models, svc := newModelServers(t)
	logs := &syncBuffer{}
	dir := t.TempDir()
	fb := startFuBridgeWith(t, "", "", newFuRoles(), off(), "", func(o *server.Options) {
		o.FollowupRoles = nil
		o.AI = svc
		o.CommandRequestsEnabled = on()
		o.ScheduleSuggestionsEnabled = off()
		o.CommandRequestRetry = 30 * time.Millisecond
		o.Log = slog.New(slog.NewTextHandler(logs, nil))
		o.Manual = &fakeManual{}
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		for _, tw := range tweaks {
			tw(o)
		}
	})
	t.Cleanup(fb.stop)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	return &pipelineBridge{fuBridge: fb, models: models, log: logs, c: c, id: fb.ids["w1"], dir: dir}
}

func (pb *pipelineBridge) worker(t *testing.T) proto.Worker {
	t.Helper()
	return workersOf(pb.world(func(proto.World) bool { return true }), "s")["w1"]
}

// settle waits until the reply's look is logged (n lines of it).
func (pb *pipelineBridge) settle(t *testing.T, n int) []string {
	t.Helper()
	looks := func() []string {
		var lines []string
		for _, l := range pb.log.turnLines() {
			if strings.Contains(l, `msg="command request turn"`) {
				lines = append(lines, l)
			}
		}
		return lines
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		lines := looks()
		if len(lines) >= n {
			fuQuiet()
			return looks()
		}
		if time.Now().After(deadline) {
			t.Fatalf("logged %d of %d looks:\n%s", len(lines), n, pb.log.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// assertQuietLog checks the diagnostics never carry the reply, a command or
// a working directory.
func (pb *pipelineBridge) assertQuietLog(t *testing.T, w proto.Worker, secrets ...string) {
	t.Helper()
	logs := pb.log.String()
	for _, s := range append([]string{missedCommand, "hello_world_server", "sudo -k", "/home/jeff/repos", "repository root", w.Cwd}, secrets...) {
		if s != "" && strings.Contains(logs, s) {
			t.Fatalf("log carries %q", s)
		}
	}
}

func hasAll(line string, parts ...string) bool {
	for _, p := range parts {
		if !strings.Contains(line, p) {
			return false
		}
	}
	return true
}

// The missed reply scores 0.52: its fenced `sudo -k` command and the
// "launch … use:" ask admit it to extraction in the lower band, and the
// card carries the exact command for the bridge in the worker's directory.
// Edit and run (the same start) launches it byte for byte, with askpass.
func TestCommandRequestMissedReplyThroughPipeline(t *testing.T) {
	pb := startPipelineBridge(t)
	reply := missedReply(t)
	pb.models.answer.Store(`{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","cwd":"the repository root","host":"bridge","why":"To launch it through Herdr"}]}`)
	pb.say(t, "missed", reply)
	w := upsertFor(pb.c, pb.id, func(w *proto.Worker) bool { return w.CommandRequest != nil })
	req := w.CommandRequest
	sum := sha256.Sum256([]byte(reply))
	if req.Key != hex.EncodeToString(sum[:]) || len(req.Commands) != 1 {
		t.Fatalf("request: %+v", req)
	}
	got := req.Commands[0]
	if got.Command != missedCommand || got.Host != "bridge" || got.Cwd != w.Cwd || got.CwdNamed || got.HostText != "" {
		t.Fatalf("command: %+v (worker cwd %q)", got, w.Cwd)
	}
	lines := pb.settle(t, 1)
	if !hasAll(lines[0], "gate=candidate", "rule=fence", "score=0.52", "threshold=0.7", "band=0.35", "extract=ok", "commands=1",
		"persisted=true", "published=true", "stale=false", "attempt=1", "hash=e3b2b1db2819", "worker="+pb.id) {
		t.Fatalf("diagnostics: %s", lines[0])
	}
	classified, extracted := pb.models.calls()
	if len(classified) != 1 || len(extracted) != 1 || extracted[0] != reply {
		t.Fatalf("calls: %d classifications, %d extractions", len(classified), len(extracted))
	}
	// Edit and run: the form starts the same command, unchanged.
	_, m := pb.c.command(proto.CmdManualProcessStart, "edit-and-run", proto.ManualProcessStartArgs{Op: "missed-213", Worker: pb.id, Cwd: pb.dir,
		Command: got.Command, Askpass: true, Source: &proto.ManualSource{Kind: "suggestion", Key: req.Key, Index: 0}})
	if m.env.T != proto.TAck {
		t.Fatalf("start: %s", m.raw)
	}
	p := ackData[proto.ManualProcessResult](t, m).Process
	if p.Command != missedCommand || p.Launched != "sudo -A -k python3 tools/hello_world_server.py 80" || p.Source.Kind != "suggestion" {
		t.Fatalf("process: %+v", p)
	}
	pb.assertQuietLog(t, *w)
}

// A named absolute directory in the reply is used as the cwd.
func TestCommandRequestMissedReplyNamedCwd(t *testing.T) {
	pb := startPipelineBridge(t)
	pb.models.answer.Store(`{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","cwd":"/home/jeff/repos/jeffreyvdb/herdr-3d","host":"bridge"}]}`)
	pb.say(t, "named", missedReply(t))
	w := upsertFor(pb.c, pb.id, func(w *proto.Worker) bool { return w.CommandRequest != nil })
	if got := w.CommandRequest.Commands[0]; got.Command != missedCommand || got.Cwd != "/home/jeff/repos/jeffreyvdb/herdr-3d" || !got.CwdNamed {
		t.Fatalf("command: %+v", got)
	}
}

// What must never become a runnable card, in the same pipeline.
func TestCommandRequestPipelineNegatives(t *testing.T) {
	example := "For example, you could run:\n\n```sh\nmake test\n```\n\nNothing else is needed."
	ran := "I ran this and every test passed:\n\n```sh\nmake test\n```"
	cases := []struct {
		name, reply, answer string
		score               float64
		extractions         int
		log                 []string
	}{
		{"example below the threshold", example, `{"commands":[{"command":"make test","host":"bridge"}]}`, 0.52, 0, []string{"gate=below", "rule=\"\"", "extract=skipped", "commands=0"}},
		{"example the model excludes", example, `{"commands":[]}`, 0.9, 1, []string{"gate=threshold", "extract=ok", "commands=0", "published=false"}},
		{"already ran below the threshold", ran, `{"commands":[{"command":"make test","host":"bridge"}]}`, 0.52, 0, []string{"gate=below", "extract=skipped"}},
		{"already ran, the model excludes", ran, `{"commands":[]}`, 0.9, 1, []string{"gate=threshold", "commands=0"}},
		{"inline mention below the threshold", "Run `make test` if you want to double check.", `{"commands":[{"command":"make test","host":"bridge"}]}`, 0.52, 0, []string{"gate=below"}},
		{"a span not in the reply", "", `{"commands":[{"command":"sudo python3 tools/hello_world_server.py 80","host":"bridge"}]}`, 0.52, 1, []string{"gate=candidate", "commands=0", "rejected=not_in_reply:1", "published=false"}},
		{"a fabricated host text", "", `{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","host":"other","host_text":"your Mac"}]}`, 0.52, 1, []string{"commands=0", "rejected=host_text:1"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pb := startPipelineBridge(t)
			reply := c.reply
			if reply == "" {
				reply = missedReply(t)
			}
			pb.models.score.Store(c.score)
			pb.models.answer.Store(c.answer)
			pb.say(t, "negative", reply)
			lines := pb.settle(t, 1)
			if !hasAll(lines[0], c.log...) {
				t.Fatalf("diagnostics: %s", lines[0])
			}
			if _, extracted := pb.models.calls(); len(extracted) != c.extractions {
				t.Fatalf("extractions %d, want %d", len(extracted), c.extractions)
			}
			if w := pb.worker(t); w.CommandRequest != nil {
				t.Fatalf("request: %+v", w.CommandRequest)
			}
		})
	}
}

// An ambiguous host is shown for review but never runs on the bridge.
func TestCommandRequestPipelineAmbiguousHost(t *testing.T) {
	pb := startPipelineBridge(t)
	pb.models.answer.Store(`{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","host":"unknown"}]}`)
	pb.say(t, "ambiguous", missedReply(t))
	req := upsertFor(pb.c, pb.id, func(w *proto.Worker) bool { return w.CommandRequest != nil }).CommandRequest
	if req.Commands[0].Host != "unknown" || req.Commands[0].Command != missedCommand {
		t.Fatalf("request: %+v", req)
	}
	pb.c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "ambiguous", Worker: pb.id, Cwd: pb.dir, Command: missedCommand,
		Source: &proto.ManualSource{Kind: "suggestion", Key: req.Key, Index: 0}}, proto.ErrStale)
}

// Model failures: a transient one is retried twice (only the command
// request's look), then recorded as failed so a restart does not ask again;
// one that recovers publishes on the retry.
func TestCommandRequestPipelineModelErrors(t *testing.T) {
	cases := []struct {
		name     string
		setup    func(m *modelServers)
		attempts int
		log      []string
		request  bool
	}{
		{"classifier error", func(m *modelServers) { m.jevFail.Store(100) }, 3, []string{"error_stage=classifier", "persisted=true", "attempt=3"}, false},
		{"LLM error", func(m *modelServers) { m.llmFail.Store(100) }, 3, []string{"error_stage=extraction", "extract=error", "attempt=3", "persisted=true"}, false},
		{"malformed extraction", func(m *modelServers) { m.answer.Store("Sure, here it is: sudo -k python3") }, 3, []string{"error_kind=malformed", "attempt=3", "persisted=true"}, false},
		{"classifier recovers", func(m *modelServers) {
			m.jevFail.Store(2) // the ai client's own retry, then the hub's
			m.answer.Store(`{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","host":"bridge"}]}`)
		}, 2, []string{"attempt=2", "published=true"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pb := startPipelineBridge(t)
			c.setup(pb.models)
			pb.say(t, "errors", missedReply(t))
			lines := pb.settle(t, c.attempts)
			last := lines[len(lines)-1]
			if !hasAll(last, c.log...) || len(lines) != c.attempts {
				t.Fatalf("diagnostics:\n%s", strings.Join(lines, "\n"))
			}
			for _, l := range lines[:len(lines)-1] {
				if !strings.Contains(l, "retry_in=") || strings.Contains(l, "retry_in=0s") {
					t.Fatalf("no retry: %s", l)
				}
			}
			if w := pb.worker(t); (w.CommandRequest != nil) != c.request {
				t.Fatalf("request: %+v", w.CommandRequest)
			}
			pb.assertQuietLog(t, pb.worker(t))
			// Nothing more is asked afterwards.
			classified, extracted := pb.models.calls()
			fuQuiet()
			c2, e2 := pb.models.calls()
			if len(c2) != len(classified) || len(e2) != len(extracted) {
				t.Fatal("asked again after the last attempt")
			}
		})
	}
}

// A request the transcript moved past closes (moved), and a launch of it is
// refused as stale.
func TestCommandRequestPipelineStaleTurn(t *testing.T) {
	pb := startPipelineBridge(t)
	pb.models.answer.Store(`{"commands":[{"command":"sudo -k python3 tools/hello_world_server.py 80","host":"bridge"}]}`)
	pb.say(t, "stale", missedReply(t))
	req := upsertFor(pb.c, pb.id, func(w *proto.Worker) bool { return w.CommandRequest != nil }).CommandRequest
	appendTo(t, pb.claude, wrapUser("Never mind, do it differently."))
	upsertFor(pb.c, pb.id, func(w *proto.Worker) bool { return w.CommandRequest == nil })
	pb.c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "stale-213", Worker: pb.id, Cwd: pb.dir, Command: missedCommand,
		Source: &proto.ManualSource{Kind: "suggestion", Key: req.Key, Index: 0}}, proto.ErrStale)
	var closed bool
	for _, l := range pb.log.turnLines() {
		closed = closed || hasAll(l, `msg="command request closed"`, "outcome=moved", "hash=e3b2b1db2819")
	}
	if !closed {
		t.Fatalf("no close line:\n%s", strings.Join(pb.log.turnLines(), "\n"))
	}
}

// A settled turn the feature does not look at still gets its line, with
// why.
func TestCommandRequestPipelineSkipLine(t *testing.T) {
	pb := startPipelineBridge(t, func(o *server.Options) { o.CommandRequestsEnabled = off() })
	pb.say(t, "skipped", missedReply(t))
	lines := pb.settle(t, 1)
	if !hasAll(lines[0], "hash=e3b2b1db2819", `skip="the feature is not ready"`, "turn=") || strings.Contains(lines[0], "score=") {
		t.Fatalf("diagnostics: %s", lines[0])
	}
	if classified, extracted := pb.models.calls(); len(classified)+len(extracted) != 0 {
		t.Fatal("models asked")
	}
}
