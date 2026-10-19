package notify

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// H3D-1: what the tests of the Questions only mode and of the question
// identity share.

const muffinAsks = "Which screenshots should the store page use: the dry run's, or wait for the final art?"

// reportObs is Muffin, a coder, done with a ready report that asks for
// input (no ask, no follow-up), its status since since, its line the
// activity summary.
func reportObs(id string, since int64, request string) Observation {
	return Observation{Worker: Worker{ID: id, Status: "done", StatusSince: since, Role: "code",
		Report: &Report{State: "ready", InputRequired: &request, Request: request}},
		Name: "Muffin", Line: "Dry-running the screenshot set with placeholder art and checking the cut-out images."}
}

// questionsRig is newRig in a mode, replies on or off.
func questionsRig(t *testing.T, mode string, replies bool) *rig {
	t.Helper()
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		o.Answer = (&answerer{}).answer
		o.Prompt = (&prompter{}).prompt
		st.Mode, st.Replies = mode, replies
	})
	if replies {
		waitListening(t, r.ch)
	}
	return r
}

// quiet waits a moment and fails if more than n messages went.
func (r *rig) noMore(t *testing.T, n int) {
	t.Helper()
	if r.ch.WaitSent(n+1, 150*time.Millisecond) {
		t.Fatalf("%d messages, want %d: %+v", len(r.ch.Sent()), n, r.ch.Sent())
	}
}

// The ticket's reproduction: one unresolved report request seen again at
// each status_since flip (60000, 120000, 180000) notifies once in the
// broader mode; under Questions only exactly one message goes, and it is
// the request itself, not the activity summary.
func TestReportRequestOnceAcrossStatusFlips(t *testing.T) {
	for _, mode := range []string{ModeEverything, ModeQuestions} {
		t.Run(mode, func(t *testing.T) {
			r := questionsRig(t, mode, false)
			r.svc.Observe(working("m"))
			for _, since := range []int64{60000, 120000, 180000} {
				r.svc.Observe(reportObs("m", since, muffinAsks))
			}
			r.svc.Observe(reportObs("m", 180000, muffinAsks))
			if !r.ch.WaitSent(1, 5*time.Second) {
				t.Fatal("nothing sent")
			}
			r.noMore(t, 1)
			n := r.ch.Sent()[0]
			if n.Reason != ReasonReport {
				t.Fatalf("reason %q", n.Reason)
			}
			text := n.Text()
			if mode == ModeEverything {
				if text != "Muffin · Report request\nDry-running the screenshot set with placeholder art and checking the cut-out images." {
					t.Fatalf("text %q", text)
				}
				return
			}
			want := "Muffin · Report request\n" + muffinAsks + "\n\n" + CardOffText
			if text != want {
				t.Fatalf("text %q, want %q", text, want)
			}
		})
	}
}

// orchObs is an orchestrator over its review-pass cap (pass), its status
// since since.
func orchObs(id string, since int64, status string, pass int) Observation {
	return Observation{Worker: Worker{ID: id, Status: status, StatusSince: since, Role: "orch", Pass: &pass},
		Name: "Secrets", Line: "Reviewing pass " + strconv.Itoa(pass)}
}

// The owner's flap: an orchestrator over the review-pass cap whose status
// keeps flipping notifies once in the broader mode (a new pass is a new
// episode), never under Questions only.
func TestReviewCapOnceAcrossStatusFlips(t *testing.T) {
	for _, mode := range []string{ModeEverything, ModeQuestions} {
		t.Run(mode, func(t *testing.T) {
			r := questionsRig(t, mode, false)
			r.svc.Observe(working("o"))
			for i, since := range []int64{60000, 120000, 180000, 240000} {
				r.svc.Observe(orchObs("o", since, []string{"idle", "working"}[i%2], 4))
			}
			want := 1
			if mode == ModeQuestions {
				want = 0
			} else if !r.ch.WaitSent(1, 5*time.Second) {
				t.Fatal("nothing sent")
			}
			r.noMore(t, want)
			r.svc.Observe(orchObs("o", 300000, "idle", 5))
			if mode == ModeEverything && !r.ch.WaitSent(2, 5*time.Second) {
				t.Fatal("a new pass over the cap was not sent")
			}
			r.noMore(t, 2*want)
		})
	}
}

