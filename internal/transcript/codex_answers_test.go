package transcript

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codexreply"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// codexUserLine is a rollout line: a user message of these content parts.
func codexUserLine(n int, parts ...map[string]string) string {
	content, _ := json.Marshal(parts)
	return fmt.Sprintf(`{"timestamp":"2026-10-07T10:00:%02d.000Z","type":"response_item","payload":{"type":"message","id":"msg_%d","role":"user","content":%s}}`+"\n", n, n, content)
}

func inputText(s string) map[string]string { return map[string]string{"type": "input_text", "text": s} }

const (
	envOpen  = "<send_user_message_question_reply>"
	envClose = "</send_user_message_question_reply>"
)

func replyEntry(msg string, index int, q, a string) string {
	id, _ := json.Marshal(fmt.Sprintf(`["request_user_input_async",%q,%d]`, msg, index))
	qq, _ := json.Marshal(q)
	aa, _ := json.Marshal(a)
	return fmt.Sprintf(`{"questionItemId":%s,"question":%s,"answer":%s}`, id, qq, aa)
}

// #183: a complete reply envelope is an answers item, in the bridge's key
// order and in the terminal's, Parts keeping the text as sent.
func TestCodexReplyEnvelopeIsAnswers(t *testing.T) {
	bridge := codexreply.ReplyEnvelope(
		codexreply.Answer{MessageID: "call_1", Question: "Which board?", Answer: "GitHub: Fomra/shift-plan"},
		codexreply.Answer{MessageID: "call_1", Index: 1, Question: "Any context?", Answer: "line one\nline \"two\" <b>[Image #1: /etc/passwd]</b>"})
	terminal := envOpen + "\n[" +
		`{"answer":"typed-in-terminal","question":"Any context for the fixture?","questionItemId":"[\"request_user_input_async\",\"call_10\",1]"}` +
		"]\n" + envClose
	for name, c := range map[string]struct {
		env  string
		want []proto.TranscriptAnswer
	}{
		"bridge order": {bridge, []proto.TranscriptAnswer{
			{Question: "Which board?", Answer: "GitHub: Fomra/shift-plan"},
			{Question: "Any context?", Answer: "line one\nline \"two\" <b>[Image #1: /etc/passwd]</b>"}}},
		"terminal order":    {terminal, []proto.TranscriptAnswer{{Question: "Any context for the fixture?", Answer: "typed-in-terminal"}}},
		"whitespace around": {"\n  " + terminal + "\n", []proto.TranscriptAnswer{{Question: "Any context for the fixture?", Answer: "typed-in-terminal"}}},
	} {
		got := itemsOf(t, Codex, codexUserLine(1, inputText(c.env)))
		if len(got) != 1 || got[0].Kind != proto.ItemUser || got[0].ID != "msg_1" {
			t.Fatalf("%s: items = %+v", name, got)
		}
		it := got[0]
		if !reflect.DeepEqual(it.Answers, c.want) {
			t.Errorf("%s: answers = %+v, want %+v", name, it.Answers, c.want)
		}
		if len(it.Parts) != 1 || it.Parts[0].Image != nil || it.Parts[0].Text != c.env {
			t.Errorf("%s: parts = %+v, want the envelope as sent", name, it.Parts)
		}
		b, _ := json.Marshal(it.Answers)
		if strings.Contains(string(b), "questionItemId") || strings.Contains(string(b), "call_") || strings.Contains(string(b), envOpen) {
			t.Errorf("%s: answers carry transport detail: %s", name, b)
		}
	}
}

