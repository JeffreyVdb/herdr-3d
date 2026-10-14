package transcript

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #21: Codex's code changes. The patch_*.jsonl fixtures are real rollout
// line shapes (codex-cli 0.145.0-0.162.1, catalogued from local rollouts)
// with neutral paths, contents and ids; patch_declined, patch_interrupted
// and patch_running are synthetic (in Codex's source, never seen locally).

func patchRow(id, status string) want {
	return want{kind: proto.ItemTool, id: id, tool: "apply_patch", status: status}
}

func execRow(id, status string) want {
	return want{kind: proto.ItemTool, id: id, tool: "exec", status: status}
}

var cmdItem = want{kind: proto.ItemNotice, hidden: true, source: "event_msg/item_completed"} // CommandExecution

func TestCodexPatchRows(t *testing.T) {
	type c struct {
		name, file string
		want       []want
		diffs      map[int][]diffOf // by item index; absent: none
		changes    map[int]*proto.TranscriptChanges
	}
	edit := func(path string, starts [2]int, lines ...string) diffOf {
		return diffOf{path: path, op: proto.DiffEdit, starts: starts, lines: lines}
	}
	create := func(path string, lines ...string) diffOf {
		return diffOf{path: path, op: proto.DiffCreate, starts: [2]int{0, 1}, lines: lines}
	}
	cases := []c{
		{"exec, one file: the script's row, then Codex's record as its own row", "patch_exec.jsonl",
			[]want{execRow("call_c21exec0single00000000001", proto.ToolOK), patchRow("exec-0c210001-0000-4000-8000-000000000001", proto.ToolOK)},
			map[int][]diffOf{1: {edit("src/tide.ts", [2]int{3, 3}, ` export const HARBOUR = "North Quay";`, "-export const HIGH = 4.1;", "+export const HIGH = 4.3;", "+export const LOW = 0.6;", " ")}}, nil},
		{"exec, several files and commands: created, edited, deleted, by path", "patch_exec_multi.jsonl",
			[]want{execRow("call_c21exec0multi000000000002", proto.ToolOK), cmdItem, patchRow("exec-0c210002-0000-4000-8000-000000000002", proto.ToolOK), cmdItem},
			map[int][]diffOf{2: {
				edit("package.json", [2]int{2, 2}, `   "private": true,`, `+  "workspaces": ["tides"],`, `   "description": "Harbour tools"`),
				{path: "tides.old.md", op: proto.DiffDelete, starts: [2]int{1, 0}, lines: []string{"-# Old tides", "-", "-See tides/."}},
				create("tides/.gitignore", "+cache/"),
				create("tides/README.md", "+# Tides", "+", "+Tables for the harbour."),
			}}, nil},
		{"exec, two patch calls: a row each, in order", "patch_exec_calls.jsonl",
			[]want{execRow("call_c21exec0calls000000000003", proto.ToolOK), patchRow("exec-0c210003-0000-4000-8000-000000000001", proto.ToolOK), cmdItem,
				patchRow("exec-0c210003-0000-4000-8000-000000000003", proto.ToolOK)},
			map[int][]diffOf{
				1: {create("roles/buoy/tasks/main.yaml", "+---", "+- name: Light the buoy", "+  ansible.builtin.include_tasks: light.yaml")},
				3: {create("roles/buoy/tasks/retire.yaml", "+---", "+- name: Retire the buoy", "+  ansible.builtin.debug:", "+    msg: retired")},
			}, nil},
		{"exec, a computed patch: nothing read from the script, the record is the change", "patch_exec_concat.jsonl",
			[]want{execRow("call_c21exec0concat00000000004", proto.ToolOK), patchRow("exec-0c210004-0000-4000-8000-000000000001", proto.ToolOK)},
			map[int][]diffOf{1: {create("docs/soundings.md", "+## Soundings", "+", "+Depths at low water, in metres.")}}, nil},
		{"exec, a patch that failed verification: an error, no change", "patch_exec_failed.jsonl",
			[]want{{kind: proto.ItemTool, id: "call_c21exec0failed00000000005", tool: "exec", status: proto.ToolError, text: "apply_patch verification failed: invalid hunk at line 9"}}, nil, nil},
		{"exec, escapes JSON does not read (\\+, \\u)", "patch_exec_escape.jsonl",
			[]want{execRow("call_c21exec0escape00000000006", proto.ToolOK), patchRow("exec-0c210006-0000-4000-8000-000000000001", proto.ToolOK)},
			map[int][]diffOf{1: {create("docs/notes.md", "+# Notes", "+", "+The pilot’s depth of", "+four metres and the `draft`+of 2 stayed the same.", "+Tabs:\there.")}}, nil},
		{"direct apply_patch: the record replaces the literal, with line numbers", "patch_direct.jsonl",
			[]want{{kind: proto.ItemTool, id: "call_c21direct0000000000000007", tool: "apply_patch", status: proto.ToolOK, text: "Exit code: 0\nWall time: 0 seconds"}},
			map[int][]diffOf{0: {
				edit("src/clock.ts", [2]int{7, 7}, "-export const TICK = 1000;", "+export const TICK = 500;"),
				create("tests/clock.test.ts", `+import { TICK } from "../src/clock";`, `+test("tick", () => expect(TICK).toBe(500));`),
			}}, nil},
		{"direct apply_patch that failed verification: an error, no change", "patch_direct_failed.jsonl",
			[]want{{kind: proto.ItemTool, id: "call_c21directfail00000000008", tool: "apply_patch", status: proto.ToolError, text: "apply_patch verification failed: Failed to find expected lines"}}, nil, nil},
		{"patch_apply_end (0.145): a direct call's and an exec's", "patch_legacy.jsonl",
			[]want{{kind: proto.ItemTool, id: "call_c21legacydirect0000000009", tool: "apply_patch", status: proto.ToolOK, text: "Exit code: 0"},
				execRow("call_c21legacyexec00000000009", proto.ToolOK), patchRow("exec-0c210009-0000-4000-8000-000000000001", proto.ToolOK)},
			map[int][]diffOf{
				0: {edit("SKILL.md", [2]int{2, 2}, " name: orchestrate", "-description: Run one worker.", "+description: Run workers in parallel.", " ---"), create("config.example.toml", "+parallel = 2", "+worktree = true")},
				2: {create("tests/smoke.sh", "+#!/usr/bin/env bash", "+set -euo pipefail")},
			}, nil},
		{"a nested patch failed while the script completed: the script's success says nothing of it", "patch_nested_failed.jsonl",
			[]want{execRow("call_c21exec0nestfail000000010", proto.ToolOK), cmdItem,
				{kind: proto.ItemTool, id: "exec-0c210010-0000-4000-8000-000000000002", tool: "apply_patch", status: proto.ToolError, text: "Failed to create parent directories"}},
			map[int][]diffOf{2: {{path: "/home/tmp/tide-a1b2", op: proto.DiffCreate, starts: [2]int{0, 1}, lines: []string{"+high water 06:40"}}}}, nil},
		{"renamed files: the new path, and an edit's lines", "patch_rename.jsonl",
			[]want{execRow("call_c21exec0rename00000000011", proto.ToolOK), patchRow("exec-0c210011-0000-4000-8000-000000000001", proto.ToolOK)},
			map[int][]diffOf{1: {
				{path: "infra/buoy_cost.tf", op: proto.DiffRename, lines: []string{}},
				{path: "infra/buoy_iam.tf", op: proto.DiffRename, starts: [2]int{85, 85}, lines: []string{"   statement {", `-    resources = ["*"]`, "+    resources = local.buoy_queue_arns", "   }"}},
			}}, nil},
		{"declined (synthetic): denied, what it would have done", "patch_declined.jsonl",
			[]want{execRow("call_c21exec0declined000000012", proto.ToolError),
				{kind: proto.ItemTool, id: "exec-0c210012-0000-4000-8000-000000000001", tool: "apply_patch", status: proto.ToolDenied, text: "patch rejected by user"}},
			map[int][]diffOf{1: {{path: "tides/cache/index.json", op: proto.DiffDelete, starts: [2]int{1, 0}, lines: []string{`-{"tides": []}`}}}}, nil},
		{"interrupted after its first patch (synthetic): the script interrupted, its proposals gone, the done patch stays", "patch_interrupted.jsonl",
			[]want{execRow("call_c21exec0interrupt0000013", proto.ToolInterrupted), patchRow("exec-0c210013-0000-4000-8000-000000000001", proto.ToolOK),
				{kind: proto.ItemNotice, source: "event_msg/turn_aborted", text: "Turn interrupted"}},
			map[int][]diffOf{1: {edit("src/tide.ts", [2]int{5, 5}, "-export const LOW = 0.6;", "+export const LOW = 0.5;")}}, nil},
		{"still running (synthetic): its literal patch proposed, without line numbers; its computed one counted", "patch_running.jsonl",
			[]want{execRow("call_c21exec0running00000014", proto.ToolRunning)},
			map[int][]diffOf{0: {edit("src/tide.ts", [2]int{0, 0}, "-export const HIGH = 4.3;", "+export const HIGH = 4.4;")}},
			map[int]*proto.TranscriptChanges{0: {Computed: 1}}},
	}
	for _, k := range cases {
		t.Run(k.name, func(t *testing.T) {
			got := items(t, Codex, k.file)
			check(t, k.file, got, k.want)
			for i, it := range got {
				if ds := diffsOf(it); !reflect.DeepEqual(ds, k.diffs[i]) {
					t.Errorf("item %d (%s): diffs\n %+v\nwant %+v", i, it.ID, ds, k.diffs[i])
				}
				var ch *proto.TranscriptChanges
				if it.Tool != nil {
					ch = it.Tool.Changes
				}
				if !reflect.DeepEqual(ch, k.changes[i]) {
					t.Errorf("item %d (%s): changes %+v, want %+v", i, it.ID, ch, k.changes[i])
				}
			}
		})
	}
	// A rename's new path.
	rn := items(t, Codex, "patch_rename.jsonl")[1].Tool.Diffs
	if rn[0].To != proj+"infra/buoy-cost.tf" || rn[1].To != proj+"infra/buoy-iam.tf" {
		t.Errorf("renamed to: %q %q", rn[0].To, rn[1].To)
	}
	// A nested row: named and summarised by its files, the record's output.
	nested := items(t, Codex, "patch_exec_calls.jsonl")[1].Tool
	if nested.InputSummary != proj+"roles/buoy/tasks/main.yaml" || nested.Input != nil || !strings.HasPrefix(nested.OutputText, "Success. Updated the following files:\nA ") {
		t.Errorf("nested row: %+v", nested)
	}
	// A script with no command is summarised by the files its patches name.
	if s := items(t, Codex, "patch_exec.jsonl")[0].Tool.InputSummary; s != proj+"src/tide.ts" {
		t.Errorf("exec summary: %q", s)
	}
	if s := items(t, Codex, "patch_exec_multi.jsonl")[0].Tool.InputSummary; s != "git init -b main (+1 more)" {
		t.Errorf("exec summary with commands: %q", s)
	}
}

