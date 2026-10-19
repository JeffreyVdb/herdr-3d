//go:build integration

package codexshare

import (
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// waitChild waits for a child row of worker id that satisfies ok.
func (c *bclient) waitChild(what, id string, d time.Duration, ok func(proto.Child) bool) proto.Child {
	c.t.Helper()
	var got proto.Child
	c.wait(what, d, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, ch := range c.kids {
			if ch.WorkerID == id && ok(ch) {
				got = ch
				return true
			}
		}
		return false
	})
	return got
}

// TestCodexShareBridgeChildren (#27): herdr-world itself, a hired shared
// worker with the real Codex TUI: a child its model spawns shows on the
// wire under the worker, from its own app-server (source app_server), with
// the transcript of its rollout, running while it works and completed when
// it ends; the worker's own turns and prompts go on as before.
func TestCodexShareBridgeChildren(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-a")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	c.setShared(true)
	w := c.hire("w", "bare-a", 0)
	if w.res.Codex == nil || w.res.Codex.Mode != proto.CodexModeShared {
		t.Fatalf("hire with the switch on: %+v", w.res.Codex)
	}
	c.prompt("first", w.id, "MOCK:say hello")
	c.settle(w)
	v := c.attached("joined", w.id)
	models := f.mock.ModelRequests()

	c.prompt("spawn", w.id, "MOCK:spawn alpha MOCK:hold a1")
	if err := f.mock.WaitHeld(f.ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	ch := c.waitChild("a running child", w.id, 60*time.Second, func(ch proto.Child) bool {
		return ch.Description == "alpha" && ch.State == proto.ChildRunning && ch.Source == proto.ChildFromAppServer
	})
	f.recordJSON("child-running", ch)
	if ch.AgentSession != v.Thread || ch.Parent != proto.ParentRoot || ch.Provider != proto.ChildCodex || ch.NativeID == "" {
		t.Fatalf("child %+v (thread %s)", ch, v.Thread)
	}
	c.waitChild("its transcript", w.id, 30*time.Second, func(x proto.Child) bool {
		return x.ID == ch.ID && x.Transcript == proto.TranscriptAvailable
	})
	f.snap("child-running", w.pane)

	if err := f.mock.Release("a1"); err != nil {
		t.Fatal(err)
	}
	done := c.waitChild("the child completed", w.id, 60*time.Second, func(x proto.Child) bool {
		return x.ID == ch.ID && x.State == proto.ChildCompleted
	})
	f.recordJSON("child-completed", done)
	c.settle(w)
	// The worker's own prompt after: through as before, one model request
	// per turn (the bridge's reads made none).
	c.prompt("after", w.id, "MOCK:say after-the-child")
	c.settle(w)
	var extra []string
	for _, r := range f.mock.Requests()[models:] {
		if r.Kind != KindTitle {
			extra = append(extra, r.Kind+" "+r.Directive)
		}
	}
	f.record("model-requests.txt", strings.Join(extra, "\n")+"\n")
	for _, r := range extra {
		if !strings.HasPrefix(r, "turn ") && !strings.HasPrefix(r, "tool ") {
			t.Errorf("an unexpected model request: %q", r)
		}
	}
	c.mu.Lock()
	f.record("events.txt", strings.Join(c.events, "\n")+"\n")
	n := 0
	for _, x := range c.kids {
		if x.WorkerID == w.id {
			n++
		}
	}
	c.mu.Unlock()
	if n != 1 {
		t.Errorf("%d child rows, want 1", n)
	}
}
