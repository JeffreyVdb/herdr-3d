package transcript

import (
	"encoding/json"
	"strings"
	"testing"
)

func callUse(id, name, input string, sidechain bool) string {
	return `{"type":"assistant","isSidechain":` + map[bool]string{true: "true", false: "false"}[sidechain] +
		`,"cwd":"/home/u/w1","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func callResult(id string) string {
	return `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"ok"}]}}`
}

func pendingIDs(t *CallTracker) []string {
	var out []string
	for _, c := range t.Pending() {
		out = append(out, c.ID)
	}
	return out
}

// #106: the main conversation's calls with no result, with their whole
// input, its sum and directory; a result, an interruption or a new prompt
// ends them; a subagent's (sidechain) call is not the worker's; the
// permission mode is the last one recorded.
func TestCallTracker(t *testing.T) {
	if NewCallTracker(Codex) != nil {
		t.Fatal("a Codex call tracker")
	}
	tr := NewCallTracker(Claude)
	bash := `{"command":"S=/tmp/run; D=$S/scratch; rm -f $D/*","description":"Clean the scratch directory"}`
	for _, l := range []string{
		`{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"s"}`,
		callUse("toolu_a", "Bash", bash, false),
		callUse("toolu_b", "Read", `{"file_path":"/home/u/w1/a.go"}`, false),
		callUse("toolu_side", "Bash", `{"command":"ls"}`, true),
	} {
		tr.Line([]byte(l))
	}
	p := tr.Pending()
	if len(p) != 2 || p[0].ID != "toolu_a" || p[0].Name != "Bash" || string(p[0].Input) != bash || p[0].Cwd != "/home/u/w1" ||
		len(p[0].Sum) != 64 || tr.Mode() != "bypassPermissions" {
		t.Fatalf("pending %+v, mode %q", p, tr.Mode())
	}
	var in struct{ Command string }
	if json.Unmarshal(p[0].Input, &in) != nil || !strings.Contains(in.Command, "rm -f $D/*") {
		t.Fatalf("input %s", p[0].Input)
	}
	tr.Line([]byte(callResult("toolu_b")))
	if ids := pendingIDs(tr); len(ids) != 1 || ids[0] != "toolu_a" {
		t.Fatalf("pending %v", ids)
	}
	tr.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`))
	if ids := pendingIDs(tr); len(ids) != 0 {
		t.Fatalf("pending after an interruption %v", ids)
	}
	tr.Line([]byte(callUse("toolu_c", "Bash", `{"command":"ls"}`, false)))
	tr.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}`))
	if ids := pendingIDs(tr); len(ids) != 1 {
		t.Fatalf("a meta line ended the call: %v", ids)
	}
	tr.Line([]byte(`{"type":"user","message":{"role":"user","content":"do something else"}}`))
	if ids := pendingIDs(tr); len(ids) != 0 {
		t.Fatalf("pending after a prompt %v", ids)
	}
	big := `{"command":"` + strings.Repeat("x", MaxCallInput) + `"}`
	tr.Line([]byte(callUse("toolu_big", "Bash", big, false)))
	if p := tr.Pending(); len(p) != 1 || p[0].Input != nil || len(p[0].Sum) != 64 {
		t.Fatalf("big %+v", p)
	}
	for i := range MaxPendingCalls + 3 {
		tr.Line([]byte(callUse("toolu_"+strings.Repeat("n", i+1), "Bash", `{"command":"true"}`, false)))
	}
	if ids := pendingIDs(tr); len(ids) != MaxPendingCalls || ids[len(ids)-1] != "toolu_"+strings.Repeat("n", MaxPendingCalls+3) {
		t.Fatalf("bounded %d %v", len(ids), ids[len(ids)-1])
	}
	tr.Reset()
	if len(tr.Pending()) != 0 || tr.Mode() != "" {
		t.Fatal("not reset")
	}
}