// What is not a complete validated envelope stays the user's bubble, its text
// whole: a prompt that quotes one, a cut or malformed one, another tool's.
func TestCodexReplyLookalikesStayPrompts(t *testing.T) {
	ok := envOpen + "\n[" + replyEntry("call_1", 0, "q", "a") + "]\n" + envClose
	for name, text := range map[string]string{
		"plain":           "Use the GitHub board",
		"quoted":          "Codex wants this:\n" + ok + "\nwhy?",
		"text after":      ok + "\nthanks",
		"truncated":       ok[:len(ok)-12],
		"unclosed":        envOpen + "\n[" + replyEntry("call_1", 0, "q", "a") + "]",
		"not json":        envOpen + "\nyes\n" + envClose,
		"empty list":      envOpen + "\n[]\n" + envClose,
		"other tool":      envOpen + "\n" + strings.Replace("["+replyEntry("call_1", 0, "q", "a")+"]", "request_user_input_async", "request_user_input", 1) + "\n" + envClose,
		"negative index":  envOpen + "\n[" + replyEntry("call_1", -1, "q", "a") + "]\n" + envClose,
		"one bad of two":  envOpen + "\n[" + replyEntry("call_1", 0, "q", "a") + `,{"questionItemId":"x","question":"q","answer":"a"}]` + "\n" + envClose,
		"tags, no fields": envOpen + envClose,
		// #183 fix round 2: a tagged array whose entries lack fields is not an answer.
		"id only":          envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]"}]` + "\n" + envClose,
		"missing question": envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]","answer":"a"}]` + "\n" + envClose,
		"missing answer":   envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]","question":"q"}]` + "\n" + envClose,
		"null question":    envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]","question":null,"answer":"a"}]` + "\n" + envClose,
		"null answer":      envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]","question":"q","answer":null}]` + "\n" + envClose,
		"number answer":    envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",0]","question":"q","answer":5}]` + "\n" + envClose,
		"null index":       envOpen + "\n" + `[{"questionItemId":"[\"request_user_input_async\",\"call_1\",null]","question":"q","answer":"a"}]` + "\n" + envClose,
		"good then bad":    envOpen + "\n[" + replyEntry("call_1", 0, "q", "a") + `,{"questionItemId":"[\"request_user_input_async\",\"call_1\",1]","question":"q"}]` + "\n" + envClose,
	} {
		got := itemsOf(t, Codex, codexUserLine(1, inputText(text)))
		if len(got) != 1 || got[0].Kind != proto.ItemUser || got[0].Answers != nil {
			t.Errorf("%s: items = %+v", name, got)
			continue
		}
		if txt := textOf(got[0]); txt != text {
			t.Errorf("%s: text = %q, want it whole", name, txt)
		}
	}
	// An image next to an envelope: the user sent more than an answer.
	got := itemsOf(t, Codex, codexUserLine(2, inputText(ok), map[string]string{"type": "input_image", "image_url": "data:image/png;base64,AAAA"}))
	if len(got) != 1 || got[0].Answers != nil {
		t.Errorf("envelope with an image: %+v", got)
	}
}

// The envelope split over two text parts is one envelope, as the bridge joins
// a user message's text inputs.
func TestCodexReplyEnvelopeJoinsTextParts(t *testing.T) {
	env := envOpen + "\n[" + replyEntry("call_1", 0, "q", "a") + "]\n" + envClose
	got := itemsOf(t, Codex, codexUserLine(1, inputText(env[:20]), inputText(env[20:])))
	if len(got) != 1 || len(got[0].Answers) != 1 {
		t.Fatalf("items = %+v", got)
	}
}

// Answers keep their order among the conversation and the cap of a list
// applies to them: transcript.item has them whole.
func TestCodexAnswersAreCapped(t *testing.T) {
	big := strings.Repeat("é", MaxText) // 2 bytes each
	env := envOpen + "\n[" + replyEntry("call_1", 0, "q", big) + "," + replyEntry("call_1", 1, "r", "short") + "]\n" + envClose
	log := codexUserLine(1, inputText("before")) + codexUserLine(2, inputText(env)) + codexUserLine(3, inputText("after"))
	path := t.TempDir() + "/t.jsonl"
	if err := os.WriteFile(path, []byte(log), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), Codex, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, err := l.Before(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 3 || textOf(p.Items[0]) != "before" || textOf(p.Items[2]) != "after" {
		t.Fatalf("items = %+v", p.Items)
	}
	listed := p.Items[1]
	if !listed.Truncated || len(listed.Answers) != 2 || len(listed.Answers[0].Answer) > MaxText || listed.Answers[1].Answer != "short" {
		t.Errorf("listed: truncated %v, %d answers, first %d bytes", listed.Truncated, len(listed.Answers), len(listed.Answers[0].Answer))
	}
	full, ok, err := l.Item("msg_2")
	if err != nil || !ok || full.Truncated || full.Answers[0].Answer != big {
		t.Errorf("item: ok %v err %v truncated %v", ok, err, full.Truncated)
	}
}

// An empty answer is still a string: the entry is an answer, not a fallback. A
// key beyond the three is ignored (the TUI's own tolerance), and what the
// envelope held stays in Parts.
func TestCodexReplyEmptyAnswerAndExtraKeysAreAnswers(t *testing.T) {
	env := envOpen + "\n[" + replyEntry("call_1", 0, "q", "") + "," +
		`{"extra":true,"answer":"b","question":"","questionItemId":"[\"request_user_input_async\",\"call_1\",1]"}` + "]\n" + envClose
	got := itemsOf(t, Codex, codexUserLine(1, inputText(env)))
	want := []proto.TranscriptAnswer{{Question: "q"}, {Answer: "b"}}
	if len(got) != 1 || !reflect.DeepEqual(got[0].Answers, want) || textOf(got[0]) != env {
		t.Fatalf("items = %+v", got)
	}
}
