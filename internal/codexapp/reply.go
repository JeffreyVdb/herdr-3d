package codexapp

import (
	"bytes"
	"encoding/json"
	"strings"
)

// #156: the native answer to Codex's async questions (request_user_input_async,
// docs/research/codex-shared-tui.md §1). It is ordinary user input whose text
// is this envelope; the terminal sends the same one when it is answered there,
// so one rule tells either answer apart from any other input.

// AsyncTool is the tool Codex asks async questions with; it names them in a
// reply's questionItemId.
const AsyncTool = "request_user_input_async"

const (
	replyOpen  = "<send_user_message_question_reply>"
	replyClose = "</send_user_message_question_reply>"
)

// Answer is one answer to one async question: the native agentMessage item
// id that carried it (the function call_id), the question's zero-based index
// in that message, its title and the answer text.
type Answer struct {
	MessageID string
	Index     int
	Question  string
	Answer    string
}

// replyEntry is one answer as the envelope holds it.
type replyEntry struct {
	QuestionItemID string `json:"questionItemId"`
	Question       string `json:"question"`
	Answer         string `json:"answer"`
}

// ReplyEnvelope builds the reply text Codex's TUI recognises as answering
// async questions (rust-v0.160.1 codex-rs/tui/src/async_question_reply.rs):
// a JSON array between <send_user_message_question_reply> tags whose
// questionItemId is the compact JSON string
// ["request_user_input_async",<message id>,<index>].
func ReplyEnvelope(answers ...Answer) string {
	entries := make([]replyEntry, 0, len(answers))
	for _, a := range answers {
		id := marshal([]any{AsyncTool, a.MessageID, a.Index})
		entries = append(entries, replyEntry{QuestionItemID: string(id), Question: a.Question, Answer: a.Answer})
	}
	return replyOpen + "\n" + string(marshal(entries)) + "\n" + replyClose
}

// ParseReply reads a user message's text as a reply envelope: the whole
// text (but the whitespace around it) is one envelope, its JSON array holds
// at least one entry, and every entry's questionItemId parses as
// ["request_user_input_async", <non-empty id>, <index ≥ 0>]. Anything else
// is not an answer (false), whatever it quotes.
func ParseReply(text string) ([]Answer, bool) {
	body, ok := strings.CutPrefix(strings.TrimSpace(text), replyOpen)
	if !ok {
		return nil, false
	}
	if body, ok = strings.CutSuffix(body, replyClose); !ok {
		return nil, false
	}
	var entries []replyEntry
	if json.Unmarshal([]byte(body), &entries) != nil || len(entries) == 0 {
		return nil, false
	}
	out := make([]Answer, 0, len(entries))
	for _, e := range entries {
		var id []json.RawMessage
		if json.Unmarshal([]byte(e.QuestionItemID), &id) != nil || len(id) != 3 {
			return nil, false
		}
		var tool, msg string
		var index int
		if json.Unmarshal(id[0], &tool) != nil || tool != AsyncTool || json.Unmarshal(id[1], &msg) != nil || msg == "" ||
			json.Unmarshal(id[2], &index) != nil || index < 0 {
			return nil, false
		}
		out = append(out, Answer{MessageID: msg, Index: index, Question: e.Question, Answer: e.Answer})
	}
	return out, true
}

// marshal is json.Marshal without HTML escaping.
func marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