// A wrap-up that needs you is one episode while it lasts, whatever its
// worker's status does; another wrap-up is another.
func TestWrapUpOnceAcrossStatusFlips(t *testing.T) {
	wrap := func(since, armed int64) Observation {
		return Observation{Worker: Worker{ID: "w", Status: "idle", StatusSince: since, WrapUpState: "needs_you", WrapUpArmedAt: armed}, Name: "Gecko"}
	}
	for _, mode := range []string{ModeEverything, ModeQuestions} {
		t.Run(mode, func(t *testing.T) {
			r := questionsRig(t, mode, false)
			r.svc.Observe(working("w"))
			r.svc.Observe(wrap(10, 5))
			r.svc.Observe(wrap(20, 5))
			r.svc.Observe(wrap(30, 5))
			want := 1
			if mode == ModeQuestions {
				want = 0
			} else if !r.ch.WaitSent(1, 5*time.Second) || r.ch.Sent()[0].Reason != ReasonWrapUp {
				t.Fatalf("sent %+v", r.ch.Sent())
			}
			r.noMore(t, want)
			r.svc.Observe(wrap(40, 35))
			if mode == ModeEverything && !r.ch.WaitSent(2, 5*time.Second) {
				t.Fatal("another wrap-up was not sent")
			}
			r.noMore(t, 2*want)
		})
	}
}

// A report request resolved, then asked again with the same words, is a
// new one.
func TestReportRequestResolvedThenAskedAgain(t *testing.T) {
	r := questionsRig(t, ModeEverything, false)
	r.svc.Observe(working("m"))
	r.svc.Observe(reportObs("m", 60000, muffinAsks))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("nothing sent")
	}
	resolved := reportObs("m", 120000, muffinAsks)
	resolved.Worker.Report.Resolved = true
	r.svc.Observe(resolved)
	r.svc.Observe(working("m"))
	r.noMore(t, 1)
	r.svc.Observe(reportObs("m", 180000, muffinAsks))
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("the request asked again was not sent")
	}
	r.noMore(t, 2)
}

// sendRows is the notify.send rows so far.
func sendRows(r *rig) []sendAudit {
	var out []sendAudit
	for _, row := range rowsOf(r, AuditSend) {
		out = append(out, row.args.(sendAudit))
	}
	return out
}

func (r *rig) waitSendRows(t *testing.T, n int) []sendAudit {
	t.Helper()
	if !r.ch.WaitFor(func() bool { return len(sendRows(r)) >= n }, 5*time.Second) {
		t.Fatalf("%d notify.send rows, want %d: %+v", len(sendRows(r)), n, sendRows(r))
	}
	return sendRows(r)
}

// Questions only, replies on: an ask is its card alone, which rings; a
// multi-question ask's later cards are quiet; the same ask seen again
// (another status_since, another line) sends nothing; a new ask notifies.
// Each set writes one notify.send row: its reason, its cards.
func TestQuestionsOnlyAskCards(t *testing.T) {
	r := questionsRig(t, ModeQuestions, true)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_1", false, false)), 1)
	if c := r.ch.SentCard(refs[0]); c.Quiet || !strings.Contains(c.Text, "Pixel · Question · Database\nWhich database?") {
		t.Fatalf("card %+v", c)
	}
	again := asking("w1", dbAsk("toolu_1", false, false))
	again.Worker.StatusSince, again.Line = 99, "Still thinking about databases"
	r.svc.Observe(again)
	two := &Ask{ToolUseID: "toolu_2", Since: 70, Questions: append(dbAsk("", false, false).Questions,
		AskQuestion{HasOptions: true, Header: "Cache", Question: "Which cache?", Options: []AskOption{{Label: "None"}, {Label: "Redis"}}})}
	r.svc.Observe(asking("w1", two))
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 3 }, 5*time.Second) {
		t.Fatalf("%d cards, want 3", len(r.ch.Cards()))
	}
	cs := r.ch.Cards()
	if first, second := r.ch.SentCard(cs[1]), r.ch.SentCard(cs[2]); first.Quiet || !second.Quiet ||
		!strings.Contains(first.Text, "Question 1 of 2") || !strings.Contains(second.Text, "Which cache?") {
		t.Fatalf("cards %+v, %+v", first, second)
	}
	time.Sleep(50 * time.Millisecond)
	if n := r.ch.Sent(); len(n) != 0 || len(r.ch.Cards()) != 3 {
		t.Fatalf("sent %+v, %d cards", n, len(r.ch.Cards()))
	}
	rows := r.waitSendRows(t, 2)
	want := []sendAudit{{ID: "w1", Kind: "needs_you", Reason: ReasonQuestion, About: aboutAsk, Via: viaCards, Cards: 1},
		{ID: "w1", Kind: "needs_you", Reason: ReasonQuestion, About: aboutAsk, Via: viaCards, Cards: 2}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %+v", rows)
	}
}

