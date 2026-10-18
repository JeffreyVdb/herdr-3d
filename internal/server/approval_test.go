package server_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// bashDialog is Claude Code's Bash permission prompt for command, as the
// captured screen draws it.
func bashDialog(command, description string) string {
	return "● Cleaning up\n" + strings.Repeat("─", 120) + "\n Bash command\n\n   " + command + "\n   " + description +
		"\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm commands in /home/u/w1\n   3. No\n\n Esc to cancel · Tab to amend\n"
}

// bashCallLine is the transcript's line of a Bash call (#106: what the
// prompt on the screen is for), and resultLine its result's.
func bashCallLine(id, command, description string) string {
	in, _ := json.Marshal(map[string]string{"command": command, "description": description})
	return `{"type":"assistant","isSidechain":false,"cwd":"/home/u/w1","timestamp":"2026-10-17T22:35:39.850Z","message":{"role":"assistant",` +
		`"content":[{"type":"tool_use","id":"` + id + `","name":"Bash","input":` + string(in) + `}]}}` + "\n"
}

func resultLine(id string) string {
	return `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id +
		`","content":"done"}]}}` + "\n"
}

const (
	cleanupCmd  = "S=/home/u/w1/run; D=$S/scratch; rm -f $D/*"
	cleanupDesc = "Clean the scratch directory"
	bypassLine  = `{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"s"}` + "\n"
)

// #106 acceptance (useful phone approval), end to end through the hub: a
// harmless variable-target cleanup Claude Code asks about in bypass mode.
// Its card shows the whole command from the transcript, its description,
// its directory and the bypass countdown; the native No is picked from
// Telegram: its digit sent once, the card says so, the notify.menu row
// says the identity was native.
func TestCardMenuNativeCleanup(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	rb.term.onKeys = func(string, []string) { go rb.setStatus("w1", "working") }
	appendLine(t, rb.claude, bypassLine+bashCallLine("toolu_clean", cleanupCmd, cleanupDesc))
	ref := rb.menuCardOf(t, "w1", bashDialog(cleanupCmd, cleanupDesc))
	c := waitCardText(t, rb.ch, ref, "In: /home/u/w1")
	for _, want := range []string{"Bash command\n" + cleanupCmd + "\n" + cleanupDesc + "\nIn: /home/u/w1\nBypass mode:", "1. Yes", "3. No"} {
		if !strings.Contains(c.Text, want) {
			t.Fatalf("card %q lacks %q", c.Text, want)
		}
	}
	if len(c.Buttons) != 3 {
		t.Fatalf("buttons %+v", c.Buttons)
	}
	rb.ch.Tap("t1", ref, buttonData(t, c, "3."))
	if end := waitCardText(t, rb.ch, ref, "✓ Answered: No"); len(end.Buttons) != 0 {
		t.Fatalf("buttons left %+v", end.Buttons)
	}
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 3"}) {
		t.Fatalf("calls %q", calls)
	}
	rows := waitNotifyRows(t, rb.st, notify.AuditMenu, 1)
	if !strings.Contains(rows[0].Args, `"source":"native"`) || !strings.Contains(rows[0].Args, `"outcome":"answered"`) ||
		strings.Contains(rows[0].Args, "rm") {
		t.Fatalf("menu row %+v", rows[0])
	}
}

// #106: the same command asked again as another call (the first one's
// result recorded, a new one pending) under an unchanged screen is another
// approval: the first card is replaced and a tap on it sends nothing; the
// new card's native Yes is sent once. Keys that leave the worker blocked:
// the card says so.
func TestCardMenuNativeCallReplaced(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	appendLine(t, rb.claude, bashCallLine("toolu_one", cleanupCmd, cleanupDesc))
	ref := rb.menuCardOf(t, "w1", bashDialog(cleanupCmd, cleanupDesc))
	old := waitCardText(t, rb.ch, ref, "In: /home/u/w1")
	appendLine(t, rb.claude, resultLine("toolu_one")+bashCallLine("toolu_two", cleanupCmd, cleanupDesc))
	if c := waitCardText(t, rb.ch, ref, notify.CardReplacedText); len(c.Buttons) != 0 {
		t.Fatalf("buttons left %+v", c.Buttons)
	}
	next := cardOf(t, rb.ch, 2)
	rb.ch.Tap("t1", ref, buttonData(t, old, "1."))
	time.Sleep(50 * time.Millisecond)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	rb.ch.Tap("t2", next, buttonData(t, waitCardText(t, rb.ch, next, "In: /home/u/w1"), "1."))
	if c := waitCardText(t, rb.ch, next, "✓ Sent: Yes\n"+notify.CardUnresolvedText); len(c.Buttons) != 0 {
		t.Fatalf("buttons left %+v", c.Buttons)
	}
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 1"}) {
		t.Fatalf("calls %q", calls)
	}
}

