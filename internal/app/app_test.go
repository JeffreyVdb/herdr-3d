package app

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// When set, the test binary acts as a herdr-3d binary (see TestMain).
const childEnv = "H3D_APP_TEST_CHILD"

func TestMain(m *testing.M) {
	if os.Getenv(childEnv) == "1" {
		os.Exit(Main("h3d-test", nil, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

func TestVersionFlag(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Main("h3d-test", []string{"-version"}, &out, &errOut); code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, errOut.String())
	}
	if got, want := strings.TrimSpace(out.String()), "h3d-test "+version.Version; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestUnknownFlag(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Main("h3d-test", []string{"-nope"}, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestRunStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- Run(ctx, "h3d-test", &out) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if !strings.HasPrefix(out.String(), "h3d-test "+version.Version+"\n") {
		t.Fatalf("output = %q, want version banner first", out.String())
	}
}

// TestSignalsExitCleanly runs this test binary as a child process and checks
// that SIGINT and SIGTERM both lead to exit code 0.
func TestSignalsExitCleanly(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM} {
		t.Run(sig.String(), func(t *testing.T) {
			cmd := exec.Command(os.Args[0])
			cmd.Env = append(os.Environ(), childEnv+"=1")
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })

			lines := bufio.NewScanner(stdout)
			if !lines.Scan() {
				t.Fatalf("no banner: %v", lines.Err())
			}
			if got, want := lines.Text(), "h3d-test "+version.Version; got != want {
				t.Fatalf("banner = %q, want %q", got, want)
			}
			// The banner is printed after signal.NotifyContext is installed.
			if err := cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			var rest strings.Builder
			for lines.Scan() {
				rest.WriteString(lines.Text() + "\n")
			}

			waited := make(chan error, 1)
			go func() { waited <- cmd.Wait() }()
			select {
			case err := <-waited:
				if err != nil {
					t.Fatalf("child exited with %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("child did not exit after signal")
			}
			if !strings.Contains(rest.String(), "shutting down") {
				t.Fatalf("missing shutdown message, got %q", rest.String())
			}
		})
	}
}