// Questions only: a follow-up's cards, the first ringing.
func TestQuestionsOnlyFollowupCards(t *testing.T) {
	r := questionsRig(t, ModeQuestions, true)
	fu := &Followup{TurnID: "turn-1", At: 60, Questions: []FollowupQuestion{
		{ID: "q1", Question: "Ship it?", Kind: "yes_no"}, {ID: "q2", Question: "Anything else?", Kind: "open"}}}
	refs := r.cardsFor(t, "w1", Observation{Worker: Worker{ID: "w1", Status: "done", StatusSince: 1, Followup: fu}, Name: "Pixel"}, 2)
	if a, b := r.ch.SentCard(refs[0]), r.ch.SentCard(refs[1]); a.Quiet || !b.Quiet || !strings.Contains(a.Text, "Pixel · Follow-up 1 of 2\nShip it?") {
		t.Fatalf("cards %+v, %+v", a, b)
	}
	r.clock.Advance(time.Minute) // the done it is in never notifies here
	r.noMore(t, 0)
}

// Questions only: a worker turns blocked (nothing: no question yet), then
// its permission menu is read: one card, ringing, with no alert before
// it. A blocked spell that never shows a menu sends nothing.
func TestQuestionsOnlyMenuCard(t *testing.T) {
	r := questionsRig(t, ModeQuestions, true)
	r.svc.Observe(working("w1"))
	r.svc.Observe(menuOn("w1", 100, nil))
	r.svc.Observe(working("w2"))
	r.svc.Observe(blocked("w2", 100))
	time.Sleep(100 * time.Millisecond)
	if len(r.ch.Sent()) != 0 || len(r.ch.Cards()) != 0 {
		t.Fatalf("a bare block sent %+v, %d cards", r.ch.Sent(), len(r.ch.Cards()))
	}
	r.svc.Observe(menuOn("w1", 100, permMenu("0123456789abcdef")))
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 1 }, 5*time.Second) {
		t.Fatal("no menu card")
	}
	if c := r.ch.SentCard(r.ch.Cards()[0]); c.Quiet || !strings.Contains(c.Text, "Pixel · Permission\n"+menuAsks["permission"]) || len(c.Buttons) == 0 {
		t.Fatalf("card %+v", c)
	}
	r.svc.Observe(menuOn("w1", 100, permMenu("0123456789abcdef"))) // read again
	r.noMore(t, 0)
	if rows := r.waitSendRows(t, 1); !reflect.DeepEqual(rows, []sendAudit{{ID: "w1", Kind: "needs_you", Reason: ReasonNeedsYou, About: aboutMenu, Via: viaCards, Cards: 1}}) {
		t.Fatalf("rows %+v", rows)
	}
	if len(r.ch.Cards()) != 1 {
		t.Fatalf("%d cards", len(r.ch.Cards()))
	}
}

// Questions only: done, a wrap-up, a bare block, a new activity line and a
// report request with no text to show send nothing.
func TestQuestionsOnlySuppresses(t *testing.T) {
	r := questionsRig(t, ModeQuestions, true)
	for _, id := range []string{"d", "u", "b", "a", "m"} {
		r.svc.Observe(working(id))
	}
	r.svc.Observe(doneObs("d", 10))
	r.svc.Observe(Observation{Worker: Worker{ID: "u", Status: "idle", StatusSince: 10, WrapUpState: "needs_you", WrapUpArmedAt: 5}, Name: "Gecko"})
	r.svc.Observe(blocked("b", 10))
	busy := working("a")
	busy.Line = "Dry-running the screenshot set"
	r.svc.Observe(busy)
	r.svc.Observe(reportObs("m", 10, "   "))
	r.clock.Advance(time.Minute)
	time.Sleep(100 * time.Millisecond)
	if len(r.ch.Sent()) != 0 || len(r.ch.Cards()) != 0 {
		t.Fatalf("sent %+v, %d cards", r.ch.Sent(), len(r.ch.Cards()))
	}
}

// Quiet silences a question's cards and its text alike.
func TestQuestionsOnlyQuiet(t *testing.T) {
	for _, replies := range []bool{true, false} {
		r := newRigWith(t, true, func(o *Options, st *Settings) {
			st.Mode, st.Replies, st.Quiet = ModeQuestions, replies, true
		})
		if replies {
			waitListening(t, r.ch)
			refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_1", false, false)), 1)
			if !r.ch.SentCard(refs[0]).Quiet {
				t.Fatal("a card rang though Quiet")
			}
			continue
		}
		r.svc.Observe(working("w1"))
		r.svc.Observe(asking("w1", dbAsk("toolu_1", false, false)))
		if !r.ch.WaitSent(1, 5*time.Second) || !r.ch.Sent()[0].Quiet {
			t.Fatalf("sent %+v", r.ch.Sent())
		}
	}
}

