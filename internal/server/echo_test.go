package server_test

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// claudeUser is a Claude transcript line with a prompt: the fixture's
// first user line with its own uuid and text.
func claudeUser(t *testing.T, uuid, text string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(fixtureLine(t, "claude", "user.jsonl", 0)), &m); err != nil {
		t.Fatal(err)
	}
	m["uuid"] = uuid
	m["message"] = map[string]any{"role": "user", "content": text}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

// echoPush reads until the push with a user item of this text, answering
// the time it arrived; the reply to reqID (if any) may come before or
// after it.
func (c *client) echoPush(id, text, reqID string) time.Time {
	c.t.Helper()
	acked := reqID == ""
	var at time.Time
	for !acked || at.IsZero() {
		m := c.next()
		switch m.env.T {
		case proto.TAck:
			if m.env.ReqID == reqID {
				acked = true
			}
		case proto.TError:
			c.t.Fatalf("%s", m.raw)
		case proto.TTranscriptItems:
			var p proto.TranscriptItems
			_ = json.Unmarshal(m.raw, &p)
			if p.ID != id {
				continue
			}
			for _, it := range p.Items {
				if it.Kind == proto.ItemUser && len(it.Parts) > 0 && it.Parts[0].Text == text {
					at = time.Now()
				}
			}
		}
	}
	return at
}

// #58: with the usage tracker kicked after worker.prompt and when a watched
// worker starts working, a prompt's user line is pushed in well under a
// second, where it waited for the watched transcripts' 1 s tick before
// (the control). Each trial starts right after a round (a filler line's
// push), the worst case for waiting on the tick; a kicked echo right after
// that push still waits out the 250 ms flush. The defaults are the bridge's:
// the tracker's intervals and the push flush.
func TestPromptEchoLatency(t *testing.T) {
	// Not parallel: it times prompt echoes in wall-clock.
	const sess = "0a0b0c0d-5858-4558-8558-585858585858"
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, fixture(t, "claude", "message.jsonl"))
	w1 := agentW("w1", "claude", "idle")
	w1.AgentSession, w1.Harness = sess, world.HarnessClaude
	tb := startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}}
	}, w1)
	n := 0
	var sentText string
	// The agent writes its user line as herdr's submit returns (Claude does it
	// before it starts working).
	tb.term.onPrompt = func(string, string) {
		n++
		appendLine(t, path, claudeUser(t, fmt.Sprintf("0a0b0c0d-0000-4000-8000-%012d", n), sentText))
	}
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})

	line := 0
	// sync appends a filler line and waits for its push: a round just ran.
	sync := func() {
		line++
		text := fmt.Sprintf("filler %d", line)
		appendLine(t, path, claudeUser(t, fmt.Sprintf("0a0b0c0d-1111-4111-8111-%012d", line), text))
		c.echoPush(id, text, "")
	}
	const trials = 3
	var control, prompted, quiet, working []time.Duration
	for i := range trials {
		// Control: a line written with no kick waits for the next tick.
		sync()
		text := fmt.Sprintf("unprompted %d", i)
		start := time.Now()
		appendLine(t, path, claudeUser(t, fmt.Sprintf("0a0b0c0d-2222-4222-8222-%012d", i), text))
		control = append(control, c.echoPush(id, text, "").Sub(start))

		// worker.prompt to the idle agent: kicked after the ack.
		sync()
		sentText = fmt.Sprintf("prompt %d", i)
		reqID := fmt.Sprintf("p%d", i)
		b, _ := json.Marshal(proto.WorkerPromptArgs{ID: id, Text: sentText})
		start = time.Now()
		c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: reqID, Args: b})
		prompted = append(prompted, c.echoPush(id, sentText, reqID).Sub(start))

		// The same with the view quiet for a while (the usual case: the last
		// push is older than the flush, so nothing holds this one back).
		sync()
		time.Sleep(300 * time.Millisecond)
		sentText = fmt.Sprintf("quiet prompt %d", i)
		reqID = fmt.Sprintf("q%d", i)
		b, _ = json.Marshal(proto.WorkerPromptArgs{ID: id, Text: sentText})
		start = time.Now()
		c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: reqID, Args: b})
		quiet = append(quiet, c.echoPush(id, sentText, reqID).Sub(start))

		// The worker turns working (a prompt from the terminal): kicked.
		sync()
		text = fmt.Sprintf("typed %d", i)
		appendLine(t, path, claudeUser(t, fmt.Sprintf("0a0b0c0d-3333-4333-8333-%012d", i), text))
		start = time.Now()
		tb.setStatus("w1", "working")
		working = append(working, c.echoPush(id, text, "").Sub(start))
		tb.setStatus("w1", "idle")
	}
	stat := func(d []time.Duration) string {
		s := slices.Clone(d)
		slices.Sort(s)
		return fmt.Sprintf("min %v median %v max %v", s[0].Round(time.Millisecond), s[len(s)/2].Round(time.Millisecond), s[len(s)-1].Round(time.Millisecond))
	}
	t.Logf("no kick (control): %s", stat(control))
	t.Logf("after worker.prompt: %s", stat(prompted))
	t.Logf("after worker.prompt, the view quiet for 300 ms: %s", stat(quiet))
	t.Logf("on turning working: %s", stat(working))
	for _, d := range slices.Concat(prompted, quiet, working) {
		if d >= time.Second {
			t.Errorf("an echo took %v (want < 1s): prompt %s, working %s", d, stat(prompted), stat(working))
		}
	}
	// The control shows what is measured: without a kick the line waits for the tick.
	if slices.Max(control) < 500*time.Millisecond {
		t.Errorf("control %s: the trials did not start right after a round", stat(control))
	}
}
