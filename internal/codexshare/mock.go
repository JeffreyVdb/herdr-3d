package codexshare

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The questions the mock asks with request_user_input_async.
const (
	QuestionColor   = "Which fixture color?"
	QuestionContext = "Any context for the fixture?"
)

// Request kinds, from the request's last relevant input item.
const (
	KindTurn  = "turn"  // a user message that starts (or steers) model work
	KindTool  = "tool"  // the continuation after a function call's output
	KindReply = "reply" // a user message carrying a question reply envelope
	KindTitle = "title" // Codex's side request for a thread title (not a turn)
)

// titlePrefix starts Codex's thread-title side request (0.160.1).
const titlePrefix = "Generate a concise, single-line task title"

// replyTag is the native async-question reply envelope's tag.
const replyTag = "<send_user_message_question_reply>"

// Request is one POST /v1/responses the mock received.
type Request struct {
	Seq       int
	Kind      string
	Directive string // the MOCK:<verb> of the user message, "" for none
	UserText  string // the last user message's text
	CallID    string // KindTool: the function call being continued
	Output    string // KindTool: that call's output text
	Body      json.RawMessage
}

// Mock is a scripted OpenAI Responses API server for Codex, bound to an
// OS-leased loopback port. A user message steers it with one directive:
//
//	MOCK:say <text>          an assistant message with <text>
//	MOCK:ask-options         request_user_input_async: QuestionColor with options
//	MOCK:ask-free            request_user_input_async: QuestionContext, no options
//	MOCK:ask-both            both questions in one call
//	MOCK:shell <cmd>         exec_command <cmd>; then MOCK_SHELL_DONE <output>
//	MOCK:approve <cmd>       exec_command <cmd> asking for escalation (an approval)
//	MOCK:hold <name>         keep the response open until Release(name)
//
// The ask directives take hold=<name> to hold the response that follows the
// tool's output, so the turn stays active. A reply envelope gets
// MOCK_REPLY_SEEN <answers>; any other text MOCK_ECHO <text>; a function
// output the directive does not continue MOCK_TOOL_DONE <call id>.
type Mock struct {
	srv *http.Server
	ln  net.Listener

	mu       sync.Mutex
	reqs     []Request
	calls    map[string]string // call id -> the directive text that made it
	holds    map[string]chan struct{}
	released map[string]bool
	holdNext map[string]string         // kind -> hold name for its next request
	held     map[string]map[string]any // hold name -> the output it releases
	delay    time.Duration
	changed  chan struct{} // closed and replaced on every change
	closed   chan struct{}
	seq      int
}

// StartMock serves the mock on 127.0.0.1:0.
func StartMock() (*Mock, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	m := &Mock{
		ln:       ln,
		calls:    map[string]string{},
		holds:    map[string]chan struct{}{},
		released: map[string]bool{},
		holdNext: map[string]string{},
		held:     map[string]map[string]any{},
		changed:  make(chan struct{}),
		closed:   make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/responses", m.serve)
	mux.HandleFunc("POST /responses", m.serve)
	m.srv = &http.Server{Handler: mux}
	go func() { _ = m.srv.Serve(ln) }()
	return m, nil
}

// URL is the provider base URL (…/v1).
func (m *Mock) URL() string { return "http://" + m.ln.Addr().String() + "/v1" }

// Close releases every hold and stops the server.
func (m *Mock) Close() {
	m.mu.Lock()
	select {
	case <-m.closed:
	default:
		close(m.closed)
	}
	m.mu.Unlock()
	_ = m.srv.Close()
}

// Requests returns a copy of every request so far.
func (m *Mock) Requests() []Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Request(nil), m.reqs...)
}

// Count is the number of requests of kind.
func (m *Mock) Count(kind string) int {
	n := 0
	for _, r := range m.Requests() {
		if r.Kind == kind {
			n++
		}
	}
	return n
}

// ModelRequests counts the requests that are model work: everything but
// title side requests.
func (m *Mock) ModelRequests() int {
	return len(m.Requests()) - m.Count(KindTitle)
}

// WaitHeld waits until a response is being held under name.
func (m *Mock) WaitHeld(ctx context.Context, name string) error {
	for {
		m.mu.Lock()
		_, ok := m.holds[name]
		ch := m.changed
		m.mu.Unlock()
		if ok {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return fmt.Errorf("no response held as %q: %w", name, ctx.Err())
		}
	}
}

