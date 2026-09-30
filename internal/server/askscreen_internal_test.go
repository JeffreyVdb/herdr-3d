package server

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The dialogs as captured (testdata/screens/claude-ask-*, codex-ask-*: Claude
// Code 2.1.285, codex-cli 0.159.2, herdr 0.9.0, 100 × 30 unless named wide;
// the grounding of #57 has the keys that led from one to the next).
func TestParseClaudeDialog(t *testing.T) {
	type row = dialogRow
	for _, tc := range []struct {
		screen   string
		tabs     []string
		review   bool
		question string
		rows     []row
		submit   int // 0: no Submit row, 1: there, 2: the cursor on it
	}{
		{"claude-ask-single", []string{"Drink"}, false, "Tea or coffee?",
			[]row{{1, "Tea", 0, true}, {2, "Coffee", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-other-typed", []string{"Drink"}, false, "What should we drink?",
			[]row{{1, "Tea", 0, false}, {2, "Coffee", 0, false}, {3, "Sparkling water", 0, true}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-two", []string{"Color", "Extras", "Submit"}, false, "Which color?",
			[]row{{1, "Red", 0, true}, {2, "Blue", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-two-q2-toggle", []string{"Color", "Extras", "Submit"}, false, "Which extras?",
			[]row{{1, "Logs", 2, true}, {2, "Metrics", 1, false}, {3, "Traces", 1, false}, {4, "Type something", 1, false}, {5, "Chat about this", 0, false}}, 1},
		{"claude-ask-two-review", []string{"Color", "Extras", "Submit"}, true, "",
			[]row{{1, "Submit answers", 0, true}, {2, "Cancel", 0, false}}, 0},
		{"claude-ask-four-q4", []string{"One", "Two", "Three", "Four", "Submit"}, false, "Fourth choice?",
			[]row{{1, "Fast", 0, true}, {2, "Safe", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-multi-digit3", []string{"Features", "Submit"}, false, "Which features should be enabled?",
			[]row{{1, "Logs", 2, false}, {2, "Metrics", 2, true}, {3, "Traces", 2, false}, {4, "Alerts", 1, false}, {5, "Type something", 1, false}, {6, "Chat about this", 0, false}}, 1},
		{"claude-ask-multi-other-submit-row", []string{"Extra", "Submit"}, false, "Which extras to enable?",
			[]row{{1, "Logs", 2, false}, {2, "Metrics", 1, false}, {3, "Traces", 1, false}, {4, "Custom dashboards", 2, false}, {5, "Chat about this", 0, false}}, 2},
		{"claude-ask-four-q2", []string{"One", "Two", "Three", "Four", "Submit"}, false, "Second choice?",
			[]row{{1, "Small", 0, true}, {2, "Large", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-four-review", []string{"One", "Two", "Three", "Four", "Submit"}, true, "",
			[]row{{1, "Submit answers", 0, true}, {2, "Cancel", 0, false}}, 0},
		{"claude-ask-multi", []string{"Features", "Submit"}, false, "Which features should be enabled?",
			[]row{{1, "Logs", 1, true}, {2, "Metrics", 1, false}, {3, "Traces", 1, false}, {4, "Alerts", 1, false}, {5, "Type something", 1, false}, {6, "Chat about this", 0, false}}, 1},
		{"claude-ask-multi-review", []string{"Features", "Submit"}, true, "",
			[]row{{1, "Submit answers", 0, true}, {2, "Cancel", 0, false}}, 0},
		// Captured live for #57 (Haiku 4.5, 120 × 40): a multi-select question before the last one ends in "Next".
		{"claude-ask-multi-first", []string{"Extras", "Color", "Submit"}, false, "Which extras should be enabled?",
			[]row{{1, "Logs", 1, true}, {2, "Metrics", 1, false}, {3, "Traces", 1, false}, {4, "Type something", 1, false}, {5, "Chat about this", 0, false}}, 1},
		{"claude-ask-chat", []string{"Discuss"}, false, "Which approach?",
			[]row{{1, "Simple", 0, true}, {2, "Detailed", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-preview", []string{"Layout"}, false, "Which card layout?",
			[]row{{1, "Compact", 0, true}, {2, "Expanded", 0, false}}, 0},
		{"claude-ask-preview-digit2", []string{"Preview"}, false, "Which preview?",
			[]row{{1, "A", 0, false}, {2, "B", 0, true}}, 0},
		{"claude-ask-long-narrow", []string{"Transport"}, false, "For the live terminal streaming implementation, should the bridge send HTTP POST requests through the existing helper for each operator interaction, preserving explicit acknowledgments and retry behavior, or use WebSocket chunks matching issue thirteen, with continuous bidirectional delivery and reconnection handling for long running agent sessions?",
			[]row{{1, "HTTP POST via helper (Recommended)", 0, true}, {2, "WebSocket chunks (as #13)", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
		{"claude-ask-named", []string{"Transport"}, false, "How should the laptop upload pasted screenshots to the bridge: through an HTTP POST handled by the small helper process that already proxies the WebSocket, or as WebSocket chunks like issue thirteen proposed?",
			[]row{{1, "HTTP POST via helper (Recommended)", 0, true}, {2, "WebSocket chunks (as #13)", 0, false}, {3, "Type something.", 0, false}, {4, "Chat about this", 0, false}}, 0},
	} {
		t.Run(tc.screen, func(t *testing.T) {
			d := parseClaudeDialog(screen(t, tc.screen))
			submit := 0
			if d.submitRow {
				submit = 1
				if d.submitCur {
					submit = 2
				}
			}
			if !d.ok || !slices.Equal(d.tabs, tc.tabs) || d.review != tc.review || d.question != tc.question || !slices.Equal(d.rows, tc.rows) || submit != tc.submit {
				t.Fatalf("dialog = %+v", d)
			}
		})
	}
	// The wide long question is the narrow one, joined the same.
	if a, b := parseClaudeDialog(screen(t, "claude-ask-long-wide")), parseClaudeDialog(screen(t, "claude-ask-long-narrow")); a.question != b.question || !slices.Equal(a.rows, b.rows) {
		t.Errorf("wide %+v\nnarrow %+v", a, b)
	}
	for _, s := range []string{"claude-permission-bash", "claude-trust", "codex-ask-single", ""} {
		var text string
		if s != "" {
			text = screen(t, s)
		}
		if d := parseClaudeDialog(text); d.ok {
			t.Errorf("%q: a dialog %+v", s, d)
		}
	}
	// History above the dialog (a todo list's ☐) is not its header.
	s := "☐ Write tests\n☐ Ship it\n\n" + screen(t, "claude-ask-single")
	if d := parseClaudeDialog(s); !d.ok || d.question != "Tea or coffee?" {
		t.Errorf("with a todo list above: %+v", d)
	}
	if d := parseClaudeDialog("● Todos\n  ☐ Write tests\n  ☐ Ship it\n\n❯ \n"); d.ok {
		t.Errorf("a todo list: %+v", d)
	}
}

func TestParseCodexDialog(t *testing.T) {
	type row = dialogRow
	for _, tc := range []struct {
		screen       string
		index, count int
		question     string
		rows         []row
		notes        bool
		notesText    string
	}{
		{"codex-ask-single", 1, 1, "Which color should the fixture use?",
			[]row{{1, "Blue (Recommended)", 0, true}, {2, "Green", 0, false}, {3, "None of the above", 0, false}}, false, ""},
		{"codex-ask-multi-second", 2, 3, "Which size?",
			[]row{{1, "Small", 0, true}, {2, "Large", 0, false}, {3, "None of the above", 0, false}}, false, ""},
		{"codex-ask-other-notes", 1, 1, "Which transport should carry the fixture payload?",
			[]row{{1, "HTTP", 0, false}, {2, "WebSocket", 0, false}, {3, "None of the above", 0, true}}, true, ""},
		{"codex-ask-other-typed", 1, 1, "Which transport should carry the fixture payload?",
			[]row{{1, "HTTP", 0, false}, {2, "WebSocket", 0, false}, {3, "None of the above", 0, true}}, true, "Use a local file instead."},
	} {
		t.Run(tc.screen, func(t *testing.T) {
			d := parseCodexDialog(screen(t, tc.screen))
			if !d.ok || d.index != tc.index || d.count != tc.count || d.question != tc.question || !slices.Equal(d.rows, tc.rows) ||
				d.notes != tc.notes || d.notesText != tc.notesText {
				t.Fatalf("dialog = %+v", d)
			}
		})
	}
	for _, s := range []string{"codex-ask-long-narrow", "codex-ask-long-wide"} {
		d := parseCodexDialog(screen(t, s))
		if !d.ok || !strings.HasPrefix(d.question, "When sending a large fixture payload through a helper process") ||
			!strings.HasSuffix(d.question, "for the person waiting at the laptop?") || len(d.rows) != 3 || d.rows[0].label != "HTTP helper (Recommended)" {
			t.Errorf("%s: %+v", s, d)
		}
	}
	if a, b := parseCodexDialog(screen(t, "codex-ask-long-narrow")), parseCodexDialog(screen(t, "codex-ask-long-wide")); a.question != b.question || len(a.rows) != 3 {
		t.Errorf("narrow %q\nwide %q", a.question, b.question)
	}
	for _, s := range []string{"codex-approval", "codex-trust", "claude-ask-single"} {
		if d := parseCodexDialog(screen(t, s)); d.ok {
			t.Errorf("%s: a dialog %+v", s, d)
		}
	}
}

// Every captured dialog screen is a dialog to its parser, and to only one.
func TestEveryAskScreenIsADialog(t *testing.T) {
	names, err := filepath.Glob(filepath.Join("testdata", "screens", "*-ask-*.txt"))
	if err != nil || len(names) < 30 {
		t.Fatalf("%d screens (%v)", len(names), err)
	}
	for _, n := range names {
		s := screen(t, strings.TrimSuffix(filepath.Base(n), ".txt"))
		claude, codex := parseClaudeDialog(s).ok, parseCodexDialog(s).ok
		if want := strings.HasPrefix(filepath.Base(n), "claude-"); claude != want || codex == want {
			t.Errorf("%s: claude %v, codex %v", n, claude, codex)
		}
	}
}

// A dialog is an ask's when it shows one of its questions with its options,
// or its review with its headers (it shows no options); cut tabs and
// scrolled-off options count.
func TestDialogShowsAsk(t *testing.T) {
	opts := func(labels ...string) []proto.AskOption {
		var o []proto.AskOption
		for _, l := range labels {
			o = append(o, proto.AskOption{Label: l})
		}
		return o
	}
	two := &proto.Ask{Questions: []proto.AskQuestion{
		{Header: "Color", Question: "Which color?", Options: opts("Red", "Blue")},
		{Header: "Extras", Question: "Which extras?", Multi: true, Options: opts("Logs", "Metrics", "Traces")},
	}}
	for _, s := range []string{"claude-ask-two", "claude-ask-two-q2", "claude-ask-two-review"} {
		if !parseClaudeDialog(screen(t, s)).showsAsk(two) {
			t.Errorf("%s: not the ask's", s)
		}
	}
	for name, a := range map[string]*proto.Ask{
		"another question": {Questions: []proto.AskQuestion{{Header: "Drink", Question: "Tea or coffee?", Options: opts("Tea", "Coffee")}}},
		"other options":    {Questions: []proto.AskQuestion{two.Questions[0], {Header: "Extras", Question: "Which extras?", Options: opts("Logs", "Spans", "Traces")}}},
		"other headers":    {Questions: []proto.AskQuestion{{Header: "Hue", Question: "Which color?", Options: opts("Red", "Blue")}, two.Questions[1]}},
	} {
		if parseClaudeDialog(screen(t, "claude-ask-two-q2")).showsAsk(a) && name != "other headers" {
			t.Errorf("%s: q2 taken for it", name)
		}
		// The review shows no options: its tabs tell.
		if parseClaudeDialog(screen(t, "claude-ask-two-review")).showsAsk(a) != (name == "other options") {
			t.Errorf("%s: the review taken for it", name)
		}
	}
	if !headerIs("Observabil…", "Observability") || headerIs("Observabil…", "Migration") || !headerIs("x", "") {
		t.Error("headerIs")
	}
	// Scrolled: only some options shown.
	if !optionsShown([]dialogRow{{n: 3, label: "Traces"}, {n: 4, label: "Type something"}}, opts("Logs", "Metrics", "Traces")) ||
		optionsShown([]dialogRow{{n: 4, label: "Type something"}}, opts("Logs", "Metrics", "Traces")) {
		t.Error("optionsShown")
	}
	codex := &proto.Ask{Questions: []proto.AskQuestion{
		{Question: "Which color?", Options: opts("Blue", "Green")}, {Question: "Which size?", Options: opts("Small", "Large")},
		{Question: "Which style?", Options: opts("Plain", "Fancy")},
	}}
	if d := parseCodexDialog(screen(t, "codex-ask-multi-third")); !d.showsAsk(codex) || d.showsAsk(&proto.Ask{Questions: codex.Questions[2:]}) {
		t.Error("codex: the third of three")
	}
}
