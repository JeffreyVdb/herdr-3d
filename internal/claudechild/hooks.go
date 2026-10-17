package claudechild

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// The bridge's Claude Code hooks (#23): a settings file of its own, passed
// to the Claude workers it starts with one --settings (it merges with the
// user's and the project's hooks, which it never touches), whose command
// hooks append their input to one log the Source reads. They only observe:
// synchronous and fast (ordering), never blocking, a failure ignored. A
// worker started otherwise, hooks disabled by the user's settings, or the
// log gone: the transcripts alone tell the same children.

// Files of the hooks' directory.
const (
	SettingsFile = "settings.json"
	LogFile      = "events.jsonl"
)

// hookEvents are the events the hooks observe, with their matcher ("":
// every one).
var hookEvents = []struct{ event, matcher string }{
	{"PreToolUse", "Agent|Task"},
	{"PostToolUse", "Agent|Task"},
	{"SubagentStart", ""},
	{"SubagentStop", ""},
}

// plainPath is a path the hook command may name in single quotes and a
// pane's shell may be typed: no quote, no blank, no metacharacter.
var plainPath = regexp.MustCompile(`^/[A-Za-z0-9._/+@,=:-]{1,200}$`)

// HookCommand is the command every hook runs: its stdin (one line of JSON)
// appended to log under flock(1), so concurrent hooks never tear a line;
// any failure is written to log.err and ignored (exit 0: the action goes
// on).
func HookCommand(flock, cat, log string) string {
	return fmt.Sprintf("'%s' -w 2 '%s' '%s' >> '%s' 2>> '%s.err' || true", flock, log, cat, log, log)
}

// InstallHooks writes the hooks' settings file in dir (made 0700; the file
// 0600, replaced whole) and returns it and the log its hooks append to.
// flock and cat are the absolute paths of the executables the hooks run.
func InstallHooks(dir, flock, cat string) (settings, log string, err error) {
	dir = filepath.Clean(dir)
	settings, log = filepath.Join(dir, SettingsFile), filepath.Join(dir, LogFile)
	for _, p := range []string{settings, log + ".err", flock, cat} {
		if !plainPath.MatchString(p) {
			return "", "", fmt.Errorf("claude hooks: %q is not a plain absolute path", p)
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", "", err
	}
	hook := []map[string]any{{"type": "command", "command": HookCommand(flock, cat, log), "timeout": 10}}
	hooks := map[string]any{}
	for _, h := range hookEvents {
		entry := map[string]any{"hooks": hook}
		if h.matcher != "" {
			entry["matcher"] = h.matcher
		}
		hooks[h.event] = []any{entry}
	}
	b, err := json.MarshalIndent(map[string]any{"hooks": hooks}, "", "  ")
	if err != nil {
		return "", "", err
	}
	tmp, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return "", "", err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", "", err
	}
	if err := tmp.Close(); err != nil {
		return "", "", err
	}
	if err := os.Rename(tmp.Name(), settings); err != nil {
		return "", "", err
	}
	return settings, log, nil
}
