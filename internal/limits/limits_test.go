package limits

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var t0 = time.Date(2026, 9, 29, 19, 0, 0, 0, time.UTC)

func newCfg(t testing.TB, sc map[string]script) (Config, *fakeRunner) {
	r := newRunner(sc)
	c := fastCfg(r)
	c.Now = func() time.Time { return t0 }
	c.defaults()
	return c, r
}

func ms(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func TestClaudeTeamPlan(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl")}
	l, err := c.probeClaude(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []proto.LimitWindow{
		{Label: "5h", Pct: 11, ResetsAt: ms("2026-09-29T20:00:00.111746Z"), WindowMins: 300},
		{Label: "week", Pct: 61.5, ResetsAt: ms("2026-09-29T22:00:00.111768Z"), WindowMins: 10080},
	}
	if l.Provider != "claude" || l.Plan != "team" || l.At != t0.UnixMilli() || l.Source != proto.LimitsProbe || !slices.Equal(l.Windows, want) {
		t.Fatalf("got %+v\nwant windows %+v", l, want)
	}
	// The probe: the issue's flags, a temp dir that is gone, no agent-session environment.
	cmd := r.started("claude")[0]
	if got := strings.Join(cmd.Args, " "); got != "-p --input-format stream-json --output-format stream-json --verbose --tools  --setting-sources  --strict-mcp-config --disable-slash-commands --no-session-persistence" {
		t.Errorf("args %q", got)
	}
	if !r.dirSeen[0] {
		t.Errorf("cwd %q did not exist", cmd.Dir)
	}
	if _, err := os.Stat(cmd.Dir); err == nil {
		t.Errorf("temp dir %q was left behind", cmd.Dir)
	}
	if slices.ContainsFunc(cmd.Env, func(kv string) bool { return strings.HasPrefix(kv, "CLAUDECODE") || strings.HasPrefix(kv, "HERDR_") }) {
		t.Errorf("env %v still has CLAUDECODE*/HERDR_*", cmd.Env)
	}
	if !slices.Contains(cmd.Env, "CLAUDE_CONFIG_DIR=/c") || !slices.Contains(cmd.Env, "PATH=/bin") {
		t.Errorf("env %v lost the rest", cmd.Env)
	}
	if r.procs[0].didKill() {
		t.Error("a process that answered and exited was killed")
	}
}

func TestClaudeModelScoped(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_model_scoped.jsonl")}
	l, err := c.probeClaude(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// model_scoped wins over the older seven_day_opus key when both are there.
	want := []proto.LimitWindow{
		{Label: "5h", Pct: 0, ResetsAt: ms("2026-09-29T20:00:00.111746Z"), WindowMins: 300},
		{Label: "week", Pct: 96, ResetsAt: ms("2026-09-29T22:00:00.111768Z"), WindowMins: 10080},
		{Label: "week", Model: "Fable", Pct: 0, ResetsAt: ms("2026-09-29T22:00:00Z"), WindowMins: 10080},
		{Label: "week", Model: "Opus", Pct: 33, WindowMins: 10080},
	}
	if !slices.Equal(l.Windows, want) {
		t.Fatalf("got %+v\nwant %+v", l.Windows, want)
	}
}

func TestClaudeOldOpusShape(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_old_opus.jsonl")}
	l, err := c.probeClaude(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	models := map[string]float64{}
	for _, w := range l.Windows {
		if w.Model != "" {
			models[w.Model] = w.Pct
		}
	}
	if l.Plan != "max" || len(l.Windows) != 4 || models["Opus"] != 72 || models["Sonnet"] != 8 {
		t.Fatalf("got %+v", l)
	}
}

func TestClaudeNoPlan(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_no_plan.jsonl")}
	if _, err := c.probeClaude(context.Background()); err != errNoPlan {
		t.Fatalf("err = %v, want errNoPlan", err)
	}
}

func TestClaudeErrorResponse(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_error.jsonl")}
	_, err := c.probeClaude(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("err = %v", err)
	}
}

func TestClaudeNotInstalled(t *testing.T) {
	c, _ := newCfg(t, map[string]script{})
	if _, err := c.probeClaude(context.Background()); err != errNotInstalled {
		t.Fatalf("err = %v", err)
	}
}

// A process that reads the request and never answers, but exits when its
// stdin closes: the probe times out and the process leaves by itself.
func TestClaudeTimeoutExitsOnStdinClose(t *testing.T) {
	c, r := newCfg(t, map[string]script{"claude": func(p *fakeProc) {
		p.reader().Scan()
		p.waitStdinClosed()
	}})
	start := time.Now()
	_, err := c.probeClaude(context.Background())
	if err != errTimeout {
		t.Fatalf("err = %v, want timeout", err)
	}
	if d := time.Since(start); d < c.Timeout || d > c.Timeout+c.Grace {
		t.Errorf("took %v, want about %v", d, c.Timeout)
	}
	if r.procs[0].didKill() {
		t.Error("a process that exits when its stdin closes was killed")
	}
}

// A process that never answers and ignores its stdin closing is killed,
// Grace after the timeout.
func TestClaudeNeverAnswersIsKilled(t *testing.T) {
	c, r := newCfg(t, map[string]script{"claude": func(p *fakeProc) { p.hang() }})
	start := time.Now()
	_, err := c.probeClaude(context.Background())
	if err != errTimeout {
		t.Fatalf("err = %v, want timeout", err)
	}
	if d := time.Since(start); d < c.Timeout+c.Grace-5*time.Millisecond || d > c.Timeout+c.Grace+time.Second {
		t.Errorf("took %v, want about timeout+grace = %v", d, c.Timeout+c.Grace)
	}
	if !r.procs[0].didKill() {
		t.Error("the process was not killed")
	}
	select {
	case <-r.procs[0].done:
	default:
		t.Error("the process was not reaped")
	}
}

// An answer arrives but the process then hangs: killed after the grace.
func TestClaudeAnsweredButHangsIsKilled(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": func(p *fakeProc) {
		p.reader().Scan()
		p.say(strings.Split(fixture(t, "claude_team.jsonl"), "\n")...)
		p.hang()
	}}
	l, err := c.probeClaude(context.Background())
	if err != nil || len(l.Windows) != 2 {
		t.Fatalf("got %+v, %v", l, err)
	}
	if !r.procs[0].didKill() {
		t.Error("the hanging process was not killed")
	}
}

func TestClaudeStreamEndsWithoutAnswer(t *testing.T) {
	c, _ := newCfg(t, map[string]script{"claude": func(p *fakeProc) { p.reader().Scan() }})
	if _, err := c.probeClaude(context.Background()); err == nil || err == errTimeout {
		t.Fatalf("err = %v, want a failure that is not a timeout", err)
	}
}

func TestClaudeIgnoresGarbageLines(t *testing.T) {
	c, _ := newCfg(t, map[string]script{"claude": func(p *fakeProc) {
		p.reader().Scan()
		p.say("not json", `{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{}}}`,
			fixture(t, "claude_team.jsonl"))
		p.waitStdinClosed()
	}})
	l, err := c.probeClaude(context.Background())
	if err != nil || l.Plan != "team" {
		t.Fatalf("got %+v, %v", l, err)
	}
}
