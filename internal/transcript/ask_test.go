package transcript

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func fixtureLines(t *testing.T, harness, name string) [][]byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", harness, name))
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out
}

// The fixtures (testdata/claude/ask*.jsonl) are lines of real Claude Code
// 2.1.285 sessions: ask.jsonl has single, multi-select, two-question, typed
// (Other), preview, Esc'd and "Chat about this" calls with their results;
// ask_pending.jsonl a call still waiting (Sonnet, the operator's own
// config, `--name`: the screen herdr called idle).
func TestAskTrackerClaude(t *testing.T) {
	tr := NewAskTracker(Claude)
	lines := fixtureLines(t, Claude, "ask.jsonl")
	// Line by line: each call waits until its result (or the interruption).
	var seen []string
	for i, l := range lines {
		tr.Line(l)
		if a := tr.Pending(); a != nil && (len(seen) == 0 || seen[len(seen)-1] != a.ToolUseID) {
			seen = append(seen, a.ToolUseID)
			if a.Source != proto.AskSourceTranscript || a.Agent != proto.AskClaude || a.Since <= 0 || len(a.Questions) == 0 {
				t.Errorf("line %d: ask %+v", i+1, a)
			}
		}
	}
	if len(seen) != 8 {
		t.Errorf("asks seen %d (%v), want 8", len(seen), seen)
	}
	if a := tr.Pending(); a != nil {
		t.Errorf("every call has its result, pending %+v", a)
	}
	if got := tr.Resolved(); got != "toolu_01SgCShe3VvQYc12cPwEwovK" {
		t.Errorf("resolved %q", got)
	}

	// The first call, alone: pending after its tool_use, gone with its result.
	tr = NewAskTracker(Claude)
	tr.Line(lines[0])
	tr.Line(lines[1])
	a := tr.Pending()
	want := []proto.AskQuestion{{Header: "Drink", Question: "Tea or coffee?", Other: true,
		Options: []proto.AskOption{{Label: "Tea", Description: "Hot tea"}, {Label: "Coffee", Description: "Hot coffee"}}}}
	if a == nil || a.ToolUseID != "toolu_014F63f4HMf8ayZ7AhNMC8Uh" || !reflect.DeepEqual(a.Questions, want) ||
		a.Since != time.Date(2026, 9, 30, 10, 42, 58, 861e6, time.UTC).UnixMilli() {
		t.Fatalf("pending %+v", a)
	}
	tr.Line(lines[2])
	if tr.Pending() != nil || tr.Resolved() != "toolu_014F63f4HMf8ayZ7AhNMC8Uh" {
		t.Fatalf("after the result: %+v / %q", tr.Pending(), tr.Resolved())
	}

	// Still waiting, as herdr called it idle.
	tr = NewAskTracker(Claude)
	for _, l := range fixtureLines(t, Claude, "ask_pending.jsonl") {
		tr.Line(l)
	}
	if a := tr.Pending(); a == nil || a.ToolUseID != "toolu_01FuqDRbauxtx9cAAmN3o8ex" || a.Questions[0].Question != "Tea or coffee?" {
		t.Fatalf("pending %+v", a)
	}
	tr.Reset()
	if tr.Pending() != nil || tr.Resolved() != "" {
		t.Error("reset kept something")
	}
}

// askUserLine is a user line of the main conversation.
func askUserLine(content string) []byte {
	return []byte(`{"type":"user","isSidechain":false,"timestamp":"2026-09-30T10:50:00.000Z","message":{"role":"user","content":` + content + `}}`)
}

