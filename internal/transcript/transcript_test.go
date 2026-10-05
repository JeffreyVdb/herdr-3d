package transcript

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// items reads a fixture whole and returns all its items.
func items(t *testing.T, harness string, files ...string) []proto.TranscriptItem {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.jsonl")
	var all []byte
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join("testdata", harness, f))
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, b...)
	}
	if err := os.WriteFile(path, all, 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), harness, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, err := l.Before(0, MaxTranscriptLimit)
	if err != nil {
		t.Fatal(err)
	}
	return p.Items
}

// MaxTranscriptLimit mirrors the server's, for reading fixtures whole.
const MaxTranscriptLimit = 500

// want is what a test checks of an item; empty fields are not checked.
type want struct {
	kind, id, raw, source, tool, status, text, diff, agent string
	hidden, images                                         bool
}

func check(t *testing.T, name string, got []proto.TranscriptItem, ws []want) {
	t.Helper()
	if len(got) != len(ws) {
		for _, it := range got {
			t.Logf("%s: %+v", name, it)
		}
		t.Fatalf("%s: %d items, want %d", name, len(got), len(ws))
	}
	for i, w := range ws {
		it := got[i]
		fail := func(what string, g, e any) { t.Errorf("%s item %d (%s): %s = %v, want %v", name, i, it.ID, what, g, e) }
		if it.Seq != int64(i+1) {
			fail("seq", it.Seq, i+1)
		}
		if it.Kind != w.kind {
			fail("kind", it.Kind, w.kind)
		}
		if it.Hidden != w.hidden {
			fail("hidden", it.Hidden, w.hidden)
		}
		if w.id != "" && it.ID != w.id {
			fail("id", it.ID, w.id)
		}
		if w.raw != "" && it.RawType != w.raw {
			fail("raw_type", it.RawType, w.raw)
		}
		if w.source != "" && (it.Notice == nil || it.Notice.Source != w.source) {
			fail("notice", it.Notice, w.source)
		}
		if w.tool != "" && (it.Tool == nil || it.Tool.Name != w.tool) {
			fail("tool", it.Tool, w.tool)
		}
		if w.status != "" && (it.Tool == nil || it.Tool.Status != w.status) {
			fail("status", it.Tool, w.status)
		}
		if w.text != "" && !strings.Contains(textOf(it), w.text) {
			fail("text", textOf(it), w.text)
		}
		if w.diff != "" && (it.Tool == nil || it.Tool.Diff == nil || it.Tool.Diff.Path != w.diff || len(it.Tool.Diff.Hunks) == 0) {
			fail("diff", it.Tool, w.diff)
		}
		if w.agent != "" && (it.Subagent == nil || it.Subagent.AgentID != w.agent) {
			fail("subagent", it.Subagent, w.agent)
		}
		if w.images != hasImage(it) {
			fail("images", hasImage(it), w.images)
		}
		if it.TS == 0 && it.Kind != proto.ItemUnknown && (it.Notice == nil || !it.Hidden) {
			fail("ts", 0, "set")
		}
	}
}

func textOf(it proto.TranscriptItem) string {
	var ss []string
	for _, p := range it.Parts {
		ss = append(ss, p.Text)
	}
	if it.Notice != nil {
		ss = append(ss, it.Notice.Text)
	}
	if it.Tool != nil {
		ss = append(ss, it.Tool.InputSummary, it.Tool.OutputText)
	}
	return strings.Join(ss, "\n")
}

func hasImage(it proto.TranscriptItem) bool {
	for _, p := range it.Parts {
		if p.Image != nil {
			return true
		}
	}
	return it.Tool != nil && len(it.Tool.Images) > 0
}

