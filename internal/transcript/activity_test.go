package transcript

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
)

// actClock is the trackers' clock in these tests.
type actClock struct{ t time.Time }

func (c *actClock) now() time.Time      { return c.t }
func (c *actClock) add(d time.Duration) { c.t = c.t.Add(d) }
func newActClock(at string) *actClock   { t, _ := time.Parse(time.RFC3339, at); return &actClock{t} }
func (c *actClock) tracker(h string) *ActivityTracker {
	return NewActivityTracker(h, nil, "", c.now)
}

// feedLine gives a tracker one line as txLines does.
func feedLine(tr *ActivityTracker, off int64, b []byte) {
	tr.Line(off, b, TurnEvents(tr.harness, b))
}

func feedAll(tr *ActivityTracker, lines [][]byte) {
	var off int64
	for _, l := range lines {
		feedLine(tr, off, l)
		off += int64(len(l)) + 1
	}
}

// step feeds lines one at a time; check sees the view after each.
type stepper struct {
	t   *testing.T
	tr  *ActivityTracker
	c   *actClock
	ls  [][]byte
	i   int
	off int64
}

func (s *stepper) next() {
	s.t.Helper()
	if s.i >= len(s.ls) {
		s.t.Fatal("no more lines")
	}
	feedLine(s.tr, s.off, s.ls[s.i])
	s.off += int64(len(s.ls[s.i])) + 1
	s.i++
}

func (s *stepper) want(kind activity.Kind, detail string) *activity.Activity {
	s.t.Helper()
	a := s.tr.View(s.c.now()).Working
	if a == nil || a.Kind != kind || (detail != "*" && a.Detail != detail) {
		s.t.Fatalf("after line %d: %+v, want %s %q", s.i, a, kind, detail)
	}
	return a
}

func TestActivityClaudeTurn(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	s := &stepper{t: t, tr: tr, c: c, ls: fixtureLines(t, Claude, "activity_turn.jsonl")}
	tr.Status("working", 0)
	s.want(activity.KindThinking, "") // the turn starts: nothing read yet
	s.next()                          // the prompt
	a := s.want(activity.KindThinking, "")
	if a.Source != activity.SourceDerived || a.Since != c.now().UnixMilli() {
		t.Fatalf("%+v", a)
	}
	c.add(2 * time.Second)
	s.next() // a thinking block
	s.want(activity.KindThinking, "")
	s.next() // Bash pytest, running
	a = s.want(activity.KindTesting, "pytest -n auto -q")
	if a.Source != activity.SourceRule || a.Since != c.now().UnixMilli() {
		t.Fatalf("%+v", a)
	}
	c.add(time.Second)
	s.next() // its result: the label holds a moment
	s.want(activity.KindTesting, "pytest -n auto -q")
	c.add(LabelHold)
	s.want(activity.KindThinking, "") // between tools
	c.add(LabelHold)
	s.next() // Read
	s.want(activity.KindInvestigating, "test_loader.py")
	s.next()
	c.add(2 * LabelHold)
	s.want(activity.KindThinking, "")
	c.add(LabelHold)
	s.next() // the final text
	s.want(activity.KindReplying, "")
	s.next() // turn_duration: the turn is over
	if v := tr.View(c.now()); v.Idle != nil || v.Working.Kind != activity.KindThinking {
		t.Fatalf("%+v", v)
	}
}

// The previous turn's last tool never shows in the next one: not after a new
// prompt, not when herdr sees the worker working before any prompt (a
// task notification wakes it), not when its turn had no end.
func TestActivityPreviousTurnNeverShows(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	ls := fixtureLines(t, Claude, "activity_turn.jsonl")
	tr.Status("working", 0)
	feedAll(tr, ls[:3]) // the prompt, thinking, Bash running
	if a := tr.View(c.now()).Working; a.Kind != activity.KindTesting {
		t.Fatalf("%+v", a)
	}
	// A new prompt, the Bash never answered: Thinking at once (no hold
	// across turns).
	feedLine(tr, 9999, ls[0])
	if a := tr.View(c.now()).Working; a.Kind != activity.KindThinking {
		t.Fatalf("%+v", a)
	}
	// Herdr working again after an idle that began once the turn had
	// opened (its end line never came): a watermark.
	tr2 := c.tracker(Claude)
	feedAll(tr2, ls[:3])
	feedLine(tr2, 9999, ls[3])
	c.t = time.Date(2026, 10, 1, 19, 1, 0, 0, time.UTC)
	tr2.Status("idle", c.now().UnixMilli())
	c.add(500 * time.Millisecond)
	tr2.Status("working", c.now().Add(-500*time.Millisecond).UnixMilli())
	if a := tr2.View(c.now()).Working; a.Kind != activity.KindThinking {
		t.Fatalf("watermark: %+v", a)
	}
}

