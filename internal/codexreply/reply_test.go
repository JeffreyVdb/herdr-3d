package codexreply

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
		"text after":  "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>\nthanks",
		"truncated":   `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input_async\",\"call_1\",0]"}]</send_user_message_question_repl`,
		"one bad":     `<send_user_message_question_reply>[{"answer":"a","question":"q","questionItemId":"[\"request_user_input_async\",\"call_1\",0]"},{"answer":"a","question":"q","questionItemId":"nope"}]</send_user_message_question_reply>`,
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

// #183 fix round 2: every entry needs a questionItemId string, "question" and
// "answer" keys that are JSON strings, and a non-null integer index; one entry
// that fails makes the whole envelope not an answer.
func TestParseReplyNeedsEveryFieldOfEveryEntry(t *testing.T) {
	const id = `"[\"request_user_input_async\",\"call_1\",0]"`
	env := func(entries ...string) string {
		return "<send_user_message_question_reply>\n[" + strings.Join(entries, ",") + "]\n</send_user_message_question_reply>"
	}
	good := `{"questionItemId":` + id + `,"question":"q","answer":"a"}`
	for name, text := range map[string]string{
		"missing question":     env(`{"questionItemId":` + id + `,"answer":"a"}`),
		"missing answer":       env(`{"questionItemId":` + id + `,"question":"q"}`),
		"missing id":           env(`{"question":"q","answer":"a"}`),
		"null question":        env(`{"questionItemId":` + id + `,"question":null,"answer":"a"}`),
		"null answer":          env(`{"questionItemId":` + id + `,"question":"q","answer":null}`),
		"null id":              env(`{"questionItemId":null,"question":"q","answer":"a"}`),
		"number question":      env(`{"questionItemId":` + id + `,"question":1,"answer":"a"}`),
		"number answer":        env(`{"questionItemId":` + id + `,"question":"q","answer":2}`),
		"bool answer":          env(`{"questionItemId":` + id + `,"question":"q","answer":true}`),
		"array answer":         env(`{"questionItemId":` + id + `,"question":"q","answer":["a"]}`),
		"object question":      env(`{"questionItemId":` + id + `,"question":{"x":1},"answer":"a"}`),
		"id not a string":      env(`{"questionItemId":["request_user_input_async","call_1",0],"question":"q","answer":"a"}`),
		"null index":           env(`{"questionItemId":"[\"request_user_input_async\",\"call_1\",null]","question":"q","answer":"a"}`),
		"string index":         env(`{"questionItemId":"[\"request_user_input_async\",\"call_1\",\"0\"]","question":"q","answer":"a"}`),
		"missing index":        env(`{"questionItemId":"[\"request_user_input_async\",\"call_1\"]","question":"q","answer":"a"}`),
		"null message id":      env(`{"questionItemId":"[\"request_user_input_async\",null,0]","question":"q","answer":"a"}`),
		"number message id":    env(`{"questionItemId":"[\"request_user_input_async\",7,0]","question":"q","answer":"a"}`),
		"null tool":            env(`{"questionItemId":"[null,\"call_1\",0]","question":"q","answer":"a"}`),
		"null entry":           env(`null`),
		"entry is a string":    env(`"nope"`),
		"bad one, good first":  env(good, `{"questionItemId":`+id+`,"question":"q"}`),
		"bad one, good second": env(`{"questionItemId":`+id+`,"answer":"a"}`, good),
		"null among good":      env(good, `null`),
	} {
		if got, ok := ParseReply(text); ok {
			t.Errorf("%s: parsed %+v", name, got)
		}
	}
}

func TestParseReplyKeepsEmptyStringsAndIgnoresExtraKeys(t *testing.T) {
	const id = `"[\"request_user_input_async\",\"call_1\",2]"`
	env := func(entry string) string {
		return "<send_user_message_question_reply>[" + entry + "]</send_user_message_question_reply>"
	}
	// An empty answer (or question) is a string, so a valid answer.
	got, ok := ParseReply(env(`{"questionItemId":` + id + `,"question":"","answer":""}`))
	if want := []Answer{{MessageID: "call_1", Index: 2}}; !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("empty strings: %+v, %v", got, ok)
	}
	// A key beyond the three is ignored, as the TUI does, in either key order.
	for name, entry := range map[string]string{
		"extra last":   `{"questionItemId":` + id + `,"question":"q","answer":"a","note":{"x":null}}`,
		"extra first":  `{"extra":1,"answer":"a","question":"q","questionItemId":` + id + `}`,
		"terminal one": `{"answer":"a","question":"q","questionItemId":` + id + `,"z":[1]}`,
	} {
		got, ok := ParseReply(env(entry))
		if want := []Answer{{MessageID: "call_1", Index: 2, Question: "q", Answer: "a"}}; !ok || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %+v, %v", name, got, ok)
		}
	}
}
