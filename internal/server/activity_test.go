package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #98 activity against the fake herdr floor and real transcript files the
// usage tracker reads (the fixtures of internal/transcript/testdata): w1 is
// a Claude agent (session wrapSess), w2 a Codex one (wrapCodex), w3 a shell.

// actRoles plays the AI integration's classifier.
type actRoles struct {
	mu    sync.Mutex
	state ai.State
	cls   *ai.FakeClassifier
}

func (r *actRoles) State(ai.Role) ai.State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}
func (r *actRoles) Classifier() ai.Classifier { return r.cls }
func (r *actRoles) calls() int                { return len(r.cls.Calls()) }

type actBridge struct {
	*hireBridge
	dir, claude, codex string
	ids                map[string]string
	clock              *actClock
}

// actClock is 2026-10-01T19:21:00Z when the bridge starts, then runs: the
// background fixtures' tasks are minutes old. pass moves it on at once.
type actClock struct {
	start, at time.Time
	mu        sync.Mutex
	skipped   time.Duration
}

func newActClock() *actClock {
	at, _ := time.Parse(time.RFC3339, "2026-10-01T19:21:00Z")
	return &actClock{start: time.Now(), at: at}
}

func (c *actClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at.Add(time.Since(c.start) + c.skipped)
}

func (c *actClock) pass(d time.Duration) {
	c.mu.Lock()
	c.skipped += d
	c.mu.Unlock()
}

// actSettle is long enough for the usage tracker (every 15 ms) to have read
// what a test just appended.
const actSettle = 100 * time.Millisecond

// wait lets d go by on the bridge's clock, as a sleep of d would: the
// tracker reads what was appended, then the clock moves on at once. Should
// the tracker read late, the label holds in real time as before: slower,
// never wrong.
func (ab *actBridge) wait(d time.Duration) {
	time.Sleep(actSettle)
	ab.clock.pass(d)
}

func startActBridge(t *testing.T, tweak func(*server.Options)) *actBridge {
	t.Helper()
	dir := t.TempDir()
	ab := &actBridge{dir: dir, clock: newActClock(), claude: filepath.Join(dir, "claude", "-home-u-w1", wrapSess+".jsonl"),
		codex: filepath.Join(dir, "codex", "2026", "10", "01", "rollout-2026-10-01T09-00-00-"+wrapCodex+".jsonl")}
	writeTranscript(t, ab.claude, wrapUser("Hi.")+wrapSay("m0", "Hello.", "end_turn")+wrapTurnEnd)
	writeTranscript(t, ab.codex, `{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"`+wrapCodex+`","cwd":"`+wrapWT2+`"}}`+"\n")
	w1 := linkedWorker("w1", "h3d/pixel-a1b2c3")
	w1.AgentSession, w1.Harness, w1.Status = wrapSess, world.HarnessClaude, "idle"
	w2 := withKind(linkedWorker("w2", "h3d/mochi-d4e5f6"), "codex")
	w2.AgentSession, w2.Harness, w2.Status = wrapCodex, world.HarnessCodex, "idle"
	w3 := worker("w3", "notes", "", "working")
	ab.hireBridge = startHireBridgeAt(t, "", func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: filepath.Join(dir, "claude"), CodexSessions: filepath.Join(dir, "codex")},
			Interval: 15 * time.Millisecond}
		o.Now = ab.clock.now
		if tweak != nil {
			tweak(o)
		}
	}, w1, w2, w3)
	ws := workersOf(ab.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 3 }), "s")
	ab.ids = map[string]string{}
	for k, w := range ws {
		ab.ids[k] = w.ID
	}
	return ab
}

func (ab *actBridge) status(ws, status string) {
	ab.fl.update(ws, func(w *world.WorkerObs) { w.Status = status })
}

// fixture appends lines of a transcript fixture (all when to is 0).
func (ab *actBridge) fixture(t *testing.T, harness, file string, from, to int) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "transcript", "testdata", harness, file))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.SplitAfter(strings.TrimRight(string(b), "\n"), "\n")
	if to == 0 {
		to = len(lines)
	}
	s := strings.Join(lines[from:to], "")
	if !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	path := ab.claude
	if harness == "codex" {
		path = ab.codex
	}
	appendTo(t, path, s)
}

