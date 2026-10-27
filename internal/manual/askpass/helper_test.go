package askpass

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvPrivateFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mp_01234567")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	env, err := Env(dir, "mp_01234567")
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env[0] != "SUDO_ASKPASS="+filepath.Join(dir, "askpass") {
		t.Fatalf("env %q", env)
	}
	for name, mode := range map[string]os.FileMode{"nonce": 0600, "askpass": 0700} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != mode {
			t.Fatalf("%s mode %o", name, info.Mode().Perm())
		}
	}
	nonce, err := os.ReadFile(filepath.Join(dir, "nonce"))
	if err != nil || len(nonce) != 64 {
		t.Fatalf("nonce %d %v", len(nonce), err)
	}
	script, err := os.ReadFile(filepath.Join(dir, "askpass"))
	if err != nil || !strings.Contains(string(script), " manual-askpass ") || strings.Contains(string(script), string(nonce)) {
		t.Fatalf("invalid helper script")
	}
	if _, err := Env(dir, "mp_01234567"); err == nil {
		t.Fatal("nonce was replaced")
	}
	if _, err := Env(dir, "mp_other"); err == nil {
		t.Fatal("mismatched directory accepted")
	}
}
