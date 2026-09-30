package imgcache

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
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
	readFile = func(root, p string) ([]byte, error) { reads = append(reads, p); return old(root, p) }
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

// An ancestor directory swapped for a link to outside the root between
// CheckPath and the read is not read through.
func TestAncestorSwapDoesNotEscapeAllowlist(t *testing.T) {
	drops, secret := tree(t)
	sub := filepath.Join(drops, "sub")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "image.png"), pngOf(t, 2, 2, 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secret, "image.png"), pngOf(t, 2, 2, 2), 0o600); err != nil {
		t.Fatal(err)
	}
	old := readFile
	defer func() { readFile = old }()
	readFile = func(root, p string) ([]byte, error) {
		if err := os.Rename(sub, sub+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(secret, sub); err != nil {
			t.Fatal(err)
		}
		return old(root, p)
	}
	_, b, _, err := LoadPath(filepath.Join(sub, "image.png"), []string{drops})
	if !errors.Is(err, ErrNotAllowed) || len(b) != 0 {
		t.Fatalf("read through a swapped ancestor: %d bytes, %v", len(b), err)
	}
}

// The file swapped for a link at the very end is refused.
func TestFinalSwapToSymlinkRefused(t *testing.T) {
	drops, secret := tree(t)
	file := filepath.Join(drops, "image.png")
	if err := os.WriteFile(file, pngOf(t, 2, 2, 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secret, "s.png"), pngOf(t, 2, 2, 2), 0o600); err != nil {
		t.Fatal(err)
	}
	old := readFile
	defer func() { readFile = old }()
	readFile = func(root, p string) ([]byte, error) {
		_ = os.Remove(p)
		_ = os.Symlink(filepath.Join(secret, "s.png"), p)
		return old(root, p)
	}
	if _, b, _, err := LoadPath(file, []string{drops}); err == nil || len(b) != 0 {
		t.Fatalf("read through a swapped link: %v", err)
	}
}

// A file swapped for a FIFO after the check does not hold the caller: the
// open does not block and the opened descriptor is refused.
func TestFinalSwapToFIFODoesNotBlock(t *testing.T) {
	drops, _ := tree(t)
	file := filepath.Join(drops, "image.png")
	if err := os.WriteFile(file, pngOf(t, 2, 2, 1), 0o600); err != nil {
		t.Fatal(err)
	}
	old := readFile
	defer func() { readFile = old }()
	readFile = func(root, p string) ([]byte, error) {
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(p, 0o600); err != nil {
			t.Fatal(err)
		}
		return old(root, p)
	}
	done := make(chan error, 1)
	go func() { _, _, _, err := LoadPath(file, []string{drops}); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrNotFile) {
			t.Fatalf("err %v, want %v", err, ErrNotFile)
		}
	case <-time.After(2 * time.Second):
		// Release the blocked open so the goroutine ends.
		if w, err := os.OpenFile(file, os.O_WRONLY, 0); err == nil {
			w.Close()
		}
		t.Fatal("LoadPath blocks opening a FIFO")
	}
}

