package codexapp

import (
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codexreply"
)

// The envelope's rule is codexreply's (its tests are there); the names here
// must stay the same functions, so the reconciler and the transcript's
// readable answers (#183) never disagree on what an answer is.
func TestReplyNamesAreCodexreplys(t *testing.T) {
	a := []Answer{{MessageID: "call_1", Index: 2, Question: "q", Answer: "a"}}
	env := ReplyEnvelope(a...)
	if env != codexreply.ReplyEnvelope(a...) {
		t.Fatalf("envelope differs: %s", env)
	}
	got, ok := ParseReply(env)
	want, wok := codexreply.ParseReply(env)
	if !ok || !wok || !reflect.DeepEqual(got, want) || !reflect.DeepEqual(got, a) {
		t.Fatalf("parse = %+v %v, codexreply %+v %v", got, ok, want, wok)
	}
	if AsyncTool != codexreply.AsyncTool {
		t.Fatal("AsyncTool differs")
	}
}
