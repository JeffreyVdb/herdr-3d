package server

import (
	"strings"
	"testing"
)

// Screens captured from herdr 0.9.0 (`pane read --source visible`, a pane
// 119 columns wide): both agents break a long path one column short of the
// pane width and indent the rest.
const (
	longDir       = "/tmp/TestProbeTrustScreens3291411554/003/a-very-long-directory-name-for-wrapping-tests/another-quite-long-segment-here/and-one-more-segment-to-exceed-width"
	claudeWrapped = "───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n /tmp/TestProbeTrustScreens3291411554/003/a-very-long-directory-name-for-wrapping-tests/another-quite-long-segment-her\n e/and-one-more-segment-to-exceed-width\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm   Esc to cancel\n"
	codexWrapped  = "\n  Folder access\n  /tmp/TestProbeTrustScreens3291411554/003/a-very-long-directory-name-for-wrapping-tests/another-quite-long-segment-he\n  re/and-one-more-segment-to-exceed-width\n\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings\n  can run code automatically, even without a model request. Continue only if you trust these files. Your trust\n  decision will be saved.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue   esc quit\n"
	codexShort    = "\n  Folder access\n  /tmp/repo\n\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings\n  can run code automatically, even without a model request. Continue only if you trust these files. Your trust\n  decision will be saved.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue   esc quit\n"
)

func TestTrustDialogMatchesTheWholePath(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, screen, dir, want string
	}{
		{"claude, wrapped long path", claudeWrapped, longDir, "claude"},
		{"codex, wrapped long path", codexWrapped, longDir, "codex"},
		{"codex, short path", codexShort, "/tmp/repo", "codex"},
		{"a parent of the path shown", claudeWrapped, longDir[:strings.LastIndex(longDir, "/")], ""},
		{"a sibling prefix of the wrapped path", codexWrapped, strings.TrimSuffix(longDir, "-width"), ""},
		{"a sibling prefix ending at the wrap", codexWrapped,
			"/tmp/TestProbeTrustScreens3291411554/003/a-very-long-directory-name-for-wrapping-tests/another-quite-long-segment-he", ""},
		{"a sibling: /tmp/repo is not /tmp/repo-other", strings.Replace(codexShort, "/tmp/repo", "/tmp/repo-other", 1), "/tmp/repo", ""},
		{"inside another path: /x/tmp/repo", strings.Replace(codexShort, "/tmp/repo", "/x/tmp/repo", 1), "/tmp/repo", ""},
		{"a subdirectory shown", strings.Replace(codexShort, "/tmp/repo", "/tmp/repo/sub", 1), "/tmp/repo", ""},
		{"quoted", strings.Replace(codexShort, "/tmp/repo", `"/tmp/repo"`, 1), "/tmp/repo", "codex"},
		{"no dialog", "❯ /tmp/repo", "/tmp/repo", ""},
	} {
		if got := trustDialog(tc.screen, tc.dir); got != tc.want {
			t.Errorf("%s: trustDialog = %q, want %q", tc.name, got, tc.want)
		}
	}
	// dir ends exactly where a line wraps, and the path shown goes on
	// ("-v2") on the next line: a sibling, not dir.
	last := "  re/and-one-more-segment-to-exceed-width"
	pad := strings.Repeat("x", 118-len(last)) // the line reaches the wrap column
	wrapped := strings.Replace(codexWrapped, last+"\n", last+pad+"\n  -v2\n", 1)
	if got := trustDialog(wrapped, longDir+pad); got != "" {
		t.Errorf("dir ends at the wrap, the path goes on: trustDialog = %q", got)
	}
	if got := trustDialog(wrapped, longDir+pad+"-v2"); got != "codex" {
		t.Errorf("the path wrapped twice: trustDialog = %q", got)
	}
}
