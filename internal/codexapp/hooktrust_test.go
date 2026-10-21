package codexapp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeHooks answers hooks/list and config/batchWrite for fakeStdioCodex
// (#167): $CODEX_HOME/hooks.json is one sessionStart hook keyed by its path
// and hashed by its content (path-independent, as Codex's); the trusted
// hashes by key are $FAKE_TRUST (one file for every home, as the shared
// config.toml). A write to a home with a file "lose" is lost once.
func fakeHooks(m map[string]any) any {
	home := os.Getenv("CODEX_HOME")
	store := map[string]string{}
	if b, err := os.ReadFile(os.Getenv("FAKE_TRUST")); err == nil {
		json.Unmarshal(b, &store)
	}
	if m["method"] == "config/batchWrite" {
		if os.Remove(filepath.Join(home, "lose")) == nil {
			return map[string]any{"status": "ok"}
		}
		for _, e := range m["params"].(map[string]any)["edits"].([]any) {
			e := e.(map[string]any)
			key := strings.TrimSuffix(strings.TrimPrefix(e["keyPath"].(string), `hooks.state."`), `".trusted_hash`)
			store[key] = e["value"].(string)
		}
		b, _ := json.Marshal(store)
		os.WriteFile(os.Getenv("FAKE_TRUST"), b, 0o600)
		return map[string]any{"status": "ok"}
	}
	var hooks []any
	if b, err := os.ReadFile(filepath.Join(home, "hooks.json")); err == nil {
		key := filepath.Join(home, "hooks.json") + ":session_start:0:0"
		hash := "sha256:" + strings.TrimSpace(string(b))
		status := "untrusted"
		if store[key] == hash {
			status = "trusted"
		} else if store[key] != "" {
			status = "modified"
		}
		hooks = append(hooks, map[string]any{"key": key, "source": "user", "sourcePath": filepath.Join(home, "hooks.json"), "eventName": "sessionStart",
			"trustStatus": status, "currentHash": hash})
	}
	return map[string]any{"data": []any{map[string]any{"cwd": "/x", "hooks": hooks}}}
}

// #167: only a hook the default trusts with the same definition is trusted
// on the profile; a lost write is written again; nothing else is touched.
func TestSeedHookTrust(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.Symlink(self, bin); err != nil {
		t.Fatal(err)
	}
	def, work := filepath.Join(dir, ".codex"), filepath.Join(dir, ".codex-work")
	os.MkdirAll(def, 0o755)
	os.MkdirAll(work, 0o755)
	trust := filepath.Join(dir, "trust.json")
	t.Setenv("FAKE_TRUST", trust)
	env := func(h string) []string { return append(os.Environ(), "CODEX_HOME="+h) }
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	seed := func() HookTrust {
		t.Helper()
		r, err := SeedHookTrust(ctx, bin, env(def), env(work), work)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	os.WriteFile(filepath.Join(def, "hooks.json"), []byte("same"), 0o644)
	os.WriteFile(filepath.Join(work, "hooks.json"), []byte("same"), 0o644)
	// The default does not trust it: nothing is trusted on the profile.
	if r := seed(); r != (HookTrust{Untrusted: 1}) {
		t.Fatalf("untrusted default: %+v", r)
	}
	os.WriteFile(trust, []byte(`{"`+def+`/hooks.json:session_start:0:0":"sha256:same"}`), 0o600)
	// A write lost once is written again.
	os.WriteFile(filepath.Join(work, "lose"), nil, 0o600)
	if r := seed(); r != (HookTrust{Seeded: 1}) {
		t.Fatalf("seed: %+v", r)
	}
	b, _ := os.ReadFile(trust)
	if !strings.Contains(string(b), work+`/hooks.json:session_start:0:0":"sha256:same"`) {
		t.Fatalf("trust %s", b)
	}
	if r := seed(); r != (HookTrust{}) {
		t.Fatalf("again: %+v", r)
	}
	// Another definition on the profile is never trusted by the default's.
	os.WriteFile(filepath.Join(work, "hooks.json"), []byte("other"), 0o644)
	if r := seed(); r != (HookTrust{Untrusted: 1}) {
		t.Fatalf("other: %+v", r)
	}
}