// WaitRequests waits until at least n requests satisfy ok.
func (m *Mock) WaitRequests(ctx context.Context, n int, ok func(Request) bool) error {
	for {
		m.mu.Lock()
		got := 0
		for _, r := range m.reqs {
			if ok(r) {
				got++
			}
		}
		ch := m.changed
		m.mu.Unlock()
		if got >= n {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return fmt.Errorf("%d of %d matching requests: %w", got, n, ctx.Err())
		}
	}
}

// SetDelay makes every response wait d before its output, as a model
// does: Herdr only reports a turn it saw working.
func (m *Mock) SetDelay(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.delay = d
}

// HoldNext holds the next request of kind (KindReply, …) under name, so a
// turn stays active after, for example, a reply reached the model.
func (m *Mock) HoldNext(kind, name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.holdNext[kind] = name
}

// Release completes the response held under name.
func (m *Mock) Release(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch, ok := m.holds[name]
	if !ok {
		return fmt.Errorf("no response held as %q", name)
	}
	if !m.released[name] {
		m.released[name] = true
		close(ch)
	}
	return nil
}

func (m *Mock) notifyLocked() {
	close(m.changed)
	m.changed = make(chan struct{})
}

// inputItem is the part of a Responses input item the mock reads.
type inputItem struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	CallID  string          `json:"call_id"`
	Output  json.RawMessage `json:"output"`
}

// texts joins the text parts of a content or output value.
func texts(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &parts)
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String()
}

// classify reads a request body into a Request (without Seq).
func classify(body []byte) Request {
	var req struct {
		Input []inputItem `json:"input"`
	}
	_ = json.Unmarshal(body, &req)
	r := Request{Body: append(json.RawMessage(nil), body...)}
	for i := len(req.Input) - 1; i >= 0; i-- {
		it := req.Input[i]
		if it.Type == "function_call_output" && r.CallID == "" && r.UserText == "" {
			r.Kind, r.CallID, r.Output = KindTool, it.CallID, texts(it.Output)
			continue
		}
		if it.Type == "message" && it.Role == "user" {
			t := texts(it.Content)
			if strings.HasPrefix(t, "<environment_context>") {
				continue
			}
			r.UserText = t
			break
		}
	}
	switch {
	case r.Kind == KindTool:
	case strings.HasPrefix(r.UserText, titlePrefix):
		r.Kind = KindTitle
	case strings.Contains(r.UserText, replyTag):
		r.Kind = KindReply
	default:
		r.Kind = KindTurn
	}
	if r.Kind != KindTitle {
		r.Directive, _ = directive(r.UserText)
	}
	return r
}

// directive finds "MOCK:<verb> <rest of line>" in text.
func directive(text string) (verb, rest string) {
	i := strings.Index(text, "MOCK:")
	if i < 0 {
		return "", ""
	}
	line, _, _ := strings.Cut(text[i+len("MOCK:"):], "\n")
	verb, rest, _ = strings.Cut(strings.TrimSpace(line), " ")
	return verb, strings.TrimSpace(rest)
}

// holdArg returns the hold=<name> argument of an ask directive.
func holdArg(rest string) string {
	for _, f := range strings.Fields(rest) {
		if name, ok := strings.CutPrefix(f, "hold="); ok {
			return name
		}
	}
	return ""
}

// item builders, in the shapes of Codex's own test helpers
// (codex-rs/core/tests/common/responses.rs, rust-v0.160.1).
func message(id, text string) map[string]any {
	return map[string]any{"type": "message", "role": "assistant", "id": id, "content": []any{
		map[string]any{"type": "output_text", "text": text},
	}}
}

func functionCall(callID, name string, args any) map[string]any {
	b, _ := json.Marshal(args)
	return map[string]any{"type": "function_call", "call_id": callID, "name": name, "arguments": string(b)}
}

type question struct {
	Title   string   `json:"title"`
	Options []string `json:"options,omitempty"`
}

func questions(verb string) []question {
	color := question{Title: QuestionColor, Options: []string{"Green", "Blue"}}
	free := question{Title: QuestionContext}
	switch verb {
	case "ask-options":
		return []question{color}
	case "ask-free":
		return []question{free}
	default:
		return []question{color, free}
	}
}

