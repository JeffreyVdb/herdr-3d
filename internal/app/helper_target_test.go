package app

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/helper"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// helperEnv sets the helper's host/socket environment (empty: unset).
func helperEnv(t *testing.T, host, remote string) {
	t.Helper()
	t.Setenv(EnvHelperHost, host)
	t.Setenv(EnvHelperRemoteSocket, remote)
}

func TestResolveHelperTargetPrecedence(t *testing.T) {
	cases := []struct {
		name                       string
		envHost, envRemote         string
		flagHost, flagRemote       string
		wantHost, wantHostSource   string
		wantRemote, wantRemoteFrom string
	}{
		{"env only", "env@devbox", "/env/b.sock", "", "", "env@devbox", sourceEnv, "/env/b.sock", sourceEnv},
		{"flag over env", "env@devbox", "/env/b.sock", "flag@devbox", "/flag/b.sock", "flag@devbox", sourceFlag, "/flag/b.sock", sourceFlag},
		{"each setting on its own", "env@devbox", "", "", "/flag/b.sock", "env@devbox", sourceEnv, "/flag/b.sock", sourceFlag},
		{"no socket: ask the host", "", "", "flag@devbox", "", "flag@devbox", sourceFlag, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			helperEnv(t, tc.envHost, tc.envRemote)
			got, err := resolveHelperTarget(tc.flagHost, tc.flagRemote)
			if err != nil {
				t.Fatal(err)
			}
			if got.Host != tc.wantHost || got.HostSource != tc.wantHostSource || got.Remote != tc.wantRemote || got.RemoteSource != tc.wantRemoteFrom {
				t.Errorf("got %+v", got)
			}
		})
	}
}

// oldHelperConfig writes a helper.env where the removed config-file fallback looked for it.
func oldHelperConfig(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "h3d-helper", "helper.env")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("H3D_HELPER_HOST=cfg@devbox\nH3D_HELPER_REMOTE_SOCKET=/cfg/bridge.sock\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("H3D_HELPER_CONFIG", file)
}

func TestResolveHelperTargetMissingHost(t *testing.T) {
	helperEnv(t, "", "")
	// #57: no host is no error: the bridge list may name some, or the game asks for one.
	if got, err := resolveHelperTarget("", ""); err != nil || got.Host != "" {
		t.Fatalf("got %+v, %v", got, err)
	}
	// A private config file is not a source: only the flag and the environment are.
	oldHelperConfig(t)
	if got, err := resolveHelperTarget("", ""); err != nil || got.Host != "" {
		t.Errorf("a helper.env on disk must not name the host, got %+v", got)
	}
	helperEnv(t, "@H3D_HELPER_HOST@", "@H3D_HELPER_REMOTE_SOCKET@")
	if got, err := resolveHelperTarget("", ""); err != nil || got.Host != "" {
		t.Errorf("an unfilled plist placeholder is no host: %+v %v", got, err)
	}
	helperEnv(t, "dev@devbox", "@H3D_HELPER_REMOTE_SOCKET@")
	if got, err := resolveHelperTarget("", ""); err != nil || got.Remote != "" {
		t.Errorf("an unfilled socket placeholder means: ask the host; got %+v, %v", got, err)
	}
	helperEnv(t, "-oProxyCommand=x", "")
	if _, err := resolveHelperTarget("", ""); err == nil {
		t.Error("a host that looks like an ssh option is refused")
	}
}