// tapChangedText is what a tap on a card's old keyboard is answered.
const tapChangedText = "It changed: check the card and tap again"

// tapAnswered waits for the n-th tap's answer and checks it says want.
func tapAnswered(t *testing.T, ch *notify.FakeChannel, n int, want string) {
	t.Helper()
	if !ch.WaitFor(func() bool { return len(ch.TapAnswers()) >= n }, 5*time.Second) || ch.TapAnswers()[n-1].Text != want {
		t.Fatalf("tap answers %+v, want %q", ch.TapAnswers(), want)
	}
}

// newKeyboard waits until card ref's button prefix is no longer old (its
// keyboard was replaced).
func newKeyboard(t *testing.T, ch *notify.FakeChannel, ref notify.Ref, prefix, old string) {
	t.Helper()
	if !ch.WaitFor(func() bool {
		for _, row := range ch.Card(ref).Buttons {
			for _, b := range row {
				if strings.HasPrefix(b.Text, prefix) {
					return b.Data != old
				}
			}
		}
		return false
	}, 5*time.Second) {
		t.Fatalf("card %+v kept its keyboard", ch.Card(ref))
	}
}

// questionOf is worker id's question as a new client's snapshot has it.
func (rb *replyBridge) questionOf(t *testing.T, ws string) *proto.Question {
	t.Helper()
	for _, w := range rb.connect(proto.Hello{}).snapshot().World.Workers {
		if w.ID == rb.ids[ws] {
			return w.Question
		}
	}
	t.Fatalf("no %s", ws)
	return nil
}

// #106: a command line that reads like a status line ("esc to interrupt")
// is the operation's: the card shows it, and a tap on its Yes once the
// screen asks about another command sends nothing; the new one gets its
// own card.
func TestCardMenuCommandLikeIncidentalThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.QuestionPoll = time.Hour; o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	first := bashDialog("echo 'esc to interrupt'; touch /tmp/a", "Perform cleanup")
	ref := rb.menuCardOf(t, "w1", first)
	c := rb.ch.Card(ref)
	if !strings.Contains(c.Text, "echo 'esc to interrupt'; touch /tmp/a") {
		t.Fatalf("card %q", c.Text)
	}
	rb.term.setScreen("w1:p1", strings.Replace(first, "touch /tmp/a", "rm -rf /tmp/b", 1))
	rb.ch.Tap("t1", ref, buttonData(t, c, "1."))
	waitCardText(t, rb.ch, ref, notify.CardReplacedText)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	if next := cardOf(t, rb.ch, 2); !strings.Contains(rb.ch.Card(next).Text, "rm -rf /tmp/b") {
		t.Fatalf("new card %+v", rb.ch.Card(next))
	}
}

// #106: a change the card cannot show (past a line's 300th character)
// still gives it a new keyboard: a tap on the old one sends nothing.
func TestCardMenuClippedChangeThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.QuestionPoll = time.Millisecond; o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	command := "echo " + strings.Repeat("ordinary words ", 25) + "; touch /tmp/a /tmp/b"
	first := bashDialog(command, "Perform cleanup")
	ref := rb.menuCardOf(t, "w1", first)
	old := rb.ch.Card(ref)
	yes := buttonData(t, old, "1.")
	rb.term.setScreen("w1:p1", strings.Replace(first, "touch /tmp/a /tmp/b", "touch /tmp/a/tmp/b", 1))
	newKeyboard(t, rb.ch, ref, "1.", yes)
	if c := rb.ch.Card(ref); c.Text != old.Text {
		t.Fatalf("the card shows the change: %q", c.Text)
	}
	rb.ch.Tap("t1", ref, yes)
	tapAnswered(t, rb.ch, 1, tapChangedText)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
}