// replyAnswers lists the answers of a reply envelope, "?" when unreadable.
func replyAnswers(text string) string {
	_, body, _ := strings.Cut(text, replyTag)
	body, _, _ = strings.Cut(body, "</send_user_message_question_reply>")
	var many []struct {
		Answer string `json:"answer"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(body)), &many) != nil {
		var one struct {
			Answer string `json:"answer"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(body)), &one) != nil {
			return "?"
		}
		many = append(many, one)
	}
	var out []string
	for _, a := range many {
		out = append(out, a.Answer)
	}
	return strings.Join(out, " | ")
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		s = s[:max]
	}
	return s
}

func (m *Mock) serve(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req := classify(body)
	m.mu.Lock()
	m.seq++
	req.Seq = m.seq
	m.reqs = append(m.reqs, req)
	respID := fmt.Sprintf("resp_%d", req.Seq)
	callID := fmt.Sprintf("call_%d", req.Seq)
	msgID := fmt.Sprintf("msg_%d", req.Seq)
	var out map[string]any
	hold := ""
	switch req.Kind {
	case KindTitle:
		out = message(msgID, "Mock fixture title")
	case KindReply:
		out = message(msgID, "MOCK_REPLY_SEEN "+replyAnswers(req.UserText))
	case KindTool:
		verb, rest := directive(m.calls[req.CallID])
		switch verb {
		case "shell", "approve":
			out = message(msgID, "MOCK_SHELL_DONE "+oneLine(req.Output, 400))
		case "ask-options", "ask-free", "ask-both":
			if hold = holdArg(rest); hold == "" {
				out = message(msgID, "MOCK_ASKED")
			}
		default:
			out = message(msgID, "MOCK_TOOL_DONE "+req.CallID)
		}
	default:
		verb, rest := directive(req.UserText)
		switch verb {
		case "say":
			out = message(msgID, rest)
		case "ask-options", "ask-free", "ask-both":
			out = functionCall(callID, "request_user_input_async", map[string]any{"questions": questions(verb)})
		case "shell":
			out = functionCall(callID, "exec_command", map[string]any{"cmd": rest, "login": false})
		case "approve":
			out = functionCall(callID, "exec_command", map[string]any{
				"cmd": rest, "login": false, "sandbox_permissions": "require_escalated",
				"justification": "Fixture approval check",
			})
		case "hold":
			hold = rest
		default:
			out = message(msgID, "MOCK_ECHO "+oneLine(req.UserText, 80))
		}
		if out != nil && out["type"] == "function_call" {
			m.calls[callID] = req.UserText
		}
	}
	if name, ok := m.holdNext[req.Kind]; ok && hold == "" {
		hold = name
		delete(m.holdNext, req.Kind)
		if out != nil {
			m.held[name] = out
		}
	}
	var release chan struct{}
	if hold != "" {
		release = make(chan struct{})
		m.holds[hold] = release
		delete(m.released, hold)
		if kept, ok := m.held[hold]; ok {
			out = kept
			delete(m.held, hold)
		} else {
			out = message(msgID, "MOCK_RELEASED "+hold)
		}
	}
	delay := m.delay
	m.notifyLocked()
	m.mu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	send := func(ev map[string]any) error {
		b, _ := json.Marshal(ev)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev["type"], b); err != nil {
			return err
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return nil
	}
	if send(map[string]any{"type": "response.created", "response": map[string]any{"id": respID}}) != nil {
		return
	}
	if delay > 0 && req.Kind != KindTitle {
		select {
		case <-time.After(delay):
		case <-m.closed:
			return
		case <-r.Context().Done():
			return
		}
	}
	if release != nil {
		select {
		case <-release:
		case <-m.closed:
			return
		case <-r.Context().Done():
			return
		}
	}
	_ = send(map[string]any{"type": "response.output_item.done", "item": out})
	_ = send(map[string]any{"type": "response.completed", "response": map[string]any{"id": respID, "usage": map[string]any{
		"input_tokens": 0, "input_tokens_details": nil, "output_tokens": 0, "output_tokens_details": nil, "total_tokens": 0,
	}}})
}
