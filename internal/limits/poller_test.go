package limits

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func TestCodexPrimaryOnly(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"codex": codexAnswers(t, fixture(t, "codex_primary.json"))}
	l, err := c.probeCodex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []proto.LimitWindow{{Label: "week", Pct: 71, ResetsAt: 1791053830000, WindowMins: 10080}}
	if l.Provider != "codex" || l.Plan != "prolite" || l.Reached != "" || l.Stale || !slices.Equal(l.Windows, want) {
		t.Fatalf("got %+v", l)
	}
	if l.Credits == nil || l.Credits.Has || l.Credits.Balance != "0" {
		t.Errorf("credits %+v", l.Credits)
	}
	if got := r.started("codex")[0].Args; !slices.Equal(got, []string{"app-server"}) {
		t.Errorf("args %v", got)
	}
}

func TestCodexPrimaryAndSecondary(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"codex": codexAnswers(t, fixture(t, "codex_two.json"))}
	l, err := c.probeCodex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []proto.LimitWindow{
		{Label: "5h", Pct: 12.5, ResetsAt: 1790700000000, WindowMins: 300},
		{Label: "week", Pct: 19, ResetsAt: 1791053830000, WindowMins: 10080},
		{Label: "5h", Model: "Spark", Pct: 3, ResetsAt: 1790700100000, WindowMins: 300}, // rateLimitsByLimitId: another limit
	}
	if l.Plan != "pro" || !slices.Equal(l.Windows, want) {
		t.Fatalf("got %+v", l)
	}
	if l.Credits == nil || !l.Credits.Has || l.Credits.Balance != "42.5" {
		t.Errorf("credits %+v", l.Credits)
	}
}

func TestCodexRateLimitReached(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"codex": codexAnswers(t, fixture(t, "codex_reached.json"))}
	l, err := c.probeCodex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if l.Reached != "rate_limit_reached" || l.Windows[0].Pct != 100 {
		t.Fatalf("got %+v", l)
	}
}

func TestCodexAppServerErrorFallsBackToTranscript(t *testing.T) {
	c, r := newCfg(t, map[string]script{"codex": func(p *fakeProc) {
		sc := p.reader()
		for sc.Scan() {
			if strings.Contains(sc.Text(), `"id":1`) {
				p.say(`{"id":1,"result":{}}`)
			}
			if strings.Contains(sc.Text(), `"id":2`) {
				p.say(`{"id":2,"error":{"code":-32603,"message":"failed to fetch codex rate limits: 401 Unauthorized"}}`)
			}
		}
	}})
	c.CodexSessions = "testdata/codex-sessions"
	if _, err := c.probeCodex(context.Background()); err == nil || !strings.Contains(err.Error(), "401 Unauthorized") {
		t.Fatalf("probe err = %v", err)
	}
	p := New(c)
	l := p.read(context.Background(), proto.LimitsCodex, t0)
	// The newest rollout has no rate_limits: the fallback goes on to the one before, and takes its last token_count.
	want := []proto.LimitWindow{
		{Label: "5h", Pct: 45, ResetsAt: 1790600000000, WindowMins: 300},
		{Label: "week", Pct: 62, ResetsAt: 1791053830000, WindowMins: 10080},
	}
	if l.Source != proto.LimitsTranscript || !l.Stale || l.Error != proto.LimitsFailed || l.At != ms("2026-09-28T17:30:00Z") ||
		l.Plan != "prolite" || !slices.Equal(l.Windows, want) {
		t.Fatalf("got %+v", l)
	}
	_ = r
}

func TestCodexErrorWithoutTranscriptKeepsLastReading(t *testing.T) {
	ok := true
	c, _ := newCfg(t, nil)
	c.Runner = runnerFunc(func(c Cmd) (Process, error) {
		if ok {
			return newRunner(map[string]script{"codex": codexAnswers(t, fixture(t, "codex_primary.json"))}).Start(c)
		}
		return newRunner(map[string]script{"codex": func(p *fakeProc) {
			p.reader().Scan()
			p.say(`{"id":1,"error":{"message":"boom"}}`)
		}}).Start(c)
	})
	p := New(c)
	first := p.read(context.Background(), proto.LimitsCodex, t0)
	ok = false
	second := p.read(context.Background(), proto.LimitsCodex, t0.Add(time.Minute))
	if first.Stale || !second.Stale || second.Error != proto.LimitsFailed || !slices.Equal(first.Windows, second.Windows) || second.At != first.At {
		t.Fatalf("first %+v\nsecond %+v", first, second)
	}
	// With no reading before and no transcript, the error stands alone.
	fresh := New(c).read(context.Background(), proto.LimitsCodex, t0)
	if !fresh.Stale || fresh.Error != proto.LimitsFailed || len(fresh.Windows) != 0 || fresh.Provider != "codex" {
		t.Fatalf("fresh %+v", fresh)
	}
}