// Every Claude Code line and block type seen in real transcripts
// (docs/protocol.md "Laptops: transcript"), one fixture each.
func TestClaudeLines(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  []want
	}{
		{"message streamed over lines", []string{"message.jsonl"}, []want{
			{kind: proto.ItemThinking, id: "msg_011CfYrEE8Ld5NT57LVE71Xw#0"},
			{kind: proto.ItemAssistant, id: "msg_011CfYrEE8Ld5NT57LVE71Xw#1", text: "Repo use GitHub issues"},
			{kind: proto.ItemTool, id: "toolu_018Aah2uHCqF4KbGuUkTSEYa", tool: "Bash", status: proto.ToolRunning, text: "gh repo view"},
			{kind: proto.ItemTool, id: "toolu_012sFpchD5Dqa9y7mPhfGKoK", tool: "Bash", status: proto.ToolRunning},
		}},
		{"a result arrives: the call's item, not a new one", []string{"message.jsonl", "bash.jsonl"}, []want{
			{kind: proto.ItemThinking},
			{kind: proto.ItemAssistant},
			{kind: proto.ItemTool, id: "toolu_018Aah2uHCqF4KbGuUkTSEYa", status: proto.ToolOK, text: "JeffreyVdb/herdr-3d issues=true"},
			{kind: proto.ItemTool, status: proto.ToolRunning},
		}},
		{"bash", []string{"bash.jsonl"}, []want{{kind: proto.ItemTool, tool: "Bash", status: proto.ToolOK, text: "issues=true"}}},
		{"bash error", []string{"bash_error.jsonl"}, []want{{kind: proto.ItemTool, tool: "Bash", status: proto.ToolError, text: "Exit code 2"}}},
		{"edit: structuredPatch diff", []string{"edit.jsonl"}, []want{{kind: proto.ItemTool, tool: "Edit", status: proto.ToolOK,
			diff: "/home/dev/.herdr/worktrees/herdr-3d/feat-33-transcript-shell/game/src/net/protocol.ts"}}},
		{"write: a created file is all added lines", []string{"write.jsonl"}, []want{{kind: proto.ItemTool, tool: "Write",
			status: proto.ToolOK, diff: "/tmp/claude-1000/-home-user--herdr-worktrees-herdr-3d-h3d-lychee-0c73a1/d1ee302b-80ec-4cf4-bff4-855ccd9a179e/scratchpad/brief-bridge.txt"}}},
		{"read of an image: omitted", []string{"read_image.jsonl"}, []want{{kind: proto.ItemTool, tool: "Read", status: proto.ToolOK, images: true}}},
		{"agent: a subagent with its id", []string{"agent.jsonl"}, []want{{kind: proto.ItemSubagent, tool: "Agent", status: proto.ToolOK,
			agent: "aa3716c63ba631707", text: "Map logo touchpoints"}}},
		{"server tool and its result", []string{"server_tool.jsonl"}, []want{{kind: proto.ItemTool, tool: "advisor", status: proto.ToolOK}}},
		{"user lines", []string{"user.jsonl"}, []want{
			{kind: proto.ItemUser, text: "Can we create a new release"},
			{kind: proto.ItemUser, text: "The usage widget", images: true},
			{kind: proto.ItemNotice, hidden: true, source: "user/meta", text: "Base directory for this skill"},
			{kind: proto.ItemUser, text: "/clear"},
			{kind: proto.ItemNotice, source: "user/command_output", text: "Set effort level to high"},
		}},
		{"a user's [Image #n: path] marker", []string{"user_marker.jsonl"}, []want{
			{kind: proto.ItemUser, images: true, text: "what is wrong with this?"}}},
		{"interrupted", []string{"interrupted.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "Bash", status: proto.ToolError, text: "The user doesn't want to proceed"},
			{kind: proto.ItemNotice, source: "user/interrupted", text: "Interrupted by user"},
		}},
		{"attachments: noise, but a queued prompt is the user's", []string{"attachment.jsonl"}, []want{
			{kind: proto.ItemNotice, hidden: true, source: "attachment/deferred_tools_delta"},
			{kind: proto.ItemNotice, hidden: true, source: "attachment/total_tokens_reminder"},
			{kind: proto.ItemNotice, hidden: true, source: "attachment/hook_additional_context", text: "CAVEMAN"},
			{kind: proto.ItemNotice, hidden: true, source: "attachment/date"},
			{kind: proto.ItemUser, text: "I meant monitor"},
			{kind: proto.ItemNotice, hidden: true, source: "attachment/edited_text_file"},
		}},
		{"system lines", []string{"system.jsonl"}, []want{
			{kind: proto.ItemNotice, hidden: true, source: "system/stop_hook_summary"},
			{kind: proto.ItemNotice, source: "system/turn_duration", text: "Turn took 9m 52s"},
			{kind: proto.ItemNotice, source: "system/away_summary", text: "Building phase-1"},
			{kind: proto.ItemNotice, hidden: true, source: "system/local_command"},
			{kind: proto.ItemNotice, source: "system/informational", text: "Remote Control disconnected"},
		}},
		{"compaction: the items before it stay", []string{"compact.jsonl"}, []want{
			{kind: proto.ItemUser, text: "Now add the transcript section"},
			{kind: proto.ItemCompaction, text: "Conversation compacted (auto, 167421 tokens)"},
			{kind: proto.ItemNotice, source: "user/compact_summary", text: "being continued"},
		}},
		{"subagent file", []string{"subagent.jsonl"}, []want{
			{kind: proto.ItemUser, text: "Repo /home/dev"},
			{kind: proto.ItemTool, status: proto.ToolOK},
			{kind: proto.ItemTool, status: proto.ToolOK},
			{kind: proto.ItemTool, status: proto.ToolRunning},
		}},
		{"unknown lines and blocks", []string{"unknown.jsonl"}, []want{
			{kind: proto.ItemUnknown, hidden: true, raw: "hologram-state"},
			{kind: proto.ItemUnknown, hidden: true, raw: "assistant/hologram", id: "msg_future01#0"},
			{kind: proto.ItemUnknown, hidden: true, raw: "system/hologram_summary"},
			{kind: proto.ItemUnknown, hidden: true, raw: "(invalid line)"},
		}},
	}
	for _, c := range cases {
		check(t, c.name, items(t, Claude, c.files...), c.want)
	}
	// Metadata lines: each a hidden notice named after its type.
	meta := items(t, Claude, "meta.jsonl")
	if len(meta) != 16 {
		t.Fatalf("meta: %d items", len(meta))
	}
	for _, it := range meta {
		if it.Kind != proto.ItemNotice || !it.Hidden || it.Notice == nil || !claudeMeta[it.Notice.Source] {
			t.Errorf("meta item %+v", it)
		}
	}
}

