package server

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #13: each refusal of worker.prompt's path is told apart for the chat by
// what it wraps, never by its words.
func TestReplyErrorKinds(t *testing.T) {
	for _, c := range []struct {
		err  error
		kind string
	}{
		{fmt.Errorf("%w: Pixel %w: answer it first (worker.answer_ask)", errInvalidState, errAskWaiting), notify.ReplyAsk},
		{fmt.Errorf("%w: the worker %w: answer it first", errInvalidState, errAskWaiting), notify.ReplyAsk},
		{fmt.Errorf("%w: 32 commands are already %w", errInputFailed, errLaneFull), notify.ReplyBusy},
		{fmt.Errorf("%w: %q", errUnknownWorker, "w"), notify.ReplyGone},
		{errHandoffInGame, notify.ReplyHandoff},
		{badPromptText("text", 17000), notify.ReplyBadText},
		{fmt.Errorf("%w: floor %q is asleep", errInvalidState, "s"), notify.ReplyState},
		{fmt.Errorf("%w: pane gone", errPromptFailed), notify.ReplyFailed},
		{errHubStopped, notify.ReplyFailed},
		// #14: the ask or follow-up tapped is no longer the worker's.
		{fmt.Errorf("%w: Pixel asks another question now (tool_use_id t)", errStale), notify.ReplyClosed},
		{fmt.Errorf("%w: the worker has no open follow-up of turn %q", errStale, "t"), notify.ReplyClosed},
		// #108: possible secrets, which only the game can review.
		{fmt.Errorf("%w: 2 possible secrets", errSecretsReviewRequired), notify.ReplySecrets},
		{fmt.Errorf("%w: prompt secrets are no longer reviewed", errSecretsReviewStale), notify.ReplySecrets},
	} {
		var re *notify.ReplyError
		if err := replyError(c.err); !errors.As(err, &re) || re.Kind != c.kind {
			t.Errorf("%v: %v, want %s", c.err, err, c.kind)
		}
	}
	if replyError(nil) != nil {
		t.Fatal("nil is not nil")
	}
	// The messages a client sees are unchanged by the wrapping.
	if got := fmt.Errorf("%w: %s %w: answer it first (worker.answer_ask)", errInvalidState, "Pixel", errAskWaiting).Error(); got != "invalid state: Pixel waits on its question: answer it first (worker.answer_ask)" {
		t.Fatalf("message %q", got)
	}
}

// #14: the cards' texts are the worker's: an ask's questions and options,
// a follow-up's; an ask with a secret question gives none of its texts.
func TestNotifyFactsCardTexts(t *testing.T) {
	q := proto.AskQuestion{Header: "DB", Question: "Which database?", Multi: true, Other: true,
		Options: []proto.AskOption{{Label: "Postgres", Description: "Relational", Preview: "x"}}}
	got := notifyFacts(&proto.Worker{Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{q}}}, false).Ask.Questions[0]
	want := notify.AskQuestion{HasOptions: true, Header: "DB", Question: "Which database?", Multi: true, Other: true,
		Options: []notify.AskOption{{Label: "Postgres", Description: "Relational", Preview: "x"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("facts %+v, want %+v", got, want)
	}
	secret := notifyFacts(&proto.Worker{Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{q, {Question: "API key?", Secret: true,
		Options: []proto.AskOption{}}}}}, false)
	if s := fmt.Sprintf("%+v", *secret.Ask); strings.Contains(s, "database") || strings.Contains(s, "Postgres") || strings.Contains(s, "API key") ||
		!secret.Ask.Questions[0].HasOptions || !secret.Ask.Questions[1].Secret {
		t.Fatalf("secret ask facts %s", s)
	}
	n := 1
	fu := notifyFacts(&proto.Worker{Followup: &proto.Followup{TurnID: "turn", Tail: "tail", Questions: []proto.FollowupQuestion{{ID: "q1",
		Label: "Q1", Question: "Branch?", Kind: proto.FollowupChoice, Options: []string{"main", "next"}, Context: "ctx",
		Recommendation: &proto.FollowupRecommendation{Text: "next", Option: &n}}}}}, false).Followup
	if wantF := (notify.FollowupQuestion{ID: "q1", Question: "Branch?", Kind: "choice", Options: 2, Label: "Q1", Context: "ctx",
		Recommendation: "next", Choices: []string{"main", "next"}}); fu.Tail != "tail" || !reflect.DeepEqual(fu.Questions[0], wantF) {
		t.Fatalf("follow-up facts %+v", fu)
	}
}

