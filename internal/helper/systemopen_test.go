package helper

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeBin writes an executable shell script called name into a fresh directory
// and puts that directory in front of PATH (the rest stays: scripts use sleep).
// Tests that use it must not run in parallel (t.Setenv).
func fakeBin(t *testing.T, name, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

func readInts(t *testing.T, path string) []int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, f := range strings.Fields(string(b)) {
		n, err := strconv.Atoi(f)
		if err != nil {
			t.Fatalf("%s: %q", path, f)
		}
		pids = append(pids, n)
	}
	return pids
}

// killAtCleanup stops the processes a test's scripts left behind.
func killAtCleanup(t *testing.T, pids ...int) {
	t.Helper()
	t.Cleanup(func() {
		for _, p := range pids {
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
	})
}

const testGrace = 2 * time.Second

func TestSystemOpenDispatch(t *testing.T) {
	// A URL with a query string, &, a fragment and percent-encoding, and a
	// space-free body: it must reach the command as exactly one argument.
	const u = "https://github.com/a/b/issues?q=is%3Aopen+x&page=2#issuecomment-1"
	for _, tc := range []struct{ goos, want string }{{"linux", "xdg-open"}, {"darwin", "open"}} {
		t.Run(tc.goos, func(t *testing.T) {
			var name string
			var args []string
			command := func(n string, a ...string) *exec.Cmd {
				name, args = n, a
				return exec.Command("true")
			}
			if err := newSystemOpener(tc.goos, command, testGrace)(context.Background(), u); err != nil {
				t.Fatal(err)
			}
			if name != tc.want || len(args) != 1 || args[0] != u {
				t.Fatalf("ran %q %q, want %q [%q]", name, args, tc.want, u)
			}
		})
	}
}

func TestSystemOpenUnsupportedPlatform(t *testing.T) {
	ran := false
	command := func(string, ...string) *exec.Cmd { ran = true; return exec.Command("true") }
	err := newSystemOpener("plan9", command, testGrace)(context.Background(), "https://github.com/a/b")
	if err == nil || !strings.Contains(err.Error(), "plan9") || ran {
		t.Fatalf("err %v, ran %v: want an error naming the OS and nothing run", err, ran)
	}
}

// The real exec plumbing: a script found on PATH gets the URL as one argument
// and the helper's own environment.
func TestSystemOpenRunsTheCommandWithOneArgAndTheEnvironment(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "argv")
	fakeBin(t, "xdg-open", `echo "$#" > `+rec+`; for a in "$@"; do printf '%s\n' "$a" >> `+rec+`; done; echo "$H3D_TEST_ENV" >> `+rec)
	t.Setenv("H3D_TEST_ENV", "inherited")
	const u = "https://github.com/a/b/pull/7?files=a%20b&x=1#diff-abc"
	if err := newSystemOpener("linux", exec.Command, testGrace)(context.Background(), u); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(rec)
	if err != nil {
		t.Fatal(err)
	}
	if want := "1\n" + u + "\ninherited\n"; string(got) != want {
		t.Fatalf("script saw %q, want %q", got, want)
	}
}

func TestSystemOpenMissingExecutable(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // nothing on it
	err := newSystemOpener("linux", exec.Command, testGrace)(context.Background(), "https://github.com/a/b")
	if !errors.Is(err, exec.ErrNotFound) || !strings.Contains(err.Error(), "xdg-open") {
		t.Fatalf("err %v: want exec.ErrNotFound naming xdg-open", err)
	}
}

func TestSystemOpenNonzeroExitHasDiagnostics(t *testing.T) {
	fakeBin(t, "xdg-open", `echo "no method available for opening" >&2; echo more; exit 4`)
	err := newSystemOpener("linux", exec.Command, testGrace)(context.Background(), "https://github.com/a/b")
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 4 {
		t.Fatalf("err %v: want an exit status 4", err)
	}
	for _, want := range []string{"xdg-open", "exit status 4", "no method available for opening", "more"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err %q lacks %q", err, want)
		}
	}
}

func TestSystemOpenDiagnosticsAreCapped(t *testing.T) {
	fakeBin(t, "xdg-open", `i=0; while [ $i -lt 2000 ]; do printf 'xxxxxxxxxx'; i=$((i+1)); done >&2; exit 3`)
	err := newSystemOpener("linux", exec.Command, testGrace)(context.Background(), "https://github.com/a/b")
	if err == nil || len(err.Error()) > maxOpenDiag+100 {
		t.Fatalf("error of %d bytes, want it capped near %d: %.80q", len(err.Error()), maxOpenDiag, err)
	}
}