func TestActivityLabelHolds(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	tr.Status("working", 0)
	feedLine(tr, 0, actPrompt("go"))
	c.add(2 * time.Second)
	feedLine(tr, 1, actTool("t1", "Bash", `{"command":"go test ./..."}`))
	if a := tr.View(c.now()).Working; a.Kind != activity.KindTesting {
		t.Fatalf("%+v", a)
	}
	// A quick tool after it: the first label holds 1.5 s.
	c.add(300 * time.Millisecond)
	feedLine(tr, 2, actResult("t1", "ok"))
	feedLine(tr, 3, actTool("t2", "Bash", `{"command":"git status"}`))
	if a := tr.View(c.now()).Working; a.Kind != activity.KindTesting {
		t.Fatalf("held: %+v", a)
	}
	c.add(LabelHold)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindInvestigating || a.Detail != "git status" {
		t.Fatalf("%+v", a)
	}
	// A meta tool keeps the label.
	feedLine(tr, 4, actTool("t3", "ToolSearch", `{"query":"select:Read"}`))
	c.add(2 * LabelHold)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindInvestigating {
		t.Fatalf("meta: %+v", a)
	}
}

// A running tool is the label even when later items came (concurrent
// calls).
func TestActivityConcurrentCalls(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	tr.Status("working", 0)
	feedLine(tr, 0, actPrompt("go"))
	feedLine(tr, 1, actTool("t1", "Bash", `{"command":"pytest"}`))
	feedLine(tr, 2, actTool("t2", "Read", `{"file_path":"/a/b.go"}`))
	feedLine(tr, 3, actResult("t2", "x"))
	c.add(5 * time.Second)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindTesting {
		t.Fatalf("%+v", a)
	}
	// A synchronous subagent is delegating.
	feedLine(tr, 4, actResult("t1", "ok"))
	feedLine(tr, 5, actTool("t4", "Agent", `{"description":"Spec axis review","prompt":"x"}`))
	c.add(5 * time.Second)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindDelegating || a.Detail != "Spec axis review" {
		t.Fatalf("%+v", a)
	}
}

func TestActivityImageHolds(t *testing.T) {
	c := newActClock("2026-10-01T19:10:00Z")
	tr := c.tracker(Claude)
	tr.Status("working", 0)
	ls := fixtureLines(t, Claude, "activity_read_png.jsonl")
	feedAll(tr, ls[:2])
	if a := tr.View(c.now()).Working; a.Kind != activity.KindInvestigating || a.Detail != "needs-you-desk.png" {
		t.Fatalf("%+v", a)
	}
	feedLine(tr, 999, ls[2]) // the result: the image
	v := tr.View(c.now())
	a := v.Working
	if a.Kind != activity.KindImage || a.Image == nil || len(a.Image.Hash) != 64 || a.Image.W != 1 || a.Image.H != 1 ||
		a.Detail != "needs-you-desk.png" || v.Image == nil {
		t.Fatalf("%+v %+v", a, a.Image)
	}
	if b, err := v.Image(); err != nil || len(b) == 0 {
		t.Fatalf("%v", err)
	}
	// Another tool: the image stays its 6 s.
	c.add(time.Second)
	feedLine(tr, 1000, actTool("t9", "Bash", `{"command":"pytest"}`))
	c.add(4 * time.Second)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindImage {
		t.Fatalf("%+v", a)
	}
	c.add(1100 * time.Millisecond)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindTesting {
		t.Fatalf("%+v", a)
	}
	// The turn's end takes it away at once.
	feedLine(tr, 1001, ls[2])
	feedLine(tr, 1002, actTurnDone())
	if a := tr.View(c.now()).Working; a.Kind != activity.KindThinking {
		t.Fatalf("%+v", a)
	}
}

