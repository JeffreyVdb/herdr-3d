package transcript

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #171: what Claude Code's Edit, Write and Bash results say a call changed.
// The fixtures are real line shapes (catalogued from local transcripts) with
// neutral paths and content; bash_diff_skipped.jsonl and
// write_update_nodiff.jsonl are synthetic: documented, never seen locally.

const proj = "/home/dev/project/"

// diffOf is a test's view of a diff: path, op, no_diff and its lines.
type diffOf struct {
	path, op string
	noDiff   bool
	lines    []string
	starts   [2]int // the first hunk's old and new start
}

func diffsOf(it proto.TranscriptItem) []diffOf {
	t := it.Tool
	if t == nil {
		return nil
	}
	ds := t.Diffs
	if len(ds) == 0 && t.Diff != nil {
		ds = []proto.TranscriptDiff{*t.Diff}
	}
	var out []diffOf
	for _, d := range ds {
		o := diffOf{path: strings.TrimPrefix(d.Path, proj), op: d.Op, noDiff: d.NoDiff, lines: []string{}}
		for i, h := range d.Hunks {
			if i == 0 {
				o.starts = [2]int{h.OldStart, h.NewStart}
			}
			o.lines = append(o.lines, h.Lines...)
		}
		out = append(out, o)
	}
	return out
}

func TestClaudeEditWriteOps(t *testing.T) {
	edit := items(t, Claude, "edit.jsonl")
	if ds := diffsOf(edit[0]); len(ds) != 1 || ds[0].op != proto.DiffEdit || ds[0].starts != [2]int{369, 369} || ds[0].noDiff {
		t.Errorf("edit: %+v", ds)
	}
	write := items(t, Claude, "write.jsonl")
	if ds := diffsOf(write[0]); len(ds) != 1 || ds[0].op != proto.DiffCreate || !strings.HasPrefix(ds[0].lines[0], "+/implement") || ds[0].starts != [2]int{0, 1} {
		t.Errorf("write create: %+v", ds)
	}

	// An overwrite with hunks is an overwrite, also when originalFile is null (17 real ones are).
	upd := items(t, Claude, "write_update.jsonl")
	if len(upd) != 2 {
		t.Fatalf("write update: %d items", len(upd))
	}
	want := []diffOf{
		{path: "docs/notes.md", op: proto.DiffOverwrite, starts: [2]int{1, 1}, lines: []string{"# Notes", " ", "-Ship the tide table on Thursday.", "+Ship the tide table on Friday.", " Check the harbour lights."}},
		{path: "config/app.toml", op: proto.DiffOverwrite, starts: [2]int{1, 1}, lines: []string{"-port = 80", "-host = \"0.0.0.0\"", "-debug = true", "+port = 8080", "+host = \"127.0.0.1\""}},
	}
	for i, it := range upd {
		if got := diffsOf(it); !reflect.DeepEqual(got, want[i:i+1]) {
			t.Errorf("write update %d: %+v, want %+v", i, got, want[i])
		}
	}

	// An overwrite without hunks (no change, too large, timed out) is no_diff: not a new file, no lines made up.
	nod := items(t, Claude, "write_update_nodiff.jsonl")
	if ds := diffsOf(nod[0]); len(ds) != 1 || ds[0].op != proto.DiffOverwrite || !ds[0].noDiff || len(ds[0].lines) != 0 {
		t.Errorf("write update, no hunks: %+v", ds)
	}
	b, _ := json.Marshal(nod[0].Tool.Diff)
	if !strings.Contains(string(b), `"hunks":[]`) || !strings.Contains(string(b), `"op":"overwrite"`) || !strings.Contains(string(b), `"no_diff":true`) {
		t.Errorf("wire: %s", b)
	}
}