// Every Codex rollout line and item type seen in real rollouts.
func TestCodexLines(t *testing.T) {
	hidden := func(src string) want { return want{kind: proto.ItemNotice, hidden: true, source: src} }
	cases := []struct {
		name  string
		files []string
		want  []want
	}{
		{"a whole session", []string{"session.jsonl"}, []want{
			hidden("session_meta"),
			hidden("event_msg/task_started"),
			hidden("message/developer"), hidden("message/developer"), hidden("message/developer"),
			{kind: proto.ItemNotice, hidden: true, source: "message/user", text: "# AGENTS.md instructions"},
			hidden("world_state"),
			hidden("turn_context"),
			{kind: proto.ItemUser, text: "Create a simple hello world application in C"},
			hidden("event_msg/item_completed"), hidden("event_msg/item_completed"),
			{kind: proto.ItemThinking, id: "rs_0e6f067a8d4c386a016abb4d8079a087d2832a830d0a8f9978"},
			hidden("event_msg/item_completed"),
			{kind: proto.ItemAssistant, text: "minimal C source file"},
			{kind: proto.ItemTool, id: "call_0t7w8LUy2sHg7G8dCDNGI7qm", tool: "exec", status: proto.ToolOK, text: "mkdir -p /tmp/hello-world"},
			hidden("token_usage_record"),
			hidden("event_msg/item_completed"),
			hidden("event_msg/token_count"),
			hidden("event_msg/item_completed"),
			{kind: proto.ItemThinking},
			hidden("event_msg/item_completed"),
			{kind: proto.ItemAssistant, text: "Created the C source"},
			hidden("token_usage_record"),
			hidden("event_msg/token_count"),
			{kind: proto.ItemNotice, source: "event_msg/task_complete", text: "Turn took 13.8s"},
		}},
		{"tools: custom and function calls with their outputs", []string{"tools.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "exec", status: proto.ToolOK, text: "cat /home/dev/.local/state/write-code"},
			{kind: proto.ItemTool, tool: "exec_command", status: proto.ToolOK, text: "cat /home/dev/.agents/skills"},
		}},
		{"tools: a script of several commands says how many more", []string{"exec_multi.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "exec", status: proto.ToolOK, text: "gitleaks git . --redact --no-banner (+2 more)"},
		}},
		{"apply_patch: a diff per file", []string{"apply_patch.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "apply_patch", status: proto.ToolOK, diff: "package.json", text: "package.json, tsconfig.json"},
		}},
		{"images: omitted", []string{"image.jsonl"}, []want{
			{kind: proto.ItemUser, images: true, text: "Something is wrong with the claude/codex limits"},
			{kind: proto.ItemTool, tool: "exec", status: proto.ToolOK, images: true},
		}},
		{"view_image: the output's image", []string{"view_image.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "view_image", status: proto.ToolOK, images: true, text: "/tmp/github-app-access-request-guide.png"},
		}},
		{"a generated image", []string{"generated.jsonl"}, []want{{kind: proto.ItemAssistant, id: "img:call_QjS7MQbBDcgOE4dkGsXea7nA", images: true}}},
		{"agents", []string{"agents.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "collaboration.spawn_agent", status: proto.ToolRunning},
			hidden("inter_agent_communication_metadata"),
			{kind: proto.ItemNotice, source: "agent_message", text: "/root/spec → /root"},
			hidden("event_msg/thread_settings_applied"),
		}},
		{"aborted: a running call is interrupted", []string{"aborted.jsonl"}, []want{
			{kind: proto.ItemTool, tool: "exec", status: proto.ToolInterrupted},
			{kind: proto.ItemNotice, source: "event_msg/turn_aborted", text: "Turn interrupted"},
		}},
		{"compacted", []string{"compacted.jsonl"}, []want{{kind: proto.ItemCompaction, source: "compacted"}}},
		{"unknown", []string{"unknown.jsonl"}, []want{
			{kind: proto.ItemUnknown, hidden: true, raw: "hologram_record"},
			{kind: proto.ItemUnknown, hidden: true, raw: "response_item/hologram_call", id: "hc_01"},
			{kind: proto.ItemUnknown, hidden: true, raw: "event_msg/hologram_started"},
			{kind: proto.ItemUnknown, hidden: true, raw: "message/narrator"},
		}},
	}
	for _, c := range cases {
		check(t, c.name, items(t, Codex, c.files...), c.want)
	}
	// apply_patch's second file is in diffs.
	it := items(t, Codex, "apply_patch.jsonl")[0]
	if d := it.Tool.Diffs; len(d) != 2 || d[1].Path != "tsconfig.json" || d[0].Hunks[0].Lines[0] != "+{" {
		t.Errorf("diffs = %+v", d)
	}
}

