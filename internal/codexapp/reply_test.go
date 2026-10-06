package codexapp

import (
	"reflect"
	"strings"
	"testing"
)

func TestReplyEnvelopeMatchesTheNativeFormat(t *testing.T) {
	// The documented example (issue #154), byte for byte.
	want := "<send_user_message_question_reply>\n" +
		`[{"questionItemId":"[\"request_user_input_async\",\"<native agent-message item id>\",0]","question":"Which fixture color?","answer":"Green"}]` +
		"\n</send_user_message_question_reply>"
	got := ReplyEnvelope(Answer{MessageID: "<native agent-message item id>", Index: 0, Question: "Which fixture color?", Answer: "Green"})
	if got != want {
		t.Fatalf("envelope\n got %s\nwant %s", got, want)
	}
	two := ReplyEnvelope(Answer{MessageID: "call_1", Index: 1, Question: "q", Answer: `a "quoted" <b>`}, Answer{MessageID: "call_2", Question: "r", Answer: "s"})
	if !strings.Contains(two, `\"call_1\",1]`) || !strings.Contains(two, `"answer":"a \"quoted\" <b>"`) {
		t.Fatalf("two answers: %s", two)
	}
}

func TestParseReplyReadsBothKeyOrders(t *testing.T) {
	// The terminal's key order (TestCodexShareQuestions/20-*: answer,
	// question, questionItemId) and the bridge's.
	terminal := "<send_user_message_question_reply>\n" +
		`[{"answer":"typed-in-terminal","question":"Any context for the fixture?","questionItemId":"[\"request_user_input_async\",\"call_10\",1]"}]` +
		"\n</send_user_message_question_reply>"
	got, ok := ParseReply(terminal)
	want := []Answer{{MessageID: "call_10", Index: 1, Question: "Any context for the fixture?", Answer: "typed-in-terminal"}}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("terminal reply = %+v, %v", got, ok)
	}
	answers := []Answer{{MessageID: "call_3", Question: "Which fixture color?", Answer: "Green"},
		{MessageID: "call_3", Index: 1, Question: "Any context?", Answer: "line one\nline two"}}
	if got, ok := ParseReply(ReplyEnvelope(answers...)); !ok || !reflect.DeepEqual(got, answers) {
		t.Fatalf("round trip = %+v, %v", got, ok)
	}
}

func TestParseReplyRefusesWhatIsNotAnEnvelope(t *testing.T) {
	for name, text := range map[string]string{
		"plain":       "MOCK:say unrelated-from-bridge",
		"quoted":      "see <send_user_message_question_reply>[]</send_user_message_question_reply> above",
		"unclosed":    "<send_user_message_question_reply>\n[]",
		"not json":    "<send_user_message_question_reply>\nnope\n</send_user_message_question_reply>",
		"empty":       "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>",
		"other tool":  `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input\",\"call_1\",0]"}]</send_user_message_question_reply>`,
		"bad index":   `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input_async\",\"call_1\",-1]"}]</send_user_message_question_reply>`,
		"float index": `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input_async\",\"call_1\",1.5]"}]</send_user_message_question_reply>`,
		"no id":       `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input_async\",\"\",0]"}]</send_user_message_question_reply>`,
		"substring":   `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"x [\"request_user_input_async\",\"call_1\",0]"}]</send_user_message_question_reply>`,
	} {
		if got, ok := ParseReply(text); ok {
			t.Errorf("%s: parsed %+v", name, got)
		}
	}
	// Surrounding whitespace is the TUI's own.
	if _, ok := ParseReply("\n " + ReplyEnvelope(Answer{MessageID: "call_1", Question: "q", Answer: "a"}) + "\n"); !ok {
		t.Error("an envelope with surrounding whitespace was refused")
	}
}
