package server_test

// #176 part 2: a paste and a mouse click through the seated laptop's
// controller, against a fake herdr controller.

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// ownedSeat is a connection's control watch of worker id at 100 × 30 whose
// controller (the n-th) sent its first frame: the pane is owned.
func ownedSeat(t *testing.T, ct *ctlTerm, c *client, id string, n int) (string, *fakeCtl, proto.TerminalControl) {
	t.Helper()
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30, Cols: 100, Rows: 30, Control: true})
	k := ct.ctl(t, n)
	k.push(t, true, "hello")
	m := ctlMsg[proto.TerminalControl](c, proto.TTerminalControl)
	c.frame()
	return id, k, m
}

// The paste and the click take the worker's lane, in order with the keys
// before and after them; a paste is the text as given (NUL and markers
// removed) and submits nothing; it goes to an agent in a question too, where
// worker.prompt is refused.
func TestSeatPasteAndClickKeepOrder(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"), agentW("w2", "claude", "blocked"))
	ct.mouse = true
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id, k, m := ownedSeat(t, ct, c, idOf(t, snap, "w1"), 0)
	if !m.Paste || !m.Mouse {
		t.Fatalf("control = %+v, want paste and mouse", m)
	}

	text := "echo one\nécho \"two\" ✓\t<&>\x00\x1b[201~; rm -rf ~"
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{{Text: ptr("ab")}}})
	if _, pm := c.command(proto.CmdWorkerPaste, "paste", proto.WorkerPasteArgs{ID: id, Text: text}); ackData[proto.PasteResult](t, pm) != (proto.PasteResult{}) {
		t.Fatalf("paste ack = %s", pm.raw)
	}
	c.mustAck(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id, Column: 5, Row: 2})
	c.mustAck(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id, Button: "right", Column: 99, Row: 29, Modifiers: 5})
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{{Key: ptr("enter")}}})
	var got []string
	for _, call := range ct.Calls() {
		if strings.HasPrefix(call, "keys ") || strings.HasPrefix(call, "text ") || strings.Contains(call, " paste ") || strings.Contains(call, " click ") {
			got = append(got, call)
		}
	}
	want := []string{
		`text w1:p1 "ab"`,
		"ctl w1:p1 paste " + strconv.Quote("echo one\nécho \"two\" ✓\t<&>; rm -rf ~"),
		"ctl w1:p1 click left at 5,2 mods 0",
		"ctl w1:p1 click right at 99,29 mods 5",
		"keys w1:p1 enter",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("input =\n%q\nwant\n%q", got, want)
	}

	// An agent with a question: worker.prompt is refused, a paste goes in.
	c2 := tb.connect(proto.Hello{})
	id2, k2, _ := ownedSeat(t, ct, c2, idOf(t, snap, "w2"), 1)
	c2.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id2, Text: "yes"}, proto.ErrInvalidState)
	c2.mustAck(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id2, Text: "a note\nfor the question"})
	if cmds := k2.commands(); !slices.Contains(cmds, `paste "a note\nfor the question"`) {
		t.Fatalf("w2 controller = %q", cmds)
	}
	for _, call := range ct.Calls() {
		if strings.Contains(call, "w2:p1") && (strings.HasPrefix(call, "keys") || strings.HasPrefix(call, "submit") || strings.HasPrefix(call, "type")) {
			t.Fatalf("the paste typed or submitted something: %q", call)
		}
	}

	// An empty paste (only NUL) is a no-op.
	before := len(k.commands())
	c.mustAck(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: "\x00"})
	if cmds := k.commands(); slices.ContainsFunc(cmds[before:], func(s string) bool { return strings.HasPrefix(s, "paste") }) {
		t.Fatalf("an empty paste was sent: %q", cmds[before:])
	}

	// The audit has the lengths and the cell, never the text.
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		switch e.Cmd {
		case proto.CmdWorkerPaste, proto.CmdTerminalMouse:
			rows = append(rows, e.Cmd+" "+e.Args)
		}
	}
	all := strings.Join(rows, "\n")
	if strings.Contains(all, "rm -rf") || strings.Contains(all, "question") || !strings.Contains(all, `"text_bytes":`) ||
		!strings.Contains(all, `"column":99`) || len(rows) != 5 {
		t.Fatalf("audit rows:\n%s", all)
	}
}