// #151: an exec script's MCP calls are only item_completed / item_started
// events (McpToolCall), no response items: tool rows named server.tool.
func TestCodexMCPCalls(t *testing.T) {
	hidden := want{kind: proto.ItemNotice, hidden: true, source: "event_msg/item_completed"}
	mcp := func(id, name, status, text string) want {
		return want{kind: proto.ItemTool, id: id, tool: name, status: status, text: text}
	}
	t.Run("completions alone, the enclosing exec and the other item types stay", func(t *testing.T) {
		got := items(t, Codex, "mcp_exec.jsonl")
		check(t, "mcp_exec", got, []want{
			{kind: proto.ItemTool, id: "call_mcp_exec_a", tool: "exec", status: proto.ToolOK, text: "tools.mcp__alterlab"},
			hidden, // Reasoning
			mcp("exec-0001", "alterlab.alterlab_search", proto.ToolOK, "1. Spec https://example.com/spec\n2. Blog"),
			mcp("exec-0002", "alterlab.alterlab_scrape", proto.ToolOK, "# Spec\n\nExample page."),
			hidden, // CommandExecution
		})
		search, scrape := got[2].Tool, got[3].Tool
		if string(search.Input) != `{"query":"model context protocol spec","num_results":2}` || search.InputSummary != "model context protocol spec" {
			t.Errorf("search input: %s / %q", search.Input, search.InputSummary)
		}
		if scrape.InputSummary != "https://example.com/spec" || !strings.Contains(string(scrape.Input), `"formats":["markdown"]`) {
			t.Errorf("scrape input: %s / %q", scrape.Input, scrape.InputSummary)
		}
	})
	t.Run("failed: isError, an error message, no content", func(t *testing.T) {
		got := items(t, Codex, "mcp_failed.jsonl")
		check(t, "mcp_failed", got, []want{
			mcp("exec-0101", "alterlab.alterlab_search", proto.ToolError, "Gateway timeout for slow query."),
			mcp("exec-0102", "monday.all_api_read", proto.ToolError, `Cannot query field "body"`),
			mcp("exec-0103", "team-search.list_repo_groups", proto.ToolError, "user rejected MCP tool call"),
			mcp("exec-0104", "grafana.query", proto.ToolOK, `{"rows":3}`), // structuredContent when no text
		})
		if got[2].Tool.InputSummary != "{}" {
			t.Errorf("no arguments: summary %q", got[2].Tool.InputSummary)
		}
	})
	t.Run("one row per call, whatever represents it", func(t *testing.T) {
		got := items(t, Codex, "mcp_dup.jsonl")
		check(t, "mcp_dup", got, []want{
			mcp("exec-0201", "alterlab.alterlab_search", proto.ToolOK, "one result"), // start + completion
			mcp("exec-0202", "alterlab.alterlab_scrape", proto.ToolRunning, ""),      // start only
			mcp("call_dup0001", "mcp__alterlab.alterlab_search", proto.ToolOK, "response text"),
			mcp("call_dup0002", "mcp__alterlab.alterlab_search", proto.ToolOK, "early response text"),
		})
		for _, it := range got[2:] {
			if strings.Contains(it.Tool.OutputText, "event text") || string(it.Tool.Input) == "" {
				t.Errorf("%s: %+v", it.ID, it.Tool)
			}
		}
	})
}

