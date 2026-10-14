package transcript

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #21: the patches a code-mode exec script passes to tools.apply_patch, read
// from its text without running it: plain string literals only.
func TestPatchLiterals(t *testing.T) {
	cases := []struct {
		name    string
		code    string
		patches []string
		unread  int
	}{
		{"double quotes, the usual escapes", `text(await tools.apply_patch("*** Begin Patch\n*** Update File: a.go\n@@\n-x := \"a\\b\"\n+x := \"c\td\"\n*** End Patch"));`,
			[]string{"*** Begin Patch\n*** Update File: a.go\n@@\n-x := \"a\\b\"\n+x := \"c\td\"\n*** End Patch"}, 0},
		{"an identity escape (\\+, real) and \\u, \\u{}, \\x", `await tools.apply_patch( "+a\+bé\u{1F600}\x41\'\0" )`, []string{"+a+bé😀A'\x00"}, 0},
		{"single quotes and a line continuation", "tools.apply_patch('one\\\ntwo\\r\\n')", []string{"onetwo\r\n"}, 0},
		{"a template literal without substitutions", "tools.apply_patch(`*** Begin Patch\n+a \\` b\n*** End Patch`)", []string{"*** Begin Patch\n+a ` b\n*** End Patch"}, 0},
		{"two calls, in order", `await tools.apply_patch("first"); await tools.apply_patch("second");`, []string{"first", "second"}, 0},
		{"concatenation (real) is computed", `tools.apply_patch("*** Begin Patch\n*** Add File: x\n"+body.split("\n").map(l=>"+"+l).join("\n")+"\n*** End Patch")`, nil, 1},
		{"an identifier is computed", "const patch = \"*** Begin Patch\";\ntools.apply_patch(patch)", nil, 1},
		{"a substitution is computed", "tools.apply_patch(`+${line}`)", nil, 1},
		{"String.raw is computed", "tools.apply_patch(String.raw`+a`)", nil, 1},
		{"an object argument is computed", `tools.apply_patch({input: "+a"})`, nil, 1},
		{"a raw newline in a quoted string is not JS", "tools.apply_patch(\"a\nb\")", nil, 1},
		{"a legacy octal escape is not read", `tools.apply_patch("\101")`, nil, 1},
		{"a bad \\x is not read", `tools.apply_patch("\xZZ")`, nil, 1},
		{"an unterminated string", `tools.apply_patch("abc`, nil, 1},
		{"one literal, one computed", `tools.apply_patch("a"); tools.apply_patch(p)`, []string{"a"}, 1},
		{"a mention in a string is not a call", `log("use tools.apply_patch(\"x\") here")`, nil, 1},
		{"no call", `const r = await tools.exec_command({cmd: "ls"})`, nil, 0},
		{"a longer name is not the tool", `tools.apply_patches("a")`, nil, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, unread := patchLiterals(c.code)
			if !reflect.DeepEqual(got, c.patches) || unread != c.unread {
				t.Errorf("patchLiterals = %q, %d; want %q, %d", got, unread, c.patches, c.unread)
			}
		})
	}
}

// #21: what Codex recorded a patch did (a FileChange item's changes, a
// patch_apply_end's), as diffs: sorted by path (the record is a map), real
// line numbers from the unified diffs, created and deleted files whole.
func TestFileChangeDiffs(t *testing.T) {
	raw := `{
		"z/new.txt": {"type": "add", "content": "one\ntwo\n"},
		"a/old.txt": {"type": "delete", "content": "gone\n"},
		"m/edit.go": {"type": "update", "unified_diff": "@@ -3,2 +3,3 @@\n ctx\n-old\n+new\n+more\n@@ -10 +11 @@\n-a\n+b\n\\ No newline at end of file\n", "move_path": null},
		"m/from.go": {"type": "update", "unified_diff": "@@ -1,22 +1 @@\n-x\n", "move_path": "m/to.go"},
		"e/empty.txt": {"type": "add", "content": ""},
		"u/same.txt": {"type": "update", "unified_diff": ""}
	}`
	var changes map[string]codexChange
	if err := json.Unmarshal([]byte(raw), &changes); err != nil {
		t.Fatal(err)
	}
	got := fileChangeDiffs(changes)
	want := []proto.TranscriptDiff{
		{Path: "a/old.txt", Op: proto.DiffDelete, Hunks: []proto.TranscriptHunk{{OldStart: 1, OldLines: 1, Lines: []string{"-gone"}}}},
		{Path: "e/empty.txt", Op: proto.DiffCreate, Hunks: []proto.TranscriptHunk{}},
		{Path: "m/edit.go", Op: proto.DiffEdit, Hunks: []proto.TranscriptHunk{
			{OldStart: 3, OldLines: 2, NewStart: 3, NewLines: 3, Lines: []string{" ctx", "-old", "+new", "+more"}},
			{OldStart: 10, OldLines: 1, NewStart: 11, NewLines: 1, Lines: []string{"-a", "+b", `\ No newline at end of file`}},
		}},
		{Path: "m/from.go", Op: proto.DiffRename, To: "m/to.go", Hunks: []proto.TranscriptHunk{{OldStart: 1, OldLines: 22, NewStart: 1, NewLines: 1, Lines: []string{"-x"}}}},
		{Path: "u/same.txt", Op: proto.DiffEdit, Hunks: []proto.TranscriptHunk{}},
		{Path: "z/new.txt", Op: proto.DiffCreate, Hunks: []proto.TranscriptHunk{{NewStart: 1, NewLines: 2, Lines: []string{"+one", "+two"}}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("fileChangeDiffs:\n got %+v\nwant %+v", got, want)
	}
}

// #21: a literal patch says what happens to each file too, but has no line
// numbers (0) and no deleted lines.
func TestParsePatchOps(t *testing.T) {
	got := parsePatch("*** Begin Patch\n*** Add File: n.txt\n+hi\n*** Delete File: d.txt\n*** Update File: u.go\n*** Move to: v.go\n@@\n-a\n+b\n*** Update File: e.go\n@@ func f\n ctx\n-c\n*** End Patch")
	want := []proto.TranscriptDiff{
		{Path: "n.txt", Op: proto.DiffCreate, Hunks: []proto.TranscriptHunk{{NewLines: 1, Lines: []string{"+hi"}}}},
		{Path: "d.txt", Op: proto.DiffDelete, NoDiff: true, Hunks: []proto.TranscriptHunk{}},
		{Path: "u.go", Op: proto.DiffRename, To: "v.go", Hunks: []proto.TranscriptHunk{{OldLines: 1, NewLines: 1, Lines: []string{"-a", "+b"}}}},
		{Path: "e.go", Op: proto.DiffEdit, Hunks: []proto.TranscriptHunk{{OldLines: 2, NewLines: 1, Lines: []string{" ctx", "-c"}}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parsePatch:\n got %+v\nwant %+v", got, want)
	}
}
