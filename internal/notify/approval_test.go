package notify

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// opMenu is permMenu of operation op (#106), about what about says.
func opMenu(hash, op string, about ...string) *Menu {
	m := permMenu(hash)
	m.Op, m.Source, m.About = op, "screen", about
	return m
}

func menuRows(r *rig) []menuAudit {
	var out []menuAudit
	for _, row := range rowsOf(r, AuditMenu) {
		out = append(out, row.args.(menuAudit))
	}
	return out
}

// #106 (the incident, notify side): one operation whose hash churns with
// every read (a counter in its dialog) in one blocked spell, the clock
// never moving: one card, never closed as answered or replaced; it shows
// the latest look, and a tap answers the latest hash.
func TestCardMenuOneCardThroughRedraws(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ref := r.menuCard(t, "w1", 100, opMenu(fmt.Sprintf("%016x", 0), "op-rm", "Bash command", "rm -f $D/* (0s)"))
	for i := 1; i < 10; i++ {
		r.svc.Observe(menuOn("w1", 100, opMenu(fmt.Sprintf("%016x", i), "op-rm", "Bash command", fmt.Sprintf("rm -f $D/* (%ds)", i))))
	}
	c := r.waitCard(t, ref, "rm -f $D/* (9s)")
	time.Sleep(50 * time.Millisecond)
	if n := len(r.ch.Cards()); n != 1 {
		t.Fatalf("%d cards, want 1", n)
	}
	for _, bad := range []string{CardInGameText, CardReplacedText, CardGoneText} {
		if strings.Contains(c.Text, bad) {
			t.Fatalf("card %q", c.Text)
		}
	}
	if len(c.Buttons) != 3 || len(r.ch.Sent()) != 1 {
		t.Fatalf("card %+v, %d alerts", c, len(r.ch.Sent()))
	}
	r.tap(t, ref, button(t, c, "1.").Data)
	if got := r.waitAnswers(t, a, 1); got[0].Hash != fmt.Sprintf("%016x", 9) || got[0].Choice != 1 {
		t.Fatalf("answer %+v", got[0])
	}
	r.waitCard(t, ref, "✓ Answered: Yes")
	if !r.ch.WaitFor(func() bool { return len(menuRows(r)) == 1 }, 5*time.Second) {
		t.Fatal("no notify.menu row")
	}
	if row := menuRows(r)[0]; row.Outcome != menuAnswered || row.Redraws != 9 || row.SpellOps != 1 || row.Source != "screen" {
		t.Fatalf("menu row %+v", row)
	}
}

// #106: a blocked spell going on with no menu read (a failed screen read,
// the hub's grace past) keeps the card and its buttons; the same operation
// back is the same card; the worker no longer blocked ends it as no longer
// waited on, never answered.
func TestCardMenuKeptThroughReadGap(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ref := r.menuCard(t, "w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a"))
	edits := r.ch.Edits()
	r.svc.Observe(menuOn("w1", 100, nil))
	r.svc.Observe(menuOn("w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a")))
	r.svc.Observe(menuOn("w1", 100, nil))
	time.Sleep(50 * time.Millisecond)
	if c := r.ch.Card(ref); len(c.Buttons) != 3 || len(r.ch.Cards()) != 1 || r.ch.Edits() != edits {
		t.Fatalf("card %+v, %d cards, %d edits", c, len(r.ch.Cards()), r.ch.Edits()-edits)
	}
	r.svc.Observe(working("w1"))
	if c := r.waitCard(t, ref, CardGoneText); len(c.Buttons) != 0 || strings.Contains(c.Text, CardInGameText) || !strings.Contains(c.Text, "touch a") {
		t.Fatalf("card %+v", c)
	}
	if !r.ch.WaitFor(func() bool { return len(menuRows(r)) == 1 }, 5*time.Second) || menuRows(r)[0].Outcome != menuGone {
		t.Fatalf("menu rows %+v", menuRows(r))
	}
	if len(a.all()) != 0 {
		t.Fatalf("answers %+v", a.all())
	}
}

// #106: a tap while no menu is read in the spell still goes (the hub reads
// the screen again before any key).
func TestCardMenuTapThroughReadGap(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ref := r.menuCard(t, "w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a"))
	r.svc.Observe(menuOn("w1", 100, nil))
	time.Sleep(20 * time.Millisecond)
	r.tap(t, ref, button(t, r.ch.Card(ref), "3.").Data)
	if got := r.waitAnswers(t, a, 1); got[0].Hash != "aaaaaaaaaaaaaaaa" || got[0].Choice != 3 {
		t.Fatalf("answer %+v", got[0])
	}
}