// A long-lived opener (xdg-open waiting on a launched app) is a success at the
// end of the grace window, is not killed, and is reaped once it exits.
func TestSystemOpenLongRunningIsLaunchedNotKilled(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	fakeBin(t, "xdg-open", `echo $$ > `+pidfile+`; exec sleep 30`)
	start := time.Now()
	if err := newSystemOpener("linux", exec.Command, 300*time.Millisecond)(context.Background(), "https://github.com/a/b"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 250*time.Millisecond || d > 3*time.Second {
		t.Fatalf("returned after %v: want about the grace window", d)
	}
	pid := readInts(t, pidfile)[0]
	killAtCleanup(t, pid)
	if !alive(pid) {
		t.Fatal("the opener was killed at the end of the grace window")
	}
	// Once it ends, the background reaper leaves no zombie.
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the exited opener to be reaped", func() bool { return !alive(pid) })
}

// A descendant that keeps the output pipe (a browser the opener started) does
// not hold the answer past the exit: a failure is still reported, with its
// output, and a success is still a success.
func TestSystemOpenDescendantHoldingThePipe(t *testing.T) {
	for _, tc := range []struct {
		name, script string
		wantErr      string
	}{
		{"exit 0", `echo $! > %s; exit 0`, ""},
		{"exit 4", `echo boom >&2; echo $! > %s; exit 4`, "boom"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pidfile := filepath.Join(t.TempDir(), "pid")
			fakeBin(t, "xdg-open", `sleep 30 &`+"\n"+strings.Replace(tc.script, "%s", pidfile, 1))
			start := time.Now()
			err := newSystemOpener("linux", exec.Command, 2*time.Second)(context.Background(), "https://github.com/a/b")
			if pids := readInts(t, pidfile); len(pids) == 1 {
				killAtCleanup(t, pids[0])
			}
			if tc.wantErr == "" && err != nil || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err %v, want %q", err, tc.wantErr)
			}
			if d := time.Since(start); d > 1900*time.Millisecond {
				t.Fatalf("took %v: the descendant held the wait up to the grace window", d)
			}
		})
	}
}

// The game going away ends the wait at once and leaves the launch alone.
func TestSystemOpenCancellationDoesNotKillALaunch(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	fakeBin(t, "xdg-open", `echo $$ > `+pidfile+`; exec sleep 30`)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		waitFor(t, "the opener to start", func() bool { b, _ := os.ReadFile(pidfile); return strings.HasSuffix(string(b), "\n") })
		cancel()
	}()
	start := time.Now()
	err := newSystemOpener("linux", exec.Command, time.Minute)(ctx, "https://github.com/a/b")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v, want context.Canceled", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v after the cancel", d)
	}
	pid := readInts(t, pidfile)[0]
	killAtCleanup(t, pid)
	if !alive(pid) {
		t.Fatal("cancellation killed a launch in flight")
	}
}

func TestSystemOpenCancelledBeforeStartRunsNothing(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "ran")
	fakeBin(t, "xdg-open", `touch `+rec)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := newSystemOpener("linux", exec.Command, testGrace)(ctx, "https://github.com/a/b"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v, want context.Canceled", err)
	}
	if _, err := os.Stat(rec); err == nil {
		t.Fatal("the command ran")
	}
}

// End to end through POST /api/open: 204 for a dispatched open, 502 with the
// opener's diagnostics for a failure, and a long-lived opener is a 204.
func TestOpenEndpointWithSystemOpener(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	fakeBin(t, "xdg-open", `case "$1" in
*fail*) echo "no desktop session" >&2; exit 4;;
*slow*) echo $$ > `+pidfile+`; exec sleep 30;;
esac`)
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: &socketBridge{},
		Bundle: writeBundle(t), Log: quietLog(), Open: newSystemOpener("linux", exec.Command, 200*time.Millisecond)})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	for _, tc := range []struct {
		url    string
		status int
		body   string
	}{
		{"https://github.com/a/b", http.StatusNoContent, ""},
		{"https://github.com/slow", http.StatusNoContent, ""},
		{"https://github.com/fail", http.StatusBadGateway, "no desktop session"},
	} {
		status, body := doOpenBody(t, ts, goodOpen(`{"url":"`+tc.url+`"}`))
		if status != tc.status || !strings.Contains(body, tc.body) {
			t.Fatalf("%s: %d %q, want %d containing %q", tc.url, status, body, tc.status, tc.body)
		}
	}
	killAtCleanup(t, readInts(t, pidfile)...)
}