// #106: a password in shell quotes never reaches the card.
func TestCardMenuQuotedPasswordThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	ref := rb.menuCardOf(t, "w1", bashDialog(`sshpass -p 'hunter2' ssh host && curl -u admin:"hunter2" https://x.test`, "Run command"))
	if c := rb.ch.Card(ref); strings.Contains(c.Text, "hunter2") || !strings.Contains(c.Text, "sshpass -p [key] ssh host") {
		t.Fatalf("card %q", c.Text)
	}
}

// #106: a permission dialog whose top is off the screen and whose call is
// not known is not approved from the game either (the screen shows only
// its end): its No is sent; a change anywhere it shows makes an answer
// stale.
func TestAnswerPartialDialog(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.QuestionPoll = time.Hour; o.AnswerTimeout = time.Millisecond })
	lines := []string{"D=/tmp/safe"}
	for range 15 {
		lines = append(lines, "echo step")
	}
	full := bashDialog(strings.Join(append(lines, "rm -f $D/*"), "\n   "), "Clean directory")
	cut := full[strings.Index(full, "   D="):]
	rb.term.setScreen("w1:p1", cut)
	rb.setStatus("w1", "blocked")
	q := upsertFor(rb.c, rb.ids["w1"], func(w *proto.Worker) bool { return w.Question != nil }).Question
	rb.c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: rb.ids["w1"], Hash: q.Hash, Choice: 1}, proto.ErrInvalidState)
	rb.term.setScreen("w1:p1", strings.Replace(cut, "D=/tmp/safe", "D=/tmp/important", 1))
	rb.c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: rb.ids["w1"], Hash: q.Hash, Choice: 3}, proto.ErrStale)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	now := rb.questionOf(t, "w1")
	rb.c.mustAck(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: rb.ids["w1"], Hash: now.Hash, Choice: 3})
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 3"}) {
		t.Fatalf("calls %q", calls)
	}
}

// #106: a card that knew its call (A) and whose screen now shows a command
// that differs from it only in its spaces is not A's any more: it shows
// what the screen asks, with a new keyboard; a tap on the old one sends
// nothing.
func TestCardMenuNativeWordsThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.QuestionPoll = time.Millisecond; o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	appendLine(t, rb.claude, bashCallLine("toolu_one", "touch /tmp/a /tmp/b", "Run command"))
	ref := rb.menuCardOf(t, "w1", bashDialog("touch /tmp/a /tmp/b", "Run command"))
	old := waitCardText(t, rb.ch, ref, "In: /home/u/w1")
	rb.term.setScreen("w1:p1", bashDialog("touch /tmp/a/tmp/b", "Run command"))
	if c := waitCardText(t, rb.ch, ref, "touch /tmp/a/tmp/b"); strings.Contains(c.Text, "In: /home/u/w1") {
		t.Fatalf("card %q", c.Text)
	}
	rb.ch.Tap("t1", ref, buttonData(t, old, "1."))
	tapAnswered(t, rb.ch, 1, tapChangedText)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
}

// #106: the game's answer is bound to the call its question was read with:
// once the transcript replaces it (the same command, in another directory)
// an answer with the old hash sends nothing.
func TestAnswerBoundToNativeCall(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	appendLine(t, rb.claude, bashCallLine("toolu_one", "touch target", "Run command"))
	ref := rb.menuCardOf(t, "w1", bashDialog("touch target", "Run command"))
	waitCardText(t, rb.ch, ref, "In: /home/u/w1")
	old := rb.questionOf(t, "w1").Hash
	appendLine(t, rb.claude, resultLine("toolu_one")+strings.Replace(bashCallLine("toolu_two", "touch target", "Run command"),
		`"cwd":"/home/u/w1"`, `"cwd":"/home/u/important"`, 1))
	waitCardText(t, rb.ch, ref, notify.CardReplacedText)
	rb.c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: rb.ids["w1"], Hash: old, Choice: 1}, proto.ErrStale)
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	if next := waitCardText(t, rb.ch, cardOf(t, rb.ch, 2), "In: /home/u/important"); len(next.Buttons) != 3 {
		t.Fatalf("new card %+v", next)
	}
}