// #88: a blocked worker's permission or trust menu is in its facts with
// its labels scrubbed, a command in them elided, never its question line
// or its excerpt; a choice menu, or one of a worker no longer blocked, is
// not.
func TestNotifyFactsMenu(t *testing.T) {
	q := &proto.Question{Kind: proto.QuestionPermission, Text: "Do you want to proceed with ghp_abcdefghij0123?", Hash: "0123456789abcdef",
		Excerpt: []string{"curl -u admin:hunter2 https://example.test"}, Choices: []proto.Choice{{N: 1, Label: "Yes"},
			{N: 2, Label: "Yes, and don't ask again for commands that start with `mysql -phunter2` (p)"}, {N: 3, Label: "No, and `cut off"},
			{N: 4, Label: "Yes, and don't ask again for mysql -phunter2 commands in /tmp/proj"}}}
	got := notifyFacts(&proto.Worker{Status: statusBlocked, Question: q}, false).Menu
	want := &notify.Menu{Hash: "0123456789abcdef", Kind: "permission", Choices: []notify.MenuChoice{
		{N: 1, Label: "Yes"}, {N: 2, Label: "Yes, and don't ask again for … (p)"}, {N: 3, Label: "No, and `…`"},
		{N: 4, Label: "Yes, and don't ask again for …"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("menu %+v, want %+v", got, want)
	}
	if s := fmt.Sprintf("%+v", got); strings.Contains(s, "hunter2") || strings.Contains(s, "example.test") || strings.Contains(s, "proceed") {
		t.Fatalf("menu facts %s", s)
	}
	q.Kind = proto.QuestionTrust
	if m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: q}, false).Menu; m == nil || m.Kind != "trust" {
		t.Fatalf("trust %+v", m)
	}
	if m := notifyFacts(&proto.Worker{Status: statusWorking, Question: q}, false).Menu; m != nil {
		t.Fatalf("not blocked %+v", m)
	}
	q.Kind = proto.QuestionChoice
	if m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: q}, false).Menu; m != nil {
		t.Fatalf("choice %+v", m)
	}
}

// #88: a command line in the dialog that asks is the screen's question
// line (questionText), and no pattern catches what it holds: nothing of it
// is in the facts. The captured screens' labels keep what they say.
func TestNotifyFactsMenuCommandLine(t *testing.T) {
	sc := strings.Replace(screen(t, "codex-approval"), "$ touch h3d-codex-probe.txt",
		"$ curl https://example.test -u alice:open-sesame 'Do you want to continue?'", 1)
	q := parseQuestion(sc, 100).q
	if !strings.Contains(q.Text, "open-sesame") {
		t.Fatalf("the command line is not the question line: %q", q.Text)
	}
	m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &q}, false).Menu
	if m == nil {
		t.Fatalf("no menu: %+v", q)
	}
	if s := fmt.Sprintf("%+v", *m); strings.Contains(s, "open-sesame") || strings.Contains(s, "curl") || strings.Contains(s, "continue") {
		t.Fatalf("the command line in the facts: %s", s)
	}
	for name, labels := range map[string][]string{
		"codex-approval":          {"Yes, proceed (y)", "Yes, and don't ask again for … (p)", "No, and tell Codex what to do differently (esc)"},
		"claude-permission-bash":  {"Yes", "Yes, and always allow access to /tmp/h3d-m5term/claude-a2be86 from this project", "No"},
		"claude-permission-write": {"Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", "No"},
		"claude-trust":            {"No, exit", "Yes, I trust this folder"},
		"codex-trust":             {"Trust and continue", "Quit"},
	} {
		q := parseQuestion(screen(t, name), 100).q
		m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &q}, false).Menu
		if m == nil {
			t.Fatalf("%s: no menu: %+v", name, q)
		}
		var got []string
		for _, c := range m.Choices {
			got = append(got, c.Label)
		}
		if !reflect.DeepEqual(got, labels) {
			t.Errorf("%s: labels %q, want %q", name, got, labels)
		}
	}
}

// #88: a command in a choice that says what not to ask about again can
// hold " commands" itself, so the label is cut where the command would
// start, its end never looked for.
func TestNotifyFactsMenuPrefixContainingCommands(t *testing.T) {
	sc := strings.Replace(screen(t, "claude-permission-bash"),
		"Yes, and always allow access to /tmp/h3d-m5term/claude-a2be86 from this project",
		"Yes, and don't ask again for echo commands && mysql -popen-sesame commands in /tmp/proj", 1)
	q := parseQuestion(sc, 100).q
	if q.Kind != proto.QuestionPermission || len(q.Choices) != 3 || !strings.Contains(q.Choices[1].Label, "open-sesame") {
		t.Fatalf("not the screen meant: %+v", q)
	}
	m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &q}, false).Menu
	if s := fmt.Sprintf("%+v", m); strings.Contains(s, "open-sesame") || strings.Contains(s, "mysql") || strings.Contains(s, "echo") {
		t.Fatalf("the command in the facts: %s", s)
	}
	if got := m.Choices[1].Label; got != "Yes, and don't ask again for …" {
		t.Fatalf("label %q", got)
	}
}

