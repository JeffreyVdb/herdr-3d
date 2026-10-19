package schedsuggest_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/schedsuggest"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// roles plays the AI integration: each role's state, the fakes, and (with
// reasoning set) what the LLM's catalog says of its efforts.
type roles struct {
	state     map[ai.Role]ai.State
	cls       *ai.FakeClassifier
	llm       *ai.FakeLLM
	reasoning *ai.Reasoning
}

func newRoles() *roles {
	return &roles{
		state: map[ai.Role]ai.State{ai.RoleClassifier: ai.StateReady, ai.RoleLLM: ai.StateReady},
		cls:   &ai.FakeClassifier{},
		llm:   &ai.FakeLLM{},
	}
}

func (r *roles) State(x ai.Role) ai.State  { return r.state[x] }
func (r *roles) Classifier() ai.Classifier { return r.cls }
func (r *roles) LLM() ai.LLM               { return r.llm }
func (r *roles) calls() (cls, llm int)     { return len(r.cls.Calls()), len(r.llm.Calls()) }

// withReasoning is roles that also say what the LLM's catalog lists.
type withReasoning struct{ *roles }

func (r withReasoning) ModelReasoning(context.Context) ai.Reasoning { return *r.reasoning }

type memStore struct {
	enabled   bool
	threshold float64
	zone      string
	ok        bool
	saves     int
}

func (m *memStore) LoadScheduleSuggestSettings(context.Context) (bool, float64, string, bool, error) {
	return m.enabled, m.threshold, m.zone, m.ok, nil
}