// patchLines are a Codex fixture's lines, each with its newline.
func patchLines(t *testing.T, name string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", Codex, name))
	if err != nil {
		t.Fatal(err)
	}
	ls := strings.SplitAfter(string(b), "\n")
	return ls[:len(ls)-1]
}

// What a script proposes is what Codex did, when its literal is read right
// (the real \+ and \u escapes): the running script's diff is the record's
// lines, with no numbers.
func TestCodexPatchLiteralMatchesRecord(t *testing.T) {
	ls := patchLines(t, "patch_exec_escape.jsonl")
	running := itemsOf(t, Codex, ls[0])[0]
	done := items(t, Codex, "patch_exec_escape.jsonl")[1]
	proposed, applied := diffsOf(running), diffsOf(done)
	if running.Tool.Status != proto.ToolRunning || len(proposed) != 1 || !reflect.DeepEqual(proposed[0].lines, applied[0].lines) {
		t.Fatalf("proposed %+v, applied %+v", proposed, applied)
	}
	if proposed[0].starts != [2]int{0, 0} || applied[0].starts != [2]int{0, 1} {
		t.Errorf("starts: proposed %v, applied %v", proposed[0].starts, applied[0].starts)
	}
}

// Live: a script's proposed patch, then the record (its own row; the
// script's proposal goes, pushed as an update), then the output; paging and
// transcript.item give the same rows, each once.
func TestCodexPatchLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	ls := patchLines(t, "patch_exec_multi.jsonl")
	writeLines(t, path, ls[0])
	tail := jsonl.NewTail(path)
	if err := tail.Next(func(int64, []byte) {}); err != nil {
		t.Fatal(err)
	}
	l, err := follow(Codex, path, tail.File(), tail.Delivered(), func(r io.ReaderAt) io.ReaderAt { return r })
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ready(t, l)
	s, p, err := l.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	exec := p.Items[0]
	if exec.Tool.Status != proto.ToolRunning || len(exec.Tool.Diffs) != 4 || exec.Tool.Diffs[0].Path != proj+"tides/README.md" {
		t.Fatalf("running script: %+v", exec.Tool)
	}
	next := func(line string) (news, ups []proto.TranscriptItem) {
		t.Helper()
		writeLines(t, path, line)
		if err := tail.Next(l.Line); err != nil {
			t.Fatal(err)
		}
		<-s.Wake()
		news, ups, err := s.Take()
		if err != nil {
			t.Fatal(err)
		}
		return news, ups
	}
	if news, ups := next(ls[1]); len(news) != 1 || !news[0].Hidden || len(ups) != 0 { // a command
		t.Fatalf("command: %+v %+v", news, ups)
	}
	news, ups := next(ls[2]) // the record
	if len(news) != 1 || news[0].ID != "exec-0c210002-0000-4000-8000-000000000002" || news[0].Seq != 3 || len(news[0].Tool.Diffs) != 4 {
		t.Fatalf("record: %+v", news)
	}
	if len(ups) != 1 || ups[0].ID != exec.ID || ups[0].Tool.Status != proto.ToolRunning || ups[0].Tool.Diff != nil {
		t.Fatalf("the script's proposal is gone: %+v", ups)
	}
	next(ls[3])
	news, ups = next(ls[4]) // the output
	if len(news) != 0 || len(ups) != 1 || ups[0].Tool.Status != proto.ToolOK || ups[0].Tool.Diff != nil {
		t.Fatalf("output: %+v %+v", news, ups)
	}
	var ids []string
	for seq := int64(0); ; {
		p, err := l.Before(seq, 1)
		if err != nil {
			t.Fatal(err)
		}
		for i := len(p.Items) - 1; i >= 0; i-- {
			ids = append([]string{p.Items[i].ID}, ids...)
		}
		if !p.HasMore {
			break
		}
		seq, _ = ParseCursor(p.Cursor)
	}
	if len(ids) != 4 || ids[0] != exec.ID || ids[2] != "exec-0c210002-0000-4000-8000-000000000002" {
		t.Fatalf("paged ids: %v", ids)
	}
	it, ok, err := l.Item(exec.ID)
	if err != nil || !ok || it.Tool.Diff != nil || it.Tool.Status != proto.ToolOK {
		t.Fatalf("item: %+v %v %v", it.Tool, ok, err)
	}
}