// TestResolveBridgeListPrecedence (#57): the flag, then the environment,
// seed a missing (or empty) list file; once the file exists it is the truth
// and neither changes it.
func TestResolveBridgeListPrecedence(t *testing.T) {
	file := func() string { return filepath.Join(t.TempDir(), "h3d-helper", "bridges.json") }
	entry := func(l helper.BridgeList) helper.BridgeEntry {
		t.Helper()
		if len(l.Bridges) != 1 || l.Active != l.Bridges[0].ID {
			t.Fatalf("want one entry in use, got %+v", l)
		}
		return l.Bridges[0]
	}

	helperEnv(t, "env@devbox", "/env/b.sock")
	tgt, _ := resolveHelperTarget("", "")
	f := file()
	l, err := resolveBridgeList(f, tgt, quietLog())
	if err != nil {
		t.Fatal(err)
	}
	if e := entry(l); e.Name != "env@devbox" || e.Host != "env@devbox" || e.RemoteSocket != "/env/b.sock" || e.Kind != helper.KindSSH {
		t.Fatalf("env seeds the list: %+v", e)
	}
	saved, ok, err := helper.LoadBridgeList(f)
	if err != nil || !ok || entry(saved) != entry(l) {
		t.Fatalf("seeded list saved: %+v %v %v", saved, ok, err)
	}
	if fi, _ := os.Stat(f); fi.Mode().Perm() != 0o600 {
		t.Errorf("list file mode %v", fi.Mode().Perm())
	}

	// The flag wins over the environment for a new list.
	tgt, _ = resolveHelperTarget("flag@devbox", "")
	l, err = resolveBridgeList(file(), tgt, quietLog())
	if err != nil || entry(l).Host != "flag@devbox" || entry(l).RemoteSocket != "/env/b.sock" {
		t.Fatalf("flag over env: %+v %v", l, err)
	}

	// An existing list is the truth: the same start again, or another host, change nothing.
	for _, flagHost := range []string{"", "other@host"} {
		tgt, _ = resolveHelperTarget(flagHost, "")
		again, err := resolveBridgeList(f, tgt, quietLog())
		if err != nil || entry(again) != entry(saved) {
			t.Fatalf("host %q over an existing list: %+v %v", flagHost, again, err)
		}
	}

	// Neither: an empty list, nothing written.
	helperEnv(t, "", "")
	tgt, _ = resolveHelperTarget("", "")
	nf := file()
	if l, err := resolveBridgeList(nf, tgt, quietLog()); err != nil || len(l.Bridges) != 0 {
		t.Fatalf("no host, no list: %+v %v", l, err)
	}
	if _, err := os.Stat(nf); !os.IsNotExist(err) {
		t.Errorf("no list file should be written without a bridge: %v", err)
	}

	// A relative remote socket is refused before anything is written; a broken file is an error naming it.
	helperEnv(t, "dev@devbox", "run/b.sock")
	tgt, _ = resolveHelperTarget("", "")
	if _, err := resolveBridgeList(nf, tgt, quietLog()); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Errorf("relative remote socket: %v", err)
	}
	if err := os.WriteFile(f, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveBridgeList(f, tgt, quietLog()); err == nil || !strings.Contains(err.Error(), f) {
		t.Errorf("broken list file: %v", err)
	}
}

// TestHelperStartsWithoutHost (#57): with neither a list nor a host the helper
// serves the game (which says to add a bridge), and writes no list.
func TestHelperStartsWithoutHost(t *testing.T) {
	helperEnv(t, "", "")
	oldHelperConfig(t)
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	list := filepath.Join(t.TempDir(), "bridges.json")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan error, 1)
	go func() {
		var out, errOut bytes.Buffer // read only after it returned
		ready <- helperMain(ctx, "h3d-helper", []string{"-no-open", "-bundle", bundle, "-listen", "127.0.0.1:0",
			"-token-file", filepath.Join(t.TempDir(), "token"), "-bridges-file", list, "-local-socket", filepath.Join(t.TempDir(), "b.sock")}, &out, &errOut)
	}()
	select {
	case err := <-ready:
		t.Fatalf("the helper stopped without a host: %v", err)
	case <-time.After(500 * time.Millisecond): // still serving
	}
	cancel()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(list); !os.IsNotExist(err) {
		t.Errorf("a list was written without a bridge: %v", err)
	}
	// -version and -print-url need no host either.
	var out, errOut bytes.Buffer
	args := []string{"-print-url", "-token-file", filepath.Join(t.TempDir(), "token")}
	if code := Helper("h3d-helper", args, &out, &errOut); code != 0 {
		t.Errorf("-print-url without a host: code %d, stderr %q", code, errOut.String())
	}
}

