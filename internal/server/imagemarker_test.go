package server_test

import (
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #64: an image reaches an agent only as an "[Image #n: <path>]" marker inside prompt text. The bridge never reads
// the marker: it must pass it on byte for byte, on every prompt path (worker.prompt, run.prepare/run.start `extra`,
// an edited run.start `prompt`), and count it in the same caps as any other text. The path check (absolute, no "]",
// no control characters) is the game's, before it sends; the bridge only refuses what it refuses in any text (NUL).
const (
	markerA = "[Image #1: /home/u/drops/2026-09/h3d-run-extra-1.png]"
	// Spaces, non-ASCII and a Drop Zone collision suffix are all legal in a path.
	markerB = "[Image #2: /home/u/drops/2026-09/Screenshot 2026-09-30 à 14.03-2.png]"
)

func TestWorkerPromptCarriesImageMarkers(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"), agentW("w2", "codex", "working"), shell("w3"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := func(ws string) string { return idOf(t, snap, ws) }

	text := "Fix the header like this " + markerA + "\nand keep " + markerB + " in mind"
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: text})
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w2"), Text: markerA})
	want := []string{"type w1:p1 " + strconv.Quote(text), "queue w2:p1 " + strconv.Quote(markerA)}
	if got := tb.term.Calls(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls = %q, want %q", got, want)
	}

	// The 16 KiB cap counts the markers: at it is fine, one byte over is refused, and nothing is sent for it.
	n := len(tb.term.Calls())
	fill := func(total int) string { return markerA + strings.Repeat("x", total-len(markerA)) }
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: fill(16 << 10)})
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: fill(16<<10 + 1)}, proto.ErrBadRequest)
	// A marker cannot smuggle what no text may carry.
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: "[Image #1: /a\x00b.png]"}, proto.ErrBadRequest)
	if got := len(tb.term.Calls()); got != n+1 {
		t.Fatalf("a refused prompt reached herdr: %d calls, want %d", got, n+1)
	}
	// A plain shell has no agent to see an image: the bridge refuses, the game says so before it gets here.
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w3"), Text: markerA}, proto.ErrInvalidState)
}

func TestRunPromptsCarryImageMarkers(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	seed := w.Presets[0].ID
	orch := buildTeam.Orch

	// run.prepare folds `extra` (trimmed) into the orchestrator's prompt as it is, markers included.
	extra := "Match the mock-up " + markerA + "\n\nSee also " + markerB + "\n"
	res := runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: "Tidy the lobby", Extra: extra})
	wantPrompt := "/write-code Tidy the lobby\n\n" + buildHead + "\n\n" + strings.TrimSpace(extra)
	if res.Prompt != wantPrompt {
		t.Fatalf("prepared prompt =\n%q\nwant\n%q", res.Prompt, wantPrompt)
	}
	// An image alone is a valid extra; the 8 KiB cap counts the markers.
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: "go", Extra: markerA}); !strings.HasSuffix(res.Prompt, "\n\n"+markerA) {
		t.Fatalf("image-only extra: %q", res.Prompt)
	}
	fill := func(total int) string { return markerA + strings.Repeat("x", total-len(markerA)) }
	runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: "go", Extra: fill(8192)})
	c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", Text: "go", Extra: fill(8193)}, proto.ErrBadRequest)
	c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", Text: "go", Extra: "[Image #1: /a\x00b.png]"}, proto.ErrBadRequest)

	// run.start with the same extra sends the prompt run.prepare showed.
	d := 2
	_, m := c.command(proto.CmdRunStart, "rs1", proto.RunStartArgs{Session: "s", DeskIndex: &d, Text: "Tidy the lobby", Orch: &orch, Preset: seed, Extra: extra})
	got := ackData[proto.RunStartResult](t, m)
	if got.Prompt != wantPrompt {
		t.Fatalf("started prompt =\n%q\nwant\n%q", got.Prompt, wantPrompt)
	}
	calls := hb.fl.Calls()
	if last := calls[len(calls)-1]; last != "type "+"w3:p1 "+strconv.Quote(wantPrompt) {
		t.Fatalf("herdr got %q", last)
	}

	// An edited prompt (`prompt`) is sent as it is, markers included, up to the 32 KiB of a hire's first prompt.
	edited := "Reply with OK for " + markerA + " and " + markerB
	d = 3
	_, m = c.command(proto.CmdRunStart, "rs2", proto.RunStartArgs{Session: "s", DeskIndex: &d, Text: "Tidy the lobby", Orch: &orch, Preset: seed, Prompt: edited})
	got = ackData[proto.RunStartResult](t, m)
	calls = hb.fl.Calls()
	if got.Prompt != edited || calls[len(calls)-1] != "type w4:p1 "+strconv.Quote(edited) {
		t.Fatalf("edited prompt: %s\n%q", m.raw, calls[len(calls)-1])
	}
	start := func(desk int, prompt string) map[string]any {
		return map[string]any{"session": "s", "desk_index": desk, "text": "x", "orch": orch, "preset": seed, "prompt": prompt}
	}
	c.mustAck(proto.CmdRunStart, start(4, markerA+strings.Repeat("x", 32<<10-len(markerA))))
	c.mustError(proto.CmdRunStart, start(5, markerA+strings.Repeat("x", 32<<10-len(markerA)+1)), proto.ErrBadRequest)
	c.mustError(proto.CmdRunStart, start(5, "[Image #1: /a\x00b.png]"), proto.ErrBadRequest)
}