// Questions only with replies off: the question's text is the message, and
// says to answer it in the game; a secret ask's says only that a question
// waits; a menu's what it asks and its choices. Each one message, no card.
func TestQuestionsOnlyRepliesOffText(t *testing.T) {
	r := questionsRig(t, ModeQuestions, false)
	r.svc.Observe(working("w1"))
	r.svc.Observe(asking("w1", dbAsk("toolu_1", true, true)))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("nothing sent")
	}
	want := "Pixel · Question\nDatabase\nWhich database?\n1. Postgres: Relational, the default\n2. SQLite: One file\n3. Redis\nOne or more.\n\n" + CardOffText
	if got := r.ch.Sent()[0].Text(); got != want {
		t.Fatalf("text %q, want %q", got, want)
	}
	secret := &Ask{ToolUseID: "toolu_s", Since: 50, Questions: []AskQuestion{{HasOptions: true, Secret: true}, {HasOptions: true}}}
	r.svc.Observe(working("w2"))
	r.svc.Observe(asking("w2", secret))
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("the secret ask sent nothing")
	}
	if got := r.ch.Sent()[1].Text(); got != "Pixel · Question\n"+QuestionSecretText {
		t.Fatalf("secret %q", got)
	}
	r.svc.Observe(working("w3"))
	r.svc.Observe(menuOn("w3", 100, nil))
	r.svc.Observe(menuOn("w3", 100, permMenu("0123456789abcdef")))
	if !r.ch.WaitSent(3, 5*time.Second) {
		t.Fatal("the menu sent nothing")
	}
	want = "Pixel · Permission\n" + menuAsks["permission"] + "\n" + CardMenuAboutText + "\n1. Yes\n2. Yes, and always allow access to /tmp/proj from this project\n3. No\n\n" + CardOffText
	if got := r.ch.Sent()[2].Text(); got != want {
		t.Fatalf("menu %q, want %q", got, want)
	}
	r.noMore(t, 3)
	if len(r.ch.Cards()) != 0 {
		t.Fatalf("%d cards", len(r.ch.Cards()))
	}
	rows := r.waitSendRows(t, 3)
	for i, about := range []string{aboutAsk, aboutAsk, aboutMenu} {
		if rows[i].Via != viaQuestion || rows[i].About != about || rows[i].Cards != 0 || rows[i].Attempts != 1 {
			t.Fatalf("row %d %+v", i, rows[i])
		}
	}
}

// The broader mode's notify.send rows say why and how many cards followed:
// an ask's alert and its card, a bare block's alert alone.
func TestSendAuditReasonAndCards(t *testing.T) {
	r := newCardRig(t, &answerer{})
	r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_1", false, false)), 1)
	r.svc.Observe(working("w2"))
	r.svc.Observe(blocked("w2", 10))
	rows := r.waitSendRows(t, 2)
	want := []sendAudit{{ID: "w1", Kind: "needs_you", Reason: ReasonQuestion, About: aboutAsk, Cards: 1, Attempts: 1},
		{ID: "w2", Kind: "needs_you", Reason: ReasonNeedsYou, About: aboutBlocked, Attempts: 1}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %+v", rows)
	}
}

// The mode is kept (a restart reads it back); a setting saved before it
// existed is everything; another value is refused.
func TestModeSetting(t *testing.T) {
	r := newRig(t, true)
	if m := r.svc.View().Mode; m != ModeEverything {
		t.Fatalf("mode %q", m)
	}
	bad := "some"
	if err := r.svc.Apply(context.Background(), Update{Mode: &bad}); CodeOf(err) != CodeBadRequest {
		t.Fatalf("bad mode: %v", err)
	}
	q := ModeQuestions
	if err := r.svc.Apply(context.Background(), Update{Mode: &q}); err != nil {
		t.Fatal(err)
	}
	if r.store.set.Mode != ModeQuestions || r.svc.View().Mode != ModeQuestions {
		t.Fatalf("saved %+v, view %q", r.store.set, r.svc.View().Mode)
	}
	again, err := New(context.Background(), Options{Store: r.store, Channel: NewFakeChannel(true)})
	if err != nil || again.View().Mode != ModeQuestions {
		t.Fatalf("restarted: %v %q", err, again.View().Mode)
	}
	old := NewFakeStore()
	old.set = &Settings{Enabled: true, NeedsYou: true}
	before, err := New(context.Background(), Options{Store: old, Channel: NewFakeChannel(true)})
	if err != nil || before.View().Mode != ModeEverything || before.questionsOnly() {
		t.Fatalf("saved before the mode: %v %q", err, before.View().Mode)
	}
}