// fakeSSH is an ssh that records its arguments and prints out (exit code rc).
func fakeSSH(t *testing.T, out string, rc int) (bin, argsFile string) {
	t.Helper()
	dir := t.TempDir()
	bin, argsFile = filepath.Join(dir, "ssh"), filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" >" + argsFile + "\nprintf '%s' '" + out + "'\nexit " + string(rune('0'+rc)) + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, argsFile
}

func TestDiscoverRemoteSocket(t *testing.T) {
	bin, argsFile := fakeSSH(t, "/run/user/1234\n", 0)
	got, err := discoverRemoteSocket(context.Background(), bin, "dev@devbox")
	if err != nil || got != "/run/user/1234/herdr-world/bridge.sock" {
		t.Fatalf("got %q, %v", got, err)
	}
	args, _ := os.ReadFile(argsFile)
	for _, want := range []string{"ControlMaster=no", "ControlPath=none", "BatchMode=yes", "dev@devbox", "$XDG_RUNTIME_DIR"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("ssh args %q lack %q", args, want)
		}
	}
	for name, tc := range map[string]struct {
		out  string
		rc   int
		want string
	}{
		"empty":         {"", 0, "no usable $XDG_RUNTIME_DIR"},
		"relative":      {"run/user/1", 0, "no usable $XDG_RUNTIME_DIR"},
		"dotdot":        {"/run/../etc", 0, "no usable $XDG_RUNTIME_DIR"},
		"blank":         {"  \n", 0, "no usable $XDG_RUNTIME_DIR"},
		"ssh failure":   {"", 3, "-remote-socket"},
		"path w/ space": {"/run/my user", 0, "no usable $XDG_RUNTIME_DIR"},
	} {
		t.Run(name, func(t *testing.T) {
			bin, _ := fakeSSH(t, tc.out, tc.rc)
			if got, err := discoverRemoteSocket(context.Background(), bin, "dev@devbox"); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %q, %v, want an error naming %q", got, err, tc.want)
			}
		})
	}
}

// TestHelperDefersDiscovery (#57): an install with only a host comes up as
// before, on that host, named after it, in use; asking the host for its socket
// waits for that bridge's own supervisor (it never holds up the start), and a
// socket named by env goes into the list as it is.
func TestHelperDefersDiscovery(t *testing.T) {
	bin, argsFile := fakeSSH(t, "/run/user/4321", 0)
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A bad listen address stops the helper right after the list is resolved, before any tunnel.
	run := func() helper.BridgeList {
		var out, errOut bytes.Buffer
		file := filepath.Join(t.TempDir(), "bridges.json")
		Helper("h3d-helper", []string{"-no-open", "-bundle", bundle, "-ssh", bin, "-listen", "0.0.0.0:1",
			"-token-file", filepath.Join(t.TempDir(), "token"), "-bridges-file", file}, &out, &errOut)
		l, _, err := helper.LoadBridgeList(file)
		if err != nil || len(l.Bridges) != 1 {
			t.Fatalf("list: %+v %v (%s)", l, err, errOut.String())
		}
		return l
	}
	helperEnv(t, "dev@devbox", "")
	if l := run(); l.Bridges[0].Host != "dev@devbox" || l.Bridges[0].RemoteSocket != "" || l.Bridges[0].Name != "dev@devbox" || l.Active != l.Bridges[0].ID {
		t.Errorf("no socket named: %+v", l)
	}
	if args, _ := os.ReadFile(argsFile); len(args) != 0 {
		t.Errorf("ssh asked at start: %q", args)
	}
	helperEnv(t, "dev@devbox", "/run/user/1/herdr-world/bridge.sock")
	if l := run(); l.Bridges[0].RemoteSocket != "/run/user/1/herdr-world/bridge.sock" {
		t.Errorf("socket named by env: %+v", l)
	}
}