func TestAskTrackerClaudeEnds(t *testing.T) {
	pending := fixtureLines(t, Claude, "ask_pending.jsonl")[1]
	str := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	for name, tc := range map[string]struct {
		line []byte
		gone bool
	}{
		"a new prompt":            {askUserLine(str("never mind, do the other thing")), true},
		"a new prompt as a block": {askUserLine(`[{"type":"text","text":"never mind"}]`), true},
		"the interruption":        {askUserLine(`[{"type":"text","text":"[Request interrupted by user for tool use]"}]`), true},
		"its error result":        {askUserLine(`[{"type":"tool_result","tool_use_id":"toolu_01FuqDRbauxtx9cAAmN3o8ex","is_error":true,"content":"rejected"}]`), true},
		"another call's result":   {askUserLine(`[{"type":"tool_result","tool_use_id":"toolu_other","content":"ok"}]`), false},
		"a reminder":              {askUserLine(str("<system-reminder>be brief</system-reminder>")), false},
		"a meta line":             {[]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat"}}`), false},
		"a task notification":     {askUserLine(str("<task-notification>done</task-notification>")), false},
		"a subagent's prompt":     {[]byte(`{"type":"user","isSidechain":true,"message":{"role":"user","content":"sub"}}`), false},
		"an attachment":           {[]byte(`{"type":"attachment","attachment":{"type":"deferred_tools_record"}}`), false},
		"not JSON":                {[]byte(`{"type":`), false},
	} {
		tr := NewAskTracker(Claude)
		tr.Line(pending)
		tr.Line(tc.line)
		if gone := tr.Pending() == nil; gone != tc.gone {
			t.Errorf("%s: gone %v, want %v", name, gone, tc.gone)
		}
	}
	// A subagent's (sidechain) ask is not the worker's dialog; nor is a call
	// without options, or another tool.
	for name, l := range map[string]string{
		"sidechain":    strings.Replace(string(pending), `"isSidechain":false`, `"isSidechain":true`, 1),
		"no options":   strings.Replace(string(pending), `"options":[{"label":"Tea","description":"Hot tea"},{"label":"Coffee","description":"Hot coffee"}]`, `"options":[]`, 1),
		"another tool": strings.Replace(string(pending), `"name":"AskUserQuestion"`, `"name":"Bash"`, 1),
	} {
		if l == string(pending) {
			t.Fatalf("%s: the fixture changed", name)
		}
		tr := NewAskTracker(Claude)
		tr.Line([]byte(l))
		if a := tr.Pending(); a != nil {
			t.Errorf("%s: pending %+v", name, a)
		}
	}
	if NewAskTracker("shell") != nil {
		t.Error("a tracker for a shell")
	}
}

func TestAskTrackerCodex(t *testing.T) {
	tr := NewAskTracker(Codex)
	var seen []string
	for _, l := range fixtureLines(t, Codex, "ask.jsonl") {
		tr.Line(l)
		if a := tr.Pending(); a != nil && (len(seen) == 0 || seen[len(seen)-1] != a.ToolUseID) {
			seen = append(seen, a.ToolUseID)
		}
	}
	if len(seen) != 4 || tr.Pending() != nil || tr.Resolved() != "call_Qlh9OpdxlSo72tTndrVqBNXT" {
		t.Fatalf("seen %v, pending %+v, resolved %q", seen, tr.Pending(), tr.Resolved())
	}
	pending := fixtureLines(t, Codex, "ask_pending.jsonl")[0]
	tr = NewAskTracker(Codex)
	tr.Line(pending)
	a := tr.Pending()
	if a == nil || a.ToolUseID != "call_ViDcGCpH6sM2VSovBVHRdQHu" || a.Agent != proto.AskCodex || len(a.Questions) != 1 {
		t.Fatalf("pending %+v", a)
	}
	q := a.Questions[0]
	if q.ID != "long" || !q.Other || q.Multi || len(q.Options) != 2 || !strings.HasPrefix(q.Options[0].Label, "HTTP helper") {
		t.Errorf("question %+v", q)
	}
	for name, tc := range map[string]struct {
		line string
		gone bool
	}{
		"its output":       {`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_ViDcGCpH6sM2VSovBVHRdQHu","output":"{}"}}`, true},
		"the turn aborted": {`{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}`, true},
		"a new prompt":     {`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"stop"}]}}`, true},
		"injected context": {`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}`, false},
		"another output":   {`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_x","output":"ok"}}`, false},
		"a token count":    {`{"type":"event_msg","payload":{"type":"token_count"}}`, false},
	} {
		tr := NewAskTracker(Codex)
		tr.Line(pending)
		tr.Line([]byte(tc.line))
		if gone := tr.Pending() == nil; gone != tc.gone {
			t.Errorf("%s: gone %v, want %v", name, gone, tc.gone)
		}
	}
}

func TestAskResults(t *testing.T) {
	type res struct {
		outcome string
		answers []proto.AskAnswer
	}
	claude := map[string]res{}
	var calls = map[string]askCall{}
	for _, l := range fixtureLines(t, Claude, "ask.jsonl") {
		var line struct {
			Message struct {
				Content []claudeBlock `json:"content"`
			} `json:"message"`
			ToolUseResult json.RawMessage `json:"toolUseResult"`
		}
		if json.Unmarshal(l, &line) != nil {
			continue
		}
		for _, bl := range line.Message.Content {
			switch bl.Type {
			case "tool_use":
				c, ok := parseAsk(Claude, bl.Input)
				if !ok {
					t.Fatalf("%s: not an ask", bl.ID)
				}
				calls[bl.ID] = c
			case "tool_result":
				o, as := calls[bl.ToolUseID].claudeResult(line.ToolUseResult, bl.IsError)
				claude[bl.ToolUseID] = res{o, as}
			}
		}
	}
	ans := func(q int, answer string, labels []string, other, notes string) proto.AskAnswer {
		return proto.AskAnswer{Question: q, Answer: answer, Labels: labels, Other: other, Notes: notes}
	}
	for id, w := range map[string]res{
		"toolu_014F63f4HMf8ayZ7AhNMC8Uh": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Coffee", []string{"Coffee"}, "", "")}},
		"toolu_01P9x5hp4AnueE99ehy3kNqX": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Logs, Metrics, Traces", []string{"Logs", "Metrics", "Traces"}, "", "")}},
		"toolu_01U8ZrKFNvqFNsavBe7a22df": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Blue", []string{"Blue"}, "", ""), ans(1, "Logs", []string{"Logs"}, "", "")}},
		"toolu_012vhFKJwCHqKoQ1THGwjkLk": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Sparkling water", nil, "Sparkling water", "")}},
		"toolu_016fnAt3wyH2JR5UL7TnKKNB": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Expanded", []string{"Expanded"}, "", "")}},
		"toolu_01SgCShe3VvQYc12cPwEwovK": {proto.AskAnswered, []proto.AskAnswer{ans(0, "B", []string{"B"}, "", "Prefer larger type")}},
		"toolu_01UYJ8PfzgPp69vD6PS9cA2K": {proto.AskDeclined, nil},
		"toolu_011WWra1kZyUuaFy6ku7fUUj": {proto.AskClarify, nil},
	} {
		if got := claude[id]; !reflect.DeepEqual(got, w) {
			t.Errorf("%s: %+v, want %+v", id, got, w)
		}
	}
	// The preview question has no Other row.
	if q := calls["toolu_016fnAt3wyH2JR5UL7TnKKNB"].questions[0]; q.Other || q.Options[1].Preview == "" {
		t.Errorf("preview question %+v", q)
	}

	var codex = map[string]askCall{}
	got := map[string]res{}
	for _, l := range fixtureLines(t, Codex, "ask.jsonl") {
		var line codexLine
		var it codexItem
		if json.Unmarshal(l, &line) != nil || json.Unmarshal(line.Payload, &it) != nil {
			continue
		}
		switch it.Type {
		case "function_call":
			c, ok := parseAsk(Codex, callArguments(it.Arguments))
			if !ok {
				t.Fatal("not an ask")
			}
			codex[it.CallID] = c
		case "function_call_output":
			o, as := codex[it.CallID].codexResult(it.Output.text)
			got[it.CallID] = res{o, as}
		}
	}
	for id, w := range map[string]res{
		"call_lmhWgAiCLClNM22yFzQXRXcZ": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Green", []string{"Green"}, "", "")}},
		"call_xQd1gbep11m9OuznwGJRfYFx": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Blue", []string{"Blue"}, "", ""), ans(1, "Large", []string{"Large"}, "", ""), ans(2, "Plain", []string{"Plain"}, "", "")}},
		"call_fLK98VtFQnWLvYRk0fcH9SZH": {proto.AskAnswered, []proto.AskAnswer{ans(0, "Use a local file instead.", nil, "Use a local file instead.", "")}},
		"call_Qlh9OpdxlSo72tTndrVqBNXT": {proto.AskDeclined, nil},
	} {
		if g := got[id]; !reflect.DeepEqual(g, w) {
			t.Errorf("%s: %+v, want %+v", id, g, w)
		}
	}
	// A secret's note never leaves the bridge.
	sec := askCall{questions: []proto.AskQuestion{{ID: "s", Secret: true, Other: true}}}
	if _, as := sec.codexResult(`{"answers":{"s":{"answers":["None of the above","user_note: hunter2"]}}}`); len(as) != 1 || strings.Contains(as[0].Answer+as[0].Other, "hunter2") {
		t.Errorf("secret answer %+v", as)
	}
}

func TestSplitLabels(t *testing.T) {
	labels := []string{"Logs", "Metrics, counters", "Traces"}
	for in, want := range map[string]struct {
		picked []string
		other  string
	}{
		"Logs":                            {[]string{"Logs"}, ""},
		"Logs, Metrics, counters, Traces": {[]string{"Logs", "Metrics, counters", "Traces"}, ""},
		"Logs, Custom dashboards":         {[]string{"Logs"}, "Custom dashboards"},
		"Sparkling water":                 {nil, "Sparkling water"},
	} {
		p, o := splitLabels(in, labels)
		if !reflect.DeepEqual(p, want.picked) || o != want.other {
			t.Errorf("%q: %q %q", in, p, o)
		}
	}
}

func TestAskCaps(t *testing.T) {
	long := strings.Repeat("é", proto.MaxAskQuestion)
	in, _ := json.Marshal(map[string]any{"questions": []map[string]any{{"question": long, "header": "H", "multiSelect": true,
		"options": []map[string]any{{"label": "a", "description": "d", "preview": strings.Repeat("p", 5000)}, {"label": "b"}}}}})
	qs, ok := AskQuestions(Claude, in)
	if !ok || len(qs) != 1 || len(qs[0].Question) > proto.MaxAskQuestion || !qs[0].Truncated || len(qs[0].Options[0].Preview) != proto.MaxAskPreview ||
		!qs[0].Multi || qs[0].Other {
		t.Errorf("capped %+v", qs)
	}
	if _, ok := AskQuestions(Claude, json.RawMessage(`{"questions":[]}`)); ok {
		t.Error("no questions")
	}
}

// An ask call's tool item carries its question card: pending, then the
// recorded answers (or how it was dismissed).
func TestAskItems(t *testing.T) {
	type card struct{ outcome, answer string }
	for _, tc := range []struct {
		harness string
		files   []string
		want    []card
	}{
		{Claude, []string{"ask.jsonl", "ask_pending.jsonl"}, []card{{proto.AskAnswered, "Coffee"}, {proto.AskAnswered, "Logs, Metrics, Traces"},
			{proto.AskAnswered, "Blue"}, {proto.AskAnswered, "Sparkling water"}, {proto.AskAnswered, "Expanded"}, {proto.AskDeclined, ""},
			{proto.AskClarify, ""}, {proto.AskAnswered, "B"}, {proto.AskPending, ""}}},
		{Codex, []string{"ask.jsonl", "ask_pending.jsonl"}, []card{{proto.AskAnswered, "Green"}, {proto.AskAnswered, "Blue"},
			{proto.AskAnswered, "Use a local file instead."}, {proto.AskDeclined, ""}, {proto.AskPending, ""}}},
	} {
		var got []card
		for _, it := range items(t, tc.harness, tc.files...) {
			if it.Tool == nil || !IsAskTool(tc.harness, it.Tool.Name) {
				continue
			}
			a := it.Tool.Ask
			if a == nil || a.Agent != tc.harness || len(a.Questions) == 0 {
				t.Fatalf("%s %s: card %+v", tc.harness, it.ID, a)
			}
			c := card{outcome: a.Outcome}
			if len(a.Answers) > 0 {
				c.answer = a.Answers[0].Answer
			}
			if (a.Outcome == proto.AskPending) != (it.Tool.Status == proto.ToolRunning) {
				t.Errorf("%s %s: outcome %s, status %s", tc.harness, it.ID, a.Outcome, it.Tool.Status)
			}
			got = append(got, c)
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v\nwant %+v", tc.harness, got, tc.want)
		}
	}
}
