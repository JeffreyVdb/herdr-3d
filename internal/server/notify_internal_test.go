package server

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #13: each refusal of worker.prompt's path is told apart for the chat by
// what it wraps, never by its words.
func TestReplyErrorKinds(t *testing.T) {
	for _, c := range []struct {
		err  error
		kind string
	}{
		{fmt.Errorf("%w: Pixel %w: answer it first (worker.answer_ask)", errInvalidState, errAskWaiting), notify.ReplyAsk},
		{fmt.Errorf("%w: the worker %w: answer it first", errInvalidState, errAskWaiting), notify.ReplyAsk},
		{fmt.Errorf("%w: 32 commands are already %w", errInputFailed, errLaneFull), notify.ReplyBusy},
		{fmt.Errorf("%w: %q", errUnknownWorker, "w"), notify.ReplyGone},
		{errHandoffInGame, notify.ReplyHandoff},
		{badPromptText("text", 17000), notify.ReplyBadText},
		{fmt.Errorf("%w: floor %q is asleep", errInvalidState, "s"), notify.ReplyState},
		{fmt.Errorf("%w: pane gone", errPromptFailed), notify.ReplyFailed},
		{errHubStopped, notify.ReplyFailed},
		// #14: the ask or follow-up tapped is no longer the worker's.
		{fmt.Errorf("%w: Pixel asks another question now (tool_use_id t)", errStale), notify.ReplyClosed},
		{fmt.Errorf("%w: the worker has no open follow-up of turn %q", errStale, "t"), notify.ReplyClosed},
	} {
		var re *notify.ReplyError
		if err := replyError(c.err); !errors.As(err, &re) || re.Kind != c.kind {
			t.Errorf("%v: %v, want %s", c.err, err, c.kind)
		}
	}
	if replyError(nil) != nil {
		t.Fatal("nil is not nil")
	}
	// The messages a client sees are unchanged by the wrapping.
	if got := fmt.Errorf("%w: %s %w: answer it first (worker.answer_ask)", errInvalidState, "Pixel", errAskWaiting).Error(); got != "invalid state: Pixel waits on its question: answer it first (worker.answer_ask)" {
		t.Fatalf("message %q", got)
	}
}

// #14: the cards' texts are the worker's: an ask's questions and options,
// a follow-up's; an ask with a secret question gives none of its texts.
func TestNotifyFactsCardTexts(t *testing.T) {
	q := proto.AskQuestion{Header: "DB", Question: "Which database?", Multi: true, Other: true,
		Options: []proto.AskOption{{Label: "Postgres", Description: "Relational", Preview: "x"}}}
	got := notifyFacts(&proto.Worker{Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{q}}}, false).Ask.Questions[0]
	want := notify.AskQuestion{HasOptions: true, Header: "DB", Question: "Which database?", Multi: true, Other: true,
		Options: []notify.AskOption{{Label: "Postgres", Description: "Relational", Preview: "x"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("facts %+v, want %+v", got, want)
	}
	secret := notifyFacts(&proto.Worker{Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{q, {Question: "API key?", Secret: true,
		Options: []proto.AskOption{}}}}}, false)
	if s := fmt.Sprintf("%+v", *secret.Ask); strings.Contains(s, "database") || strings.Contains(s, "Postgres") || strings.Contains(s, "API key") ||
		!secret.Ask.Questions[0].HasOptions || !secret.Ask.Questions[1].Secret {
		t.Fatalf("secret ask facts %s", s)
	}
	n := 1
	fu := notifyFacts(&proto.Worker{Followup: &proto.Followup{TurnID: "turn", Tail: "tail", Questions: []proto.FollowupQuestion{{ID: "q1",
		Label: "Q1", Question: "Branch?", Kind: proto.FollowupChoice, Options: []string{"main", "next"}, Context: "ctx",
		Recommendation: &proto.FollowupRecommendation{Text: "next", Option: &n}}}}}, false).Followup
	if wantF := (notify.FollowupQuestion{ID: "q1", Question: "Branch?", Kind: "choice", Options: 2, Label: "Q1", Context: "ctx",
		Recommendation: "next", Choices: []string{"main", "next"}}); fu.Tail != "tail" || !reflect.DeepEqual(fu.Questions[0], wantF) {
		t.Fatalf("follow-up facts %+v", fu)
	}
}
