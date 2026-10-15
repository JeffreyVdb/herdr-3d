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

// Verify is what Control re-runs before every wake and launch on a path
// resolved at startup: the same MissingError as a shell never installed.
func TestVerifyCachedPath(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bash")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Verify(Bash, bin); err != nil {
		t.Fatalf("Verify of an executable file = %v", err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(bin, link); err != nil {
		t.Fatal(err)
	}
	if err := Verify("", link); err != nil {
		t.Fatalf("Verify of a link to an executable = %v", err)
	}
	if err := os.Chmod(bin, 0o644); err != nil {
		t.Fatal(err)
	}
	for name, p := range map[string]string{"not executable": bin, "link to it": link, "directory": dir, "missing": filepath.Join(dir, "nope")} {
		err := Verify(Fish, p)
		var me *MissingError
		if !errors.As(err, &me) || me.Kind != Fish || me.Path != p {
			t.Errorf("%s: Verify = %v, want a *MissingError for %s", name, err, p)
			continue
		}
		for _, want := range []string{p, "--shell", "HERDR_WORLD_SHELL", "bash"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: %q does not mention %q", name, err, want)
			}
		}
	}
	if err := Verify("", dir); err == nil || !strings.Contains(err.Error(), `"bash"`) {
		t.Errorf("the empty policy is bash: %v", err)
	}
}
