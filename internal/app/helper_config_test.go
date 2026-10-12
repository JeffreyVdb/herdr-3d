package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// helperEnv clears the helper's host/socket settings and points the private config file at dir.
func helperEnv(t *testing.T, host, remote, file string) {
	t.Helper()
	t.Setenv(EnvHelperHost, host)
	t.Setenv(EnvHelperRemoteSocket, remote)
	t.Setenv(EnvHelperConfig, file)
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "helper.env")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestParseHelperConfig(t *testing.T) {
	got, err := parseHelperConfig("helper.env", []byte(`# the helper's private config
H3D_HELPER_HOST=dev@devbox

export H3D_HELPER_REMOTE_SOCKET = "/run/user/1000/herdr-world/bridge.sock"   
H3D_HELPER_LISTEN=0.0.0.0:1
H3D_HELPER_HOST_EXTRA=no
SOMETHING_ELSE='x'
  # indented comment
`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		EnvHelperHost:         "dev@devbox",
		EnvHelperRemoteSocket: "/run/user/1000/herdr-world/bridge.sock",
	}
	if len(got) != len(want) || got[EnvHelperHost] != want[EnvHelperHost] || got[EnvHelperRemoteSocket] != want[EnvHelperRemoteSocket] {
		t.Errorf("got %v, want %v (unknown keys are ignored)", got, want)
	}
	for in, want := range map[string]string{
		"H3D_HELPER_HOST='dev@devbox'":             "dev@devbox",
		"H3D_HELPER_HOST=dev@devbox # the dev box": "dev@devbox",
		`H3D_HELPER_HOST="dev box # kept"`:         "dev box # kept",
		"H3D_HELPER_HOST=":                         "",
		"H3D_HELPER_HOST=a=b":                      "a=b",
		"\ufeffH3D_HELPER_HOST=dev@devbox\r\n":     "dev@devbox",
		"H3D_HELPER_HOST=\"unterminated":           "\"unterminated",
		"H3D_HELPER_HOST=dev@devbox#not-a-comment": "dev@devbox#not-a-comment",
	} {
		got, err := parseHelperConfig("helper.env", []byte(in))
		if err != nil || got[EnvHelperHost] != want {
			t.Errorf("%q: got %q, %v, want %q", in, got[EnvHelperHost], err, want)
		}
	}
	_, err = parseHelperConfig("/x/helper.env", []byte("H3D_HELPER_HOST=a\nnot a setting\n"))
	if err == nil || !strings.Contains(err.Error(), "/x/helper.env:2") {
		t.Errorf("malformed line: %v, want the file and line number", err)
	}
}

func TestResolveHelperTargetPrecedence(t *testing.T) {
	file := writeFile(t, "H3D_HELPER_HOST=cfg@devbox\nH3D_HELPER_REMOTE_SOCKET=/cfg/bridge.sock\n")
	cases := []struct {
		name                       string
		envHost, envRemote         string
		flagHost, flagRemote       string
		wantHost, wantHostSource   string
		wantRemote, wantRemoteFrom string
	}{
		{"config only", "", "", "", "", "cfg@devbox", sourceConfig, "/cfg/bridge.sock", sourceConfig},
		{"env over config", "env@devbox", "/env/b.sock", "", "", "env@devbox", sourceEnv, "/env/b.sock", sourceEnv},
		{"flag over env and config", "env@devbox", "/env/b.sock", "flag@devbox", "/flag/b.sock", "flag@devbox", sourceFlag, "/flag/b.sock", sourceFlag},
		{"each setting on its own", "env@devbox", "", "", "/flag/b.sock", "env@devbox", sourceEnv, "/flag/b.sock", sourceFlag},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			helperEnv(t, tc.envHost, tc.envRemote, file)
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

func TestResolveHelperTargetMissingHost(t *testing.T) {
	for name, file := range map[string]string{
		"no config file":  filepath.Join(t.TempDir(), "missing.env"),
		"no host in file": writeFile(t, "# nothing\nH3D_HELPER_REMOTE_SOCKET=/x/bridge.sock\n"),
	} {
		t.Run(name, func(t *testing.T) {
			helperEnv(t, "", "", file)
			_, err := resolveHelperTarget("", "")
			if err == nil {
				t.Fatal("want an error: the helper has no built-in host")
			}
			for _, want := range []string{"-host", "$" + EnvHelperHost, file} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("%q must name %q", err, want)
				}
			}
		})
	}
	helperEnv(t, "", "", writeFile(t, "garbage"))
	if _, err := resolveHelperTarget("", ""); err == nil || !strings.Contains(err.Error(), ":1:") {
		t.Errorf("a malformed config file is an error with its line: %v", err)
	}
	helperEnv(t, "-oProxyCommand=x", "", filepath.Join(t.TempDir(), "missing.env"))
	if _, err := resolveHelperTarget("", ""); err == nil {
		t.Error("a host that looks like an ssh option is refused")
	}
}

func TestHelperExitsWithoutHost(t *testing.T) {
	file := filepath.Join(t.TempDir(), "helper.env")
	helperEnv(t, "", "", file)
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := Helper("h3d-helper", []string{"-no-open", "-bundle", bundle, "-token-file", filepath.Join(t.TempDir(), "token")}, &out, &errOut)
	if code != 1 {
		t.Fatalf("code %d, stderr %q", code, errOut.String())
	}
	for _, want := range []string{"no bridge host", "-host", EnvHelperHost, file} {
		if !strings.Contains(errOut.String(), want) {
			t.Errorf("stderr %q must name %q", errOut.String(), want)
		}
	}
	// -version and -print-url need no host.
	errOut.Reset()
	args := []string{"-print-url", "-token-file", filepath.Join(t.TempDir(), "token")}
	if code := Helper("h3d-helper", args, &out, &errOut); code != 0 {
		t.Errorf("-print-url without a host: code %d, stderr %q", code, errOut.String())
	}
}

func TestHelperConfigPath(t *testing.T) {
	t.Setenv(EnvHelperConfig, "")
	t.Setenv("HOME", "/home/u")
	t.Setenv("XDG_CONFIG_HOME", "")
	if got := HelperConfigPath(); !strings.HasPrefix(got, "/home/u/") || !strings.HasSuffix(got, "h3d-helper/helper.env") {
		t.Errorf("default %q, want /home/u/…/h3d-helper/helper.env", got)
	}
	t.Setenv(EnvHelperConfig, "/etc/x.env")
	if got := HelperConfigPath(); got != "/etc/x.env" {
		t.Errorf("override %q", got)
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
	helperEnv(t, "dev@devbox", "", filepath.Join(t.TempDir(), "missing.env"))
	if _, args := run(); !strings.Contains(args, "dev@devbox") {
		t.Errorf("no socket named: the helper should ask the host over ssh, ssh got %q", args)
	}
	os.Remove(argsFile)
	helperEnv(t, "dev@devbox", "/run/user/1/herdr-world/bridge.sock", filepath.Join(t.TempDir(), "missing.env"))
	if _, args := run(); args != "" {
		t.Errorf("socket named by env: ssh must not be asked, got %q", args)
	}
}
