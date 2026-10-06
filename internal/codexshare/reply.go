package codexshare

import (
	"bytes"
	"encoding/json"
)

// Answer is one answer to one async question: the native agentMessage item
// id that carried it, the question's zero-based index in that message, its
// title and the answer text.
type Answer struct {
	MessageID string
	Index     int
	Question  string
	Answer    string
}

// ReplyEnvelope builds the reply text Codex's TUI recognises as answering
// async questions (rust-v0.160.1 codex-rs/tui/src/async_question_reply.rs):
// a JSON array between <send_user_message_question_reply> tags whose
// questionItemId is the compact JSON string
// ["request_user_input_async",<message id>,<index>].
func ReplyEnvelope(answers ...Answer) string {
	type entry struct {
		QuestionItemID string `json:"questionItemId"`
		Question       string `json:"question"`
		Answer         string `json:"answer"`
	}
	entries := make([]entry, 0, len(answers))
	for _, a := range answers {
		id := marshal([]any{"request_user_input_async", a.MessageID, a.Index})
		entries = append(entries, entry{QuestionItemID: string(id), Question: a.Question, Answer: a.Answer})
	}
	return replyTag + "\n" + string(marshal(entries)) + "\n</send_user_message_question_reply>"
}

// marshal is json.Marshal without HTML escaping.
func marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