// #106: the operation's native call learnt after its card opened is the
// same card; another native call under the same screen operation is
// another operation: the card is replaced and the new one gets its own.
func TestCardMenuNativeCallReplaces(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ref := r.menuCard(t, "w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a"))
	x := opMenu("aaaaaaaaaaaaaaaa", "op-a", "Bash: touch a")
	x.Native, x.Source = "native-x", "native"
	r.svc.Observe(menuOn("w1", 100, x))
	r.waitCard(t, ref, "Bash: touch a")
	y := opMenu("aaaaaaaaaaaaaaaa", "op-a", "Bash: touch a")
	y.Native, y.Source = "native-y", "native"
	r.svc.Observe(menuOn("w1", 100, y))
	if c := r.waitCard(t, ref, CardReplacedText); len(c.Buttons) != 0 {
		t.Fatalf("card %+v", c)
	}
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 2 }, 5*time.Second) {
		t.Fatalf("%d cards, want 2", len(r.ch.Cards()))
	}
	// The first one's native call again: carded in this spell, no third card.
	r.svc.Observe(menuOn("w1", 100, x))
	time.Sleep(50 * time.Millisecond)
	if n := len(r.ch.Cards()); n != 2 {
		t.Fatalf("%d cards, want 2", n)
	}
}

// #106: a choice the bridge withheld (it approves what the card cannot show
// whole) has no button, the card says why, and a tap with its data (an
// old keyboard's) sends nothing.
func TestCardMenuWithheld(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	m := opMenu("aaaaaaaaaaaaaaaa", "op-a", "⚠ Its start is off the screen; it ends:", "rm -f $D/*")
	m.Choices[0].Withheld, m.Choices[1].Withheld = true, true
	ref := r.menuCard(t, "w1", 100, m)
	c := r.ch.Card(ref)
	if len(c.Buttons) != 1 || c.Buttons[0][0].Text != "3. No" || !strings.Contains(c.Text, CardWithheldText) || !strings.Contains(c.Text, "1. Yes") {
		t.Fatalf("card %+v", c)
	}
	tok, _, _, _ := parseData(c.Buttons[0][0].Data)
	if got := r.tapAnswer(t, r.tap(t, ref, data(tok, actOption, 1))); got != tapClosedText {
		t.Fatalf("withheld tap: %q", got)
	}
	r.tap(t, ref, c.Buttons[0][0].Data)
	if got := r.waitAnswers(t, a, 1); len(got) != 1 || got[0].Choice != 3 {
		t.Fatalf("answers %+v", got)
	}
	if !r.ch.WaitFor(func() bool { return len(menuRows(r)) == 1 }, 5*time.Second) || !menuRows(r)[0].Partial {
		t.Fatalf("menu rows %+v", menuRows(r))
	}
}

// #106: the notify.menu rows hold no text: no label, no line of what it is
// about, no hash or operation.
func TestCardMenuRowsHoldNoText(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	r.menuCard(t, "w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-secret", "curl -u admin:hunter2 https://x.test"))
	r.svc.Observe(menuOn("w1", 100, opMenu("bbbbbbbbbbbbbbbb", "op-other", "touch b")))
	r.svc.Observe(working("w1"))
	if !r.ch.WaitFor(func() bool { return len(menuRows(r)) == 2 }, 5*time.Second) {
		t.Fatalf("menu rows %+v", menuRows(r))
	}
	if rows := menuRows(r); rows[0].Outcome != menuReplaced || rows[0].SpellOps != 2 || rows[1].Outcome != menuGone {
		t.Fatalf("menu rows %+v", rows)
	}
	for _, row := range rowsOf(r, AuditMenu) {
		b, _ := json.Marshal(row.args)
		for _, bad := range []string{"curl", "hunter2", "touch", "Yes", "aaaa", "op-"} {
			if strings.Contains(string(b), bad) {
				t.Fatalf("%q in %s", bad, b)
			}
		}
	}
}

// #106: what a menu's card shows changes (a rewrap, its native call
// learnt): a new keyboard comes with it, and a tap on the old one, from
// before the user could see the change, answers nothing: it says to check
// the card and tap again, and the card keeps its buttons.
func TestCardMenuOldKeyboard(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ref := r.menuCard(t, "w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a b"))
	old := r.ch.Card(ref)
	r.svc.Observe(menuOn("w1", 100, opMenu("bbbbbbbbbbbbbbbb", "op-a", "touch a", "b")))
	now := r.waitCard(t, ref, "touch a\nb")
	if got := r.tapAnswer(t, r.tap(t, ref, button(t, old, "1.").Data)); got != tapChangedText {
		t.Fatalf("old keyboard's tap: %q", got)
	}
	time.Sleep(20 * time.Millisecond)
	if c := r.ch.Card(ref); len(c.Buttons) != 3 || len(a.all()) != 0 || len(r.ch.Cleared()) != 0 {
		t.Fatalf("card %+v, answers %+v", c, a.all())
	}
	r.tap(t, ref, button(t, now, "1.").Data)
	if got := r.waitAnswers(t, a, 1); got[0].Hash != "bbbbbbbbbbbbbbbb" {
		t.Fatalf("answer %+v", got[0])
	}
	if taps := rowsOf(r, AuditTap); len(taps) != 2 || taps[0].args.(tapAudit).Outcome != tapChanged {
		t.Fatalf("taps %+v", taps)
	}
}