// activityOf reads events until worker id's activity (in a worker.activity
// or its upsert) passes ok.
func activityOf(c *client, id string, ok func(*proto.Activity) bool) *proto.Activity {
	c.t.Helper()
	for {
		ev := c.event()
		switch {
		case ev.T == proto.EvWorkerActivity && ev.ID == id && ok(ev.Activity):
			return ev.Activity
		case ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ok(ev.Worker.Activity):
			return ev.Worker.Activity
		}
	}
}

// workingWith reads events until worker id is working with an activity that
// passes ok. herdr's status comes in a worker.upsert when the activity
// changes with it, else (the tracker has not read the worker yet) in a
// worker.status, the activity following in a worker.activity.
func workingWith(c *client, id string, ok func(*proto.Activity) bool) {
	c.t.Helper()
	status, shown := "", false
	var a *proto.Activity
	for status != "working" || !shown || !ok(a) {
		switch ev := c.event(); {
		case ev.T == proto.EvWorkerStatus && ev.ID == id:
			status = ev.Status
		case ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id:
			status, a, shown = ev.Worker.Status, ev.Worker.Activity, true
		case ev.T == proto.EvWorkerActivity && ev.ID == id:
			a, shown = ev.Activity, true
		}
	}
}

func kindIs(k activity.Kind) func(*proto.Activity) bool {
	return func(a *proto.Activity) bool { return a != nil && a.Kind == k }
}

func none(a *proto.Activity) bool { return a == nil }

func claudeToolLine(id, name string, input any) string {
	in, _ := json.Marshal(input)
	b, _ := json.Marshal(map[string]any{"type": "assistant", "isSidechain": false, "message": map[string]any{"id": "msg-" + id,
		"role": "assistant", "stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use", "id": id,
			"name": name, "input": json.RawMessage(in)}}}})
	return string(b) + "\n"
}

func claudeResultLine(id, text string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user",
		"content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": text}}}})
	return string(b) + "\n"
}

// What a Claude worker does goes out as it does it: Thinking, then its tool's
// label, nothing once herdr says idle, and never for a shell.
func TestActivityOnTheWire(t *testing.T) {
	t.Parallel()
	ab := startActBridge(t, nil)
	c := ab.c
	w1, w3 := ab.ids["w1"], ab.ids["w3"]
	ab.status("w1", "working")
	appendTo(t, ab.claude, wrapUser("Run the tests."))
	a := activityOf(c, w1, kindIs(activity.KindThinking))
	if a.Source != activity.SourceDerived || a.Since == 0 {
		t.Fatalf("%+v", a)
	}
	ab.wait(transcript.LabelHold) // the label holds
	appendTo(t, ab.claude, claudeToolLine("t1", "Bash", map[string]any{"command": "cd backend && uv run pytest -n auto | tail -5"}))
	a = activityOf(c, w1, kindIs(activity.KindTesting))
	if a.Detail != "pytest -n auto" || a.Source != activity.SourceRule {
		t.Fatalf("%+v", a)
	}
	// In the snapshot too.
	snap := ab.connect(proto.Hello{}).snapshot()
	for _, w := range snap.World.Workers {
		switch w.ID {
		case w1:
			if w.Activity == nil || w.Activity.Kind != activity.KindTesting {
				t.Fatalf("snapshot: %+v", w.Activity)
			}
		case w3:
			if w.Activity != nil {
				t.Fatalf("a shell has an activity: %+v", w.Activity)
			}
		}
	}
	// Idle: no activity, in the same upsert as the status.
	ab.status("w1", "idle")
	w := upsertFor(c, w1, func(w *proto.Worker) bool { return w.Status == "idle" })
	if w.Activity != nil {
		t.Fatalf("idle with %+v", w.Activity)
	}
	// Working again with no prompt read: the previous turn's tool does not
	// come back.
	ab.status("w1", "working")
	w = upsertFor(c, w1, func(w *proto.Worker) bool { return w.Status == "working" })
	time.Sleep(100 * time.Millisecond)
	if w.Activity != nil && w.Activity.Kind == activity.KindTesting {
		t.Fatalf("the previous turn's tool: %+v", w.Activity)
	}
	activityOf(c, w1, kindIs(activity.KindThinking))
}