func (m *memStore) SaveScheduleSuggestSettings(_ context.Context, en bool, th float64, zone string) error {
	m.enabled, m.threshold, m.zone, m.ok = en, th, zone, true
	m.saves++
	return nil
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

// newService is a ready service at now (switched on, zone stored).
func newService(t *testing.T, r schedsuggest.Roles, zone string, now func() time.Time) *schedsuggest.Service {
	t.Helper()
	svc, err := schedsuggest.New(context.Background(), schedsuggest.Options{Roles: r,
		Store: &memStore{enabled: true, threshold: schedsuggest.DefaultThreshold, zone: zone, ok: true}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

// goldenCase is one case of testdata/golden.json: a message (a file, or the
// final message of a Codex rollout read as the bridge reads it), the time
// and zone it is read at, the gate's score and the LLM's answer, and what
// comes of it: a suggestion due at want_due (UTC), or none (want_why: "gate"
// below the threshold, else a part of why).
type goldenCase struct {
	Name     string  `json:"name"`
	Message  string  `json:"message"`
	Codex    string  `json:"codex"`
	Now      string  `json:"now"`
	Zone     string  `json:"zone"`
	Score    float64 `json:"score"`
	LLM      string  `json:"llm"`
	WantDue  string  `json:"want_due"`
	WantWhy  string  `json:"want_why"`
	Tolerate int     `json:"live_tolerance_min"`
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct{ Cases []goldenCase }
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g.Cases
}

// text is the case's message: a file as it is, or a Codex rollout's final
// message as the follow-up tracker reads it at the turn's end.
func (c goldenCase) text(t *testing.T) string {
	t.Helper()
	if c.Codex == "" {
		b, err := os.ReadFile(filepath.Join("testdata", c.Message))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	f, err := os.Open(filepath.Join("testdata", c.Codex))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := transcript.NewFollowupTracker(transcript.Codex)
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		tr.Line(sc.Bytes())
	}
	turn := tr.Turn()
	if turn == nil {
		t.Fatalf("%s: no ended turn", c.Codex)
	}
	return turn.Text
}

// The golden cases with canned models: each gives a suggestion at the right
// UTC instant, or none; the LLM is asked only past the gate, with the
// message, the time in UTC and the user's zone.
func TestGolden(t *testing.T) {
	t.Parallel()
	for _, c := range loadGolden(t) {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			r := newRoles()
			r.cls.Score, r.llm.Text = c.Score, c.LLM
			now := mustTime(t, c.Now)
			svc := newService(t, r, c.Zone, func() time.Time { return now })
			text := c.text(t)
			res, err := svc.Detect(context.Background(), text)
			if err != nil {
				t.Fatal(err)
			}
			calls := r.cls.Calls()
			if len(calls) != 1 || calls[0].Question != schedsuggest.GateQuestion || calls[0].State["last_agent_message"] != text {
				t.Fatalf("classifier calls = %+v", calls)
			}
			llm := r.llm.Calls()
			if c.WantWhy == "gate" {
				if res.Flag || res.Draft != nil || len(llm) != 0 {
					t.Fatalf("under the gate: %+v, %d LLM calls", res, len(llm))
				}
				return
			}
			if len(llm) != 1 {
				t.Fatalf("%d LLM calls", len(llm))
			}
			req := llm[0]
			user := req.Messages[1].Content
			if !strings.Contains(user, "Current time: "+now.UTC().Format(time.RFC3339)) || !strings.HasSuffix(user, text) || !req.JSON || !req.NoPartial || !req.NoUncertainRetry {
				t.Fatalf("request = %+v", req)
			}
			if c.Zone != "" && !strings.Contains(user, "The user's time zone: "+c.Zone) {
				t.Fatalf("no zone in %q", user)
			}
			if c.WantDue == "" {
				if res.Draft != nil || !strings.Contains(res.Why, c.WantWhy) {
					t.Fatalf("want none (%q), got %+v", c.WantWhy, res.Extraction)
				}
				return
			}
			if res.Draft == nil {
				t.Fatalf("no draft: %s", res.Why)
			}
			if got := res.Draft.DueAt.Format(time.RFC3339); got != c.WantDue || res.Draft.DueAt.Location() != time.UTC {
				t.Fatalf("due_at = %s (%v), want %s", got, res.Draft.DueAt.Location(), c.WantDue)
			}
			if res.Draft.Title == "" || !strings.Contains(res.Draft.Prompt, "handoff") {
				t.Fatalf("draft = %+v", res.Draft)
			}
		})
	}
}

// The gate: below the threshold the LLM is never asked; at it, it is.
func TestGateThreshold(t *testing.T) {
	t.Parallel()
	now := mustTime(t, "2026-10-18T10:00:00Z")
	for _, c := range []struct {
		score float64
		llm   int
	}{{0.69, 0}, {0.7, 1}, {0.95, 1}} {
		r := newRoles()
		r.cls.Score, r.llm.Text = c.score, `{"none":true}`
		res, err := newService(t, r, "", func() time.Time { return now }).Detect(context.Background(), "Soak for 24h.")
		if err != nil {
			t.Fatal(err)
		}
		if _, n := r.calls(); n != c.llm || res.Flag != (c.llm == 1) {
			t.Fatalf("score %.2f: flag %v, %d LLM calls", c.score, res.Flag, n)
		}
		if c.llm == 1 && (res.Draft != nil || res.Why != schedsuggest.WhyNone) {
			t.Fatalf("score %.2f: %+v", c.score, res.Extraction)
		}
	}
}

// Every invalid answer is no suggestion, with why; the valid parts are
// bounded (a long title cut, an offset kept in UTC).
func TestParse(t *testing.T) {
	t.Parallel()
	now := mustTime(t, "2026-10-18T10:00:00Z")
	long := strings.Repeat("é", 150) // 300 bytes
	for _, c := range []struct {
		name, out, why string
		due, title     string
	}{
		{name: "none", out: `{"none":true}`, why: "none"},
		{name: "prose around", out: "Sure:\n```json\n{\"due_at\":\"2026-10-18T13:00:00+02:00\",\"title\":\"x\",\"draft_prompt\":\"Do it.\"}\n```", due: "2026-10-18T11:00:00Z"},
		{name: "no json", out: "nothing to schedule", why: "did not answer with a JSON object"},
		{name: "not a suggestion", out: `{"due_at":12}`, why: "not a suggestion"},
		{name: "no offset", out: `{"due_at":"2026-10-19T10:45:00","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "date only", out: `{"due_at":"2026-10-19","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		// time.RFC3339 alone takes these (#66 R1): none is RFC 3339.
		{name: "offset hour 24", out: `{"due_at":"2026-10-20T10:00:00+24:00","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "offset minute 60", out: `{"due_at":"2026-10-19T10:00:00+01:60","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "one-digit hour", out: `{"due_at":"2026-10-19T1:00:00Z","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "comma fraction", out: `{"due_at":"2026-10-19T10:00:00,5Z","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "lowercase t", out: `{"due_at":"2026-10-19t10:00:00Z","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "lowercase z", out: `{"due_at":"2026-10-19T10:00:00z","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "space for T", out: `{"due_at":"2026-10-19 10:00:00Z","title":"t","draft_prompt":"p"}`, why: "RFC 3339"},
		{name: "fraction", out: `{"due_at":"2026-10-19T10:00:00.5Z","title":"t","draft_prompt":"p"}`, due: "2026-10-19T10:00:00Z"},
		{name: "offset -00:00", out: `{"due_at":"2026-10-19T10:00:00-00:00","title":"t","draft_prompt":"p"}`, due: "2026-10-19T10:00:00Z"},
		{name: "offset +23:59", out: `{"due_at":"2026-10-19T10:00:00+23:59","title":"t","draft_prompt":"p"}`, due: "2026-10-18T10:01:00Z"},
		{name: "past", out: `{"due_at":"2026-10-18T09:59:59Z","title":"t","draft_prompt":"p"}`, why: "not in the future"},
		{name: "now", out: `{"due_at":"2026-10-18T10:00:00Z","title":"t","draft_prompt":"p"}`, why: "not in the future"},
		{name: "31 days", out: `{"due_at":"2026-11-18T10:00:01Z","title":"t","draft_prompt":"p"}`, why: "more than 30 days"},
		{name: "30 days", out: `{"due_at":"2026-11-17T10:00:00Z","title":"t","draft_prompt":"p"}`, due: "2026-11-17T10:00:00Z"},
		{name: "empty title", out: `{"due_at":"2026-10-19T10:00:00Z","title":" \n ","draft_prompt":"p"}`, why: "title is empty"},
		{name: "empty prompt", out: `{"due_at":"2026-10-19T10:00:00Z","title":"t","draft_prompt":"\t"}`, why: "draft prompt is empty"},
		{name: "flag prompt", out: `{"due_at":"2026-10-19T10:00:00Z","title":"t","draft_prompt":"--help"}`, why: "starts with"},
		{name: "huge prompt", out: `{"due_at":"2026-10-19T10:00:00Z","title":"t","draft_prompt":"` + strings.Repeat("a", schedsuggest.MaxPrompt+1) + `"}`, why: "bytes (at most"},
		{name: "long title", out: `{"due_at":"2026-10-19T10:00:00Z","title":"` + long + `\nmore","draft_prompt":"p"}`, due: "2026-10-19T10:00:00Z", title: "cut"},
	} {
		d, err := schedsuggest.Parse(c.out, now)
		if c.why != "" {
			if err == nil || !strings.Contains(err.Error(), c.why) {
				t.Errorf("%s: err = %v, want %q", c.name, err, c.why)
			}
			if c.why == "none" && !errors.Is(err, schedsuggest.ErrNone) {
				t.Errorf("%s: not ErrNone", c.name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if got := d.DueAt.Format(time.RFC3339); got != c.due || d.DueAt.Location() != time.UTC {
			t.Errorf("%s: due %s", c.name, got)
		}
		if c.title == "cut" && (len(d.Title) > schedsuggest.MaxTitle || !strings.HasSuffix(d.Title, "…") || strings.Contains(d.Title, "\n")) {
			t.Errorf("%s: title %q (%d bytes)", c.name, d.Title, len(d.Title))
		}
	}
}

// The draft prompt keeps its lines; tabs become spaces, control characters
// go.
func TestParsePromptText(t *testing.T) {
	t.Parallel()
	d, err := schedsuggest.Parse(`{"due_at":"2026-10-19T10:00:00Z","title":"T\u0007itle","draft_prompt":"  Step 1:\r\n\tcheck\u001b[0m\n"}`, mustTime(t, "2026-10-18T10:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if d.Prompt != "Step 1:\n    check[0m" || d.Title != "T itle" {
		t.Fatalf("draft = %q / %q", d.Title, d.Prompt)
	}
}

// The extraction's failures are none, never an error, and never a second
// call after a timeout; a cut-off answer is tried once more with less
// reasoning when the model takes it, else not.
func TestExtractFailures(t *testing.T) {
	t.Parallel()
	now := mustTime(t, "2026-10-18T10:00:00Z")
	clock := func() time.Time { return now }
	truncated := &ai.Error{Kind: ai.KindTruncated, Msg: "cut off at the token limit"}
	for _, c := range []struct {
		name      string
		err       error
		reasoning *ai.Reasoning
		calls     int
		efforts   []string
	}{
		{"timeout", &ai.Error{Kind: ai.KindTimeout, Msg: "timed out"}, nil, 1, []string{""}},
		{"truncated, unknown model", truncated, nil, 1, []string{""}},
		{"truncated, reasoning model", truncated, &ai.Reasoning{Support: ai.SupportYes, Efforts: []string{"none", "low"}, Listed: true}, 2, []string{"low", "none"}},
	} {
		r := newRoles()
		r.cls.Score, r.llm.Err = 0.9, c.err
		var rs schedsuggest.Roles = r
		if c.reasoning != nil {
			r.reasoning = c.reasoning
			rs = withReasoning{r}
		}
		res, err := newService(t, rs, "", clock).Detect(context.Background(), "after the soak")
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		calls := r.llm.Calls()
		if !res.Flag || res.Draft != nil || !strings.Contains(res.Why, string(ai.KindOf(c.err))) || len(calls) != c.calls {
			t.Fatalf("%s: %+v, %d calls", c.name, res, len(calls))
		}
		for i, e := range c.efforts {
			if calls[i].ReasoningEffort != e {
				t.Fatalf("%s: call %d effort %q, want %q", c.name, i, calls[i].ReasoningEffort, e)
			}
		}
	}
}

// due_at is checked against the clock when the answer came, not when the
// message was sent: a slow answer whose time passed meanwhile is none.
func TestValidatedAtAnswer(t *testing.T) {
	t.Parallel()
	now := mustTime(t, "2026-10-18T10:00:00Z")
	r := newRoles()
	r.cls.Score = 0.9
	r.llm.Func = func(context.Context, ai.Request) (string, error) {
		now = now.Add(10 * time.Minute) // the call took its time
		return `{"due_at":"2026-10-18T10:05:00Z","title":"t","draft_prompt":"p"}`, nil
	}
	res, err := newService(t, r, "", func() time.Time { return now }).Detect(context.Background(), "in 5 minutes")
	if err != nil {
		t.Fatal(err)
	}
	if res.Draft != nil || !strings.Contains(res.Why, "not in the future") {
		t.Fatalf("%+v", res.Extraction)
	}
}

// Off, nothing is sent; a role that is not ready (also when it went while
// the classifier ran) makes no further call, and the state says which.
func TestNotReadySendsNothing(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	r := newRoles()
	r.cls.Score, r.llm.Text = 0.99, `{"none":true}`
	off, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: r, Store: &memStore{}})
	if err != nil {
		t.Fatal(err)
	}
	if v := off.View(); v.State != schedsuggest.StateOff || v.Enabled || v.Threshold != schedsuggest.DefaultThreshold || len(v.Env) != 0 {
		t.Fatalf("default view = %+v", v)
	}
	if _, err := off.Detect(ctx, "x"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("off: %v", err)
	}
	if _, err := off.Scored(ctx, "x", 0.99); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("off, scored: %v", err)
	}
	if c, l := r.calls(); c+l != 0 {
		t.Fatalf("off: %d classifier, %d LLM calls", c, l)
	}

	r.state[ai.RoleLLM] = ai.StateInvalid
	on := newService(t, r, "", nil)
	v := on.View()
	if v.State != schedsuggest.StateIncomplete || len(v.Missing) != 1 || v.Missing[0] != "llm" || v.Roles.LLM != "invalid" {
		t.Fatalf("incomplete view = %+v", v)
	}
	if _, err := on.Detect(ctx, "x"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("incomplete: %v", err)
	}
	if c, l := r.calls(); c+l != 0 {
		t.Fatalf("incomplete: %d classifier, %d LLM calls", c, l)
	}
	// Switching on needs both roles.
	en := true
	if err := off.Set(ctx, &en, nil); err == nil || err.(*schedsuggest.Error).Code != schedsuggest.CodeIncomplete {
		t.Fatalf("enable while incomplete: %v", err)
	}

	// The LLM goes while the classifier scores: no extraction.
	r2 := newRoles()
	svc := newService(t, r2, "", nil)
	r2.cls.Func = func(context.Context, map[string]any, string) (float64, error) {
		r2.state[ai.RoleLLM] = ai.StateOff
		return 0.99, nil
	}
	if _, err := svc.Detect(ctx, "x"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("gone meanwhile: %v", err)
	}
	if _, l := r2.calls(); l != 0 {
		t.Fatalf("gone meanwhile: %d LLM calls", l)
	}
}

// The settings: stored, bounded, and the environment's toggle wins.
func TestSettings(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := &memStore{}
	svc, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: newRoles(), Store: st})
	if err != nil {
		t.Fatal(err)
	}
	en, th := true, 0.8
	if err := svc.Set(ctx, &en, &th); err != nil {
		t.Fatal(err)
	}
	if v := svc.View(); v.State != schedsuggest.StateReady || v.Threshold != 0.8 || !st.enabled || st.threshold != 0.8 {
		t.Fatalf("after set: %+v, store %+v", v, st)
	}
	for _, bad := range []float64{0.01, 1, -1} {
		if err := svc.Set(ctx, nil, &bad); err == nil || err.(*schedsuggest.Error).Code != schedsuggest.CodeBadRequest {
			t.Fatalf("threshold %v: %v", bad, err)
		}
	}
	// A stored threshold out of bounds is the default.
	again, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: newRoles(), Store: &memStore{enabled: true, threshold: 3, ok: true}})
	if err != nil {
		t.Fatal(err)
	}
	if v := again.View(); v.Threshold != schedsuggest.DefaultThreshold || !v.Enabled {
		t.Fatalf("reloaded = %+v", v)
	}

	// The environment: on whatever the store says, read-only.
	off := false
	envOn := true
	env, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: newRoles(), Store: &memStore{}, EnvEnabled: &envOn})
	if err != nil {
		t.Fatal(err)
	}
	if v := env.View(); v.State != schedsuggest.StateReady || len(v.Env) != 1 || v.Env[0] != "enabled" {
		t.Fatalf("env view = %+v", v)
	}
	if err := env.Set(ctx, &off, nil); err == nil || err.(*schedsuggest.Error).Code != schedsuggest.CodeEnvLocked {
		t.Fatalf("switch off under env: %v", err)
	}
	if err := env.Set(ctx, nil, &th); err != nil {
		t.Fatalf("threshold under env: %v", err)
	}
}

// The user's zone: an IANA name only, stored, and read into the request;
// unset, the request says UTC.
func TestZone(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := &memStore{}
	r := newRoles()
	svc, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: r, Store: st})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "Local", "Mars/Olympus", "+02:00", "Europe/Brussels\n", strings.Repeat("A", 70)} {
		if _, err := svc.SetZone(ctx, bad); err == nil || err.(*schedsuggest.Error).Code != schedsuggest.CodeBadRequest {
			t.Fatalf("zone %q: %v", bad, err)
		}
	}
	changed, err := svc.SetZone(ctx, "Asia/Tokyo")
	if err != nil || !changed || st.zone != "Asia/Tokyo" || svc.View().Zone != "Asia/Tokyo" {
		t.Fatalf("set zone: %v %v %+v", changed, err, st)
	}
	if changed, _ := svc.SetZone(ctx, "Asia/Tokyo"); changed {
		t.Fatal("the same zone again changed it")
	}
	now := mustTime(t, "2026-10-18T10:00:00Z")
	r.cls.Score, r.llm.Text = 0.9, `{"none":true}`
	en := true
	_ = svc.Set(ctx, &en, nil)
	tokyo := newService(t, r, "Asia/Tokyo", func() time.Time { return now })
	if _, err := tokyo.Detect(ctx, "x"); err != nil {
		t.Fatal(err)
	}
	user := r.llm.Calls()[0].Messages[1].Content
	if !strings.Contains(user, "The user's time zone: Asia/Tokyo (now Sunday 2026-10-18 19:00 there, UTC+09:00).") {
		t.Fatalf("tokyo request: %q", user)
	}
	utc := newService(t, r, "", func() time.Time { return now })
	if _, err := utc.Detect(ctx, "x"); err != nil {
		t.Fatal(err)
	}
	if user := r.llm.Calls()[1].Messages[1].Content; !strings.Contains(user, "time zone is not known: read clock times without a zone as UTC") {
		t.Fatalf("unset zone request: %q", user)
	}
}

// Scored: the caller's score, the same threshold and readiness, no
// classifier call.
func TestScored(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	r := newRoles()
	r.llm.Text = `{"due_at":"2026-10-19T10:00:00Z","title":"t","draft_prompt":"p"}`
	now := mustTime(t, "2026-10-18T10:00:00Z")
	svc := newService(t, r, "", func() time.Time { return now })
	res, err := svc.Scored(ctx, "x", 0.5)
	if err != nil || res.Flag {
		t.Fatalf("under: %+v %v", res, err)
	}
	res, err = svc.Scored(ctx, "x", 0.7)
	if err != nil || !res.Flag || res.Draft == nil {
		t.Fatalf("at: %+v %v", res, err)
	}
	if c, l := r.calls(); c != 0 || l != 1 {
		t.Fatalf("%d classifier, %d LLM calls", c, l)
	}
}