func TestVersion(t *testing.T) {
	for _, c := range []struct{ harness, file, want string }{
		{Claude, "message.jsonl", "2.1.285"},
		{Codex, "session.jsonl", "0.158.0"},
	} {
		l, err := Read(context.Background(), c.harness, filepath.Join("testdata", c.harness, c.file))
		if err != nil {
			t.Fatal(err)
		}
		if v := l.Version(); v != c.want {
			t.Errorf("%s version %q, want %q", c.file, v, c.want)
		}
		l.Close()
	}
}

// claudeLine builds an assistant line of one block.
func assistantBlock(msg string, idx int, block string) string {
	return fmt.Sprintf(`{"type":"assistant","uuid":"u-%s-%d","timestamp":"2026-09-29T10:00:%02d.000Z","message":{"id":%q,`+
		`"role":"assistant","content":[%s]},"apiBlockIndex":%d,"version":"2.1.285"}`+"\n", msg, idx, idx, msg, block, idx)
}

func text(s string) string { return fmt.Sprintf(`{"type":"text","text":%q}`, s) }

func toolUse(id, name string) string {
	return fmt.Sprintf(`{"type":"tool_use","id":%q,"name":%q,"input":{"command":"ls -la"}}`, id, name)
}

func toolResult(id, content string, isError bool) string {
	return fmt.Sprintf(`{"type":"user","uuid":"r-%s","timestamp":"2026-09-29T10:01:00.000Z","message":{"role":"user",`+
		`"content":[{"type":"tool_result","tool_use_id":%q,"content":%q,"is_error":%v}]}}`+"\n", id, id, content, isError)
}

