package transcript

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #56: Codex's collaboration calls and inter-agent messages, trimmed from
// a real parent rollout (codex-cli 0.162.1; the second spawn, the followup
// and the wait from two more of the same day; close_agent synthetic: never
// seen locally) and its child's (session_meta and its task).
func TestCodexCollab(t *testing.T) {
	hidden := want{kind: proto.ItemNotice, hidden: true, source: "event_msg/item_completed"}
	sums := map[string]string{}
	tool := func(id, name, status, sum string) want {
		sums[id] = sum
		return want{kind: proto.ItemTool, id: id, tool: name, status: status}
	}
	got := items(t, Codex, "collab.jsonl")
	check(t, "collab", got, []want{
		tool("call_b29014c00922488d89e346e245b44af0", "spawn_agent", proto.ToolOK, "gpu_research"),
		hidden, // SubAgentActivity started: also the call's
		tool("call_d97cab4bc14948fcbd3e71f65ac1c36a", "send_message", proto.ToolOK, "gpu_research"),
		hidden, // interacted
		{kind: proto.ItemNotice, id: "amsg_01a1439e-91da-79c2-a082-1052d8081541", source: "agent_message", text: "/root/gpu_research → /root"},
		tool("call_bb905e7596064beaae8faf916557d34b", "spawn_agent", proto.ToolOK, "runtime_research"),
		hidden,
		tool("call_949ba72754f741ab816de5404e070055", "followup_task", proto.ToolOK, "runtime_research"),
		hidden,
		tool("call_8d789cb664cc4e12bd5302bbd0a82993", "wait_agent", proto.ToolOK, ""),
		hidden, // CollabAgentToolCall
		hidden, // SubAgentActivity completed: no call's, no row of its own
		{kind: proto.ItemNotice, id: "amsg_01a1439f-e866-77e0-889d-fbf8faceb33d", source: "agent_message", text: "Wrote the GPU notes"},
		tool("call_c56close000000000000000000000001", "close_agent", proto.ToolOK, "gpu_research"),
	})
	collab := func(i int) proto.TranscriptCollab {
		t.Helper()
		if got[i].Collab == nil {
			t.Fatalf("item %d (%s): no collab", i, got[i].ID)
		}
		return *got[i].Collab
	}
	same := func(i int, w proto.TranscriptCollab) {
		t.Helper()
		if c := collab(i); c != w {
			t.Errorf("item %d (%s): collab\n got %+v\nwant %+v", i, got[i].ID, c, w)
		}
	}
	// The model and effort are only in the SubAgentActivity event; the path in both it and the output.
	same(0, proto.TranscriptCollab{Kind: proto.CollabSpawn, TaskName: "gpu_research", AgentPath: "/root/gpu_research", Model: "gpt-6.1-sol",
		Effort: "high", ThreadID: "01a1439d-d782-7322-8469-ee452eaa3190", Encrypted: true})
	same(2, proto.TranscriptCollab{Kind: proto.CollabSend, Target: "gpu_research", AgentPath: "/root/gpu_research",
		ThreadID: "01a1439d-d782-7322-8469-ee452eaa3190", Encrypted: true})
	same(4, proto.TranscriptCollab{Kind: proto.CollabInbound, AgentPath: "/root/gpu_research", Recipient: "/root", MessageType: "MESSAGE", Encrypted: true})
	same(5, proto.TranscriptCollab{Kind: proto.CollabSpawn, TaskName: "runtime_research", AgentPath: "/root/runtime_research", Model: "gpt-6.1-sol",
		Effort: "high", ForkTurns: "all", ThreadID: "01a14450-a13e-79d1-8c52-5e9ef4aab8e0", Encrypted: true})
	same(7, proto.TranscriptCollab{Kind: proto.CollabFollowup, Target: "runtime_research", AgentPath: "/root/runtime_research",
		ThreadID: "01a14450-a13e-79d1-8c52-5e9ef4aab8e0", Encrypted: true})
	same(9, proto.TranscriptCollab{Kind: proto.CollabWait})
	// A plain payload (a final answer) is the message.
	same(12, proto.TranscriptCollab{Kind: proto.CollabInbound, AgentPath: "/root/gpu_research", Recipient: "/root", MessageType: "FINAL_ANSWER",
		Prompt: "Wrote the GPU notes: the current Playwright flags already use the discrete GPU."})
	same(13, proto.TranscriptCollab{Kind: proto.CollabClose, Target: "gpu_research", AgentPath: "/root/gpu_research"})

	// The summary is the task or target, never the message; the raw call stays whole (the view's Raw request).
	for _, it := range got {
		if sum, ok := sums[it.ID]; ok && it.Tool.InputSummary != sum {
			t.Errorf("%s: summary %q, want %q", it.ID, it.Tool.InputSummary, sum)
		}
	}
	var in map[string]string
	if json.Unmarshal(got[0].Tool.Input, &in) != nil || in["message"] != "gAAAAABstub0000" || got[0].Tool.OutputText != `{"task_name":"/root/gpu_research"}` {
		t.Errorf("raw spawn: %s / %q", got[0].Tool.Input, got[0].Tool.OutputText)
	}
	if o := got[9].Tool.OutputText; o != `{"message":"Wait completed.","timed_out":false}` {
		t.Errorf("wait output %q", o)
	}

	// The child: its session_meta is metadata; its task, from the parent, is encrypted.
	child := items(t, Codex, "collab_child.jsonl")
	check(t, "collab_child", child, []want{
		{kind: proto.ItemNotice, hidden: true, source: "session_meta"},
		{kind: proto.ItemNotice, id: "amsg_01a1439d-dbc0-7d70-9c0e-b0294ed4a0e3", source: "agent_message", text: "/root → /root/gpu_research"},
	})
	if c := child[1].Collab; c == nil || *c != (proto.TranscriptCollab{Kind: proto.CollabInbound, AgentPath: "/root", Recipient: "/root/gpu_research",
		MessageType: "NEW_TASK", Encrypted: true}) {
		t.Errorf("child task: %+v", c)
	}
	if n := child[1].Notice.Text; strings.Contains(n, "Payload") || strings.Contains(n, codexEncrypted) {
		t.Errorf("child notice %q", n)
	}
}

