package hoststats

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type runCall struct {
	path string
	env  []string
}

// fakeRunner answers each run with the next script entry; a nil entry blocks
// until the context ends (a hang).
type fakeRunner struct {
	mu     sync.Mutex
	script []fakeRun
	calls  []runCall
}

type fakeRun struct {
	out  string
	exit int
	err  error
	hang bool
}

func (f *fakeRunner) Run(ctx context.Context, path string, env []string) ([]byte, int, error) {
	f.mu.Lock()
	f.calls = append(f.calls, runCall{path, slices.Clone(env)})
	var r fakeRun
	if len(f.script) > 0 {
		r, f.script = f.script[0], f.script[1:]
	}
	f.mu.Unlock()
	if r.hang {
		<-ctx.Done()
		return nil, -1, ctx.Err()
	}
	return []byte(r.out), r.exit, r.err
}

func (f *fakeRunner) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func osRelease(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func resolveAll(name string) string { return "/opt/bin/" + name }

type updatesRig struct {
	u   *Updates
	run *fakeRunner
	now *time.Time
}

func newUpdates(t *testing.T, release string, script ...fakeRun) *updatesRig {
	t.Helper()
	now := time.Unix(1_800_000_000, 0).UTC()
	r := &updatesRig{run: &fakeRunner{script: script}, now: &now}
	r.u = NewUpdates(UpdatesConfig{
		Runner: r.run, Resolve: resolveAll, OSRelease: osRelease(t, release), StateDir: "/state/h3d/checkupdates",
		Env: func() []string { return []string{"PATH=/usr/bin", "HOME=/home/x"} }, Timeout: 2 * time.Second,
	}, func() time.Time { return now })
	r.u.Refresh()
	return r
}

// poll runs one Poll and waits for its run to end: started is false when no
// run began (none ended within a moment).
func (r *updatesRig) poll(t *testing.T) (changed, started bool) {
	t.Helper()
	ch := make(chan bool, 1)
	r.u.Poll(context.Background(), func(c bool) { ch <- c })
	select {
	case changed = <-ch:
		return changed, true
	case <-time.After(150 * time.Millisecond):
		return false, false
	}
}

const archRelease = "NAME=Arch\nID=arch\n"

func TestUpdatesExitCodes(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{out: "linux 6.1-1 -> 6.2-1\nfirefox 1 -> 2\n\ngit 3 -> 4\n", exit: 0}, fakeRun{exit: 2}, fakeRun{exit: 1}, fakeRun{err: context.DeadlineExceeded})
	if r.u.Last() != nil {
		t.Fatal("nothing checked yet")
	}
	if ch, st := r.poll(t); !st || !ch {
		t.Fatal("exit 0 is a result")
	}
	first := *r.now
	if l := r.u.Last(); l == nil || l.Count != 3 || !l.CheckedAt.Equal(first) {
		t.Fatalf("exit 0, three lines: %+v", l)
	}
	*r.now = r.now.Add(13 * time.Hour)
	if ch, st := r.poll(t); !st || !ch {
		t.Fatal("exit 2 is a result")
	}
	if l := r.u.Last(); l == nil || l.Count != 0 || !l.CheckedAt.Equal(*r.now) {
		t.Fatalf("exit 2, none: %+v", l)
	}
	good := *r.u.Last()
	for i, name := range []string{"exit 1", "timeout"} {
		*r.now = r.now.Add(13 * time.Hour)
		if ch, st := r.poll(t); !st || ch {
			t.Fatalf("%s: started %v changed %v", name, st, ch)
		}
		if l := r.u.Last(); l == nil || *l != good {
			t.Fatalf("%s #%d keeps the last good count and its time: %+v, want %+v", name, i, l, good)
		}
	}
}

func TestUpdatesFailureWithNothingGoodStaysAbsent(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{exit: 1})
	r.poll(t)
	if r.u.Last() != nil {
		t.Fatal("a failed first run must not invent a count")
	}
}

