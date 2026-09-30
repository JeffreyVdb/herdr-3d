package server

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func screen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "screens", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Screens captured from throwaway sessions under herdr 0.9.0 (`pane read
// --source visible`, 120 × 40 panes; the host in the shell prompt
// replaced), with what herdr reported and what picked a choice live:
//
//   - claude-trust: Claude Code 2.1 in a folder it has not seen: blocked;
//     the menu has no digits ("2" does nothing), Down + Enter trusts.
//   - claude-permission-bash, -write: a tool permission prompt (no
//     --permission-mode bypassPermissions): blocked; "1" runs it, Esc
//     rejects it (status done).
//   - claude-question: the AskUserQuestion tool: blocked; "2" answers.
//   - codex-approval: Codex 0.158 (-a on-request -s read-only) asking to
//     run a command outside its sandbox: blocked; "1" approves.
//   - codex-trust: Codex's trust dialog: herdr says idle (so it is never
//     read as a question); "1" does nothing, Enter trusts.
func TestParseQuestionOnCapturedScreens(t *testing.T) {
	for _, tc := range []struct {
		screen   string
		kind     string
		text     string
		choices  []string
		selected int
		numbered bool
		keys     map[int][]string // choice → keys
		excerpt  string           // the excerpt's last line
	}{
		{"claude-trust", proto.QuestionTrust, "Quick safety check: Is this a project you created or one you trust?",
			[]string{"No, exit", "Yes, I trust this folder"}, 1, false,
			map[int][]string{1: {"enter"}, 2: {"down", "enter"}}, "Enter to confirm · Esc to cancel"},
		{"claude-permission-bash", proto.QuestionPermission, "Do you want to proceed?",
			[]string{"Yes", "Yes, and always allow access to /tmp/h3d-m5term/claude-a2be86 from this project", "No"}, 1, true,
			map[int][]string{1: {"1"}, 3: {"3"}}, "Esc to cancel · Tab to amend"},
		{"claude-permission-write", proto.QuestionPermission, "Do you want to create notes-h3d.txt?",
			[]string{"Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", "No"},
			1, true, map[int][]string{2: {"2"}}, "Esc to cancel · Tab to amend"},
		{"claude-question", proto.QuestionChoice, "Tea or coffee?",
			[]string{"Tea", "Coffee", "Type something.", "Chat about this"}, 1, true,
			map[int][]string{2: {"2"}, 4: {"4"}}, "Enter to select · ↑/↓ to navigate · Esc to cancel"},
		{"codex-approval", proto.QuestionPermission, "Would you like to run the following command?",
			[]string{"Yes, proceed (y)", "Yes, and don't ask again for commands that start with `touch h3d-codex-probe.txt` (p)",
				"No, and tell Codex what to do differently (esc)"}, 1, true,
			map[int][]string{1: {"1"}, 3: {"3"}}, "Press enter to confirm or esc to cancel"},
		{"codex-trust", proto.QuestionTrust, "Trust this folder?",
			[]string{"Trust and continue", "Quit"}, 1, true,
			map[int][]string{1: {"enter"}, 2: {"down", "enter"}}, "enter continue · esc quit"},
	} {
		t.Run(tc.screen, func(t *testing.T) {
			sq := parseQuestion(screen(t, tc.screen), 1)
			q := sq.q
			var labels []string
			for i, c := range q.Choices {
				if c.N != i+1 {
					t.Errorf("choice %d has n %d", i, c.N)
				}
				labels = append(labels, c.Label)
			}
			if q.Kind != tc.kind || q.Text != tc.text || !slices.Equal(labels, tc.choices) || q.Selected != tc.selected ||
				sq.numbered != tc.numbered {
				t.Fatalf("question = %+v (numbered %v)\nwant kind %s, text %q, choices %q, selected %d", q, sq.numbered,
					tc.kind, tc.text, tc.choices, tc.selected)
			}
			for n, want := range tc.keys {
				if got := sq.answerKeys(n); !slices.Equal(got, want) {
					t.Errorf("keys for %d = %q, want %q", n, got, want)
				}
			}
			if len(q.Excerpt) == 0 || len(q.Excerpt) > maxExcerptLines || q.Excerpt[len(q.Excerpt)-1] != tc.excerpt {
				t.Errorf("excerpt = %q", q.Excerpt)
			}
			for _, l := range q.Excerpt {
				if l == "" || l != strings.TrimSpace(l) || len([]rune(l)) > maxExcerptRunes {
					t.Errorf("excerpt line %q", l)
				}
			}
			if len(q.Hash) != 16 || !hashRe.MatchString(q.Hash) {
				t.Errorf("hash = %q", q.Hash)
			}
		})
	}
}

func TestParseQuestionEdges(t *testing.T) {
	perm := screen(t, "claude-permission-bash")
	base := parseQuestion(perm, 1).q

	// The cursor moving, or the lines above changing, is the same question.
	moved := strings.Replace(strings.Replace(perm, " ❯ 1. Yes", "   1. Yes", 1), "   2. Yes,", " ❯ 2. Yes,", 1)
	if q := parseQuestion(moved, 1).q; q.Hash != base.Hash || q.Selected != 2 {
		t.Errorf("cursor on 2: %+v", q)
	}
	if q := parseQuestion("● Reading 3 files…\n"+perm, 1).q; q.Hash != base.Hash {
		t.Errorf("more history: hash %s, want %s", q.Hash, base.Hash)
	}
	// Another question or other choices are another hash.
	if q := parseQuestion(strings.Replace(perm, "proceed?", "delete it?", 1), 1).q; q.Hash == base.Hash {
		t.Error("another question, same hash")
	}
	if q := parseQuestion(strings.Replace(perm, "3. No", "3. No, stop", 1), 1).q; q.Hash == base.Hash {
		t.Error("another choice, same hash")
	}
	// The same question and choices about another command, or asked in
	// another blocked spell, are another hash too: an approval of one
	// never approves the other.
	if q := parseQuestion(strings.ReplaceAll(perm, "touch h3d-perm-probe.txt", "rm -rf important-project"), 1).q; q.Hash == base.Hash ||
		q.Text != base.Text || !reflect.DeepEqual(q.Choices, base.Choices) {
		t.Errorf("another command: %+v", q)
	}
	if q := parseQuestion(perm, 2).q; q.Hash == base.Hash {
		t.Error("blocked again, same hash")
	}
	for name, tc := range map[string]struct {
		screen, old, new string
	}{
		"another file's content": {"claude-permission-write", "  1 hello", "  1 goodbye"},
		"another codex command":  {"codex-approval", "  $ touch h3d-codex-probe.txt", "  $ rm -rf ~"},
		"another trust folder":   {"claude-trust", " /tmp/h3d-m5term/claude-a2be86\n", " /home/someone/secrets\n"},
	} {
		s := screen(t, tc.screen)
		if !strings.Contains(s, tc.old) {
			t.Fatalf("%s: %q not on the screen", name, tc.old)
		}
		if a, b := parseQuestion(s, 1).q, parseQuestion(strings.Replace(s, tc.old, tc.new, 1), 1).q; a.Hash == b.Hash {
			t.Errorf("%s: same hash %s", name, a.Hash)
		}
	}

	for name, s := range map[string]string{
		"claude at its prompt": "● Done.\n\n────\n❯ \n────\n  ⏵⏵ bypass permissions on",
		"a numbered list, then more output": "● Plan:\n  1. Read hub.go\n  2. Write tests\n\n● Reading hub.go\n" +
			"  ⎿  Read 1331 lines\n\n● Writing tests\n  ⎿  12 tests\n\n✻ Working… (12s)",
		"numbers out of order":               "  1. Yes\n  3. No\n\n Esc to cancel",
		"no choice 1":                        "  2. Yes\n  3. No\n\n Esc to cancel",
		"a cursor without siblings or hints": "❯ Use the Write tool to create notes.txt\n\n● Write(notes.txt)\n  ⎿  Wrote 1 line",
		"an echoed prompt that wrapped":      "❯ Use the AskUserQuestion tool to ask me one question with two options, Tea and\n  Coffee.\n",
		"empty":                              "",
	} {
		q := parseQuestion(s, 1).q
		if q.Kind != proto.QuestionOther || len(q.Choices) != 0 || q.Selected != 0 || q.Choices == nil {
			t.Errorf("%s: %+v", name, q)
		}
	}
	// Blocked without a menu: the text is the asking line near the bottom.
	if q := parseQuestion("● Should I also update the docs?\n\n✻ Waiting", 1).q; q.Kind != proto.QuestionOther ||
		q.Text != "● Should I also update the docs?" || !reflect.DeepEqual(q.Excerpt, []string{"● Should I also update the docs?", "✻ Waiting"}) {
		t.Errorf("no menu: %+v", q)
	}
	// Long lines are clipped, and only the last lines are kept.
	long := strings.Repeat("x", 300)
	many := strings.Repeat("line\n", 20) + long + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	q := parseQuestion(many, 1).q
	if len(q.Excerpt) != maxExcerptLines || len([]rune(q.Excerpt[4])) != maxExcerptRunes || q.Kind != proto.QuestionPermission {
		t.Errorf("excerpt = %q (%s)", q.Excerpt, q.Kind)
	}
}

// #57: the structured-question dialogs, as the grounding captured them,
// parse whole: a long question joined however it wraps (it was cut to its
// last line, or lost at 100 columns), labels without their descriptions or
// previews, and Claude's Yes / No question not a permission.
func TestParseQuestionOnAskDialogs(t *testing.T) {
	long := "For the live terminal streaming implementation, should the bridge send HTTP POST requests through the existing helper for each operator interaction, preserving explicit acknowledgments and retry behavior, or use WebSocket chunks matching issue thirteen, with continuous bidirectional delivery and reconnection handling for long running agent sessions?"
	codexLong := "When sending a large fixture payload through a helper process while the receiver is temporarily unavailable and the terminal is narrow, which transport should preserve delivery ordering, retries, and a clear progress indication for the person waiting at the laptop?"
	for _, tc := range []struct {
		screen   string
		text     string
		choices  []string
		selected int
	}{
		{"claude-ask-long-narrow", long, []string{"HTTP POST via helper (Recommended)", "WebSocket chunks (as #13)", "Type something.", "Chat about this"}, 1},
		{"claude-ask-long-wide", long, []string{"HTTP POST via helper (Recommended)", "WebSocket chunks (as #13)", "Type something.", "Chat about this"}, 1},
		{"claude-ask-named", "How should the laptop upload pasted screenshots to the bridge: through an HTTP POST handled by the small helper process that already proxies the WebSocket, or as WebSocket chunks like issue thirteen proposed?",
			[]string{"HTTP POST via helper (Recommended)", "WebSocket chunks (as #13)", "Type something.", "Chat about this"}, 1},
		{"claude-ask-preview", "Which card layout?", []string{"Compact", "Expanded"}, 1},
		{"claude-ask-esc", "Continue experiment?", []string{"Yes", "No", "Type something.", "Chat about this"}, 1},
		{"claude-ask-multi-digit3", "Which features should be enabled?", []string{"Logs", "Metrics", "Traces", "Alerts", "Type something", "Chat about this"}, 2},
		{"codex-ask-single", "Which color should the fixture use?", []string{"Blue (Recommended)", "Green", "None of the above"}, 1},
		{"codex-ask-long-narrow", codexLong, []string{"HTTP helper (Recommended)", "WebSocket stream", "None of the above"}, 1},
	} {
		t.Run(tc.screen, func(t *testing.T) {
			sq := parseQuestion(screen(t, tc.screen), 1)
			var labels []string
			for _, c := range sq.q.Choices {
				labels = append(labels, c.Label)
			}
			if sq.q.Kind != proto.QuestionChoice || sq.q.Text != clip(tc.text) || !slices.Equal(labels, tc.choices) || sq.q.Selected != tc.selected || !sq.numbered {
				t.Fatalf("question = %+v", sq.q)
			}
		})
	}
}
