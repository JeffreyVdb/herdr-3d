package claudechild

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The settings file holds the four observational hooks, every one the
// same synchronous command hook (no async, no failure blocking), and is
// private to the user.
func TestInstallHooks(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "claude-hooks")
	settings, log, err := InstallHooks(dir, "/usr/bin/flock", "/usr/bin/cat")
	if err != nil {
		t.Fatal(err)
	}
	if settings != filepath.Join(dir, SettingsFile) || log != filepath.Join(dir, LogFile) {
		t.Fatalf("paths %q %q", settings, log)
	}
	fi, err := os.Stat(settings)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("settings file %v %v", fi.Mode(), err)
	}
	b, _ := os.ReadFile(settings)
	var got struct {
		Hooks map[string][]struct {
			Matcher string           `json:"matcher"`
			Hooks   []map[string]any `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"PreToolUse": "Agent|Task", "PostToolUse": "Agent|Task", "SubagentStart": "", "SubagentStop": ""}
	if len(got.Hooks) != len(want) {
		t.Fatalf("hooks %s", b)
	}
	cmd := HookCommand("/usr/bin/flock", "/usr/bin/cat", log)
	for ev, m := range want {
		hs := got.Hooks[ev]
		if len(hs) != 1 || hs[0].Matcher != m || len(hs[0].Hooks) != 1 || hs[0].Hooks[0]["type"] != "command" ||
			hs[0].Hooks[0]["command"] != cmd || hs[0].Hooks[0]["async"] != nil || hs[0].Hooks[0]["onFailure"] != nil {
			t.Fatalf("%s: %s", ev, b)
		}
	}
	if _, _, err := InstallHooks(filepath.Join(t.TempDir(), "it's"), "/usr/bin/flock", "/usr/bin/cat"); err == nil {
		t.Fatal("a path with a quote was accepted")
	}
}

// The hook command appends each hook's stdin whole, also from many hooks at
// once with lines larger than a pipe's atomic write, and exits 0 when it
// cannot write.
func TestHookCommandAppendsWholeLines(t *testing.T) {
	flock, err := exec.LookPath("flock")
	if err != nil {
		t.Skip("no flock")
	}
	cat, _ := exec.LookPath("cat")
	dir := t.TempDir()
	log := filepath.Join(dir, LogFile)
	cmd := HookCommand(flock, cat, log)
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			line := fmt.Sprintf(`{"session_id":"s","n":%d,"pad":"%s"}`, i, strings.Repeat("x", 20000+i*997))
			c := exec.Command("sh", "-c", cmd)
			c.Stdin = strings.NewReader(line + "\n")
			if out, err := c.CombinedOutput(); err != nil {
				t.Errorf("hook: %v %s", err, out)
			}
		})
	}
	wg.Wait()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	ls := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	if len(ls) != 16 {
		t.Fatalf("%d lines", len(ls))
	}
	for _, l := range ls {
		if !json.Valid([]byte(l)) {
			t.Fatalf("torn line: %.80s…", l)
		}
	}
	bad := exec.Command("sh", "-c", HookCommand(flock, cat, filepath.Join(dir, "missing", LogFile)))
	bad.Stdin = strings.NewReader("{}\n")
	if err := bad.Run(); err != nil {
		t.Fatalf("a failing hook did not exit 0: %v", err)
	}
}

// The source reads the rotated log after a restart, rotates the log past
// its size, and reads lines appended after the rotation.
func TestHookLogRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LogFile)
	var got []string
	fn := func(b []byte) { got = append(got, string(b)) }
	appendLines(t, path+".1", `{"n":1}`)
	appendLines(t, path, `{"n":2}`, `{"n":3}`)
	h := &hookLog{path: path, max: 10, log: New(Options{}).opts.Log}
	h.start(fn)
	if strings.Join(got, ",") != `{"n":1},{"n":2},{"n":3}` {
		t.Fatalf("start: %q", got)
	}
	if b, _ := os.ReadFile(path + ".1"); string(b) != "{\"n\":2}\n{\"n\":3}\n" {
		t.Fatalf("not rotated: %q", b)
	}
	appendLines(t, path, `{"n":4}`)
	h.read(fn)
	if got[len(got)-1] != `{"n":4}` || len(got) != 4 {
		t.Fatalf("after rotation: %q", got)
	}
}