func TestActivityCodexExec(t *testing.T) {
	c := newActClock("2026-10-02T02:45:00Z")
	tr := c.tracker(Codex)
	s := &stepper{t: t, tr: tr, c: c, ls: fixtureLines(t, Codex, "activity_exec.jsonl")}
	tr.Status("working", 0)
	s.next() // session_meta
	s.next() // task_started
	s.next() // the prompt
	s.next() // reasoning
	s.want(activity.KindThinking, "")
	c.add(2 * time.Second)
	s.next() // exec: pytest
	s.want(activity.KindTesting, "pytest -n auto -q")
	s.next() // its output: still running as session 19707
	c.add(2 * time.Second)
	s.want(activity.KindThinking, "")
	c.add(2 * time.Second)
	s.next() // a write_stdin poll of that session keeps Testing
	s.want(activity.KindTesting, "pytest -n auto -q")
	s.next()
	c.add(2 * time.Second)
	s.next() // write_stdin + view_image
	c.add(2 * time.Second)
	s.next() // its output has the image
	a := s.want(activity.KindImage, "needs-you-desk.png")
	if a.Image == nil || a.Image.W != 1 {
		t.Fatalf("%+v", a)
	}
	c.add(ImageHold)
	s.next() // apply_patch
	s.want(activity.KindWriting, "followupCard.ts")
	s.next()
	c.add(2 * time.Second)
	s.next() // the final message
	s.want(activity.KindReplying, "")
	s.next() // task_complete
	s.want(activity.KindThinking, "")
}

// A Codex view_image (direct) and a generated image show too.
func TestActivityCodexImages(t *testing.T) {
	for _, f := range []string{"view_image.jsonl", "generated.jsonl", "image.jsonl"} {
		c := newActClock("2026-09-30T00:00:00Z")
		tr := c.tracker(Codex)
		tr.Status("working", 0)
		feedAll(tr, fixtureLines(t, Codex, f))
		if a := tr.View(c.now()).Working; a.Kind != activity.KindImage || a.Image == nil || a.Image.Hash == "" {
			t.Fatalf("%s: %+v", f, a)
		}
	}
	// The user's own image (a pasted screenshot) is not the agent's.
	c := newActClock("2026-09-30T00:00:00Z")
	tr := c.tracker(Codex)
	tr.Status("working", 0)
	feedLine(tr, 0, []byte(`{"timestamp":"2026-09-30T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}]}}`))
	if a := tr.View(c.now()).Working; a.Kind != activity.KindThinking {
		t.Fatalf("%+v", a)
	}
}

func TestActivityUnplacedCommandIsACandidate(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	tr.Status("working", 0)
	feedLine(tr, 0, actPrompt("go"))
	feedLine(tr, 1, actTool("t1", "Bash", `{"command":"python3 /x/wait_for_results.py /runs/r1"}`))
	v := tr.View(c.now())
	if v.Working.Kind != activity.KindWorking || v.Candidate == nil || v.Candidate.Item != "t1" || v.Candidate.Tool != "Bash" ||
		v.Candidate.Command != "python3 /x/wait_for_results.py /runs/r1" {
		t.Fatalf("%+v %+v", v.Working, v.Candidate)
	}
	feedLine(tr, 2, actResult("t1", "done"))
	c.add(2 * LabelHold)
	if v := tr.View(c.now()); v.Candidate != nil {
		t.Fatalf("%+v", v.Candidate)
	}
}

func TestActivitySidechainLinesAreNotTheWorkers(t *testing.T) {
	c := newActClock("2026-10-01T19:00:00Z")
	tr := c.tracker(Claude)
	tr.Status("working", 0)
	feedLine(tr, 0, actPrompt("go"))
	side := bytes.Replace(actTool("s1", "Bash", `{"command":"pytest"}`), []byte(`"isSidechain":false`), []byte(`"isSidechain":true`), 1)
	feedLine(tr, 1, side)
	if a := tr.View(c.now()).Working; a.Kind != activity.KindThinking {
		t.Fatalf("%+v", a)
	}
}

