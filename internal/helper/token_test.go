package helper

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg", "token")

	first, err := LoadToken(path)
	if err != nil || !validToken(first) {
		t.Fatalf("create: %q, %v", first, err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("token file: %v, %v (want 0600)", fi, err)
	}
	if fi, err := os.Stat(filepath.Dir(path)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("token dir: %v, %v (want 0700)", fi, err)
	}

	again, err := LoadToken(path)
	if err != nil || again != first {
		t.Errorf("second load = %q, %v; want the same token %q", again, err, first)
	}

	if err := os.WriteFile(path, []byte("not a token"), 0o600); err != nil {
		t.Fatal(err)
	}
	fresh, err := LoadToken(path)
	if err != nil || !validToken(fresh) || fresh == first {
		t.Errorf("malformed file: got %q, %v; want a new valid token", fresh, err)
	}
}

func TestInstalledApp(t *testing.T) {
	home := t.TempDir()
	if _, ok := InstalledApp(home, "herdr-3d"); ok {
		t.Fatal("found an app in an empty home")
	}
	app := filepath.Join(home, "Applications", "Chrome Apps.localized", "herdr-3d.app")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	if p, ok := InstalledApp(home, "herdr-3d"); !ok || p != app {
		t.Errorf("InstalledApp = %q, %v; want %q, true", p, ok, app)
	}
}
