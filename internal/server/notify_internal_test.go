package server

import (
	"errors"
	"fmt"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
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