// #98 §3b: the real background tasks of a turn (h3d-nutmeg-3, 2026-10-01).
func TestActivityBackgroundTasks(t *testing.T) {
	c := newActClock("2026-10-01T19:21:00Z")
	tr := c.tracker(Claude)
	open := fixtureLines(t, Claude, "activity_bg_open.jsonl")
	feedAll(tr, open)
	end, _ := time.Parse(time.RFC3339Nano, "2026-10-01T19:20:52.331Z")
	idle := func() *activity.Activity { return tr.View(c.now()).Idle }
	a := idle()
	if a == nil || a.Kind != activity.KindWaiting || a.Tasks != 5 || a.Since != end.UnixMilli() || a.Source != activity.SourceDerived {
		t.Fatalf("%+v", a)
	}
	if a.Detail != "Monitor: full e2e result" {
		t.Fatalf("detail %q", a.Detail)
	}
	s := &stepper{t: t, tr: tr, c: c, ls: fixtureLines(t, Claude, "activity_bg_notify.jsonl")}
	tasks := func(n int) {
		t.Helper()
		a := idle()
		if (n == 0 && a != nil) || (n > 0 && (a == nil || a.Tasks != n)) {
			t.Fatalf("after line %d: %+v, want %d tasks", s.i, a, n)
		}
	}
	s.next() // a Monitor's event: it goes on
	tasks(5)
	s.next() // the background Bash completed (queue-operation)
	tasks(4)
	s.next() // and its user line
	tasks(4)
	s.next() // the first Monitor's stream ended
	tasks(3)
	s.next() // (its attachment)
	s.next() // TaskStop of the second
	tasks(2)
	s.next()
	s.next()
	s.next() // the woken turn ends
	if a := idle(); a.Detail != "Monitor: full e2e result" || a.Tasks != 2 {
		t.Fatalf("%+v", a)
	}
	s.next() // the third Monitor ended: the subagent is left
	if a := idle(); a.Detail != "Subagent: Standards axis review" || a.Tasks != 1 {
		t.Fatalf("%+v", a)
	}
	s.next() // the subagent finished: nothing to wait on
	tasks(0)

	// A bridge restart reads the file again: the same open set.
	re := c.tracker(Claude)
	feedAll(re, append(append([][]byte(nil), open...), s.ls[:5]...))
	if a := re.View(c.now()).Idle; a == nil || a.Tasks != 3 {
		t.Fatalf("rebuilt: %+v", a)
	}

	// A Monitor past its timeout (persistent false) closes by itself; and
	// past the safety cap, everything.
	ex := c.tracker(Claude)
	feedAll(ex, open)
	started, _ := time.Parse(time.RFC3339Nano, "2026-10-01T19:20:49.236Z")
	c.t = started.Add(30*time.Minute + time.Second)
	if a := ex.View(c.now()).Idle; a == nil || a.Tasks != 2 || a.Detail != "Testing in the background" {
		t.Fatalf("expired monitors: %+v", a)
	}
	c.add(MaxTaskAge)
	if a := ex.View(c.now()).Idle; a != nil {
		t.Fatalf("over the cap: %+v", a)
	}
}

func TestActivityScheduleWakeup(t *testing.T) {
	c := newActClock("2026-10-01T12:41:00Z")
	tr := c.tracker(Claude)
	feedAll(tr, fixtureLines(t, Claude, "activity_wakeup.jsonl"))
	at := time.UnixMilli(1790858700000)
	a := tr.View(c.now()).Idle
	if a == nil || a.Tasks != 1 || a.Detail != "Wakes at "+at.Format("15:04") {
		t.Fatalf("%+v", a)
	}
	c.t = at.Add(time.Second)
	if a := tr.View(c.now()).Idle; a != nil {
		t.Fatalf("%+v", a)
	}
}

// ---- lines --------------------------------------------------------------------------------------------------

var lineN int

func actLine(v map[string]any) []byte {
	lineN++
	v["isSidechain"] = false
	v["uuid"] = "u-" + string(rune('a'+lineN%26)) + time.Now().Format("150405.000000000")
	v["timestamp"] = "2026-10-01T19:00:00.000Z"
	b, _ := json.Marshal(v)
	return b
}

func actPrompt(text string) []byte {
	return actLine(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
}

func actTool(id, name, input string) []byte {
	return actLine(map[string]any{"type": "assistant", "message": map[string]any{"id": "msg-" + id, "role": "assistant",
		"stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use", "id": id, "name": name, "input": json.RawMessage(input)}}}})
}

func actResult(id, text string) []byte {
	return actLine(map[string]any{"type": "user", "message": map[string]any{"role": "user",
		"content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": text}}}})
}

func actTurnDone() []byte {
	return actLine(map[string]any{"type": "system", "subtype": "turn_duration", "durationMs": 1000})
}
