package notify

import (
	"context"
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
