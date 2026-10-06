package codexshare

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// userBody is a Responses API request body whose last input is a user message.
func userBody(text string) string {
	b, _ := json.Marshal(map[string]any{"model": "mock", "input": []any{
		map[string]any{"type": "message", "role": "developer", "content": []any{map[string]any{"type": "input_text", "text": "dev"}}},
		map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "<environment_context>\n</environment_context>"}}},
		map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}},
	}})
	return string(b)
}

// toolBody is a request body that continues after a function call's output.
func toolBody(prompt, callID, output string) string {
	b, _ := json.Marshal(map[string]any{"model": "mock", "input": []any{
		map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": prompt}}},
		map[string]any{"type": "function_call", "call_id": callID, "name": "x", "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": callID, "output": output},
	}})
	return string(b)
}

type sseEvent struct {
	Type string
	Data map[string]any
}

// post sends one request to the mock and parses its SSE stream.
func post(t *testing.T, m *Mock, body string) []sseEvent {
	t.Helper()
	resp, err := http.Post(m.URL()+"/responses", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	var out []sseEvent
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var cur sseEvent
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			cur.Type = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &cur.Data); err != nil {
				t.Fatalf("data line %q: %v", line, err)
			}
		case line == "":
			out = append(out, cur)
			cur = sseEvent{}
		}
	}
	if len(out) < 2 || out[0].Type != "response.created" || out[len(out)-1].Type != "response.completed" {
		t.Fatalf("stream not framed created..completed: %+v", out)
	}
	return out
}

// item returns the single output item of a stream.
func item(t *testing.T, evs []sseEvent) map[string]any {
	t.Helper()
	var items []map[string]any
	for _, e := range evs {
		if e.Type == "response.output_item.done" {
			items = append(items, e.Data["item"].(map[string]any))
		}
	}
	if len(items) != 1 {
		t.Fatalf("want one output item, got %+v", items)
	}
	return items[0]
}

func assistantText(it map[string]any) string {
	c, _ := it["content"].([]any)
	if len(c) == 0 {
		return ""
	}
	s, _ := c[0].(map[string]any)["text"].(string)
	return s
}