// Consecutive text blocks of one message are one item (in block order);
// a tool_use between them starts another; a block sent again replaces its
// part.
func TestMergeBlocks(t *testing.T) {
	lines := assistantBlock("m1", 0, `{"type":"thinking","thinking":"hmm"}`) +
		assistantBlock("m1", 1, text("first")) +
		assistantBlock("m1", 2, text("second")) +
		assistantBlock("m1", 3, toolUse("toolu_a", "Bash")) +
		assistantBlock("m1", 4, text("after the tool")) +
		assistantBlock("m1", 2, text("second, again")) +
		assistantBlock("m2", 0, text("next message"))
	got := itemsOf(t, Claude, lines)
	check(t, "merge", got, []want{
		{kind: proto.ItemThinking, id: "m1#0", text: "hmm"},
		{kind: proto.ItemAssistant, id: "m1#1"},
		{kind: proto.ItemTool, id: "toolu_a", status: proto.ToolRunning},
		{kind: proto.ItemAssistant, id: "m1#4", text: "after the tool"},
		{kind: proto.ItemAssistant, id: "m2#0", text: "next message"},
	})
	if p := got[1].Parts; len(p) != 2 || p[0].Text != "first" || p[1].Text != "second, again" {
		t.Errorf("merged parts = %+v", p)
	}
}

func itemsOf(t *testing.T, harness, content string) []proto.TranscriptItem {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), harness, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, err := l.Before(0, MaxTranscriptLimit)
	if err != nil {
		t.Fatal(err)
	}
	return p.Items
}

// An interruption interrupts every call still running (Claude and Codex),
// and only those.
func TestInterruptRunning(t *testing.T) {
	claude := assistantBlock("m1", 0, toolUse("toolu_a", "Bash")) +
		assistantBlock("m1", 1, toolUse("toolu_b", "Agent")) +
		assistantBlock("m1", 2, toolUse("toolu_c", "Bash")) +
		toolResult("toolu_c", "done", false) +
		`{"type":"user","uuid":"int","timestamp":"2026-09-29T10:02:00.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}` + "\n" +
		assistantBlock("m2", 0, toolUse("toolu_d", "Bash"))
	got := itemsOf(t, Claude, claude)
	check(t, "claude", got, []want{
		{kind: proto.ItemTool, id: "toolu_a", status: proto.ToolInterrupted},
		{kind: proto.ItemSubagent, id: "toolu_b", status: proto.ToolInterrupted},
		{kind: proto.ItemTool, id: "toolu_c", status: proto.ToolOK, text: "done"},
		{kind: proto.ItemNotice, source: "user/interrupted"},
		{kind: proto.ItemTool, id: "toolu_d", status: proto.ToolRunning},
	})
	if s := got[1].Subagent; s == nil || s.Status != proto.ToolInterrupted {
		t.Errorf("subagent = %+v", s)
	}
}