// A root that names exactly one file serves that file.
func TestRootThatIsOneFile(t *testing.T) {
	drops, _ := tree(t)
	file := filepath.Join(drops, "one.png")
	if err := os.WriteFile(file, pngOf(t, 2, 2, 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, b, info, err := LoadPath(file, []string{file}); err != nil || info.Mime != PNG || len(b) == 0 {
		t.Fatalf("%v %+v", err, info)
	}
	if _, _, _, err := LoadPath(filepath.Join(drops, "other.png"), []string{file}); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("a sibling of the file root: %v", err)
	}
}

// Any directory on the way to the file, the root and those above it as
// well as those below, swapped for a link to a look-alike tree outside
// between CheckPath and the read, is not read through; nor is a root that
// names one file, or the directories above it. A root that is a link and
// stays one is still served.
func TestSwapAnywhereOnTheWayDoesNotEscape(t *testing.T) {
	cases := []struct {
		name string
		file string // the image, relative to base
		root string // the root, relative to base
		swap string // what is swapped for a link, relative to base
	}{
		{"a directory below the root", "a/allowed/drops/sub/image.png", "a/allowed/drops", "a/allowed/drops/sub"},
		{"the root", "a/allowed/drops/image.png", "a/allowed/drops", "a/allowed/drops"},
		{"the root's parent", "a/allowed/drops/image.png", "a/allowed/drops", "a/allowed"},
		{"a directory further above", "a/allowed/drops/image.png", "a/allowed/drops", "a"},
		{"a file root", "a/allowed/one.png", "a/allowed/one.png", "a/allowed/one.png"},
		{"a file root's parent", "a/allowed/one.png", "a/allowed/one.png", "a/allowed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			inside, outside := pngOf(t, 2, 2, 1), pngOf(t, 2, 2, 2)
			file := filepath.Join(base, c.file)
			swap := filepath.Join(base, c.swap)
			// the look-alike: the same path below a link target outside
			rel, err := filepath.Rel(swap, file)
			if err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(base, "secret", filepath.Base(swap))
			elsewhere := filepath.Join(target, rel) // rel is "." for a file swapped itself
			for p, b := range map[string][]byte{file: inside, elsewhere: outside} {
				if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, b, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			old := readFile
			defer func() { readFile = old }()
			readFile = func(root, p string) ([]byte, error) {
				if err := os.Rename(swap, swap+"-old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, swap); err != nil {
					t.Fatal(err)
				}
				return old(root, p)
			}
			_, b, _, err := LoadPath(file, []string{filepath.Join(base, c.root)})
			if bytes.Equal(b, outside) {
				t.Fatalf("served the outside image through the swapped %s", c.swap)
			}
			if !errors.Is(err, ErrNotAllowed) || len(b) != 0 {
				t.Fatalf("%d bytes, %v; want %v", len(b), err, ErrNotAllowed)
			}
		})
	}
}

// A root configured as a link, and a directory above the root that is a
// link, both stable, are followed once when the path is checked: the image
// is served, named through the link or by its real path.
func TestStableLinkedRootsAreServed(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(base, "real", "drops")
	if err := os.MkdirAll(real, 0o700); err != nil {
		t.Fatal(err)
	}
	img := pngOf(t, 2, 2, 1)
	if err := os.WriteFile(filepath.Join(real, "image.png"), img, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(base, "rootlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "real"), filepath.Join(base, "uplink")); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ path, root string }{
		{filepath.Join(base, "rootlink", "image.png"), filepath.Join(base, "rootlink")},
		{filepath.Join(real, "image.png"), filepath.Join(base, "rootlink")},
		{filepath.Join(base, "uplink", "drops", "image.png"), filepath.Join(base, "uplink", "drops")},
		{filepath.Join(base, "rootlink", "image.png"), filepath.Join(base, "rootlink", "image.png")},
	} {
		if _, b, info, err := LoadPath(c.path, []string{c.root}); err != nil || info.Mime != PNG || !bytes.Equal(b, img) {
			t.Errorf("%s under %s: %v %+v", c.path, c.root, err, info)
		}
	}
}

// A directory above the root that may be passed through but not listed
// does not stop the read (the walk only looks names up in it).
func TestSearchOnlyDirectoryAboveTheRoot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("O_PATH is linux only")
	}
	if os.Geteuid() == 0 {
		t.Skip("root reads every directory")
	}
	drops, _ := tree(t)
	root := filepath.Join(drops, "pass", "drops")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	img := pngOf(t, 2, 2, 1)
	if err := os.WriteFile(filepath.Join(root, "image.png"), img, 0o600); err != nil {
		t.Fatal(err)
	}
	pass := filepath.Join(drops, "pass")
	if err := os.Chmod(pass, 0o100); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(pass, 0o700) })
	if _, b, _, err := LoadPath(filepath.Join(root, "image.png"), []string{root}); err != nil || !bytes.Equal(b, img) {
		t.Fatalf("%d bytes, %v", len(b), err)
	}
}
