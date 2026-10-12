package harness

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var translateCmds = []proto.CommandEntry{
	{Name: "review", Kind: proto.CommandKindBuiltin},
	{Name: "compact", Kind: proto.CommandKindBuiltin},
	{Name: "zzprobe", Kind: proto.CommandKindSkill},
	{Name: "zzprobe-two", Kind: proto.CommandKindSkill},
	{Name: "caveman:caveman-commit", Kind: proto.CommandKindSkill},
	{Name: "grill", Kind: proto.CommandKindSkill},
	{Name: "écrire", Kind: proto.CommandKindSkill},
	{Name: "legacy", Kind: proto.CommandKindCustom},
	{Name: "dual", Kind: proto.CommandKindSkill},
	{Name: "dual", Kind: proto.CommandKindBuiltin},
}

func TestTranslate(t *testing.T) {
	files := map[string]bool{
		"README.md": true, "src/main.go": true, "internal/": true, "internal": true,
		"my docs/a b.txt": true, "ünï/файл.txt": true, "a.txt": true,
	}
	resolve := func(p string) bool { return files[p] }
	tests := []struct {
		name, kind, in, want string
	}{
		// the ticket's table
		{"skill codex", "codex", "/grill args here", "$grill args here"},
		{"skill claude", "claude", "/grill args here", "/grill args here"},
		{"skill mid-text", "codex", "please run /grill now", "please run $grill now"},
		{"builtin codex", "codex", "/compact", "/compact"},
		{"builtin that is also a skill name", "codex", "/dual x", "/dual x"},
		{"file codex", "codex", "read @README.md please", "read README.md please"},
		{"file claude", "claude", "read @README.md please", "read @README.md please"},
		{"unknown harness", "other", "/grill @README.md", "/grill @README.md"},
		// slash look-alikes
		{"usr bin", "codex", "run /usr/bin/env", "run /usr/bin/env"},
		{"url", "codex", "see http://x/y and https://grill/grill", "see http://x/y and https://grill/grill"},
		{"a/b", "codex", "a/grill and grill/b", "a/grill and grill/b"},
		{"unknown skill", "codex", "/foo bar", "/foo bar"},
		{"custom command is not a skill", "codex", "/legacy", "/legacy"},
		{"skill as path", "codex", "/grill/more", "/grill/more"},
		{"double slash", "codex", "//grill", "//grill"},
		{"prefix skill", "codex", "/zzprobe and /zzprobe-two", "$zzprobe and $zzprobe-two"},
		{"prefix skill, longer unknown", "codex", "/zzprobe-three", "/zzprobe-three"},
		{"prefix of a known longer", "codex", "/zzprobe-", "$zzprobe-"},
		{"trailing dot", "codex", "use /grill.", "use $grill."},
		{"trailing comma and paren", "codex", "(/grill), then /grill!", "($grill), then $grill!"},
		{"trailing colon", "codex", "do /grill: now", "do $grill: now"},
		{"quoted", "codex", `say "/grill"`, `say "$grill"`},
		{"namespaced", "codex", "/caveman:caveman-commit now", "$caveman:caveman-commit now"},
		{"namespace prefix only", "codex", "/caveman:", "/caveman:"},
		{"unicode skill", "codex", "/écrire ça", "$écrire ça"},
		{"unicode before", "codex", "é/grill", "é/grill"},
		{"after newline", "codex", "a\n/grill b\n\t/grill", "a\n$grill b\n\t$grill"},
		{"repeated", "codex", "/grill /grill /grill", "$grill $grill $grill"},
		{"already dollar", "codex", "$grill and /grill", "$grill and $grill"},
		{"only dollar", "codex", "$grill", "$grill"},
		{"lone slash", "codex", "/ and /", "/ and /"},
		{"backtick is not a word start", "codex", "`/grill`", "`/grill`"},
		// @ look-alikes and paths
		{"mention", "codex", "ask @user about it", "ask @user about it"},
		{"email", "codex", "mail me@README.md or a@b.com", "mail me@README.md or a@b.com"},
		{"file with dot", "codex", "see @README.md.", "see README.md."},
		{"file in brackets", "codex", "(@src/main.go), ok", "(src/main.go), ok"},
		{"dir", "codex", "list @internal/ now", "list internal/ now"},
		{"dir no slash", "codex", "list @internal", "list internal"},
		{"missing file", "codex", "see @nope.go", "see @nope.go"},
		{"repeated file", "codex", "@a.txt @a.txt", "a.txt a.txt"},
		{"quoted path with spaces", "codex", `read @"my docs/a b.txt" now`, "read my docs/a b.txt now"},
		{"quoted path, claude keeps it", "claude", `read @"my docs/a b.txt" now`, `read @"my docs/a b.txt" now`},
		{"unquoted path with spaces is cut at the space", "codex", "read @my docs/a b.txt", "read @my docs/a b.txt"},
		{"quoted missing", "codex", `read @"no such" now`, `read @"no such" now`},
		{"quote never closed", "codex", `read @"my docs/a b.txt`, `read @"my docs/a b.txt`},
		{"quote closes on next line", "codex", "read @\"my docs\n/a b.txt\"", "read @\"my docs\n/a b.txt\""},
		{"unicode path", "codex", "see @ünï/файл.txt!", "see ünï/файл.txt!"},
		{"escape with ..", "codex", "see @../secret", "see @../secret"},
		{"escape with ..", "codex", "see @src/../../etc/passwd", "see @src/../../etc/passwd"},
		{"mixed", "codex", "/grill @src/main.go and /compact @x", "$grill src/main.go and /compact @x"},
		{"at at", "codex", "@@README.md", "@@README.md"},
		// image markers (#64) are the game's
		{"image marker", "codex", "see [Image #1: /home/u/drops/grill @README.md.png] and /grill",
			"see [Image #1: /home/u/drops/grill @README.md.png] and $grill"},
		{"image marker with spaces", "codex", "[Image #12: /d/a /grill b.png] @README.md", "[Image #12: /d/a /grill b.png] README.md"},
		{"not a marker", "codex", "[Image: /grill] [Image #x: /grill]", "[Image: $grill] [Image #x: $grill]"},
		{"unclosed marker", "codex", "[Image #1: /grill", "[Image #1: $grill"},
		// edges
		{"empty", "codex", "", ""},
		{"no tokens", "codex", "just words", "just words"},
		{"lone at", "codex", "@", "@"},
		{"at start", "codex", "@README.md", "README.md"},
		{"multibyte tail", "codex", "/grill é", "$grill é"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Translate(tc.kind, tc.in, translateCmds, resolve); got != tc.want {
				t.Errorf("Translate(%q, %q) = %q, want %q", tc.kind, tc.in, got, tc.want)
			}
		})
	}
}