// A large record is cut for lists like any diff (#171), whole in
// transcript.item; its line numbers are the record's.
func TestCodexPatchLarge(t *testing.T) {
	var b strings.Builder
	b.WriteString("@@ -1,3000 +1,3000 @@\\n")
	for i := range 3000 {
		fmt.Fprintf(&b, "-old line %04d\\n+new line %04d\\n", i, i)
	}
	content := `{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_big","name":"exec","input":"run()"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"exec-big","changes":{"big.txt":{"type":"update","unified_diff":"` + b.String() + `","move_path":null}},"status":"completed","stdout":"","stderr":""}}}` + "\n"
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(t.Context(), Codex, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, err := l.Before(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	cut := p.Items[1].Tool.Diff
	if !cut.Truncated || len(cut.Hunks[0].Lines) >= 6000 || cut.Hunks[0].OldStart != 1 || cut.Hunks[0].OldLines != 3000 {
		t.Fatalf("list: truncated %v, %d lines, %+v", cut.Truncated, len(cut.Hunks[0].Lines), cut.Hunks[0].OldLines)
	}
	full, ok, err := l.Item("exec-big")
	if err != nil || !ok || full.Tool.Diff.Truncated || len(full.Tool.Diff.Hunks[0].Lines) != 6000 {
		t.Fatalf("item: %v %v", ok, err)
	}
}