// #56: an older build's spawn (no namespace) with its message in plain
// text and a nickname in its output; another namespace's send_message is
// not a collaboration call.
func TestCodexCollabV1(t *testing.T) {
	got := items(t, Codex, "collab_v1.jsonl")
	check(t, "collab_v1", got, []want{
		{kind: proto.ItemTool, tool: "spawn_agent", status: proto.ToolOK},
		{kind: proto.ItemTool, tool: "mcp__chat.send_message", status: proto.ToolRunning},
	})
	if c := got[0].Collab; c == nil || *c != (proto.TranscriptCollab{Kind: proto.CollabSpawn, AgentType: "explorer", Nickname: "Meitner",
		ThreadID: "0199a0b1-0000-7000-8000-000000000001", Prompt: "Find where the transcript parser names Codex tool rows."}) {
		t.Errorf("v1 spawn: %+v", c)
	}
	if s := got[0].Tool.InputSummary; s != "explorer" {
		t.Errorf("v1 summary %q", s)
	}
	if got[1].Collab != nil {
		t.Errorf("another namespace's send_message: %+v", got[1].Collab)
	}
}

// #56: a long plain payload is cut in lists like a part, whole in
// transcript.item.
func TestCodexCollabPromptCap(t *testing.T) {
	b := &builder{it: proto.TranscriptItem{Kind: proto.ItemNotice, Collab: &proto.TranscriptCollab{Kind: proto.CollabInbound, Prompt: strings.Repeat("a", MaxText+10)}}}
	if it := b.finish(false); len(it.Collab.Prompt) != MaxText || !it.Truncated {
		t.Errorf("list: %d bytes, truncated %v", len(it.Collab.Prompt), it.Truncated)
	}
	if it := b.finish(true); len(it.Collab.Prompt) != MaxText+10 || it.Truncated {
		t.Errorf("full: %d bytes, truncated %v", len(it.Collab.Prompt), it.Truncated)
	}
}

// #25: a legacy-history rollout's sub_agent_activity event is a hidden
// notice, not an unknown item; with CodexHistoryStart, a subagent's
// records before its history start are hidden, its own first line is
// read (its cli_version), and a line with no ordinal counts as inherited.
func TestCodexSubagentLines(t *testing.T) {
	cs, _ := parseCodex(10, []byte(`{"timestamp":"2026-10-18T08:00:01.020Z","type":"event_msg","payload":{"type":"sub_agent_activity",`+
		`"event_id":"call_1","occurred_at_ms":1,"agent_thread_id":"t","agent_path":"/root/lint","kind":"started"}}`))
	if len(cs) != 1 || cs[0].kind != proto.ItemNotice || !cs[0].hidden {
		t.Fatalf("sub_agent_activity = %+v", cs)
	}
	meta := `{"timestamp":"2026-10-18T08:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"c","cli_version":"0.163.0"}}`
	if _, v := parseCodexFrom(9, 0, []byte(meta)); v != "0.163.0" {
		t.Errorf("own session_meta version %q", v)
	}
	parent := `{"timestamp":"2026-10-18T08:00:00.000Z","ordinal":1,"type":"session_meta","payload":{"id":"p","cli_version":"0.160.1"}}`
	user := `{"timestamp":"2026-10-18T08:00:00.000Z","ordinal":%d,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"count the lines"}]}}`
	for _, line := range []string{parent, strings.Replace(user, "%d", "4", 1), strings.Replace(user, `"ordinal":%d,`, "", 1)} {
		cs, v := parseCodexFrom(9, 100, []byte(line))
		if len(cs) != 1 || !cs[0].hidden || v != "" {
			t.Errorf("inherited %s = %+v, %q", line, cs, v)
		}
	}
	if cs, _ := parseCodexFrom(9, 100, []byte(strings.Replace(user, "%d", "9", 1))); len(cs) != 1 || cs[0].hidden {
		t.Errorf("own message = %+v", cs)
	}
}
