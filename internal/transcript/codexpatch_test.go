package transcript

import (
	"encoding/json"
	"reflect"
	"strings"
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
		{"a mention in a string is not a call", `log("use tools.apply_patch(\"x\") here")`, nil, 0},
		// R1: only a call in the script's code counts, never text in its
		// comments or strings, or inside a computed argument.
		{"a call in a line comment", "// tools.apply_patch(\"*** Begin Patch\\n*** Add File: ghost.txt\\n+ghost\\n*** End Patch\")\nawait tools.exec_command({cmd: \"sleep 30\"})", nil, 0},
		{"a call in a block comment", "/* example:\n tools.apply_patch(\"+ghost\")\n*/ tools.apply_patch(\"+real\")", []string{"+real"}, 0},
		{"a call in single quotes", `const usage = 'tools.apply_patch("+ghost")'; tools.apply_patch("+real")`, []string{"+real"}, 0},
		{"a call in a template's text", "log(`tools.apply_patch(\"+ghost\")`); tools.apply_patch(`+real`)", []string{"+real"}, 0},
		{"a call in a computed template argument", "tools.apply_patch(`${body}\ntools.apply_patch(\"+ghost\")`); tools.apply_patch(\"+real\")", []string{"+real"}, 1},
		{"a call inside a computed argument is not read on its own", `tools.apply_patch(wrap(tools.apply_patch("+inner"))); tools.apply_patch("+real")`, []string{"+real"}, 1},
		{"a call in a substitution is code", "log(`${await tools.apply_patch(\"+real\")}`)", []string{"+real"}, 0},
		{"a call after a comment with ) and quotes", "f(1, // it's done) \"\n  2); /* ) ' ` */ tools.apply_patch(\"+real\")", []string{"+real"}, 0},
		{"a call after a string with ) and //", `log(") // '"); tools.apply_patch("+real")`, []string{"+real"}, 0},
		{"a regular expression with quotes and //", "const re = /[\"'`]\\/\\//g; tools.apply_patch(\"+real\")", []string{"+real"}, 0},
		{"a division is not a regular expression", "const h = a / 2, s = \"/\"; tools.apply_patch(\"+real\")", []string{"+real"}, 0},
		// Where the pass can't be sure, it reads no patch from the script:
		// every apply_patch it names is unread.
		{"a computed argument with no end: nothing is read", "tools.apply_patch(p + `${x`); tools.apply_patch(\"+ghost\")", nil, 2},
		{"a string with no close: nothing is read", "log('abc\ntools.apply_patch(\"+ghost\")", nil, 1},
		{"a member named tools (globalThis.tools?) is not read", `x.tools.apply_patch("+ghost")`, nil, 1},
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

// R1: a script that only mentions a patch in a comment proposes nothing,
// read whole: no diff, no computed patch.
func TestCodexPatchCommentedCall(t *testing.T) {
	code := "// tools.apply_patch(\"*** Begin Patch\\n*** Add File: ghost.txt\\n+ghost\\n*** End Patch\")\nawait tools.exec_command({cmd: \"sleep 30\"})"
	payload, err := json.Marshal(map[string]any{"type": "custom_tool_call", "call_id": "call_ghost", "status": "completed", "name": "exec", "input": code})
	if err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"2026-10-14T08:00:00.000Z","type":"response_item","payload":` + string(payload) + "}\n"
	its := itemsOf(t, Codex, line)
	if len(its) != 1 || its[0].Tool == nil {
		t.Fatalf("items: %+v", its)
	}
	if tool := its[0].Tool; tool.Diff != nil || len(tool.Diffs) != 0 || tool.Changes != nil {
		t.Errorf("a commented call proposes %+v %+v, changes %+v", tool.Diff, tool.Diffs, tool.Changes)
	}
}

// R1: call text anywhere but a real call in the script's code (a regular
// expression after any token, a comment, a string, a template, an escaped
// or longer name, a member, a label) never becomes a patch, read alone or
// as a running exec. Where the pass can't be sure, it reads no patch at
// all, even a real one: only the patches listed in real come out.
func TestPatchLiteralsNeverInvent(t *testing.T) {
	const call = `tools.apply_patch("*** Begin Patch\n*** Add File: ghost.txt\n+ghost\n*** End Patch")`
	// The same call as a regular expression's text: its * and + escaped.
	const re = `tools.apply_patch("\*\*\* Begin Patch\n\*\*\* Add File: ghost.txt\n\+ghost\n\*\*\* End Patch")`
	cases := []struct {
		name, code string
		real       []string
	}{
		// The R2 review's cases.
		{"regex after if", `if (true) /RE/.test("unused");`, nil},
		{"regex after a block", `if (true) {} /RE/.test("unused");`, nil},
		{"regex after while", `while (false) /RE/.test("unused");`, nil},
		{"regex after if in a substitution", "log(`${(()=>{if(true) /RE/.test(\"unused\");})()}`);", nil},
		{"an escaped name: xatools", `x\u{61}CALL;`, nil},
		{"a member", `x.CALL;`, nil},
		{"an optional member", `x?.CALL;`, nil},
		{"a member after a comment", `x./*member*/CALL;`, nil},
		{"regex after =", `const re = /RE/;`, nil},
		{"regex after return", `function f(){return /RE/;}`, nil},
		{"a call in a computed argument", `tools.apply_patch(wrap(CALL));`, nil},
		{"a call in a computed template argument", "tools.apply_patch(`x${CALL}`);", nil},
		{"a nested template's text", "log(`x${`CALL`}`);", nil},
		{"an unterminated comment", `/* CALL`, nil},
		{"an unterminated template", "log(`CALL", nil},
		{"an unterminated quote", `log('CALL`, nil},
		// Regular expressions after more tokens.
		{"regex after (", `log(/RE/.test("x"));`, nil},
		{"regex after ,", `f(1, /RE/);`, nil},
		{"regex after for", `for (;;) /RE/.test("x");`, nil},
		{"regex after else", `if (a) b(); else /RE/.test("x");`, nil},
		{"regex after do", `do /RE/.test("x"); while (0);`, nil},
		{"regex after break and a newline", "for (;;) { break\n/RE/.test(\"x\") }", nil},
		{"regex after await", `await /RE/.test("x");`, nil},
		{"regex after of", `for (const m of /RE/.exec(s)) {}`, nil},
		{"regex after ]", `a[0] /RE/ 1;`, nil},
		{"/ after ++", "a++\n/RE/ 1;", nil},
		{"/ after an object", `x = {} /RE/ 1;`, nil},
		{"a v-flag class in a class", `x = /[[a]/; CALL; /]/v;`, nil},
		{"a line separator in a regex", "x = /a\u2028CALL/;", nil},
		// Comments.
		{"a line comment", "// CALL\nlog(1)", nil},
		{"a block comment", `/* CALL */ log(1)`, nil},
		{"an HTML-like open comment", "<!-- CALL\nlog(1)", nil},
		{"an HTML-like close comment", "--> CALL\nlog(1)", nil},
		{"a line separator ends a comment", "// note\u2028CALL", nil},
		// Strings and templates.
		{"double quotes", `log("tools.apply_patch(\"+ghost\")")`, nil},
		{"single quotes", `log('CALL')`, nil},
		{"a template", "log(`CALL`)", nil},
		{"a template in a substitution", "log(`${`${\"x\"}CALL`}`)", nil},
		// Names.
		{"an escaped name: tools", `\u0074ools.apply_patch("+ghost")`, nil},
		{"an escaped apply_patch", `tools.apply\u005Fpatch("+ghost")`, nil},
		{"a private name", `class A { #tools = {}; m() { this.#CALL } }`, nil},
		{"a longer name", `_CALL; $CALL; myCALL`, nil},
		{"a non-ASCII name", `ñCALL`, nil},
		{"a non-ASCII name after", `toolsñ.apply_patch("+ghost")`, nil},
		{"a label named apply_patch", "apply_patch: for (;;) break apply_patch; CALL", nil},
		{"an alias", `const f = tools.apply_patch; f("+ghost")`, nil},
		{"an optional call", `tools.apply_patch?.("+ghost")`, nil},
		{"a construction", `new CALL`, nil},
		{"a computed name", `tools["apply_patch"]("+ghost")`, nil},
		{"spaced", `tools .apply_patch("+ghost")`, nil},
		// Real calls still read.
		{"a label named tools", `tools: tools.apply_patch("+real")`, []string{"+real"}},
		{"after a regex and a division", `const re = /["'` + "`" + `]\/\//g, h = n / 2; tools.apply_patch("+real")`, []string{"+real"}},
		{"after typeof, a division by a call", `x = typeof y; z = f(1) + n / 2; tools.apply_patch("+real") / 1`, []string{"+real"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code := strings.ReplaceAll(strings.ReplaceAll(c.code, "RE", re), "CALL", call)
			if got, _ := patchLiterals(code); !reflect.DeepEqual(got, c.real) {
				t.Errorf("patchLiterals(%s) = %q, want %q", code, got, c.real)
			}
			if c.real != nil {
				return
			}
			payload, err := json.Marshal(map[string]any{"type": "custom_tool_call", "call_id": "call_ghost", "name": "exec", "input": code})
			if err != nil {
				t.Fatal(err)
			}
			line := `{"timestamp":"2026-10-14T08:00:00.000Z","type":"response_item","payload":` + string(payload) + "}\n"
			for _, it := range itemsOf(t, Codex, line) {
				if it.Tool != nil && (it.Tool.Diff != nil || len(it.Tool.Diffs) != 0) {
					t.Errorf("a running exec proposes %+v %+v", it.Tool.Diff, it.Tool.Diffs)
				}
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