type runnerFunc func(Cmd) (Process, error)

func (f runnerFunc) Start(c Cmd) (Process, error) { return f(c) }

func TestNoPlanAndNotInstalled(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_no_plan.jsonl")}
	p := New(c)
	l := p.read(context.Background(), proto.LimitsClaude, t0)
	if l.Error != proto.LimitsNoPlan || l.Stale || len(l.Windows) != 0 || l.Windows == nil {
		t.Fatalf("no plan: %+v", l)
	}
	if got := p.state["claude"].next; !got.Equal(t0.Add(30 * time.Minute)) {
		t.Errorf("no plan: next %v, want +30m", got)
	}
	l = p.read(context.Background(), proto.LimitsCodex, t0) // no codex script: the CLI is not there
	if l.Error != proto.LimitsNotInstalled || !l.Stale {
		t.Fatalf("not installed: %+v", l)
	}
	if got := p.state["codex"].next; !got.Equal(t0.Add(30 * time.Minute)) {
		t.Errorf("not installed: next %v, want +30m", got)
	}
}

// A Codex CLI that is not installed on the bridge's PATH can still have left rollouts: they are shown, as of their time.
func TestCodexNotInstalledStillUsesTranscript(t *testing.T) {
	c, _ := newCfg(t, nil)
	c.CodexSessions = "testdata/codex-sessions"
	l := New(c).read(context.Background(), proto.LimitsCodex, t0) // no codex script: the CLI is not there
	if l.Error != proto.LimitsNotInstalled || l.Source != proto.LimitsTranscript || !l.Stale || len(l.Windows) == 0 {
		t.Fatalf("got %+v", l)
	}
}

func TestTimeoutReading(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": func(p *fakeProc) { p.hang() }}
	l := New(c).read(context.Background(), proto.LimitsClaude, t0)
	if l.Error != proto.LimitsTimeout || !l.Stale || l.Provider != "claude" {
		t.Fatalf("got %+v", l)
	}
}