// #88: what menuText leaves of a label that may name a command: cut where
// the command would start, else "…"; its key kept, nothing of the command.
func TestMenuTextNamesCommand(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Yes, and don't ask again for echo commands && mysql -popen-sesame commands in /tmp/proj", "Yes, and don't ask again for …"},
		{"Yes, and don't ask again for `echo commands` && mysql -popen-sesame commands in /tmp/proj", "Yes, and don't ask again for …"},
		{"Yes, and don't ask again for echo `x` commands mysql -popen-sesame commands", "Yes, and don't ask again for …"},
		{"Yes, and don't ask again for for mysql -popen-sesame for commands in /tmp/proj", "Yes, and don't ask again for …"},
		{"Yes, and don't ask again for commands that start with `mysql -popen-sesame` (p)", "Yes, and don't ask again for … (p)"},
		{"Yes, and don't ask again for commands that start with `mysql -popen-sesame", "Yes, and don't ask again for …"},
		{"Yes, and don't ask again for mysql -popen-sesame --host db.internal.example comm", "Yes, and don't ask again for …"},
		{"Yes, and don’t ask again for mysql -popen-sesame commands", "Yes, and don’t ask again for …"},
		{"YES, AND DO NOT ASK AGAIN FOR mysql -popen-sesame COMMANDS", "YES, AND DO NOT ASK AGAIN for …"},
		{"Yes, never ask again: mysql -popen-sesame", "Yes, never ask again …"},
		{"Yes, and don't ask again", "Yes, and don't ask again"},
		{"No, and ask again for mysql -popen-sesame next time", "…"},
		{"Always run mysql -popen-sesame and don't ask again (a)", "… (a)"},
		{"Yes, allow mysql -popen-sesame commands this session", "…"},
		{"Yes, and don't ask-again for mysql -popen-sesame", "…"},
	} {
		got := menuText(c.in)
		if got != c.want {
			t.Errorf("menuText(%q) = %q, want %q", c.in, got, c.want)
		}
		if strings.Contains(got, "sesame") || strings.Contains(got, "mysql") || strings.Contains(got, "echo") {
			t.Errorf("menuText(%q) = %q: the command left", c.in, got)
		}
	}
}

// #88: no captured screen's menu sends a label that names a command: each
// is one we keep as it is, or cut.
func TestNotifyFactsMenuScreens(t *testing.T) {
	names, err := filepath.Glob(filepath.Join("testdata", "screens", "*.txt"))
	if err != nil || len(names) == 0 {
		t.Fatalf("screens %v %v", names, err)
	}
	menus := 0
	for _, name := range names {
		q := parseQuestion(screen(t, strings.TrimSuffix(filepath.Base(name), ".txt")), 100).q
		m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &q}, false).Menu
		if m == nil {
			continue
		}
		menus++
		for _, c := range m.Choices {
			cut := strings.Contains(c.Label, "ask again") && (strings.HasSuffix(c.Label, "ask again for …") ||
				keyHintRe.MatchString(c.Label) && strings.HasSuffix(keyHintRe.ReplaceAllString(c.Label, ""), "ask again for …"))
			if !cut && (namesCommandRe.MatchString(c.Label) && !menuLabelsKept[c.Label] || strings.Contains(strings.ReplaceAll(c.Label, "`…`", ""), "`")) {
				t.Errorf("%s: label %q", name, c.Label)
			}
		}
	}
	if menus != 5 {
		t.Fatalf("%d menus among the screens, want 5", menus)
	}
}

// #88: a menu card's tap refused because the worker is no longer blocked
// is a menu no longer open; an ask's refusal stays as it is.
func TestMenuErrorKinds(t *testing.T) {
	notBlocked := fmt.Errorf("%w: Pixel is working, not blocked", errInvalidState)
	var re *notify.ReplyError
	if err := replyError(menuError(notify.Answer{Hash: "0123456789abcdef"}, notBlocked)); !errors.As(err, &re) || re.Kind != notify.ReplyClosed {
		t.Fatalf("menu: %v", err)
	}
	if err := replyError(menuError(notify.Answer{ToolUseID: "t"}, notBlocked)); !errors.As(err, &re) || re.Kind != notify.ReplyState {
		t.Fatalf("ask: %v", err)
	}
}