// An alert that waits (here, parked by its worker's cooldown) and is no
// question is dropped once Questions only is on.
func TestQuestionsOnlyDropsWaitingAlerts(t *testing.T) {
	r := newRigWith(t, true, func(o *Options, _ *Settings) {
		o.Limits = NoLimits()
		o.Limits.Cooldown = time.Minute
	})
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("nothing sent")
	}
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 20))
	r.waitTimer(t, 1)
	q := ModeQuestions
	if err := r.svc.Apply(context.Background(), Update{Mode: &q}); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(time.Minute)
	if !r.ch.WaitFor(func() bool { return len(rowsOf(r, AuditLimit)) == 1 }, 5*time.Second) {
		t.Fatal("the parked alert was not released")
	}
	if row := rowsOf(r, AuditLimit)[0].args.(limitAudit); row.Outcome != "dropped" {
		t.Fatalf("limit row %+v", row)
	}
	r.noMore(t, 1)
}

// A freelancer with an unresolved report request, blocked later on a
// permission menu: the menu's card still comes (with an alert in the
// broader mode, its blocked spell's, as before the episode was the
// request), and the request, seen again after it, notifies no more.
func TestMenuOfAWorkerWithARequest(t *testing.T) {
	for _, mode := range []string{ModeEverything, ModeQuestions} {
		t.Run(mode, func(t *testing.T) {
			r := questionsRig(t, mode, true)
			r.svc.Observe(working("m"))
			r.svc.Observe(reportObs("m", 60000, muffinAsks))
			if !r.ch.WaitSent(1, 5*time.Second) {
				t.Fatal("the request sent nothing")
			}
			onMenu := reportObs("m", 120000, muffinAsks)
			onMenu.Worker.Status = "blocked"
			r.svc.Observe(onMenu)
			onMenu.Worker.Menu = permMenu("0123456789abcdef")
			r.svc.Observe(onMenu)
			if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 1 }, 5*time.Second) {
				t.Fatalf("%d menu cards, want 1", len(r.ch.Cards()))
			}
			want := 1 // under Questions only the card is the message
			if mode == ModeEverything {
				want = 2
				if !r.ch.WaitSent(2, 5*time.Second) {
					t.Fatal("the menu's spell sent no alert")
				}
			}
			if c := r.ch.SentCard(r.ch.Cards()[0]); c.Quiet == (mode == ModeQuestions) {
				t.Fatalf("card quiet %v in %s", c.Quiet, mode)
			}
			r.svc.Observe(reportObs("m", 180000, muffinAsks)) // answered: the request again
			r.noMore(t, want)
			if len(r.ch.Cards()) != 1 {
				t.Fatalf("%d cards", len(r.ch.Cards()))
			}
		})
	}
}

// Review R2: a native call replaced under the same screen operation is a
// new decision (#106 row 4): with replies off under Questions only it is
// a message of its own.
func TestNativeReplacementRepliesOff(t *testing.T) {
	r := questionsRig(t, ModeQuestions, false)
	r.svc.Observe(working("w"))
	a := permMenu("hash-a")
	a.Op, a.Native = "same-screen-operation", "call-a"
	r.svc.Observe(menuOn("w", 100, a))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("the first permission was not sent")
	}
	b := permMenu("hash-b")
	b.Op, b.Native = a.Op, "call-b"
	r.svc.Observe(menuOn("w", 100, b))
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("the new native call sent no question")
	}
	r.noMore(t, 2)
}

// Review R3: a question card set parked by the send budget does not go
// once notifications were switched off meanwhile.
func TestParkedQuestionAfterDisabled(t *testing.T) {
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		st.Mode, st.Replies = ModeQuestions, true
		o.Limits = NoLimits()
		o.Limits.WorkerCards, o.Limits.Window = 1, time.Minute
	})
	waitListening(t, r.ch)
	r.cardsFor(t, "w", asking("w", dbAsk("ask-a", false, false)), 1)
	r.svc.Observe(asking("w", dbAsk("ask-b", false, false)))
	r.waitTimer(t, 1)
	off := false
	if err := r.svc.Apply(context.Background(), Update{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(time.Minute)
	if r.ch.WaitFor(func() bool { return len(r.ch.Cards()) > 1 || len(r.ch.Sent()) > 0 }, 300*time.Millisecond) {
		t.Fatal("the parked question went after notifications were switched off")
	}
}

// Review R4: a question card set parked by the send budget goes as its
// text once replies were switched off meanwhile.
func TestParkedQuestionRepliesTurnedOff(t *testing.T) {
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		st.Mode, st.Replies = ModeQuestions, true
		o.Limits = NoLimits()
		o.Limits.WorkerCards, o.Limits.Window = 1, time.Minute
	})
	waitListening(t, r.ch)
	r.cardsFor(t, "w", asking("w", dbAsk("ask-b", false, false)), 1)
	r.svc.Observe(asking("w", dbAsk("ask-c", false, false)))
	r.waitTimer(t, 1)
	off := false
	if err := r.svc.Apply(context.Background(), Update{Replies: &off}); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(time.Minute)
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("the parked question was lost instead of going as its text")
	}
	if got := r.ch.Sent()[0].Text(); !strings.Contains(got, "Which database?") || !strings.HasSuffix(got, CardOffText) {
		t.Fatalf("text %q", got)
	}
	r.noMore(t, 1)
}