func TestClaudeBashChanges(t *testing.T) {
	type c struct {
		name   string
		file   string
		diffs  [][]diffOf
		change []*proto.TranscriptChanges
	}
	more := []string{proj + "src/c.ts", proj + "src/d.ts", proj + "src/e.ts"}
	cases := []c{
		{"one file", "bash_diff.jsonl", [][]diffOf{{{path: "src/fetch.py", op: proto.DiffEdit, starts: [2]int{12, 12},
			lines: []string{"     session = Session()", "     timeout = 10", "-    retries = 3", "+    retries = 5", "     backoff = 0.5", "     return session"}}}},
			[]*proto.TranscriptChanges{nil}},
		{"several files: edited, created, deleted, an empty new one", "bash_diff_multi.jsonl", [][]diffOf{{
			{path: "src/helpers.py", op: proto.DiffEdit, starts: [2]int{1, 1}, lines: []string{"-def slug(s):", "-    return s.lower().replace(' ', '-')", "-", "-def clamp(x, lo, hi):", "-    return max(lo, min(hi, x))", " ", "+from .text import slug"}},
			{path: "src/text.py", op: proto.DiffCreate, starts: [2]int{0, 1}, lines: []string{"+def slug(s):", "+    return s.lower().replace(' ', '-')"}},
			{path: "src/legacy_math.py", op: proto.DiffDelete, starts: [2]int{1, 0}, lines: []string{"-def clamp(x, lo, hi):", "-    return max(lo, min(hi, x))"}},
			{path: "src/__init__.py", op: proto.DiffCreate, lines: []string{}},
		}}, []*proto.TranscriptChanges{nil}},
		{"more files than diffs, and changed paths only", "bash_diff_more.jsonl", [][]diffOf{{
			{path: "src/a.ts", op: proto.DiffEdit, starts: [2]int{3, 3}, lines: []string{"-const a = {x:1}", "+const a = { x: 1 };"}},
			{path: "src/b.ts", op: proto.DiffEdit, starts: [2]int{7, 7}, lines: []string{"-export default b", "+export default b;"}},
		}, nil}, []*proto.TranscriptChanges{{Paths: more, MoreFiles: 3}, {Paths: []string{proj + "gen/api.pb.go", proj + "gen/api_grpc.pb.go"}, MoreFiles: 2}}},
		{"unavailable: with a diff, and with none", "bash_diff_unavailable.jsonl", [][]diffOf{{
			{path: "VERSION", op: proto.DiffEdit, starts: [2]int{1, 1}, lines: []string{"-1.3.2", "+1.4.0"}},
		}, nil}, []*proto.TranscriptChanges{{Paths: []string{proj + "CHANGELOG.md"}, MoreFiles: 1, Unavailable: true}, {Unavailable: true, Shared: true}}},
		{"shared: with a diff, and alone", "bash_diff_shared.jsonl", [][]diffOf{{
			{path: ".env.example", op: proto.DiffEdit, starts: [2]int{2, 2}, lines: []string{" PORT=8080", "+LOG_LEVEL=debug"}},
		}, nil}, []*proto.TranscriptChanges{{Shared: true}, {Shared: true}}},
		{"skipped (synthetic: documented, never seen)", "bash_diff_skipped.jsonl", [][]diffOf{nil}, []*proto.TranscriptChanges{{Skipped: true}}},
	}
	for _, k := range cases {
		got := items(t, Claude, k.file)
		if len(got) != len(k.diffs) {
			t.Fatalf("%s: %d items", k.name, len(got))
		}
		for i, it := range got {
			if it.Tool == nil || it.Tool.Name != "Bash" || it.Tool.Status != proto.ToolOK {
				t.Fatalf("%s %d: %+v", k.name, i, it.Tool)
			}
			if ds := diffsOf(it); !reflect.DeepEqual(ds, k.diffs[i]) {
				t.Errorf("%s %d: diffs %+v, want %+v", k.name, i, ds, k.diffs[i])
			}
			if !reflect.DeepEqual(it.Tool.Changes, k.change[i]) {
				t.Errorf("%s %d: changes %+v, want %+v", k.name, i, it.Tool.Changes, k.change[i])
			}
		}
	}
	// Several files: diff is the first, diffs all of them.
	multi := items(t, Claude, "bash_diff_multi.jsonl")[0].Tool
	if multi.Diff == nil || multi.Diff.Path != proj+"src/helpers.py" || len(multi.Diffs) != 4 {
		t.Errorf("multi: %+v", multi)
	}
	// A Bash with no record (an older Claude Code, recording off): nothing at all, not "no changes".
	plain := items(t, Claude, "bash.jsonl")[0].Tool
	if plain.Diff != nil || plain.Diffs != nil || plain.Changes != nil {
		t.Errorf("bash without bashEditDiff: %+v", plain)
	}
	b, _ := json.Marshal(plain)
	if strings.Contains(string(b), "changes") {
		t.Errorf("wire: %s", b)
	}
}

func TestClaudeChangeFailures(t *testing.T) {
	got := items(t, Claude, "change_failed.jsonl")
	check(t, "failures", got, []want{
		{kind: proto.ItemTool, tool: "Edit", status: proto.ToolError, text: "String to replace not found"},
		{kind: proto.ItemTool, tool: "Bash", status: proto.ToolError, text: "Exit code 2"},
		{kind: proto.ItemTool, tool: "Write", status: proto.ToolDenied, text: "The user doesn't want to proceed"},
		{kind: proto.ItemNotice, source: "user/interrupted"},
		{kind: proto.ItemTool, tool: "Edit", status: proto.ToolInterrupted},
		{kind: proto.ItemNotice, source: "user/interrupted"},
	})
	// None of them shows a change: a failed, refused or stopped edit is not a diff (and nothing is made up from the input).
	for _, it := range got {
		if t2 := it.Tool; t2 != nil && (t2.Diff != nil || t2.Diffs != nil || t2.Changes != nil) {
			t.Errorf("%s: %+v", it.ID, t2)
		}
	}
}

// The list cap keeps what a diff says of its file.
func TestCapDiffKeepsOp(t *testing.T) {
	budget := 10
	d := capDiff(proto.TranscriptDiff{Path: "a", Op: proto.DiffOverwrite, NoDiff: true, Hunks: []proto.TranscriptHunk{{Lines: []string{"+0123456789", "+x"}}}}, &budget)
	if d.Op != proto.DiffOverwrite || !d.NoDiff || !d.Truncated || len(d.Hunks) != 1 || len(d.Hunks[0].Lines) != 0 {
		t.Errorf("%+v", d)
	}
}