func TestUpdatesTwelveHourCache(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{out: "a 1 -> 2\n"}, fakeRun{exit: 2}, fakeRun{exit: 1}, fakeRun{exit: 2})
	r.poll(t)
	first := *r.now
	for _, d := range []time.Duration{time.Second, time.Hour, 11*time.Hour + 59*time.Minute} {
		*r.now = first.Add(d)
		if _, started := r.poll(t); started {
			t.Fatalf("a second run after only %v", d)
		}
	}
	if r.run.count() != 1 {
		t.Fatalf("runs = %d", r.run.count())
	}
	*r.now = first.Add(12*time.Hour + time.Second)
	if _, started := r.poll(t); !started {
		t.Fatal("12 h later it asks again")
	}
	// A run that failed counts too: the next one is 12 h after it began, not at the next poll.
	*r.now = r.now.Add(12*time.Hour + time.Second)
	r.poll(t) // exit 1
	for range 5 {
		*r.now = r.now.Add(5 * time.Second)
		if _, started := r.poll(t); started {
			t.Fatal("a failed run is retried at once")
		}
	}
}

func TestUpdatesOneRunAtATime(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{hang: true})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 4)
	r.u.Poll(ctx, func(c bool) { done <- c })
	for r.run.count() == 0 {
		time.Sleep(time.Millisecond)
	}
	*r.now = r.now.Add(48 * time.Hour)
	r.u.Poll(ctx, nil)
	time.Sleep(20 * time.Millisecond)
	if r.run.count() != 1 {
		t.Fatalf("a second run started while one is in flight: %d", r.run.count())
	}
	cancel() // stopped watching: no result, but the attempt counts
	if <-done {
		t.Fatal("a cancelled run is no result")
	}
	if r.u.Last() != nil {
		t.Fatal("no result from a cancelled run")
	}
	r.run.script = []fakeRun{{exit: 2}}
	*r.now = r.now.Add(-47 * time.Hour) // 1 h after the attempt
	if _, started := r.poll(t); started {
		t.Fatal("a cancelled run is an attempt: nothing starts within 12 h of it")
	}
}

func TestUpdatesWatchCyclesStartOneRun(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{hang: true}, fakeRun{hang: true}, fakeRun{hang: true}, fakeRun{hang: true})
	for i := 0; i < 5; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan bool, 1)
		r.u.Poll(ctx, func(c bool) { done <- c })
		if i == 0 {
			for r.run.count() == 0 {
				time.Sleep(time.Millisecond)
			}
		}
		cancel()
		if i == 0 && <-done {
			t.Fatal("a cancelled run is no result")
		}
		*r.now = r.now.Add(time.Hour)
		time.Sleep(5 * time.Millisecond)
	}
	if n := r.run.count(); n != 1 {
		t.Fatalf("watch, unwatch, watch started %d runs inside 12 h, want 1", n)
	}
	*r.now = r.now.Add(12 * time.Hour)
	r.run.mu.Lock()
	r.run.script = []fakeRun{{out: "a 1 -> 2\n"}}
	r.run.mu.Unlock()
	if ch, st := r.poll(t); !st || !ch {
		t.Fatalf("12 h after the attempt the next one runs: started %v changed %v", st, ch)
	}
}

func TestUpdatesStoppedRunDropsItsStaleLock(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"cancel", "timeout"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			r := newUpdates(t, archRelease, fakeRun{hang: true}, fakeRun{exit: 2})
			dir := t.TempDir()
			r.u.cfg.StateDir = dir
			lock, keep := filepath.Join(dir, "db.lck"), filepath.Join(dir, "sync")
			for _, p := range []string{lock, keep} {
				if err := os.WriteFile(p, nil, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if name == "timeout" {
				r.u.cfg.Timeout = 20 * time.Millisecond
			}
			done := make(chan bool, 1)
			r.u.Poll(ctx, func(c bool) { done <- c })
			if name == "cancel" {
				for r.run.count() == 0 {
					time.Sleep(time.Millisecond)
				}
				cancel()
			}
			<-done
			if _, err := os.Stat(lock); !os.IsNotExist(err) {
				t.Fatalf("a stopped run left db.lck: %v", err)
			}
			if _, err := os.Stat(keep); err != nil {
				t.Fatalf("only db.lck goes: %v", err)
			}
			*r.now = r.now.Add(13 * time.Hour)
			if ch, st := r.poll(t); !st || !ch {
				t.Fatalf("the next due run works: started %v changed %v", st, ch)
			}
		})
	}
}

