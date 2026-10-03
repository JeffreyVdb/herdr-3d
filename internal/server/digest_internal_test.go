package server

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// #118 phase 2 review: the hub's part of the summaries, driven directly.

// dgReady is an LLM role that is always ready.
type dgReady struct{ llm *ai.FakeLLM }

func (r dgReady) State(ai.Role) ai.State     { return ai.StateReady }
func (r dgReady) Fingerprint(ai.Role) string { return "fp" }
func (r dgReady) LLM() ai.LLM                { return r.llm }

// dgHubFor is a hub with one one-off worker "w" on floor "s", the feature
// switched on by the environment (its LLM fake), its clock *clock; viewed
// puts a client on the floor.
func dgHubFor(t *testing.T, clock *time.Time, viewed bool) (*Hub, *ai.FakeLLM) {
	t.Helper()
	ctx := context.Background()
	llm := &ai.FakeLLM{Func: func(_ context.Context, req ai.Request) (string, error) {
		if strings.Contains(req.Messages[0].Content, "label the task") {
			return "Fix the lift doors", nil
		}
		return "Reading the lift code", nil
	}}
	now := func() time.Time { return *clock }
	on := true
	svc, err := digest.New(ctx, digest.Options{Roles: dgReady{llm}, EnvEnabled: &on, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	h := &Hub{opts: Options{Now: now, DigestSettle: time.Millisecond, DigestGap: time.Hour},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)), st: st, ring: newRing(256),
		ops: make(chan func(context.Context), 16), done: make(chan struct{}),
		clients: map[*Client]struct{}{}, workers: map[string]*proto.Worker{"w": {ID: "w", Session: "s"}},
		act: activityHub{views: map[*Client]string{}}, dg: map[string]*transcript.Digest{},
		dgs: digestHub{svc: svc, ws: map[string]*dgLLM{}}}
	if viewed {
		c := &Client{send: make(chan []byte, 256)}
		h.clients[c], h.act.views[c] = struct{}{}, "s"
	}
	return h, llm
}

// runOp runs the next operation handed to the hub (a call's completion).
func runOp(t *testing.T, h *Hub) {
	t.Helper()
	select {
	case op := <-h.ops:
		op(context.Background())
	case <-time.After(5 * time.Second):
		t.Fatal("no hub operation")
	}
}

func dgView(resets int, recent string) *transcript.Digest {
	return &transcript.Digest{Steps: 3, Ended: 1, Prompt: "Fix the lift doors.", PromptHash: "h1", Resets: resets,
		Recent: []transcript.DigestStep{{Texts: []string{recent}}}}
}

// R3: a reset is the tracker's identity changing, never guessed from the
// counts: a /clear and the same prompt read within one poll (equal counts and
// prompt hash, one more reset), or another agent session's tracker (equal
// everything), drops the model's lines, starts a new generation (a turn that
// ended in it is due) and ignores a completion of the old one.
func TestDigestResetByIdentity(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 3, 12, 0, 0, 0, time.Local)
	h, _ := dgHubFor(t, &clock, false)
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgView(0, "Editing the old session")})
	l := h.dgs.ws["w"]
	l.task, l.taskHash, l.taskTried, l.now, l.nowAt, l.endedAt = "Old task", "h1", "h1", "Editing previous session", 1, time.Time{}
	h.refreshDigest("w")
	if d := h.workers["w"].Digest; d == nil || d.NowSource != proto.DigestLLM || d.TaskSource != proto.DigestLLM {
		t.Fatalf("the model's lines do not show: %+v", d)
	}
	steps := []struct {
		name  string
		epoch int
		d     *transcript.Digest
	}{
		{"/clear and the same prompt in one poll", 1, dgView(1, "Editing the new session")},
		{"another agent session, the same counts", 2, dgView(1, "Editing the new session")},
	}
	for _, s := range steps {
		old := l.gen
		clock = clock.Add(time.Second)
		h.digestSeen(ctx, digestUpdate{id: "w", epoch: s.epoch, digest: s.d})
		if l = h.dgs.ws["w"]; l.gen == old || l.now != "" || l.nowAt != 0 || l.task != "" || l.taskTried != "" || !l.endedAt.Equal(clock) {
			t.Fatalf("%s: %+v", s.name, *l)
		}
		if d := h.workers["w"].Digest; d == nil || d.NowSource == proto.DigestLLM || d.TaskSource == proto.DigestLLM {
			t.Fatalf("%s: the old lines still show: %+v", s.name, d)
		}
		// The old generation's call answers: dropped.
		h.digestDone(ctx, digestCand{id: "w", in: digest.Input{Kind: digest.KindNow}}, old, time.Time{}, digest.Result{Line: "Stale"}, nil)
		h.digestDone(ctx, digestCand{id: "w", in: digest.Input{Kind: digest.KindTask}, hash: "h1"}, old, time.Time{}, digest.Result{Line: "Stale"}, nil)
		if l.now != "" || l.task != "" {
			t.Fatalf("%s: an old generation's line was taken: %+v", s.name, *l)
		}
	}
	// The same identity again: no reset.
	l.now = "Kept"
	gen := l.gen
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 2, digest: dgView(1, "Editing the new session")})
	if l.gen != gen || l.now != "Kept" {
		t.Fatalf("no reset, yet %+v", *l)
	}
}

// R3: the usage tracker gives each digest tracker of a worker its own epoch
// (another agent session), and a /clear shows in the digest's Resets.
func TestOfferDigestIdentity(t *testing.T) {
	tr := newUsageTracker(UsageConfig{})
	w := usageWorker{id: "w"}
	t1 := transcript.NewDigestTracker(transcript.Claude)
	tr.lines["w"] = &txLines{digest: t1}
	tr.offerDigest(w)
	tr.offerDigest(w) // unchanged: nothing more
	if len(tr.dgUps) != 1 {
		t.Fatalf("updates = %d", len(tr.dgUps))
	}
	first := tr.dgUps[0]
	t1.Reset()
	tr.offerDigest(w)
	if u := tr.dgUps[1]; u.epoch != first.epoch || u.digest.Resets != first.digest.Resets+1 {
		t.Fatalf("after /clear: epoch %d (was %d), resets %d", u.epoch, first.epoch, u.digest.Resets)
	}
	tr.lines["w"] = &txLines{digest: transcript.NewDigestTracker(transcript.Claude)}
	tr.offerDigest(w)
	if u := tr.dgUps[2]; u.epoch == first.epoch || u.digest.Resets != 0 {
		t.Fatalf("another session: epoch %d (was %d)", u.epoch, first.epoch)
	}
}
