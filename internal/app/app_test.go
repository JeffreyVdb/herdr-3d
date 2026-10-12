package app

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// When set, the test binary acts as h3d-helper with the arguments in
// helperArgsEnv (one per line); see TestMain.
const (
	childEnv      = "H3D_APP_TEST_CHILD"
	helperArgsEnv = "H3D_APP_TEST_HELPER_ARGS"
)

func TestMain(m *testing.M) {
	// The helper has no built-in bridge host: name one (children inherit it), and keep a
	// developer's real private helper config out of the tests.
	os.Setenv(EnvHelperHost, "dev@devbox")
	os.Setenv(EnvHelperRemoteSocket, "/run/user/1000/herdr-world/bridge.sock")
	os.Setenv(EnvHelperConfig, filepath.Join(os.TempDir(), "h3d-no-such-helper.env"))
	if os.Getenv(childEnv) == "1" {
		os.Exit(Helper("h3d-helper", strings.Split(os.Getenv(helperArgsEnv), "\n"), os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

func TestHelperVersionAndFlags(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Helper("h3d-helper", []string{"-version"}, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "h3d-helper "+version.Version {
		t.Fatalf("-version: code %d, out %q, err %q", code, out.String(), errOut.String())
	}
	if code := Helper("h3d-helper", []string{"-nope"}, &out, &errOut); code != 2 {
		t.Fatalf("unknown flag: code %d", code)
	}
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		args []string
		want string
	}{
		"public listen":   {[]string{"-no-open", "-bundle", bundle, "-listen", "0.0.0.0:7777"}, "loopback"},
		"hostname listen": {[]string{"-no-open", "-bundle", bundle, "-listen", "localhost:7777"}, "loopback"},
		"no bundle":       {[]string{"-no-open", "-bundle", t.TempDir()}, "index.html missing"},
		"bad dev url":     {[]string{"-no-open", "-dev-upstream", "127.0.0.1:5173"}, "-dev-upstream"},
	} {
		errOut.Reset()
		if code := Helper("h3d-helper", tc.args, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), tc.want) {
			t.Errorf("%s: code %d, stderr %q, want %q", name, code, errOut.String(), tc.want)
		}
	}
}

func TestDefaultHelperPaths(t *testing.T) {
	t.Setenv("HOME", "/home/u")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	for got, suffix := range map[string]string{
		DefaultLocalSocket():   "h3d-helper/bridge.sock",
		DefaultBundle():        "h3d-helper/dist",
		DefaultChromeProfile(): "h3d-helper/chrome",
	} {
		if !strings.HasPrefix(got, "/home/u/") || !strings.HasSuffix(got, suffix) {
			t.Errorf("%q, want /home/u/…/%s", got, suffix)
		}
	}
	if len(DefaultLocalSocket()) > 103 {
		t.Errorf("default socket path too long for a unix socket: %s", DefaultLocalSocket())
	}
}

// TestHelperSignalsExitCleanly runs this test binary as h3d-helper (with an
// ssh that always fails, so the tunnel just backs off) and checks that
// SIGINT and SIGTERM both shut it down with exit code 0.
func TestHelperSignalsExitCleanly(t *testing.T) {
	falseBin, err := exec.LookPath("false")
	if err != nil {
		t.Skip("no false(1)")
	}
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	for _, sig := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM} {
		t.Run(sig.String(), func(t *testing.T) {
			cmd := exec.Command(os.Args[0])
			args := []string{"-no-open", "-listen", "127.0.0.1:0", "-bundle", bundle, "-ssh", falseBin,
				"-local-socket", filepath.Join(sockDir, "b.sock")}
			cmd.Env = append(os.Environ(), childEnv+"=1", helperArgsEnv+"="+strings.Join(args, "\n"))
			stderr, err := cmd.StderrPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })

			lines := bufio.NewScanner(stderr)
			var log strings.Builder
			// Serving, and the tunnel already backing off after ssh failed.
			for !strings.Contains(log.String(), "h3d-helper serving") || !strings.Contains(log.String(), "tunnel down, restarting") {
				if !lines.Scan() {
					t.Fatalf("helper did not start: %v\n%s", lines.Err(), log.String())
				}
				log.WriteString(lines.Text() + "\n")
			}
			if err := cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			for lines.Scan() {
				log.WriteString(lines.Text() + "\n")
			}
			waited := make(chan error, 1)
			go func() { waited <- cmd.Wait() }()
			select {
			case err := <-waited:
				if err != nil {
					t.Fatalf("child exited with %v\n%s", err, log.String())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("child did not exit after signal")
			}
			if !strings.Contains(log.String(), "shutting down") || !strings.Contains(log.String(), "tunnel stopped") {
				t.Fatalf("missing log lines:\n%s", log.String())
			}
		})
	}
}
