package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

// noHostMessage checks a missing-host error names the flag and the env var, and nothing else to set.
func noHostMessage(t *testing.T, msg string) {
	t.Helper()
	for _, want := range []string{"no bridge host", "-host", "$" + EnvHelperHost} {
		if !strings.Contains(msg, want) {
			t.Errorf("%q must name %q", msg, want)
		}
	}
	for _, unwanted := range []string{"config", "helper.env", "deprecated"} {
		if strings.Contains(msg, unwanted) {
			t.Errorf("%q must not mention %q: flag and environment are the only sources", msg, unwanted)
		}
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
	_, err := resolveHelperTarget("", "")
	if err == nil {
		t.Fatal("want an error: the helper has no built-in host")
	}
	noHostMessage(t, err.Error())
	// A private config file is not a source: only the flag and the environment are.
	oldHelperConfig(t)
	if got, err := resolveHelperTarget("", ""); err == nil {
		t.Errorf("a helper.env on disk must not name the host, got %+v", got)
	}
	helperEnv(t, "@H3D_HELPER_HOST@", "@H3D_HELPER_REMOTE_SOCKET@")
	if _, err := resolveHelperTarget("", ""); err == nil || !strings.Contains(err.Error(), "no bridge host") {
		t.Errorf("an unfilled plist placeholder is no host: %v", err)
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

func TestHelperExitsWithoutHost(t *testing.T) {
	helperEnv(t, "", "")
	oldHelperConfig(t)
	var out, errOut bytes.Buffer
	// The missing host is reported before the bundle is even looked at.
	code := Helper("h3d-helper", []string{"-no-open", "-bundle", t.TempDir(), "-token-file", filepath.Join(t.TempDir(), "token")}, &out, &errOut)
	if code != 1 {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
	noHostMessage(t, errOut.String())
	// -version and -print-url need no host.
	errOut.Reset()
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

// TestHelperDiscoversRemoteSocket: with no socket named anywhere, the helper asks the host and
// tunnels to what it reports; a socket named by env skips the question.
func TestHelperRemoteSocketExplicitOrDiscovered(t *testing.T) {
	bin, argsFile := fakeSSH(t, "/run/user/4321", 0)
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A bad listen address stops the helper right after the target is resolved, before any tunnel.
	run := func() (string, string) {
		var out, errOut bytes.Buffer
		Helper("h3d-helper", []string{"-no-open", "-bundle", bundle, "-ssh", bin, "-listen", "0.0.0.0:1",
			"-token-file", filepath.Join(t.TempDir(), "token")}, &out, &errOut)
		args, _ := os.ReadFile(argsFile)
		return errOut.String(), string(args)
	}
	helperEnv(t, "dev@devbox", "")
	if _, args := run(); !strings.Contains(args, "dev@devbox") {
		t.Errorf("no socket named: the helper should ask the host over ssh, ssh got %q", args)
	}
	os.Remove(argsFile)
	helperEnv(t, "dev@devbox", "/run/user/1/herdr-world/bridge.sock")
	if _, args := run(); args != "" {
		t.Errorf("socket named by env: ssh must not be asked, got %q", args)
	}
}