// Review R5: a report request the worker still shows is never forgotten,
// however many other questions come between.
func TestUnresolvedReportAfterManyMenus(t *testing.T) {
	r := questionsRig(t, ModeQuestions, false)
	r.svc.Observe(working("w"))
	original := reportObs("w", 60000, muffinAsks)
	r.svc.Observe(original)
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("the report request was not sent")
	}
	for i := range 2 * maxKnown {
		o := reportObs("w", 60000, muffinAsks)
		o.Worker.Status = "blocked"
		m := permMenu("hash-" + strconv.Itoa(i))
		m.Op = "op-" + strconv.Itoa(i)
		o.Worker.Menu = m
		r.svc.Observe(o)
		if !r.ch.WaitSent(i+2, 5*time.Second) {
			t.Fatalf("menu %d was not sent", i)
		}
	}
	original.Worker.StatusSince = 180000
	r.svc.Observe(original)
	r.noMore(t, 2*maxKnown+1)
}

// rings counts what rang: the messages sent (a failed attempt aside) and
// the cards that went with a sound.
func (r *rig) rings() int {
	n := 0
	for _, s := range r.ch.Sent() {
		if s.Name != "(failed)" {
			n++
		}
	}
	for _, ref := range r.ch.Cards() {
		if !r.ch.SentCard(ref).Quiet {
			n++
		}
	}
	return n
}

// The episode matrix (H3D-1): each kind in either mode, replies off and
// on. Step by step: its first sighting; the same state with another line;
// another status_since (directly, then through a working spell); a new
// question; a menu's native call replaced. A kind named by its blocked
// spell or its done (a bare block, done; a bare block's menu in the
// broader mode is its spell's) is new with each status_since, by design.
func TestEpisodeMatrix(t *testing.T) {
	menu := func(since int64, v, native string) *Menu {
		m := permMenu(fmt64("h-%s-%s-%d", v, native, since))
		m.Decision, m.Op, m.Native = "d-"+v, fmt64("op-%s-%d", v, since), native
		return m
	}
	cases := []struct {
		name string
		at   func(since int64, v, native, line string) Observation
		// want: what rings at each step, broader and Questions only.
		want map[string][6]int
	}{
		{"ask", func(since int64, v, _, line string) Observation {
			o := asking("w", dbAsk("ask-"+v, false, false))
			o.Worker.StatusSince, o.Line = since, line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 0}, ModeQuestions: {1, 0, 0, 0, 1, 0}}},
		{"followup", func(since int64, v, _, line string) Observation {
			return Observation{Worker: Worker{ID: "w", Status: "idle", StatusSince: since, Followup: &Followup{TurnID: "turn-" + v, At: since,
				Questions: []FollowupQuestion{{ID: "q1", Question: "Ship it?", Kind: "yes_no"}}}}, Name: "Pixel", Line: line}
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 0}, ModeQuestions: {1, 0, 0, 0, 1, 0}}},
		{"report", func(since int64, v, _, line string) Observation {
			o := reportObs("w", since, muffinAsks+" ("+v+")")
			o.Line = line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 0}, ModeQuestions: {1, 0, 0, 0, 1, 0}}},
		{"wrapup", func(since int64, v, _, line string) Observation {
			return Observation{Worker: Worker{ID: "w", Status: "idle", StatusSince: since, WrapUpState: "needs_you",
				WrapUpArmedAt: int64(atoi(v)) * 7}, Name: "Gecko", Line: line}
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 0}, ModeQuestions: {}}},
		{"crew", func(since int64, v, _, line string) Observation {
			o := orchObs("w", since, "idle", 3+atoi(v))
			o.Line = line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 0}, ModeQuestions: {}}},
		{"blocked", func(since int64, _, _, line string) Observation {
			o := blocked("w", since)
			o.Line = line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 1, 1, 1, 0}, ModeQuestions: {}}},
		{"done", func(since int64, _, _, line string) Observation {
			o := doneObs("w", since)
			o.Line = line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 1, 1, 1, 0}, ModeQuestions: {}}},
		{"menu", func(since int64, v, native, line string) Observation {
			o := menuOn("w", since, menu(since, v, native))
			o.Line = line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 1, 1, 1, 0}, ModeQuestions: {1, 0, 0, 0, 1, 1}}},
		{"request_menu", func(since int64, v, native, line string) Observation {
			o := reportObs("w", since, muffinAsks)
			o.Worker.Status, o.Worker.Menu, o.Line = "blocked", menu(since, v, native), line
			return o
		}, map[string][6]int{ModeEverything: {1, 0, 0, 0, 1, 1}, ModeQuestions: {1, 0, 0, 0, 1, 1}}},
	}
	for _, c := range cases {
		for _, mode := range []string{ModeEverything, ModeQuestions} {
			for _, replies := range []bool{false, true} {
				t.Run(fmt64("%s/%s/replies=%t", c.name, mode, replies), func(t *testing.T) {
					r := questionsRig(t, mode, replies)
					step := func(os ...Observation) int {
						before := r.rings()
						for _, o := range os {
							r.svc.Observe(o)
							r.settle(t)
						}
						r.clock.Advance(DefaultSettle) // a done's settle
						r.settle(t)
						return r.rings() - before
					}
					step(working("w"))
					got := [6]int{
						step(c.at(60000, "1", "call-a", "line 1")),
						step(c.at(60000, "1", "call-a", "line 2"), c.at(60000, "1", "call-a", "line 2")),
						step(c.at(120000, "1", "call-a", "line 3")),
						step(working("w"), c.at(180000, "1", "call-a", "line 4")),
						step(c.at(240000, "2", "call-a", "line 5")),
						step(c.at(240000, "2", "call-b", "line 5")),
					}
					if want := c.want[mode]; got != want {
						t.Fatalf("rang %v, want %v (first, line, since, working between, new, native)", got, want)
					}
				})
			}
		}
	}
}