// What a paste or a click is refused for, before anything reaches herdr.
func TestSeatPasteAndClickRefusals(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"), shell("w2"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id1, id2 := idOf(t, snap, "w1"), idOf(t, snap, "w2")

	// No control watch: no paste, no click (an observer watch neither).
	c.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id1, Text: "x"}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id1}, proto.ErrBadRequest)
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id2, Fps: 30})
	c.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id2, Text: "x"}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: "nobody", Text: "x"}, proto.ErrUnknownWorker)

	id, k, m := ownedSeat(t, ct, c, id1, 0)
	if !m.Paste || m.Mouse {
		t.Fatalf("control = %+v: an old herdr takes pastes, no clicks", m)
	}
	// An old herdr: no clicks.
	c.mustError(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id, Column: 1, Row: 1}, proto.ErrInvalidState)
	ct.mouse = true
	c2 := tb.connect(proto.Hello{})
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the first controller is released", k.isReleased)
	id, k, _ = ownedSeat(t, ct, c2, id1, 1)
	for _, bad := range []any{
		proto.TerminalMouseArgs{ID: id, Button: "back"},
		proto.TerminalMouseArgs{ID: id, Column: -1},
		proto.TerminalMouseArgs{ID: id, Column: 100}, // the grid is 100 × 30
		proto.TerminalMouseArgs{ID: id, Row: 30},
		proto.TerminalMouseArgs{ID: id, Modifiers: 8},
		map[string]any{"id": id, "column": 1, "row": 1, "action": "drag"},
	} {
		c2.mustError(proto.CmdTerminalMouse, bad, proto.ErrBadRequest)
	}
	c2.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: strings.Repeat("x", herdr.MaxMessage+1)}, proto.ErrBadRequest)
	// The limit is the text as pasted: NUL and markers do not count.
	c2.mustAck(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: strings.Repeat("x", herdr.MaxMessage) + "\x00\x1b[200~"})
	// At most 10 clicks a second.
	for range 10 {
		c2.mustAck(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id})
	}
	c2.mustError(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id}, proto.ErrCapacity)
	clicks := 0
	for _, cmd := range k.commands() {
		if strings.HasPrefix(cmd, "click") {
			clicks++
		}
	}
	if clicks != 10 {
		t.Fatalf("%d clicks reached herdr", clicks)
	}
}

// A read-only seat (another client owns the pane): no paste, no click.
func TestSeatPasteReadOnly(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"))
	ct.mouse = true
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30, Cols: 100, Rows: 30, Control: true})
	ct.ctl(t, 0).refuse(t, refusal)
	ct.observer(t, 0).push(t, true, "theirs")
	if m := ctlMsg[proto.TerminalControl](c, proto.TTerminalControl); m.Mode != proto.ControlReadOnly || m.Paste || m.Mouse {
		t.Fatalf("control = %+v", m)
	}
	c.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: "x"}, proto.ErrInvalidState)
	c.mustError(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: id}, proto.ErrInvalidState)
}

// #108: an agent's paste is reviewed like its prompt: refused without a
// review when it holds a possible secret; with one, the protected ranges go
// as file references; nothing secret is audited.
func TestSeatPasteSecrets(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	dir := filepath.Join(base, "run", "secrets")
	if err := os.Mkdir(filepath.Join(base, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	tb, ct := startCtlBridge(t, func(o *server.Options) { o.SecretsDir = dir }, agentW("w1", "claude", "idle"), shell("w2"))
	c := tb.connect(proto.Hello{Client: "game"})
	snap := c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id, k, _ := ownedSeat(t, ct, c, idOf(t, snap, "w1"), 0)
	const sentinel = "Rq-Sentinel-93xQ!"
	text := "deploy with PASSWORD=" + sentinel + "\nthen check"
	c.mustError(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: text}, proto.ErrSecretsReviewRequired)
	_, sm := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	s := ackData[proto.PromptSecretsScan](t, sm)
	if len(s.Candidates) != 1 {
		t.Fatalf("candidates %+v", s.Candidates)
	}
	_, m := c.command(proto.CmdWorkerPaste, "p", proto.WorkerPasteArgs{ID: id, Text: text, Secrets: &proto.SecretsReview{Revision: s.Revision,
		Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
	pr := ackData[proto.PasteResult](t, m)
	if pr.Protected != 1 || pr.Sent == "" || strings.Contains(pr.Sent, sentinel) {
		t.Fatalf("ack %s", m.raw)
	}
	refs := refRe.FindAllStringSubmatch(pr.Sent, -1)
	if len(refs) != 1 {
		t.Fatalf("sent %q", pr.Sent)
	}
	if b, err := os.ReadFile(refs[0][1]); err != nil || string(b) != sentinel {
		t.Fatalf("protected file %q, %v", b, err)
	}
	if cmds := k.commands(); !slices.Contains(cmds, "paste "+strconv.Quote(pr.Sent)) {
		t.Fatalf("controller = %q", cmds)
	}
	// A clean paste needs no review; a shell's paste is not scanned (as its keys).
	c.mustAck(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id, Text: "plain words"})
	c2 := tb.connect(proto.Hello{Client: "game"})
	id2, k2, _ := ownedSeat(t, ct, c2, idOf(t, snap, "w2"), 1)
	c2.mustAck(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: id2, Text: "PASSWORD=" + sentinel})
	if cmds := k2.commands(); !slices.Contains(cmds, "paste "+strconv.Quote("PASSWORD="+sentinel)) {
		t.Fatalf("shell controller = %q", cmds)
	}
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if strings.Contains(e.Args, sentinel) || strings.Contains(e.Result, sentinel) {
			t.Fatalf("the secret is in the audit: %s %s", e.Cmd, e.Args)
		}
	}
}
