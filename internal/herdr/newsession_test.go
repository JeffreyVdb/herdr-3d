package herdr

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #58: the names session.create accepts. The cap is measured on the host
// (docs/research ground-herdr-sess, Q2): with a sessions directory of 33
// bytes ("/home/jeff/.config/herdr/sessions") herdr binds a 56-byte name
// and fails a 57-byte one on the sun_path limit.
func TestMaxNewSessionName(t *testing.T) {
	for dir, want := range map[string]int{
		"/home/jeff/.config/herdr/sessions":    56,
		"/home/jeffrey/.config/herdr/sessions": 53,
		"/home/u/.config/herdr/sessions/":      59, // a trailing slash is not part of the path
		"/" + strings.Repeat("d", 100):         0,
		"/s":                                   64, // never more than herdr's own cap
	} {
		if got := MaxNewSessionName(dir); got != want {
			t.Errorf("MaxNewSessionName(%q) = %d, want %d", dir, got, want)
		}
	}
}

func TestCheckNewSessionName(t *testing.T) {
	const max = 56
	for _, name := range []string{"a", "h3dtest_9", "1h3dtest", "424242", "my-floor", "a_b-c", strings.Repeat("x", 56),
		"v-0123", "v-0123456789abc", "v-0123456789ag", "w-0123456789ab", "xv-0123456789ab"} {
		if err := CheckNewSessionName(name, max); err != nil {
			t.Errorf("CheckNewSessionName(%q) = %v, want ok", name, err)
		}
	}
	for name, why := range map[string]string{
		"":                       "Give the floor a name.",
		"default":                "“default” is herdr’s own session",
		"v-0123456789ab":         "virtual floors",
		"v-ba9876543210":         "virtual floors",
		"-h3dtest":               "cannot start with “-”",
		"h3dtest-UPPER":          "lowercase letters, digits, “_” and “-”",
		"h3dtest.dot":            "lowercase letters, digits, “_” and “-”",
		"h3dtest-sl/ash":         "lowercase letters, digits, “_” and “-”",
		"a b":                    "lowercase letters, digits, “_” and “-”",
		"..":                     "lowercase letters, digits, “_” and “-”",
		"émile":                  "lowercase letters, digits, “_” and “-”",
		strings.Repeat("x", 57):  "at most 56 characters",
		strings.Repeat("x", 200): "at most 56 characters",
	} {
		err := CheckNewSessionName(name, max)
		if err == nil || !strings.Contains(err.Error(), why) {
			t.Errorf("CheckNewSessionName(%q) = %v, want %q", name, err, why)
		}
		if ValidNewSessionName(name, max) {
			t.Errorf("ValidNewSessionName(%q) = true", name)
		}
	}
}

func TestSessionsDir(t *testing.T) {
	def := Session{Name: "default", Default: true, SessionDir: "/home/u/.config/herdr"}
	named := Session{Name: "admin", SessionDir: "/home/u/.config/herdr/sessions/admin"}
	for _, tc := range []struct {
		name string
		list []Session
		want string
	}{
		{"a named session's parent", []Session{def, named}, "/home/u/.config/herdr/sessions"},
		{"only the default session", []Session{def}, "/home/u/.config/herdr/sessions"},
	} {
		got, err := SessionsDir(tc.list)
		if err != nil || got != tc.want {
			t.Errorf("%s: SessionsDir = %q, %v; want %q", tc.name, got, err, tc.want)
		}
	}
	for _, list := range [][]Session{nil, {{Name: "x"}}, {{Name: "x", SessionDir: "relative/x"}}} {
		if got, err := SessionsDir(list); err == nil {
			t.Errorf("SessionsDir(%+v) = %q, want an error", list, got)
		}
	}
}

func TestNewSessionTaken(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "leftover"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "afile"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	list := []Session{
		{Name: "default", Default: true, SessionDir: filepath.Dir(dir)},
		{Name: "running", Running: true, SessionDir: filepath.Join(dir, "running")},
		{Name: "stopped", SessionDir: filepath.Join(dir, "stopped")},
	}
	units := map[string]bool{"herdr-s-unit-only.service": true}
	loaded := func(unit string) bool { return units[unit] }
	for name, why := range map[string]string{
		"running":   "already a herdr session",
		"stopped":   "already a herdr session (asleep)",
		"default":   "already a herdr session",
		"leftover":  "already has a folder",
		"afile":     "already has a folder",
		"unit-only": "herdr-s-unit-only.service is still loaded",
	} {
		if got := NewSessionTaken(list, dir, name, loaded); !strings.Contains(got, why) {
			t.Errorf("NewSessionTaken(%q) = %q, want %q", name, got, why)
		}
	}
	if got := NewSessionTaken(list, dir, "fresh", loaded); got != "" {
		t.Errorf("NewSessionTaken(fresh) = %q, want free", got)
	}
	if got := NewSessionTaken(list, dir, "fresh", nil); got != "" {
		t.Errorf("NewSessionTaken(fresh, no unit check) = %q, want free", got)
	}
}

func TestTransientUnitLoaded(t *testing.T) {
	run := t.TempDir()
	if err := os.MkdirAll(filepath.Join(run, "systemd", "transient"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(run, "systemd", "transient", "herdr-s-x.service"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded := TransientUnitLoaded(run)
	if !loaded("herdr-s-x.service") || loaded("herdr-s-y.service") || loaded("../herdr-s-x.service") {
		t.Error("TransientUnitLoaded does not follow the transient unit files")
	}
	if TransientUnitLoaded("")("herdr-s-x.service") {
		t.Error("no runtime dir: nothing is known to be loaded")
	}
}

func TestRuntimeDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/4242")
	if got := RuntimeDir(); got != "/run/user/4242" {
		t.Errorf("RuntimeDir = %q", got)
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	if got, want := RuntimeDir(), fmt.Sprintf("/run/user/%d", os.Getuid()); got != want {
		t.Errorf("RuntimeDir without XDG_RUNTIME_DIR = %q, want %q", got, want)
	}
}