// Every 2 minutes, three failures in a row back off to 10 minutes, a success
// starts over.
func TestScheduleAndBackoff(t *testing.T) {
	fail := true
	var calls int
	c, _ := newCfg(t, nil)
	c.ClaudeBin = "claude"
	c.Runner = runnerFunc(func(cmd Cmd) (Process, error) {
		if cmd.Path == "codex" {
			return nil, errNotInstalled // keep codex out of this: it is on the 30 min retry
		}
		calls++
		if fail {
			return nil, errors.New("exec failed")
		}
		return newRunner(map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl")}).Start(cmd)
	})
	p := New(c)
	ctx := context.Background()
	now := t0
	step := func(d time.Duration) int {
		now = now.Add(d)
		before := calls
		p.step(ctx, now)
		return calls - before
	}
	if step(0) != 1 { // failure 1
		t.Fatal("first step did not probe")
	}
	if step(time.Minute) != 0 || step(time.Minute+time.Second) != 1 { // due after 2 min: failure 2
		t.Fatal("not every 2 minutes")
	}
	if step(2*time.Minute) != 1 { // failure 3
		t.Fatal("no third probe")
	}
	if step(2*time.Minute) != 0 || step(7*time.Minute) != 0 { // backed off: 9 min in, not yet
		t.Fatal("did not back off to 10 minutes")
	}
	fail = false
	if step(time.Minute) != 1 { // 10 min after the third failure: success
		t.Fatal("no probe after the backoff")
	}
	if step(time.Minute) != 0 || step(time.Minute) != 1 { // back to every 2 minutes
		t.Fatal("did not go back to every 2 minutes")
	}
	if p.state["claude"].failures != 0 {
		t.Error("failures not reset")
	}
}

func TestRefreshAtMostEvery20Seconds(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl")}
	now := t0
	c.Now = func() time.Time { return now }
	p := New(c)
	p.step(context.Background(), now)
	now = now.Add(time.Second)
	if len(p.step(context.Background(), now)) != 0 {
		t.Fatal("probed again 1 s later")
	}
	if !p.Refresh() {
		t.Fatal("first refresh refused")
	}
	<-p.kick
	if got := p.step(context.Background(), now); len(got) == 0 {
		t.Fatal("refresh did not make the providers due")
	}
	now = now.Add(19 * time.Second)
	if p.Refresh() {
		t.Fatal("second refresh 19 s later queued")
	}
	now = now.Add(time.Second)
	if !p.Refresh() {
		t.Fatal("refresh after 20 s refused")
	}
}

// A refresh that is acknowledged while a probe is running is not lost: once
// that probe is done, both providers are read again (the reading in flight
// may be older than the request).
func TestRefreshDuringProbeReadsAgain(t *testing.T) {
	started := make(chan string, 8)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := map[string]int{}
	c, _ := newCfg(t, nil)
	c.Runner = runnerFunc(func(cmd Cmd) (Process, error) {
		mu.Lock()
		calls[cmd.Path]++
		first := calls[cmd.Path] == 1
		mu.Unlock()
		if first { // the first probe of each provider waits for the test
			started <- cmd.Path
			<-release
		}
		if cmd.Path == "codex" {
			return newRunner(map[string]script{"codex": codexAnswers(t, fixture(t, "codex_primary.json"))}).Start(cmd)
		}
		return newRunner(map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl")}).Start(cmd)
	})
	now := t0
	c.Now = func() time.Time { return now }
	p := New(c)
	ctx := context.Background()
	stepped := make(chan []proto.Limits)
	go func() { stepped <- p.step(ctx, now) }()
	<-started
	<-started // both probes are running
	if !p.Refresh() {
		t.Fatal("refresh during the probes was not queued")
	}
	<-p.kick
	close(release)
	if got := <-stepped; len(got) != 2 {
		t.Fatalf("first step read %d providers", len(got))
	}
	now = now.Add(time.Second) // far from the 2 min interval
	got := p.step(ctx, now)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || calls["claude"] != 2 || calls["codex"] != 2 {
		t.Fatalf("after the refresh: %d readings, probes %v; want a fresh read of both", len(got), calls)
	}
	// It is used up: the next step, a second later, reads nothing.
	mu.Unlock()
	got = p.step(ctx, now.Add(time.Second))
	mu.Lock()
	if len(got) != 0 {
		t.Fatalf("%d providers read again with nothing asked for", len(got))
	}
}

func TestRunDoesNotProbeWithoutAClient(t *testing.T) {
	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl"), "codex": codexAnswers(t, fixture(t, "codex_primary.json"))}
	c.Tick = 5 * time.Millisecond
	p := New(c)
	active := make(chan bool, 1)
	is := false
	got := make(chan proto.Limits, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Run(ctx, func() bool {
		select {
		case is = <-active:
		default:
		}
		return is
	}, func(l proto.Limits) { got <- l })
	time.Sleep(60 * time.Millisecond)
	if len(r.Started) != 0 {
		t.Fatalf("probed with no client: %v", r.Started)
	}
	active <- true
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case l := <-got:
			seen[l.Provider] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("no readings after a client came: %v", seen)
		}
	}
}

// Ten polls of both providers write no file anywhere under HOME (Claude's
// projects, Codex's sessions), and leave nothing in the temp directory.
func TestProbingCreatesNoSessionFiles(t *testing.T) {
	home := t.TempDir()
	tmp := t.TempDir()
	claudeProjects := filepath.Join(home, ".claude", "projects", "-some-project")
	codexSessions := filepath.Join(home, ".codex", "sessions")
	if err := os.MkdirAll(claudeProjects, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claudeProjects, "s1.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	copyTree(t, "testdata/codex-sessions", codexSessions)
	t.Setenv("HOME", home)
	t.Setenv("TMPDIR", tmp)

	c, r := newCfg(t, nil)
	r.scripts = map[string]script{"claude": claudeAnswers(t, "claude_team.jsonl"), "codex": codexAnswers(t, fixture(t, "codex_primary.json"))}
	c.CodexSessions = codexSessions
	now := t0
	c.Now = func() time.Time { return now }
	p := New(c)
	before := listing(t, home)
	for range 10 {
		now = now.Add(3 * time.Minute)
		if got := p.step(context.Background(), now); len(got) != 2 {
			t.Fatalf("poll returned %d readings", len(got))
		}
	}
	if len(r.started("claude")) != 10 || len(r.started("codex")) != 10 {
		t.Fatalf("started %d claude, %d codex probes, want 10 each", len(r.started("claude")), len(r.started("codex")))
	}
	if after := listing(t, home); !slices.Equal(before, after) {
		t.Fatalf("files under HOME changed:\nbefore %v\nafter  %v", before, after)
	}
	if left, _ := os.ReadDir(tmp); len(left) != 0 {
		t.Errorf("the probes left %d entries in the temp directory", len(left))
	}
	for _, c := range r.Started {
		if !strings.HasPrefix(c.Dir, tmp) {
			t.Errorf("probe ran in %q, want a fresh directory under %q", c.Dir, tmp)
		}
	}
}

func listing(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, path+" "+info.ModTime().String())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}
