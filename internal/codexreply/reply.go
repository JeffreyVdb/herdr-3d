// Package codexreply is the native reply to Codex's async questions: the one
// rule that builds and recognises it. The bridge's questions reconciler
// (codexapp) and the transcript's readable answer entries (#183) both use it,
// so a message is an answer for one exactly when it is for the other.
// Standard library only: the transcript must not link the app-server client.
package codexreply

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

// rawEntry is one answer as the envelope holds it, before it is checked: a
// key that is absent is a nil field, and a JSON null is the bytes "null",
// so neither passes for an empty string or a zero index.
type rawEntry struct {
	QuestionItemID json.RawMessage `json:"questionItemId"`
	Question       json.RawMessage `json:"question"`
	Answer         json.RawMessage `json:"answer"`
}

// ParseReply reads a user message's text as a reply envelope: the whole
// text (but the whitespace around it) is one envelope, its JSON array holds
// at least one entry, and every entry has a questionItemId string that
// parses as ["request_user_input_async", <non-empty id>, <index ≥ 0>] and
// "question" and "answer" keys that are JSON strings (an empty string is a
// string; a missing key, null or any other type is not). The envelope is
// all or nothing: one entry that fails makes the whole text not an answer
// (false), so the reconciler and the transcript never act on, or show, half
// of a reply, and never show an answer the user's own text does not hold.
// Keys beyond those three are ignored, as the TUI does. Whatever else the
// text is, it is not an answer, whatever it quotes.
func ParseReply(text string) ([]Answer, bool) {
	body, ok := strings.CutPrefix(strings.TrimSpace(text), replyOpen)
	if !ok {
		return nil, false
	}
	if body, ok = strings.CutSuffix(body, replyClose); !ok {
		return nil, false
	}
	var entries []rawEntry
	if json.Unmarshal([]byte(body), &entries) != nil || len(entries) == 0 {
		return nil, false
	}
	out := make([]Answer, 0, len(entries))
	for _, e := range entries {
		itemID, ok1 := jsonString(e.QuestionItemID)
		question, ok2 := jsonString(e.Question)
		answer, ok3 := jsonString(e.Answer)
		if !ok1 || !ok2 || !ok3 {
			return nil, false
		}
		var id []json.RawMessage
		if json.Unmarshal([]byte(itemID), &id) != nil || len(id) != 3 {
			return nil, false
		}
		tool, okTool := jsonString(id[0])
		msg, okMsg := jsonString(id[1])
		index, okIndex := jsonIndex(id[2])
		if !okTool || tool != AsyncTool || !okMsg || msg == "" || !okIndex {
			return nil, false
		}
		out = append(out, Answer{MessageID: msg, Index: index, Question: question, Answer: answer})
	}
	return out, true
}

// jsonString is the string a JSON value is, false for an absent value, null
// or any other type.
func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	return s, json.Unmarshal(raw, &s) == nil
}

// jsonIndex is the non-negative integer a JSON value is, false for an absent
// value, null, a fraction or any other type.
func jsonIndex(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 || raw[0] == 'n' {
		return 0, false
	}
	var n int
	return n, json.Unmarshal(raw, &n) == nil && n >= 0
}

// marshal is json.Marshal without HTML escaping.
func marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