func fmt64(format string, a ...any) string { return fmt.Sprintf(format, a...) }

func atoi(v string) int {
	n, _ := strconv.Atoi(v)
	return n
}

// The delivery matrix (H3D-1, review R3/R4): a question waiting (its card
// set parked by the card budget, its text parked by the cooldown, its text
// between two attempts) when the settings change is checked again as it
// goes: switched off or its event off, nothing; the mode or replies
// changed, it goes in the form they say now.
func TestWaitingQuestionMatrix(t *testing.T) {
	no, yes := false, true
	everything := ModeEverything
	changes := []struct {
		name string
		// from: replies before the change; u the change (then: undone,
		// for replies off and on again).
		from    bool
		u, then Update
		// want: nothing; else an alert, its text ending end, or a card
		// that rings.
		nothing bool
		alert   bool
		end     string
		ring    bool
	}{
		{name: "enabled_off", from: true, u: Update{Enabled: &no}, nothing: true},
		{name: "needs_you_off", from: true, u: Update{NeedsYou: &no}, nothing: true},
		{name: "mode_everything", from: true, u: Update{Mode: &everything}, alert: true},
		{name: "replies_off", from: true, u: Update{Replies: &no}, end: CardOffText},
		{name: "replies_on", from: false, u: Update{Replies: &yes}, ring: true},
	}
	waits := []string{"cards", "alert", "retry"}
	for _, w := range waits {
		for _, c := range changes {
			t.Run(w+"/"+c.name, func(t *testing.T) {
				from := c.from
				if w == "cards" {
					from = true // a card set waits only while replies are on
				}
				var hold, entered chan struct{}
				r := newRigWith(t, true, func(o *Options, st *Settings) {
					st.Mode, st.Replies = ModeQuestions, from
					o.Answer = (&answerer{}).answer
					o.Prompt = (&prompter{}).prompt
					o.Limits = NoLimits()
					switch w {
					case "cards":
						o.Limits.WorkerCards, o.Limits.Window = 1, time.Minute
					case "alert":
						o.Limits.Cooldown = time.Minute
					}
				})
				if from {
					waitListening(t, r.ch)
				}
				// A question with cards (an ask), or with replies on and no
				// cards to wait as text, a report request.
				first, second := asking("w", dbAsk("ask-a", false, false)), asking("w", dbAsk("ask-b", false, false))
				text := "Which database?"
				if w != "cards" && from {
					first, second = reportObs("w", 60000, muffinAsks), reportObs("w", 60000, "Which art?")
					text = "Which art?"
				}
				if w == "retry" {
					hold, entered = make(chan struct{}), make(chan struct{})
					r.ch.SendErr = func(_ context.Context, n int) error {
						if n == 0 {
							close(entered)
							<-hold
							return &SendError{Code: CodeUnreachable, Msg: "down"}
						}
						return nil
					}
					r.svc.Observe(working("w"))
					r.svc.Observe(second)
					select {
					case <-entered: // its first attempt is under way
					case <-time.After(5 * time.Second):
						t.Fatal("no attempt")
					}
				} else {
					r.svc.Observe(working("w"))
					r.svc.Observe(first)
					if !r.ch.WaitFor(func() bool { return r.rings() == 1 }, 5*time.Second) {
						t.Fatal("the first question did not go")
					}
					r.svc.Observe(second)
					r.waitTimer(t, 1)
				}
				before, cards := r.rings(), len(r.ch.Cards())
				if err := r.svc.Apply(context.Background(), c.u); err != nil {
					t.Fatal(err)
				}
				if c.name == "replies_on" && w == "cards" {
					// off and on again before it goes: it still rings.
					if err := r.svc.Apply(context.Background(), Update{Replies: &no}); err != nil {
						t.Fatal(err)
					}
					if err := r.svc.Apply(context.Background(), c.u); err != nil {
						t.Fatal(err)
					}
				}
				if hold != nil {
					close(hold)
					r.waitTimer(t, 1) // its backoff
				}
				r.clock.Advance(time.Minute)
				r.settle(t)
				newCards := r.ch.Cards()[cards:]
				var sent []Notification
				for _, n := range r.ch.Sent() {
					if n.Name != "(failed)" {
						sent = append(sent, n)
					}
				}
				if w != "retry" {
					sent = sent[min(before, len(sent)):]
					if w == "cards" {
						sent = r.ch.Sent()
					}
				}
				switch {
				case c.nothing:
					if r.rings() != before || len(newCards) != 0 {
						t.Fatalf("went though switched off: %d rang, %d cards", r.rings()-before, len(newCards))
					}
				case c.alert:
					last := sent[len(sent)-1]
					if last.Body != "" || last.Reason != ReasonQuestion && last.Reason != ReasonReport {
						t.Fatalf("not the broader mode's alert: %+v", last)
					}
					for _, ref := range newCards {
						if !r.ch.SentCard(ref).Quiet {
							t.Fatal("a card rang after its alert")
						}
					}
				case c.end != "":
					if len(newCards) != 0 {
						t.Fatalf("%d cards with replies off", len(newCards))
					}
					last := sent[len(sent)-1]
					if !strings.Contains(last.Body, text) || !strings.HasSuffix(last.Body, c.end) {
						t.Fatalf("text %q", last.Body)
					}
				case c.ring:
					if len(newCards) != 1 || r.ch.SentCard(newCards[0]).Quiet || !strings.Contains(r.ch.SentCard(newCards[0]).Text, text) {
						t.Fatalf("%d cards, want one that rings", len(newCards))
					}
				}
				if !c.nothing && r.rings() != before+1 {
					t.Fatalf("%d rang, want 1", r.rings()-before)
				}
			})
		}
	}
}