func TestTranslateNeverGrows(t *testing.T) {
	resolve := func(string) bool { return true }
	for _, in := range []string{"/grill @a /grill", "@\"a b\" @c", "x /zzprobe-two @y."} {
		if got := Translate("codex", in, translateCmds, resolve); len(got) > len(in) {
			t.Errorf("Translate(%q) = %q is longer", in, got)
		}
	}
}

func TestTranslateNilResolveAndNoSkills(t *testing.T) {
	if got := Translate("codex", "/grill @a", translateCmds, nil); got != "$grill @a" {
		t.Errorf("nil resolveFile: %q", got)
	}
	if got := Translate("codex", "/grill @a", nil, func(string) bool { return true }); got != "/grill a" {
		t.Errorf("no skills: %q", got)
	}
}

func TestRewrites(t *testing.T) {
	if !Rewrites("codex") || Rewrites("claude") || Rewrites("") {
		t.Error("Rewrites: only codex has rules")
	}
}

func TestInCheckout(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "src", "my dir"), 0o755))
	must(os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(root, "src", "my dir", "b c.txt"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o644))
	must(os.Symlink(outside, filepath.Join(root, "out")))
	must(os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "secret-link")))
	must(os.Symlink("src/a.go", filepath.Join(root, "inner-link")))
	must(os.Symlink("src", filepath.Join(root, "inner-dir-link")))
	in := InCheckout(root)
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"src/a.go", true}, {"src", true}, {"src/", true}, {"./src/a.go", true},
		{"src/my dir/b c.txt", true},
		{filepath.Join(root, "src/a.go"), true}, // absolute, inside
		{"inner-link", true}, {"inner-dir-link/a.go", true},
		{"src/../src/a.go", true},
		{"missing", false}, {"", false},
		{"..", false}, {"../" + filepath.Base(outside) + "/secret", false}, {"src/../../x", false},
		{filepath.Join(outside, "secret"), false}, // absolute, outside
		{"out", false}, {"out/secret", false}, {"secret-link", false},
		{"src/a.go\x00", false},
		{"/etc/passwd", false}, {"/", false},
	} {
		if got := in(tc.path); got != tc.want {
			t.Errorf("InCheckout(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
	if InCheckout("")("src") || InCheckout("relative")("src") {
		t.Error("a checkout that is not absolute resolves nothing")
	}
	// A checkout that is itself a symlink is still a root.
	link := filepath.Join(t.TempDir(), "link")
	must(os.Symlink(root, link))
	if !InCheckout(link)("src/a.go") {
		t.Error("a symlinked checkout does not resolve its files")
	}
}

func TestRetryKeys(t *testing.T) {
	for _, tc := range []struct {
		kind, text string
		want       []string
	}{
		{"codex", "$zzprobe", []string{"esc", "enter"}},
		{"codex", "use $zzprobe.", []string{"esc", "enter"}},
		{"codex", "(see $caveman:caveman-commit!)", []string{"esc", "enter"}},
		{"codex", "line one\nthen $grill", []string{"esc", "enter"}},
		{"codex", "please run $zzprobe now", []string{"enter"}},
		{"codex", "costs 5$", []string{"enter"}},
		{"codex", "a$b", []string{"enter"}},
		{"codex", "$", []string{"enter"}},
		{"codex", "price $5/mo", []string{"enter"}},
		{"codex", "", []string{"enter"}},
		{"claude", "$zzprobe", []string{"enter"}},
		{"", "$zzprobe", []string{"enter"}},
	} {
		if got := RetryKeys(tc.kind, tc.text); !slices.Equal(got, tc.want) {
			t.Errorf("RetryKeys(%q, %q) = %q, want %q", tc.kind, tc.text, got, tc.want)
		}
	}
}

// The server bounds a prompt's source at 4 x the limit (server.maxShrink):
// no rewrite may make a text shorter than a quarter of itself. The worst is a
// quoted one-byte path, @"a" (4 bytes) to a (1).
func TestTranslateNeverShrinksPastAQuarter(t *testing.T) {
	const maxShrink = 4
	resolve := func(p string) bool { return true }
	for _, in := range []string{
		`@"a"`, `@"a"@"a"@"a"`, `@"a" @"b" @"c"`, `("@"a"`, "@a @b", `@"é"`, `@"a b" /grill`, "/grill/grill", "/zzprobe /zzprobe.",
		`@"a".@"a",`, `@a. @a) @a!`,
	} {
		for n := 1; n <= 3; n++ {
			text := ""
			for range n {
				text += in + " "
			}
			out := Translate("codex", text, translateCmds, resolve)
			if len(out)*maxShrink < len(text) {
				t.Errorf("%q (%d bytes) became %q (%d bytes): more than %dx shorter", text, len(text), out, len(out), maxShrink)
			}
		}
	}
	// The worst case is reached, so the bound cannot be lower.
	if out := Translate("codex", `@"a"@"a"`, nil, resolve); len(out)*maxShrink != len(`@"a"@"a"`) {
		t.Fatalf("worst case: %q", out)
	}
}

// #224: a skill's native spelling comes from the harness's rules.
func TestSkillCall(t *testing.T) {
	if got := SkillCall("codex", "handoff"); got != "$handoff" {
		t.Errorf("codex: %q", got)
	}
	if got := SkillCall("claude", "handoff"); got != "/handoff" {
		t.Errorf("claude: %q", got)
	}
}