// Changes go out at most twice a second per worker, the last one always.
func TestActivityIsThrottled(t *testing.T) {
	// Not parallel: it counts events per wall-clock second.
	ab := startActBridge(t, nil)
	w1 := ab.ids["w1"]
	ab.status("w1", "working")
	workingWith(ab.c, w1, kindIs(activity.KindThinking))
	// Read the events as they come, with when.
	type seen struct {
		at time.Time
		a  *proto.Activity
	}
	var mu sync.Mutex
	var got []seen
	go func() {
		for {
			env, raw, err := ab.c.conn.Read(context.Background())
			if err != nil {
				return
			}
			var ev proto.Event
			if env.T == proto.EvWorkerActivity && json.Unmarshal(raw, &ev) == nil && ev.ID == w1 {
				mu.Lock()
				got = append(got, seen{time.Now(), ev.Activity})
				mu.Unlock()
			}
		}
	}()
	// Every prompt starts a turn: a new Thinking each time.
	var last string
	for i := range 30 {
		last = fmt.Sprint("prompt ", i)
		appendTo(t, ab.claude, wrapUser(last))
		time.Sleep(40 * time.Millisecond)
	}
	time.Sleep(1200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(got) < 2 || len(got) > 5 {
		t.Fatalf("%d worker.activity events for 30 changes in 1.2 s", len(got))
	}
	for i := 1; i < len(got); i++ {
		if d := got[i].at.Sub(got[i-1].at); d < 400*time.Millisecond {
			t.Fatalf("two worker.activity events %v apart", d)
		}
	}
	// The last change went out: its Thinking started after the last prompt.
	if a := got[len(got)-1].a; a == nil || a.Kind != activity.KindThinking || a.Since < got[0].a.Since {
		t.Fatalf("%+v", a)
	}
}

// #98 §3b with the real lines: a turn that ends with open tasks is waiting
// while idle, each notification closes its task, the last one clears it.
func TestActivityWaitingOnBackgroundTasks(t *testing.T) {
	t.Parallel()
	ab := startActBridge(t, nil)
	c := ab.c
	w1 := ab.ids["w1"]
	ab.status("w1", "working")
	ab.fixture(t, "claude", "activity_bg_open.jsonl", 0, 0) // read in one round: the turn is over already
	time.Sleep(200 * time.Millisecond)
	ab.status("w1", "done")
	a := activityOf(c, w1, func(a *proto.Activity) bool { return a != nil && a.Kind == activity.KindWaiting })
	end, _ := time.Parse(time.RFC3339Nano, "2026-10-01T19:20:52.331Z")
	if a == nil || a.Kind != activity.KindWaiting || a.Tasks != 5 || a.Since != end.UnixMilli() || a.Detail == "" {
		t.Fatalf("%+v", a)
	}
	ab.fixture(t, "claude", "activity_bg_notify.jsonl", 0, 3) // a monitor event, the Bash completed
	activityOf(c, w1, func(a *proto.Activity) bool { return a != nil && a.Tasks == 4 })
	ab.fixture(t, "claude", "activity_bg_notify.jsonl", 3, 0) // the rest: all closed
	activityOf(c, w1, none)
}

// The image an agent looks at is on its monitor: a Claude Read of a png, a
// Codex code-mode exec with view_image. Its thumbnail is served to a
// connection on the worker's floor, by the hash the activity shows now; not
// to another connection, nor by another hash.
func TestActivityImageIsServedToItsFloor(t *testing.T) {
	t.Parallel()
	cache, err := imgcache.New(imgcache.Config{})
	if err != nil {
		t.Fatal(err)
	}
	ab := startActBridge(t, func(o *server.Options) { o.Usage.Images = &transcript.Images{Cache: cache} })
	c, other := ab.c, ab.connect(proto.Hello{Client: "elsewhere"})
	other.snapshot()
	w1, w2 := ab.ids["w1"], ab.ids["w2"]
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"}) // the floor c stands on
	ab.status("w1", "working")
	ab.fixture(t, "claude", "activity_read_png.jsonl", 0, 0)
	a := activityOf(c, w1, kindIs(activity.KindImage))
	if a.Image == nil || len(a.Image.Hash) != 64 || a.Image.W != 1 || a.Image.H != 1 || a.Detail != "needs-you-desk.png" {
		t.Fatalf("%+v %+v", a, a.Image)
	}
	_, ack := c.mustAck(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w1, Hash: a.Image.Hash, Size: proto.ImageThumb})
	b, _ := json.Marshal(ack.Data)
	var img proto.TranscriptImageResult
	if json.Unmarshal(b, &img) != nil || img.Mime != "image/png" || img.Width != 1 || img.Data == "" || img.Size != proto.ImageThumb {
		t.Fatalf("%s", b)
	}
	// Not on the floor: refused, as before.
	other.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w1, Hash: a.Image.Hash, Size: proto.ImageThumb}, proto.ErrInvalidState)
	// Another hash (one the activity does not show): refused.
	stale := strings.Repeat("ab", 32)
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w1, Hash: stale, Size: proto.ImageThumb}, proto.ErrInvalidState)
	// Never the whole image this way.
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w1, Hash: a.Image.Hash, Size: proto.ImageFull}, proto.ErrInvalidState)
	// A connection that left the floor no longer may.
	c.mustAck(proto.CmdBoardUnwatch, proto.BoardArgs{Session: "s"})
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w1, Hash: a.Image.Hash, Size: proto.ImageThumb}, proto.ErrInvalidState)

	// Codex: the code-mode exec with write_stdin and view_image.
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	ab.status("w2", "working")
	ab.fixture(t, "codex", "activity_exec.jsonl", 1, 10)
	a = activityOf(c, w2, kindIs(activity.KindImage))
	if a.Detail != "needs-you-desk.png" || a.Image == nil {
		t.Fatalf("%+v", a)
	}
	c.mustAck(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: w2, Hash: a.Image.Hash, Size: proto.ImageThumb})
}

