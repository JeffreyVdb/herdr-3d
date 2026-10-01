package drops

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func write(t *testing.T, path string, b []byte, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func snapshot(t *testing.T, root string) map[string]time.Time {
	t.Helper()
	out := map[string]time.Time{}
	_ = filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err == nil {
			out[p] = fi.ModTime()
		}
		return nil
	})
	return out
}

func TestListNewestFirstImagesMarked(t *testing.T) {
	root := t.TempDir()
	img := pngBytes(t, 40, 20)
	write(t, filepath.Join(root, "2026-09", "old.png"), img, 3*time.Hour)
	write(t, filepath.Join(root, "2026-10", "new.png"), img, time.Minute)
	write(t, filepath.Join(root, "2026-10", "notes.md"), []byte("# hi"), 2*time.Minute)
	write(t, filepath.Join(root, "loose.png"), img, time.Hour)
	write(t, filepath.Join(root, "2026-10", ".hidden.png"), img, 0)
	write(t, filepath.Join(root, "2026-10", "deep", "x.png"), img, 0) // two levels down: not a drop
	outside := filepath.Join(t.TempDir(), "secret.png")
	write(t, outside, img, 0)
	if err := os.Symlink(outside, filepath.Join(root, "2026-10", "link.png")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, root)
	got, err := List(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, d := range got {
		names = append(names, d.Name)
	}
	want := []string{"new.png", "notes.md", "loose.png", "old.png"}
	if len(names) != len(want) {
		t.Fatalf("drops %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("drops %v, want %v", names, want)
		}
	}
	if d := got[0]; !d.Image || d.Mime != "image/png" || d.Size != int64(len(img)) || d.Path != filepath.Join(root, "2026-10", "new.png") || d.MTime == 0 {
		t.Fatalf("new.png %+v", d)
	}
	if d := got[1]; d.Image || d.Reason != imgcache.ReasonNotImage {
		t.Fatalf("notes.md %+v", d)
	}
	if after := snapshot(t, root); len(after) != len(before) {
		t.Fatalf("the listing changed the directory")
	}
	if two, _ := List(root, 2); len(two) != 2 {
		t.Fatalf("limit 2: %d", len(two))
	}
}

func TestListNoRoot(t *testing.T) {
	if _, err := List("", 5); !errors.Is(err, ErrNoRoot) {
		t.Fatal(err)
	}
	got, err := List(filepath.Join(t.TempDir(), "missing"), 5)
	if err != nil || len(got) != 0 {
		t.Fatalf("%v %v", got, err)
	}
}

func TestReadOnlyUnderRoot(t *testing.T) {
	root := t.TempDir()
	img := pngBytes(t, 900, 300)
	p := filepath.Join(root, "2026-10", "a.png")
	write(t, p, img, 0)
	b, info, err := Read(root, p)
	if err != nil || !bytes.Equal(b, img) || info.Width != 900 {
		t.Fatalf("read: %v %+v", err, info)
	}
	th, err := Thumb(root, p)
	if err != nil || th.Width != imgcache.ThumbSide || th.Height != 160 {
		t.Fatalf("thumb %dx%d %v", th.Width, th.Height, err)
	}
	outside := filepath.Join(t.TempDir(), "x.png")
	write(t, outside, img, 0)
	for _, bad := range []string{outside, root + "/../x.png", "2026-10/a.png", filepath.Join(root, "2026-10", "missing.png")} {
		if _, _, err := Read(root, bad); err == nil {
			t.Errorf("read %q", bad)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "2026-10", "l.png")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Read(root, filepath.Join(root, "2026-10", "l.png")); !errors.Is(err, imgcache.ErrNotAllowed) {
		t.Errorf("read through a link out: %v", err)
	}
}
