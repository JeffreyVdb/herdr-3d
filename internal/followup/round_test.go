package followup_test

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
)

var update = flag.Bool("update", false, "rewrite the golden files")

func readTestdata(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// want is what a test expects of one parsed question.
type want struct {
	label, question, kind string
	options               int
	rec                   string // the recommendation's start
	option                int    // the option it names (-1: none)
	context               []string
}

func check(t *testing.T, qs []followup.Question, wants []want) {
	t.Helper()
	if len(qs) != len(wants) {
		t.Fatalf("%d questions; want %d", len(qs), len(wants))
	}
	for i, w := range wants {
		q := qs[i]
		if q.ID != fmt.Sprintf("q%d", i+1) || q.Label != w.label || q.Question != w.question || q.Kind != w.kind || len(q.Options) != w.options {
			t.Errorf("question %d = %s %q %q %s, %d options; want %s %q %s, %d", i+1, q.ID, q.Label, q.Question, q.Kind, len(q.Options), w.label, w.question, w.kind, w.options)
		}
		if q.Recommendation == nil || !strings.HasPrefix(q.Recommendation.Text, w.rec) {
			t.Errorf("%s recommendation = %+v; want it to start %q", w.label, q.Recommendation, w.rec)
			continue
		}
		got := -1
		if q.Recommendation.Option != nil {
			got = *q.Recommendation.Option
		}
		if got != w.option {
			t.Errorf("%s recommends option %d; want %d", w.label, got, w.option)
		}
		for _, c := range w.context {
			if !strings.Contains(q.Context, c) {
				t.Errorf("%s context %q lacks %q", w.label, q.Context, c)
			}
		}
	}
}

// The incident's round (#60): ten questions, each kept with its label, its
// context, its options when it has any (sub-questions are not options) and
// its recommendation.
func TestParseRoundIncident(t *testing.T) {
	qs, unlisted, err := followup.ParseRound(followup.SampleGrill)
	if err != nil || unlisted != 0 {
		t.Fatalf("ParseRound = %d unlisted, %v", unlisted, err)
	}
	check(t, qs, []want{
		{"Q8", "Hire params captured at creation", "open", 0, "Store the full spec (floor, harness, model, effort, cwd, worktree)", -1,
			[]string{"A `worker.hire` needs floor", "- cwd: source worker's cwd. If that was a worktree that's gone by fire time, then what?", "- worktree flag: the default?"}},
		{"Q9", "Asleep floor at fire time", "choice", 3, "(c), default on. The whole point is not having to remember.", 2,
			[]string{"`floor.wake` resumes **every** worker"}},
		{"Q10", "Desks full at fire time", "choice", 2, "(b). A soak follow-up", 1, nil},
		{"Q11", "How the handoff reaches the new agent", "choice", 2, "(b). Size-safe", 1, []string{"The prompt limit is 32 KiB"}},
		{"Q12", "Handoff source on create", "open", 0, "Chip: literal handoff", -1, []string{"- Should LLM/agent handoff modes be offered too?"}},
		{"Q13", "Detection pipeline & toggle", "open", 0, "A separate bridge setting", -1, []string{"Separate settings toggle or shared with follow-ups? Default?"}},
		{"Q14", "Office display form", "choice", 3, "(c). Schedules belong to a floor", 2, []string{"departures board"}},
		{"Q15", "Manual creation entry points", "open", 0, "The first two.", -1, []string{"- A keyboard shortcut?", "Where can you create one without a chip?"}},
		{"Q16", "Notifying outcomes", "open", 0, "Game toast plus display status.", -1, nil},
		{"Q17", "Defining \"missed\"", "open", 0, "5 min grace. Under that it just runs", -1, nil},
	})
	q9 := qs[1]
	if q9.Options[2] != `(c) Per-schedule checkbox "wake floor if asleep", default on.` || strings.Contains(q9.Context, "(a)") {
		t.Fatalf("Q9 = %+v", q9)
	}
	if q10 := qs[2]; !strings.HasSuffix(q10.Options[1], "This counts toward lateness under `max_lateness`.") || q10.Context != "" {
		t.Fatalf("Q10 = %+v: its long option is kept whole", q10)
	}
	// A recommendation spans its lines; the round's text around the blocks is no question's.
	if q8 := qs[0].Recommendation.Text; !strings.HasSuffix(q8, "Desk is picked at fire time, not stored.") {
		t.Fatalf("Q8's recommendation = %q", q8)
	}
	for _, q := range qs {
		if strings.Contains(q.Context, "Round 2.") || strings.Contains(q.Context, "➡️") || strings.Contains(q.Context, "❓") {
			t.Fatalf("%s context = %q", q.Label, q.Context)
		}
	}
}

func TestParseRoundFirstRound(t *testing.T) {
	qs, _, err := followup.ParseRound(readTestdata(t, "grill-round1.md"))
	if err != nil {
		t.Fatal(err)
	}
	check(t, qs, []want{
		{"Q1", "What fires", "choice", 3, "(c). Soak example", 2, []string{"When schedule triggers, what happens?"}},
		{"Q2", "One-shot vs recurring", "open", 0, "One-shot only for this epic.", -1, nil},
		{"Q3", "Detection → creation flow", "choice", 3, "(a). Never schedule", 0, nil},
		{"Q4", "Prompt content of suggestion", "open", 0, "One schedule per message.", -1, nil},
		{"Q5", "Missed-window policy shape", "open", 0, "Per-schedule policy", -1, []string{"- Default policy?"}},
		{"Q6", "Time input & tz", "open", 0, "Yes as stated.", -1, nil},
		{"Q7", "Edit/cancel lifecycle", "open", 0, "Yes, including \"run now\"", -1, nil},
	})
	if strings.Contains(qs[6].Recommendation.Text, "Answer these") {
		t.Fatalf("Q7's recommendation took the round's last line: %q", qs[6].Recommendation.Text)
	}
}

// The other header (the title in the label's bold), recommendations that
// are bold-led and span lines, open questions with sub-questions.
func TestParseRoundOpenQuestions(t *testing.T) {
	qs, _, err := followup.ParseRound(readTestdata(t, "grill-open.md"))
	if err != nil {
		t.Fatal(err)
	}
	check(t, qs, []want{
		{"Q18", "Who may switch the night shift on", "open", 0, "**Yes to both.** A night shift keeps workers running", -1, []string{"Should switching a floor to night shift need"}},
		{"Q19", "Lamp colour at dusk", "open", 0, "**White on night shift floors only.**", -1, []string{"- Does the amber fade still run on the other floors?"}},
	})
	if r := qs[0].Recommendation.Text; !strings.HasSuffix(r, "\nThe audit row makes a surprise bill traceable.") {
		t.Fatalf("Q18's recommendation = %q: want both its lines", r)
	}
	if strings.Contains(qs[1].Recommendation.Text, "Once the research lands") {
		t.Fatal("the round's closing line is in Q19's recommendation")
	}
}

// Letters inline in the body, em dashes: #166's round.
func TestParseRoundInlineLetters(t *testing.T) {
	qs, _, err := followup.ParseRound(grillRound)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 6 {
		t.Fatalf("%d questions", len(qs))
	}
	q := qs[0]
	if q.Label != "Q1" || q.Question != "What is a Project?" || q.Kind != followup.KindChoice || len(q.Options) != 4 ||
		q.Options[3] != "(d) a named entity in config, seeded from the repository" || q.Context != "Candidates:" {
		t.Fatalf("Q1 = %+v", q)
	}
	if o := q.Recommendation.Option; o == nil || *o != 3 {
		t.Fatalf("Q1 recommends %v; want (d)", o)
	}
}

func TestParseRoundRejects(t *testing.T) {
	block := func(n int) string {
		return fmt.Sprintf("❓ **Q%d** - **Title %d**: Which?\n- (a) One\n- (b) Two\n\n➡️ (a).\n\n", n, n)
	}
	for name, tc := range map[string]struct {
		text string
		want string
	}{
		"no block":          {"Should I go on?", ""},
		"in a code fence":   {"```\n" + block(1) + "```\nShould I?", ""},
		"a loose question":  {block(1) + "❓ Should I also bump the version?", "block 2 does not start like"},
		"twice the same Q":  {block(1) + block(1), "Q1 is asked twice"},
		"no bold":           {"❓ Q1 - Title: which?\n➡️ (a)", "block 1 does not start like"},
		"title only spaces": {"❓ **Q1** - ** **: which?", "has no title"},
	} {
		t.Run(name, func(t *testing.T) {
			qs, _, err := followup.ParseRound(tc.text)
			switch {
			case tc.want == "" && !errors.Is(err, followup.ErrNotARound):
				t.Fatalf("ParseRound = %+v, %v; want ErrNotARound", qs, err)
			case tc.want != "" && (err == nil || errors.Is(err, followup.ErrNotARound) || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("ParseRound = %+v, %v; want %q", qs, err, tc.want)
			}
		})
	}
	// Over the bound: the rest are counted, never dropped silently.
	var b strings.Builder
	for i := range followup.MaxRoundQuestions + 2 {
		b.WriteString(block(i + 1))
	}
	qs, unlisted, err := followup.ParseRound(b.String())
	if err != nil || len(qs) != followup.MaxRoundQuestions || unlisted != 2 {
		t.Fatalf("ParseRound = %d questions, %d unlisted, %v", len(qs), unlisted, err)
	}
}

// A malformed block sends the message to the LLM, which reads it.
func TestRunSendsAMalformedRoundToTheLLM(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.9
	r.llm.Text = twoQuestions
	text := "❓ **Q1** - **Ship it**: now?\n➡️ Yes.\n\n❓ Should I also bump the version?"
	res, err := followup.Run(context.Background(), r.cls, r.llm, text, 0.7)
	if err != nil || res.Source != followup.SourceModel || len(res.Questions) != 2 || !strings.Contains(res.NotRound, "block 2") {
		t.Fatalf("Run = %+v, %v", res, err)
	}
}

// Rounds of 8, 9 and 10 questions keep every one, read as a round (no call)
// and listed by the LLM.
func TestRunKeepsEveryQuestion(t *testing.T) {
	for _, n := range []int{8, 9, 10} {
		t.Run(fmt.Sprintf("%d as a round", n), func(t *testing.T) {
			r := newRoles()
			r.cls.Score = 0.9
			var b strings.Builder
			for i := range n {
				fmt.Fprintf(&b, "❓ **Q%d** - **Decision %d**: Which?\n- (a) One\n- (b) Two\n\n➡️ (b), because.\n\n", i+1, i+1)
			}
			res, err := followup.Run(context.Background(), r.cls, r.llm, b.String(), 0.7)
			if err != nil || res.Source != followup.SourceParsed || len(res.Questions) != n || res.Unlisted != 0 {
				t.Fatalf("Run = %+v, %v", res, err)
			}
			if _, l := r.calls(); l != 0 {
				t.Fatal("a round went to the LLM")
			}
		})
		t.Run(fmt.Sprintf("%d by the LLM", n), func(t *testing.T) {
			r := newRoles()
			r.cls.Score = 0.9
			r.llm.Text = manyQuestions(n)
			res, err := followup.Run(context.Background(), r.cls, r.llm, "Should I? And this? (… n questions)", 0.7)
			if err != nil || res.Source != followup.SourceModel || len(res.Questions) != n || res.Unlisted != 0 {
				t.Fatalf("Run = %+v, %v", res, err)
			}
			if q := res.Questions[n-1]; q.ID != fmt.Sprintf("q%d", n) || q.Question != fmt.Sprintf("Q%d?", n-1) {
				t.Fatalf("last question = %+v", q)
			}
		})
	}
}

// Over MaxQuestions, and what the LLM says it left out: counted.
func TestParseCountsWhatItLeavesOut(t *testing.T) {
	qs, unlisted, err := followup.Parse(manyQuestions(followup.MaxQuestions + 3))
	if err != nil || len(qs) != followup.MaxQuestions || unlisted != 3 {
		t.Fatalf("Parse = %d, %d unlisted, %v", len(qs), unlisted, err)
	}
	qs, unlisted, err = followup.Parse(`{"questions":[{"question":"Which?","kind":"open"}],"more":4}`)
	if err != nil || len(qs) != 1 || unlisted != 4 {
		t.Fatalf("Parse with more = %d, %d unlisted, %v", len(qs), unlisted, err)
	}
}

// The extended schema: label, context, recommendation (with its option and
// reason) survive Parse.
func TestParseKeepsRecommendations(t *testing.T) {
	qs, _, err := followup.Parse(`{"questions":[
		{"label":"Q9","question":"Asleep floor at fire time: what then?","kind":"choice",
		 "options":["(a) Auto-wake the floor, then hire.","(b) Mark it failed.","(c) A per-schedule checkbox, default on."],
		 "context":"A hire on an asleep floor returns ` + "`invalid_state`" + `.\n- floor.wake resumes every worker",
		 "recommendation":"(c), default on.","recommended_option":3,"why":"The whole point is not having to remember."},
		{"label":"not a label at all","question":"Grace period?","kind":"open","recommendation":"5 min grace.\nUnder that it just runs.","recommended_option":2}]}`)
	if err != nil {
		t.Fatal(err)
	}
	q := qs[0]
	if q.Label != "Q9" || !strings.Contains(q.Context, "\n- floor.wake") || q.Recommendation == nil || q.Recommendation.Text != "(c), default on." ||
		q.Recommendation.Why != "The whole point is not having to remember." || q.Recommendation.Option == nil || *q.Recommendation.Option != 2 {
		t.Fatalf("Q9 = %+v %+v", q, q.Recommendation)
	}
	if q := qs[1]; q.Label != "" || q.Recommendation.Text != "5 min grace.\nUnder that it just runs." || q.Recommendation.Option != nil {
		t.Fatalf("open = %+v %+v: its lines kept, no option", q, q.Recommendation)
	}
	b, _ := json.Marshal(qs[0])
	if !strings.Contains(string(b), `"recommendation":{"text":"(c), default on.","why":"The whole point is not having to remember.","option":2}`) {
		t.Fatalf("JSON = %s", b)
	}
}

// One invalid question does not cost the round: left out and counted, a
// choice with bad options becomes an open question.
func TestParseRepairsOrCountsAnInvalidQuestion(t *testing.T) {
	qs, unlisted, err := followup.Parse(`{"questions":[
		{"question":"Ship now?","kind":"yes_no"},
		{"question":"","kind":"open"},
		{"question":"Which?","kind":"multi"},
		{"question":"Which one?","kind":"choice","options":["A"]},
		{"question":"Name it?","kind":"open"}]}`)
	if err != nil || len(qs) != 3 || unlisted != 2 {
		t.Fatalf("Parse = %+v, %d unlisted, %v", qs, unlisted, err)
	}
	if q := qs[1]; q.ID != "q2" || q.Kind != followup.KindOpen || q.Options != nil || q.Context != "- A" {
		t.Fatalf("the one-option choice = %+v", q)
	}
	if qs[2].ID != "q3" || qs[2].Question != "Name it?" {
		t.Fatalf("ids are not in order: %+v", qs)
	}
}

// truncated is the error of an answer cut off at the budget.
var truncated = &ai.Error{Kind: ai.KindTruncated, Msg: "the model used its whole completion budget (8192 of 8192 tokens, 8192 of them reasoning) before writing any text"}

var listed = ai.Reasoning{Support: ai.SupportYes, Listed: true, Efforts: []string{"none", "low", "medium", "high"}, Default: "medium"}

// The extraction's call: the budget, low effort when the catalog lists it,
// no partial answer; cut off, once more with no reasoning; cut off again,
// the error (the fallback's).
func TestExtractLLMBudgetAndRetry(t *testing.T) {
	ctx := context.Background()
	for name, tc := range map[string]struct {
		r       ai.Reasoning
		answers []error
		efforts []string
		ok      bool
	}{
		"low, at once":          {listed, []error{nil}, []string{"low"}, true},
		"cut off, then none":    {listed, []error{truncated, nil}, []string{"low", "none"}, true},
		"empty, then none":      {listed, []error{&ai.Error{Kind: ai.KindEmpty, Msg: "the model returned no text"}, nil}, []string{"low", "none"}, true},
		"cut off twice":         {listed, []error{truncated, truncated}, []string{"low", "none"}, false},
		"a timeout is no retry": {listed, []error{&ai.Error{Kind: ai.KindTimeout, Msg: "timed out"}}, []string{"low"}, false},
		"mandatory reasoning":   {ai.Reasoning{Support: ai.SupportYes, Listed: true, Efforts: []string{"minimal", "low", "high"}, Mandatory: true}, []error{truncated, nil}, []string{"low", "minimal"}, true},
		"unknown: nothing sent": {ai.UnknownReasoning(), []error{truncated}, []string{""}, false},
		"no low on the list":    {ai.Reasoning{Support: ai.SupportYes, Listed: true, Efforts: []string{"high"}}, []error{truncated}, []string{""}, false},
	} {
		t.Run(name, func(t *testing.T) {
			llm := &ai.FakeLLM{}
			llm.Func = func(_ context.Context, req ai.Request) (string, error) {
				if err := tc.answers[len(llm.Calls())-1]; err != nil {
					return "", err
				}
				return twoQuestions, nil
			}
			qs, _, efforts, err := followup.ExtractLLM(ctx, llm, "Should I?", tc.r)
			if (err == nil) != tc.ok || (tc.ok && len(qs) != 2) {
				t.Fatalf("ExtractLLM = %+v, %v", qs, err)
			}
			if fmt.Sprint(efforts) != fmt.Sprint(tc.efforts) {
				t.Fatalf("efforts = %q; want %q", efforts, tc.efforts)
			}
			for i, req := range llm.Calls() {
				if req.MaxTokens != followup.ExtractMaxTokens || !req.NoPartial || !req.JSON || req.BudgetWins || req.Timeout != followup.ExtractTimeout || !req.NoUncertainRetry || req.ReasoningEffort != tc.efforts[i] {
					t.Fatalf("call %d = %+v", i+1, req)
				}
			}
		})
	}
}

// Through Detect: the effort comes from the AI integration's catalog, and a
// round cut off twice is the fallback, with why.
func TestDetectFallsBackAfterTheRetry(t *testing.T) {
	now := mustNow()
	r := passingRoles()
	rr := &reasoningRoles{roles: r, r: listed}
	s, err := followup.New(context.Background(), followup.Options{Roles: rr, Store: &memStore{enabled: true, threshold: 0.7, ok: true}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	r.llm.Func, r.llm.Text, r.llm.Err = nil, "", truncated
	res, err := s.Detect(context.Background(), followup.SampleQuestions)
	if err != nil || res.Source != followup.SourceFallback || !strings.Contains(res.ExtractErr, "whole completion budget") {
		t.Fatalf("Detect = %+v, %v", res, err)
	}
	if fmt.Sprint(res.Efforts) != "[low none]" {
		t.Fatalf("efforts = %q", res.Efforts)
	}
	// Retry: the extraction alone, no classifier.
	c0, _ := r.calls()
	r.llm.Err, r.llm.Text = nil, twoQuestions
	ex, err := s.Retry(context.Background(), followup.SampleQuestions)
	if err != nil || ex.Source != followup.SourceModel || len(ex.Questions) != 2 {
		t.Fatalf("Retry = %+v, %v", ex, err)
	}
	if c, _ := r.calls(); c != c0 {
		t.Fatal("the retry classified the message again")
	}
}

// The incident's round read whole, as JSON: game/fixtures/followup-grill.json
// is what the fixture bridge shows of it (go test -run Golden -update).
func TestGrillGolden(t *testing.T) {
	qs, _, err := followup.ParseRound(followup.SampleGrill)
	if err != nil {
		t.Fatal(err)
	}
	f := followup.Followup{TurnID: "grill0000000060a", Questions: qs, Score: 0.89, Source: followup.SourceParsed, At: 1_792_064_661_000}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := filepath.Join("..", "..", "game", "fixtures", "followup-grill.json")
	if *update {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(b) {
		t.Fatalf("%s is not the parsed round (go test ./internal/followup -run Golden -update): %v", path, err)
	}
}
