package server_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #118: the floor overview's digest, from real transcript fixtures the usage
// tracker reads (internal/transcript/testdata/*/digest_turns.jsonl): w1 is a
// Claude agent, w2 a Codex one (the follow-up bridge, its features off).
func TestDigestOnTheWire(t *testing.T) {
	fb := startFuBridge(t, "", "", newFuRoles(), nil, "")
	c := fb.connect(proto.Hello{})
	// Before any assistant step: the task as soon as it is known (w1's first
	// prompt), never a now line; nothing at all without a prompt (w2).
	before := workersOf(c.snapshot().World, "s")
	if d := before["w1"].Digest; d == nil || *d != (proto.WorkerDigest{Task: "Hi.", TaskSource: proto.DigestPrompt}) {
		t.Fatalf("w1 digest before any step = %+v", d)
	}
	if d := before["w2"].Digest; d != nil {
		t.Fatalf("w2 has a digest without a prompt: %+v", d)
	}
	fb.turn(t, "claude", "digest_turns.jsonl")
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.NowSource == proto.DigestRecap })
	want := proto.WorkerDigest{Task: "Floor overview on the lounge wall", TaskSource: proto.DigestAITitle,
		Now: "Built the floor overview screen; the tests pass. Next: a review.", NowSource: proto.DigestRecap, NowAt: 1791021900000}
	if *w.Digest != want {
		t.Fatalf("claude digest = %+v", *w.Digest)
	}
	fb.turn(t, "codex", "digest_turns.jsonl")
	w = upsertFor(c, fb.ids["w2"], func(w *proto.Worker) bool { return w.Digest != nil })
	if *w.Digest != (proto.WorkerDigest{Task: "Port the importer to v2?", TaskSource: proto.DigestPrompt, NowSource: proto.DigestTitle}) {
		t.Fatalf("codex digest = %+v", *w.Digest)
	}
	// The title's line is the worker's own title: never copied into the digest.
	raw, _ := json.Marshal(w)
	if !strings.Contains(string(raw), `"digest":{"task":"Port the importer to v2?","task_source":"prompt","now_source":"title"}`) {
		t.Fatalf("wire = %s", raw)
	}
	// A reconnect's snapshot has them.
	ws := workersOf(fb.connect(proto.Hello{}).snapshot().World, "s")
	if d := ws["w1"].Digest; d == nil || *d != want {
		t.Fatalf("snapshot digest = %+v", d)
	}
}
