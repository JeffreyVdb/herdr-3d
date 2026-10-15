package shell

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	for in, want := range map[string]Kind{"": Bash, "bash": Bash, "fish": Fish} {
		if got, err := Parse(in); err != nil || got != want {
			t.Errorf("Parse(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"zsh", "/bin/fish", "Bash", "bash -l", "sh", "fish;id"} {
		_, err := Parse(bad)
		if err == nil || !strings.Contains(err.Error(), "--shell") {
			t.Errorf("Parse(%q) = %v; want an error naming the option", bad, err)
		}
	}
}

func TestLauncherExt(t *testing.T) {
	if Kind("").LauncherExt() != ".sh" || Bash.LauncherExt() != ".sh" || Fish.LauncherExt() != ".fish" {
		t.Fatal("launcher extensions changed")
	}
}

func exe(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// Resolve never reads $SHELL, and a fish that is merely installed does not
// change what bash resolves to.
func TestResolvePrefersConfiguredKindOnly(t *testing.T) {
	dir := t.TempDir()
	exe(t, filepath.Join(dir, "bash"))
	exe(t, filepath.Join(dir, "fish"))
	t.Setenv("PATH", dir)
	t.Setenv("SHELL", filepath.Join(dir, "fish"))
	old := FallbackDirs
	FallbackDirs = nil
	t.Cleanup(func() { FallbackDirs = old })

	got, err := Resolve(Bash)
	if err != nil || got != filepath.Join(dir, "bash") {
		t.Fatalf("Resolve(Bash) = %q, %v", got, err)
	}
	if got, err := Resolve(""); err != nil || got != filepath.Join(dir, "bash") {
		t.Fatalf("Resolve(\"\") = %q, %v", got, err)
	}
}

func TestResolveFallbackDirsAndMissing(t *testing.T) {
	empty, fb := t.TempDir(), t.TempDir()
	t.Setenv("PATH", empty)
	old := FallbackDirs
	FallbackDirs = []string{filepath.Join(fb, "usr-bin"), fb}
	t.Cleanup(func() { FallbackDirs = old })

	if _, err := Resolve(Bash); err == nil {
		t.Fatal("a missing bash was found")
	} else {
		var me *MissingError
		if !errors.As(err, &me) || !strings.Contains(err.Error(), "--shell") || !strings.Contains(err.Error(), "fish") ||
			!strings.Contains(err.Error(), "never falls back") {
			t.Fatalf("error is not actionable: %v", err)
		}
	}
	// Only fish installed: bash is still missing (no silent switch).
	exe(t, filepath.Join(fb, "fish"))
	if _, err := Resolve(Bash); err == nil {
		t.Fatal("bash resolved to something while only fish is installed")
	}
	exe(t, filepath.Join(fb, "bash"))
	if got, err := Resolve(Bash); err != nil || got != filepath.Join(fb, "bash") {
		t.Fatalf("fallback dir not searched: %q, %v", got, err)
	}
	// A non-executable file is not a shell.
	if err := os.Chmod(filepath.Join(fb, "bash"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(Bash); err == nil {
		t.Fatal("a non-executable bash was accepted")
	}
}

func TestResolveFishKeepsLegacyPath(t *testing.T) {
	if !executable("/bin/fish") {
		t.Skip("no /bin/fish on this host")
	}
	if got, err := Resolve(Fish); err != nil || got != "/bin/fish" {
		t.Fatalf("Resolve(Fish) = %q, %v; the compatibility argv keeps /bin/fish", got, err)
	}
}