func TestUpdatesFinishedRunLeavesTheStateDirAlone(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{exit: 2})
	dir := t.TempDir()
	r.u.cfg.StateDir = dir
	other := filepath.Join(dir, "db.lck.other")
	if err := os.WriteFile(other, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, st := r.poll(t); !st {
		t.Fatal("no run")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("a finished run removed %v", err)
	}
}

func TestExecRunnerTermsTheGroupBeforeKilling(t *testing.T) {
	t.Parallel()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	lock := filepath.Join(dir, "db.lck")
	script := filepath.Join(dir, "fake.sh")
	body := "#!" + sh + "\ntrap 'rm -f \"$CU_LOCK\"; exit 0' TERM\n: > \"$CU_LOCK\"\nsleep 30 &\nwait\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			if _, err := os.Stat(lock); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
	}()
	start := time.Now()
	_, _, err = ExecRunner{}.Run(ctx, script, append(os.Environ(), "CU_LOCK="+lock))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the context's", err)
	}
	if d := time.Since(start); d > stopGrace {
		t.Fatalf("took %v: the group was killed, not asked to stop", d)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatalf("the TERM trap did not run: %v", err)
	}
}

func TestUpdatesTimeout(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{hang: true})
	r.u.cfg.Timeout = 30 * time.Millisecond
	if ch, st := r.poll(t); !st || ch {
		t.Fatalf("a hanging checkupdates times out and changes nothing: started %v changed %v", st, ch)
	}
	if r.u.Last() != nil {
		t.Fatal("no count from a timeout")
	}
}

func TestUpdatesEnvironment(t *testing.T) {
	t.Parallel()
	r := newUpdates(t, archRelease, fakeRun{exit: 2})
	r.poll(t)
	c := r.run.calls[0]
	if c.path != "/opt/bin/checkupdates" {
		t.Fatalf("path = %q", c.path)
	}
	if !slices.Contains(c.env, "CHECKUPDATES_DB=/state/h3d/checkupdates") {
		t.Fatalf("CHECKUPDATES_DB not the bridge's own directory: %v", c.env)
	}
	if !slices.Contains(c.env, "PATH=/usr/bin:/opt/bin") {
		t.Fatalf("PATH lacks fakeroot's directory: %v", c.env)
	}
	for _, kv := range c.env {
		if strings.HasPrefix(kv, "SUDO") {
			t.Fatalf("env %v", c.env)
		}
	}
}

func TestUpdatesUnsupportedHosts(t *testing.T) {
	t.Parallel()
	missing := func(miss string) func(string) string {
		return func(n string) string {
			if n == miss {
				return n // execpath.Resolve leaves a missing executable bare
			}
			return "/opt/bin/" + n
		}
	}
	cases := []struct {
		name, release string
		resolve       func(string) string
		want          bool
	}{
		{"arch", "ID=arch\n", resolveAll, true},
		{"id_like arch (omarchy)", "ID=omarchy\nID_LIKE=arch\n", resolveAll, true},
		{"id_like quoted list", "ID=manjaro\nID_LIKE=\"arch archlinux\"\n", resolveAll, true},
		{"debian", "ID=debian\nID_LIKE=\"\"\n", resolveAll, false},
		{"ubuntu", "ID=ubuntu\nID_LIKE=debian\n", resolveAll, false},
		{"archive is not arch", "ID=archive\n", resolveAll, false},
		{"no os-release", "", resolveAll, false},
		{"no checkupdates", "ID=arch\n", missing("checkupdates"), false},
		{"no fakeroot", "ID=arch\n", missing("fakeroot"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rel := osRelease(t, c.release)
			if c.release == "" {
				rel = filepath.Join(t.TempDir(), "nope")
			}
			run := &fakeRunner{script: []fakeRun{{out: "a 1 -> 2\n"}}}
			u := NewUpdates(UpdatesConfig{Runner: run, Resolve: c.resolve, OSRelease: rel}, time.Now)
			u.Refresh()
			if u.Supported() != c.want {
				t.Fatalf("supported = %v", u.Supported())
			}
			u.Poll(context.Background(), nil)
			time.Sleep(20 * time.Millisecond)
			if !c.want && (run.count() != 0 || u.Last() != nil) {
				t.Fatalf("an unsupported host ran checkupdates (%d) or has a count (%v)", run.count(), u.Last())
			}
		})
	}
}