// R1 with replies on: the same permission seen again after its status
// flipped (a working spell between ended its card) rings no more, and its
// card comes back, silent, so it can still be answered.
func TestMenuCardBackAfterStatusFlip(t *testing.T) {
	for _, mode := range []string{ModeEverything, ModeQuestions} {
		t.Run(mode, func(t *testing.T) {
			r := questionsRig(t, mode, true)
			at := func(since int64) Observation {
				m := permMenu(fmt64("hash-%d", since))
				m.Decision, m.Op = "the-decision", fmt64("op-%d", since)
				o := reportObs("w", since, muffinAsks) // its menu an episode of its own in either mode
				o.Worker.Status, o.Worker.Menu = "blocked", m
				return o
			}
			r.svc.Observe(working("w"))
			r.svc.Observe(at(60000))
			if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 1 }, 5*time.Second) {
				t.Fatal("no card")
			}
			r.settle(t)
			rang := r.rings()
			r.svc.Observe(working("w"))
			r.waitCard(t, r.ch.Cards()[0], CardGoneText)
			r.svc.Observe(at(120000))
			if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) == 2 }, 5*time.Second) {
				t.Fatal("its card did not come back")
			}
			r.settle(t)
			if c := r.ch.SentCard(r.ch.Cards()[1]); !c.Quiet || r.rings() != rang {
				t.Fatalf("rang again: card quiet %v, %d rang, want %d", c.Quiet, r.rings(), rang)
			}
		})
	}
}
