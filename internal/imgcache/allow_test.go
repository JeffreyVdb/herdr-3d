package imgcache

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// tree makes <base>/drops (a root), <base>/secret (not one) and returns
// their real paths.
func tree(t *testing.T) (drops, secret string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	drops, secret = filepath.Join(base, "drops"), filepath.Join(base, "secret")
	for _, d := range []string{drops, secret} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return drops, secret
}

// counts the files read.
func countReads(t *testing.T) *[]string {
	t.Helper()
	var reads []string
	old := readFile
	readFile = func(p string) ([]byte, error) { reads = append(reads, p); return old(p) }
	t.Cleanup(func() { readFile = old })
	return &reads
}

func TestAllowlist(t *testing.T) {
	drops, secret := tree(t)
	img := pngOf(t, 3, 3, 0)
	write := func(p string, b []byte) string {
		t.Helper()
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ok := write(filepath.Join(drops, "a.png"), img)
	outside := write(filepath.Join(secret, "s.png"), img)
	notImage := write(filepath.Join(drops, "notes.png"), []byte("hello"))
	big := filepath.Join(drops, "big.png")
	if f, err := os.Create(big); err == nil {
		_ = f.Truncate(MaxImage + 1)
		f.Close()
	}
	// symlinks: a file under the root that leads out, a directory that
	// does, and a link inside the root (fine).
	_ = os.Symlink(outside, filepath.Join(drops, "escape.png"))
	_ = os.Symlink(secret, filepath.Join(drops, "escdir"))
	_ = os.Symlink(ok, filepath.Join(drops, "inside.png"))
	// the root reached through a link
	rootLink := filepath.Join(filepath.Dir(drops), "droplink")
	_ = os.Symlink(drops, rootLink)
	_ = os.MkdirAll(filepath.Join(drops, "sub"), 0o755)
	subFile := write(filepath.Join(drops, "sub", "b.png"), img)

	cases := []struct {
		name, path string
		roots      []string
		want       error // nil: available
	}{
		{"under the root", ok, []string{drops}, nil},
		{"nested", subFile, []string{drops}, nil},
		{"a link inside the root", filepath.Join(drops, "inside.png"), []string{drops}, nil},
		{"a path through some other link is refused before anything is looked at", filepath.Join(rootLink, "a.png"), []string{drops}, ErrNotAllowed},
		{"a root that is a link", ok, []string{rootLink}, nil},
		{"outside every root", outside, []string{drops}, ErrNotAllowed},
		{"no roots", ok, nil, ErrNotAllowed},
		{"the root is not a prefix of a sibling", drops + "-x/a.png", []string{drops}, ErrNotAllowed},
		{"a symlink to a file outside", filepath.Join(drops, "escape.png"), []string{drops}, ErrNotAllowed},
		{"a symlink to a directory outside", filepath.Join(drops, "escdir", "s.png"), []string{drops}, ErrNotAllowed},
		{"dot-dot out of the root", drops + "/../secret/s.png", []string{drops}, ErrNotAllowed},
		{"relative", "a.png", []string{drops}, ErrNotAllowed},
		{"empty", "", []string{drops}, ErrNotAllowed},
		{"the whole disk is not a root", outside, []string{"/"}, ErrNotAllowed},
		{"a relative root is nothing", ok, []string{"drops"}, ErrNotAllowed},
		{"missing", filepath.Join(drops, "gone.png"), []string{drops}, ErrMissing},
		{"a directory", filepath.Join(drops, "sub"), []string{drops}, ErrNotFile},
		{"over 25 MiB", big, []string{drops}, ErrTooLarge},
		{"not an image", notImage, []string{drops}, ErrNotImage},
	}
	for _, c := range cases {
		reads := countReads(t)
		_, data, info, err := LoadPath(c.path, c.roots)
		if c.want == nil {
			if err != nil || info.Mime != PNG || len(data) == 0 {
				t.Errorf("%s: %+v, %v", c.name, info, err)
			}
			continue
		}
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err %v, want %v", c.name, err, c.want)
		}
		// Nothing that is not allowed is ever read.
		switch c.want {
		case ErrNotAllowed, ErrMissing, ErrNotFile, ErrTooLarge:
			if len(*reads) != 0 {
				t.Errorf("%s: the bridge read %v", c.name, *reads)
			}
		}
	}
}

// A path outside every root is refused before any file system call: a
// missing file and an existing one look the same.
func TestOutsideAnswersTheSameWhetherOrNotItExists(t *testing.T) {
	drops, secret := tree(t)
	_ = os.WriteFile(filepath.Join(secret, "s.png"), pngOf(t, 2, 2, 0), 0o644)
	for _, p := range []string{filepath.Join(secret, "s.png"), filepath.Join(secret, "nope.png")} {
		if _, err := CheckPath(p, []string{drops}); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: %v", p, err)
		}
	}
}

func TestReasonWords(t *testing.T) {
	for err, want := range map[error]string{ErrNotAllowed: "not_allowed", ErrMissing: "missing", ErrTooLarge: "too_large", ErrNotImage: "not_image", ErrNotFile: "invalid"} {
		if got := Reason(err); got != want {
			t.Errorf("%v: %s", err, got)
		}
	}
}