func startMock(t *testing.T) *Mock {
	t.Helper()
	m, err := StartMock()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func TestMockSayAndEcho(t *testing.T) {
	m := startMock(t)
	it := item(t, post(t, m, userBody("please MOCK:say hello there")))
	if it["type"] != "message" || it["role"] != "assistant" || assistantText(it) != "hello there" {
		t.Fatalf("say: %+v", it)
	}
	if got := assistantText(item(t, post(t, m, userBody("Reply with OK")))); got != "MOCK_ECHO Reply with OK" {
		t.Fatalf("echo: %q", got)
	}
	reqs := m.Requests()
	if len(reqs) != 2 || reqs[0].Kind != KindTurn || reqs[0].Directive != "say" || reqs[1].Directive != "" {
		t.Fatalf("requests %+v", reqs)
	}
	if m.Count(KindTurn) != 2 || m.Count(KindTitle) != 0 {
		t.Fatalf("counts turn=%d title=%d", m.Count(KindTurn), m.Count(KindTitle))
	}
}

func TestMockAskEmitsAsyncQuestionThenAcknowledges(t *testing.T) {
	m := startMock(t)
	it := item(t, post(t, m, userBody("MOCK:ask-both")))
	if it["type"] != "function_call" || it["name"] != "request_user_input_async" {
		t.Fatalf("ask: %+v", it)
	}
	var args struct {
		Questions []struct {
			Title   string   `json:"title"`
			Options []string `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal([]byte(it["arguments"].(string)), &args); err != nil {
		t.Fatal(err)
	}
	if len(args.Questions) != 2 || args.Questions[0].Title != QuestionColor || len(args.Questions[0].Options) != 2 ||
		args.Questions[1].Title != QuestionContext || args.Questions[1].Options != nil {
		t.Fatalf("questions %+v", args.Questions)
	}
	callID := it["call_id"].(string)
	after := item(t, post(t, m, toolBody("MOCK:ask-both", callID, `{"accepted":true}`)))
	if got := assistantText(after); got != "MOCK_ASKED" {
		t.Fatalf("after accepted: %q", got)
	}
	reqs := m.Requests()
	if reqs[1].Kind != KindTool || reqs[1].CallID != callID {
		t.Fatalf("tool request %+v", reqs[1])
	}
}

func TestMockAskOptionsAndFreeAreSeparateQuestions(t *testing.T) {
	m := startMock(t)
	for directive, title := range map[string]string{"MOCK:ask-options": QuestionColor, "MOCK:ask-free": QuestionContext} {
		it := item(t, post(t, m, userBody(directive)))
		if !strings.Contains(it["arguments"].(string), title) {
			t.Fatalf("%s: %v", directive, it["arguments"])
		}
	}
}

func TestMockShellRunsExecCommandAndEchoesItsOutput(t *testing.T) {
	m := startMock(t)
	it := item(t, post(t, m, userBody("MOCK:shell printenv H3D_X")))
	if it["name"] != "exec_command" {
		t.Fatalf("shell: %+v", it)
	}
	var args map[string]any
	_ = json.Unmarshal([]byte(it["arguments"].(string)), &args)
	if args["cmd"] != "printenv H3D_X" || args["login"] != false {
		t.Fatalf("args %+v", args)
	}
	out := assistantText(item(t, post(t, m, toolBody("MOCK:shell printenv H3D_X", it["call_id"].(string), "Output:\nsentinel-1\n"))))
	if !strings.HasPrefix(out, "MOCK_SHELL_DONE ") || !strings.Contains(out, "sentinel-1") {
		t.Fatalf("shell result %q", out)
	}
}

func TestMockApproveAsksForEscalation(t *testing.T) {
	m := startMock(t)
	it := item(t, post(t, m, userBody("MOCK:approve touch approved.txt")))
	var args map[string]any
	_ = json.Unmarshal([]byte(it["arguments"].(string)), &args)
	if it["name"] != "exec_command" || args["sandbox_permissions"] != "require_escalated" || args["cmd"] != "touch approved.txt" {
		t.Fatalf("approve: %+v", args)
	}
}

func TestMockReplyEnvelopeIsRecognised(t *testing.T) {
	m := startMock(t)
	env := "<send_user_message_question_reply>\n[{\"questionItemId\":\"x\",\"question\":\"q\",\"answer\":\"Green\"}]\n</send_user_message_question_reply>"
	got := assistantText(item(t, post(t, m, userBody(env))))
	if got != "MOCK_REPLY_SEEN Green" {
		t.Fatalf("reply: %q", got)
	}
	if r := m.Requests()[0]; r.Kind != KindReply {
		t.Fatalf("kind %q", r.Kind)
	}
}

func TestMockTitleRequestsAreNotTurns(t *testing.T) {
	m := startMock(t)
	post(t, m, userBody("Generate a concise, single-line task title of at most 36 characters"))
	if m.Count(KindTitle) != 1 || m.Count(KindTurn) != 0 || m.ModelRequests() != 0 {
		t.Fatalf("requests %+v", m.Requests())
	}
}

func TestMockHoldKeepsTheResponseOpenUntilReleased(t *testing.T) {
	m := startMock(t)
	done := make(chan []sseEvent, 1)
	go func() { done <- post(t, m, userBody("MOCK:hold h1")) }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.WaitHeld(ctx, "h1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		t.Fatal("held response completed before release")
	case <-time.After(100 * time.Millisecond):
	}
	if err := m.Release("h1"); err != nil {
		t.Fatal(err)
	}
	select {
	case evs := <-done:
		if got := assistantText(item(t, evs)); got != "MOCK_RELEASED h1" {
			t.Fatalf("released: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("release did not complete the response")
	}
	if err := m.Release("nope"); err == nil {
		t.Fatal("releasing an unknown hold must fail")
	}
}

func TestMockAskWithHoldHoldsTheFollowUp(t *testing.T) {
	m := startMock(t)
	it := item(t, post(t, m, userBody("MOCK:ask-options hold=q")))
	done := make(chan []sseEvent, 1)
	go func() {
		done <- post(t, m, toolBody("MOCK:ask-options hold=q", it["call_id"].(string), `{"accepted":true}`))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.WaitHeld(ctx, "q"); err != nil {
		t.Fatal(err)
	}
	_ = m.Release("q")
	if got := assistantText(item(t, <-done)); got != "MOCK_RELEASED q" {
		t.Fatalf("got %q", got)
	}
}

func TestMockCloseReleasesHolds(t *testing.T) {
	m, err := StartMock()
	if err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() {
		resp, err := http.Post(m.URL()+"/responses", "application/json", strings.NewReader(userBody("MOCK:hold z")))
		if err == nil {
			resp.Body.Close()
		}
		errc <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.WaitHeld(ctx, "z"); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { m.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close blocked on a held response")
	}
	<-errc
}

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
	if replyAnswers(two) != `a "quoted" <b> | s` || !strings.Contains(two, `\"call_1\",1]`) {
		t.Fatalf("two answers: %s", two)
	}
}

func TestMockHoldNextHoldsTheNextRequestOfAKind(t *testing.T) {
	m := startMock(t)
	m.HoldNext(KindReply, "r1")
	env := ReplyEnvelope(Answer{MessageID: "call_1", Question: "q", Answer: "Blue"})
	done := make(chan []sseEvent, 1)
	go func() { done <- post(t, m, userBody(env)) }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.WaitHeld(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	_ = m.Release("r1")
	if got := assistantText(item(t, <-done)); got != "MOCK_REPLY_SEEN Blue" {
		t.Fatalf("held reply answered %q", got)
	}
	// Only the next one: the following reply is not held.
	if got := assistantText(item(t, post(t, m, userBody(env)))); got != "MOCK_REPLY_SEEN Blue" {
		t.Fatalf("second reply %q", got)
	}
}

func TestMockDelayPostponesTheOutput(t *testing.T) {
	m := startMock(t)
	m.SetDelay(300 * time.Millisecond)
	start := time.Now()
	post(t, m, userBody("MOCK:say slow"))
	if time.Since(start) < 300*time.Millisecond {
		t.Fatal("response was not delayed")
	}
}