// Lists cap output_text at 64 KiB (output_truncated) and leave out an
// input over 4 KiB; transcript.item has both whole.
func TestCaps(t *testing.T) {
	big := strings.Repeat("x", MaxText+100)
	input := fmt.Sprintf(`{"type":"tool_use","id":"toolu_big","name":"Write","input":{"file_path":"/f","content":%q}}`, strings.Repeat("y", MaxInput))
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte(assistantBlock("m1", 0, input)+toolResult("toolu_big", big, false)+
		assistantBlock("m2", 0, text(big))), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), Claude, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, _ := l.Before(0, 10)
	tool := p.Items[0].Tool
	if len(tool.OutputText) != MaxText || !tool.OutputTruncated || tool.Input != nil || tool.InputSummary != "/f" {
		t.Errorf("listed: %d bytes, truncated %v, input %d bytes, summary %q", len(tool.OutputText), tool.OutputTruncated,
			len(tool.Input), tool.InputSummary)
	}
	if it := p.Items[1]; len(it.Parts[0].Text) != MaxText || !it.Truncated {
		t.Errorf("listed text: %d bytes, truncated %v", len(it.Parts[0].Text), it.Truncated)
	}
	full, ok, err := l.Item("toolu_big")
	if err != nil || !ok || full.Tool.OutputText != big || full.Tool.OutputTruncated || len(full.Tool.Input) < MaxInput {
		t.Errorf("item: ok %v err %v, %d bytes, input %d bytes", ok, err, len(full.Tool.OutputText), len(full.Tool.Input))
	}
	if _, ok, _ := l.Item("nope"); ok {
		t.Error("found an item that is not there")
	}
}

func TestCut(t *testing.T) {
	if s := cut("héllo", 2); s != "h" {
		t.Errorf("cut in a rune = %q", s)
	}
	if s := clipSummary("\n  first line\nsecond"); s != "first line" {
		t.Errorf("summary = %q", s)
	}
}

func TestParsePatch(t *testing.T) {
	ds := parsePatch("*** Begin Patch\n*** Update File: a.go\n@@ func a()\n ctx\n-old\n+new\n@@\n+more\n*** Delete File: b.go\n" +
		"*** Update File: c.go\n*** Move to: d.go\n@@\n-x\n+y\n*** End Patch\n")
	if len(ds) != 3 || ds[0].Path != "a.go" || len(ds[0].Hunks) != 2 || ds[1].Path != "b.go" || len(ds[1].Hunks) != 0 ||
		ds[2].Path != "c.go → d.go" {
		t.Fatalf("diffs = %+v", ds)
	}
	if h := ds[0].Hunks[0]; h.OldLines != 2 || h.NewLines != 2 || strings.Join(h.Lines, "|") != " ctx|-old|+new" {
		t.Errorf("hunk = %+v", h)
	}
	if parsePatch("not a patch") != nil {
		t.Error("a diff from nothing")
	}
}

func TestExecSummary(t *testing.T) {
	for _, c := range []struct{ name, code, want string }{
		{"one command", `text(await tools.exec_command({cmd:"ls"}));`, "ls"},
		{"two commands", `tools.exec_command({cmd:"ls"}); tools.exec_command({cmd:"pwd"});`, "ls (+1 more)"},
		{"stdin polls are not commands", `tools.write_stdin({session_id:1}); tools.exec_command({cmd:"ls"});`, "ls"},
		{"first line only", `tools.exec_command({cmd:"a\nb"}); tools.exec_command({cmd:"c"});`, "a (+1 more)"},
		{"no cmd", `text(await tools.write_stdin({session_id:1}));`, "fallback"},
	} {
		if got := execSummary(c.code, "fallback"); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	long := strings.Repeat("x", 300)
	got := execSummary(`tools.exec_command({cmd:"`+long+`"}); tools.exec_command({cmd:"y"});`, "")
	if n := utf8.RuneCountInString(got); n != maxSummary || !strings.HasSuffix(got, "… (+1 more)") {
		t.Errorf("long: %d runes, %q", n, got)
	}
}