func newActRoles() *actRoles {
	r := &actRoles{state: ai.StateReady, cls: &ai.FakeClassifier{}}
	r.cls.ManyFunc = func(_ context.Context, state map[string]any, _ map[string]string) (map[string]float64, error) {
		if strings.Contains(state["command"].(string), "wait_for_results") {
			return map[string]float64{"waiting": 0.93, "investigating": 0.66}, nil
		}
		return map[string]float64{"investigating": 0.56, "writing": 0.53}, nil
	}
	return r
}

func activityState(t *testing.T, c *client, typ string, args any) proto.ActivityState {
	t.Helper()
	_, ack := c.mustAck(typ, args)
	b, _ := json.Marshal(ack.Data)
	var s proto.ActivityState
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func yes() *bool { v := true; return &v }

// "Classify unknown commands": off, or the classifier not ready, nothing is
// sent and an unplaced command is Working; on, it is asked about once (the
// same normalised command again is the cache's), only for a floor someone
// stands on, and its answer shows.
func TestActivityModelOptIn(t *testing.T) {
	t.Parallel()
	roles := newActRoles()
	ab := startActBridge(t, func(o *server.Options) { o.ActivityRoles = roles })
	c := ab.c
	w1 := ab.ids["w1"]
	if s := activityState(t, c, proto.CmdActivityGet, nil); s.ModelEnabled || s.State != proto.ActivityOff || s.Threshold != 0.6 ||
		s.Margin != 0.2 || s.DailyCap != 2000 || s.Classifier != "ready" {
		t.Fatalf("%+v", s)
	}
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	ab.status("w1", "working")
	appendTo(t, ab.claude, wrapUser("Wait for the coders."))
	ab.wait(transcript.LabelHold)
	wait := claudeToolLine("t1", "Bash", map[string]any{"command": "python3 /home/u/.agents/skills/write-code/scripts/wait_for_results.py /runs/20261002-0603-activity --timeout 600"})
	appendTo(t, ab.claude, wait)
	a := activityOf(c, w1, kindIs(activity.KindWorking))
	if a.Source != activity.SourceRule || a.Detail == "" {
		t.Fatalf("%+v", a)
	}
	time.Sleep(200 * time.Millisecond)
	if n := roles.calls(); n != 0 {
		t.Fatalf("switched off: %d calls", n)
	}
	// On, but the classifier not ready: still nothing.
	roles.mu.Lock()
	roles.state = ai.StateIncomplete
	roles.mu.Unlock()
	if s := activityState(t, c, proto.CmdActivitySet, proto.ActivitySetArgs{ModelEnabled: yes()}); s.State != proto.ActivityIncomplete {
		t.Fatalf("%+v", s)
	}
	time.Sleep(200 * time.Millisecond)
	if n := roles.calls(); n != 0 {
		t.Fatalf("not ready: %d calls", n)
	}
	roles.mu.Lock()
	roles.state = ai.StateReady
	roles.mu.Unlock()
	// Ready (the bridge sees it on the next state change: a setting).
	th := 0.6
	activityState(t, c, proto.CmdActivitySet, proto.ActivitySetArgs{Threshold: &th})
	a = activityOf(c, w1, kindIs(activity.KindWaiting))
	if a.Source != activity.SourceModel {
		t.Fatalf("%+v", a)
	}
	if n := roles.calls(); n != 1 {
		t.Fatalf("%d calls", n)
	}
	call := roles.cls.Calls()[0]
	if call.State["tool"] != "Bash" || strings.Contains(call.State["command"].(string), "/home/u") || len(call.Questions) != 7 {
		t.Fatalf("%+v", call)
	}
	// The same command (other run id, other path): the cache's answer.
	appendTo(t, ab.claude, claudeResultLine("t1", "ok"))
	ab.wait(2 * transcript.LabelHold)
	appendTo(t, ab.claude, claudeToolLine("t2", "Bash", map[string]any{"command": "python3 /other/wait_for_results.py /runs/20261003-1200-other --timeout 900"}))
	activityOf(c, w1, func(a *proto.Activity) bool {
		return a != nil && a.Kind == activity.KindWaiting && a.Source == activity.SourceModel
	})
	if n := roles.calls(); n != 1 {
		t.Fatalf("a cache hit called out: %d calls", n)
	}
	// An answer under the margin stays Working (and is cached too).
	appendTo(t, ab.claude, claudeResultLine("t2", "ok"))
	ab.wait(2 * transcript.LabelHold)
	appendTo(t, ab.claude, claudeToolLine("t3", "Bash", map[string]any{"command": "parallel-cli extract https://example.com/docs"}))
	deadline := time.Now().Add(3 * time.Second)
	for roles.calls() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := roles.calls(); n != 2 {
		t.Fatalf("%d calls", n)
	}
	time.Sleep(100 * time.Millisecond)
	snap := ab.connect(proto.Hello{}).snapshot()
	if snap.World.Activity == nil || snap.World.Activity.CallsToday != 2 || snap.World.Activity.CacheSize != 2 {
		t.Fatalf("%+v", snap.World.Activity)
	}
	for _, w := range snap.World.Workers {
		if w.ID == w1 && (w.Activity == nil || w.Activity.Kind != activity.KindWorking) {
			t.Fatalf("%+v", w.Activity)
		}
	}
}

// One call at a time; a candidate that is no longer current when the slot
// frees is never asked about; nothing for a floor no one stands on; the
// daily cap holds.
func TestActivityModelBudget(t *testing.T) {
	t.Parallel()
	roles := newActRoles()
	release := make(chan struct{})
	var mu sync.Mutex
	inflight, maxInflight := 0, 0
	roles.cls.ManyFunc = func(ctx context.Context, state map[string]any, _ map[string]string) (map[string]float64, error) {
		mu.Lock()
		inflight++
		maxInflight = max(maxInflight, inflight)
		mu.Unlock()
		defer func() { mu.Lock(); inflight--; mu.Unlock() }()
		if strings.Contains(state["command"].(string), "slow-tool") {
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return map[string]float64{"waiting": 0.9}, nil
	}
	ab := startActBridge(t, func(o *server.Options) { o.ActivityRoles = roles })
	c := ab.c
	activityState(t, c, proto.CmdActivitySet, proto.ActivitySetArgs{ModelEnabled: yes()})
	// No one stands on the floor: nothing is asked.
	ab.status("w1", "working")
	ab.status("w2", "working")
	appendTo(t, ab.claude, wrapUser("go")+claudeToolLine("t1", "Bash", map[string]any{"command": "slow-tool --x"}))
	activityOf(c, ab.ids["w1"], kindIs(activity.KindWorking))
	time.Sleep(200 * time.Millisecond)
	if n := roles.calls(); n != 0 {
		t.Fatalf("no one on the floor: %d calls", n)
	}
	// Someone comes: w1's command is asked about (and held).
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	deadline := time.Now().Add(3 * time.Second)
	for roles.calls() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// Meanwhile w2 runs an unknown command, then moves on to a known one
	// before the slot frees: it is never asked about.
	appendTo(t, ab.codex, wrapCodexLine("event_msg", map[string]any{"type": "task_started"})+
		wrapCodexLine("response_item", map[string]any{"type": "function_call", "name": "exec_command", "call_id": "c1",
			"arguments": `{"cmd":"other-tool --y"}`}))
	activityOf(c, ab.ids["w2"], kindIs(activity.KindWorking))
	appendTo(t, ab.codex, wrapCodexLine("response_item", map[string]any{"type": "function_call_output", "call_id": "c1", "output": "ok"})+
		wrapCodexLine("response_item", map[string]any{"type": "function_call", "name": "exec_command", "call_id": "c2",
			"arguments": `{"cmd":"go test ./..."}`}))
	ab.wait(2 * transcript.LabelHold)
	activityOf(c, ab.ids["w2"], kindIs(activity.KindTesting))
	close(release)
	activityOf(c, ab.ids["w1"], kindIs(activity.KindWaiting))
	time.Sleep(300 * time.Millisecond)
	for _, call := range roles.cls.Calls() {
		if strings.Contains(call.State["command"].(string), "other-tool") {
			t.Fatal("a superseded command was asked about")
		}
	}
	mu.Lock()
	if maxInflight != 1 {
		t.Fatalf("%d calls at once", maxInflight)
	}
	mu.Unlock()
	// The daily cap: rules only.
	one := 1
	if s := activityState(t, c, proto.CmdActivitySet, proto.ActivitySetArgs{DailyCap: &one}); s.State != proto.ActivityCapped {
		t.Fatalf("%+v", s)
	}
	n := roles.calls()
	appendTo(t, ab.claude, claudeResultLine("t1", "ok"))
	ab.wait(2 * transcript.LabelHold)
	appendTo(t, ab.claude, claudeToolLine("t9", "Bash", map[string]any{"command": "third-tool --z"}))
	activityOf(c, ab.ids["w1"], kindIs(activity.KindWorking))
	time.Sleep(200 * time.Millisecond)
	if roles.calls() != n {
		t.Fatal("over the daily cap")
	}
}

func TestActivitySettingsCommands(t *testing.T) {
	t.Parallel()
	off := false
	roles := newActRoles()
	ab := startActBridge(t, func(o *server.Options) { o.ActivityRoles = roles; o.ActivityModel = &off })
	c := ab.c
	s := activityState(t, c, proto.CmdActivityGet, nil)
	if len(s.Env) != 1 || s.Env[0] != "model_enabled" || s.ModelEnabled {
		t.Fatalf("%+v", s)
	}
	c.mustError(proto.CmdActivitySet, proto.ActivitySetArgs{ModelEnabled: yes()}, activity.CodeEnvLocked)
	bad := 3.0
	c.mustError(proto.CmdActivitySet, proto.ActivitySetArgs{Threshold: &bad}, proto.ErrBadRequest)
	c.mustError(proto.CmdActivitySet, map[string]any{"nope": 1}, proto.ErrBadRequest)
	m := 0.3
	evs, _ := c.mustAck(proto.CmdActivitySet, proto.ActivitySetArgs{Margin: &m})
	got := false
	for _, ev := range evs {
		got = got || ev.T == proto.EvActivityUpdate
	}
	if !got {
		t.Fatalf("no activity.update before the ack: %+v", evs)
	}
	// Without the AI integration the commands are unsupported and the
	// snapshot has no activity state; the rules still run.
	plain := startActBridge(t, nil)
	plain.c.mustError(proto.CmdActivityGet, nil, proto.ErrUnsupported)
	if snap := plain.connect(proto.Hello{}).snapshot(); snap.World.Activity != nil {
		t.Fatalf("%+v", snap.World.Activity)
	}
}
