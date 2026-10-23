package codexapp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// miseNoVersion is what mise's direnv shim prints, and exits 1, when no
// version of direnv is selected for the directory it runs in (#116).
const miseNoVersion = `mise ERROR No version is set for shim: direnv
Set a global default version with one of the following:
mise use -g direnv@2.38.2
mise use -g direnv@latest
Or set a local version with one of the following:
mise use direnv@2.38.2
mise use direnv@latest
`

// script writes an executable shell script named name into dir.
// Tests using it stay sequential: writing an executable while another test
// forks can leave the child holding its writable descriptor until exec,
// causing a concurrent launch of the script to fail with "text file busy".
func script(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// preflightWith is a Preflight over the real ExecRunner: a codex that says
// it is a verified version and a direnv that is the script body.
func preflightWith(t *testing.T, direnvBody string) (Preflight, string) {
	t.Helper()
	bin := t.TempDir()
	return Preflight{
		Codex:  script(t, bin, "codex", "echo 'codex-cli 0.163.0'\n"),
		Direnv: script(t, bin, "direnv", direnvBody),
		Run:    ExecRunner(os.Environ()),
	}, t.TempDir()
}

func status(rc string) string {
	return `echo '{"config":{},"state":{"foundRC":` + rc + `,"loadedRC":null}}'` + "\n"
}

func TestPreflightRealRunner(t *testing.T) {
	for name, tc := range map[string]struct {
		direnv string
		want   func(t *testing.T, err error)
	}{
		"no .envrc": {status("null"), func(t *testing.T, err error) {
			if err != nil {
				t.Fatal(err)
			}
		}},
		"allowed .envrc": {status(`{"allowed":0,"path":"/r/.envrc"}`), func(t *testing.T, err error) {
			if err != nil {
				t.Fatal(err)
			}
		}},
		"blocked .envrc": {status(`{"allowed":1,"path":"/r/.envrc"}`), func(t *testing.T, err error) {
			if !errors.Is(err, ErrEnvrcBlocked) {
				t.Fatalf("err = %v", err)
			}
		}},
		"denied .envrc": {status(`{"allowed":2,"path":"/r/.envrc"}`), func(t *testing.T, err error) {
			if !errors.Is(err, ErrEnvrcBlocked) {
				t.Fatalf("err = %v", err)
			}
		}},
		"inactive mise shim": {"cat >&2 <<'EOF'\n" + miseNoVersion + "EOF\nexit 1\n", func(t *testing.T, err error) {
			var du *DirenvUnselectedError
			if !errors.As(err, &du) {
				t.Fatalf("err = %v (%T)", err, err)
			}
			if strings.Contains(err.Error(), "\n") || strings.Contains(err.Error(), "mise use") || errors.Is(err, ErrEnvrcBlocked) {
				t.Fatalf("text %q", err)
			}
			if !strings.Contains(du.Detail, "mise use -g direnv@2.38.2") || !strings.Contains(du.Detail, "Or set a local version") {
				t.Fatalf("detail %q", du.Detail)
			}
			var ee *ExecError
			if !errors.As(err, &ee) || ee.Stderr != du.Detail {
				t.Fatalf("exec error %+v", ee)
			}
		}},
		"mise which wording": {"echo 'direnv is a mise bin however it is not currently active' >&2\nexit 1\n", func(t *testing.T, err error) {
			var du *DirenvUnselectedError
			if !errors.As(err, &du) {
				t.Fatalf("err = %v", err)
			}
		}},
		"other failure": {"echo 'direnv: unexpected' >&2\nexit 3\n", func(t *testing.T, err error) {
			var du *DirenvUnselectedError
			if err == nil || errors.As(err, &du) || errors.Is(err, ErrEnvrcBlocked) || !strings.HasPrefix(err.Error(), "direnv status: ") ||
				!strings.Contains(err.Error(), "unexpected") {
				t.Fatalf("err = %v", err)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			p, dir := preflightWith(t, tc.direnv)
			err := p.Check(context.Background(), dir)
			tc.want(t, err)
			var du *DirenvUnselectedError
			if errors.As(err, &du) && du.Dir != dir {
				t.Fatalf("dir %q, want %q", du.Dir, dir)
			}
		})
	}
	t.Run("missing executable", func(t *testing.T) {
		p, dir := preflightWith(t, status("null"))
		p.Direnv = filepath.Join(t.TempDir(), "no-direnv")
		if err := p.Check(context.Background(), dir); err != nil {
			t.Fatalf("a missing direnv is skipped: %v", err)
		}
	})
}

// The one-line text is the note's reason and the game's contract
// (game/src/world/codexServer.test.ts has the same words).
func TestPreflightRealRunnerNoteText(t *testing.T) {
	p, dir := preflightWith(t, "cat >&2 <<'EOF'\n"+miseNoVersion+"EOF\nexit 1\n")
	err := p.Check(context.Background(), dir)
	if want := "direnv is installed through mise but has no version selected for " + dir; err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

// ExecError keeps the text callers have always had, the exec error to match
// and the whole (bounded) stderr.
func TestExecError(t *testing.T) {
	bin := t.TempDir()
	long := script(t, bin, "long", "i=0\nwhile [ $i -lt 2000 ]; do echo 'abcdefghij' >&2; i=$((i+1)); done\nexit 2\n")
	_, err := ExecRunner(os.Environ())(context.Background(), bin, long)
	var ee *ExecError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v", err)
	}
	if len(ee.Stderr) != stderrKept {
		t.Fatalf("kept %d bytes, want %d", len(ee.Stderr), stderrKept)
	}
	if want := long + ": exit status 2: " + ee.Stderr[:300]; err.Error() != want {
		t.Fatalf("text %q, want %q", err.Error(), want)
	}
	var exit interface{ ExitCode() int }
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("not unwrapped to the exit error: %v", err)
	}
}
