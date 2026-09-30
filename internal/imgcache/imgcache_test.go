package imgcache

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// pngOf is a w x h PNG; seed makes the bytes differ.
func pngOf(t testing.TB, w, h, seed int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		row := img.Pix[y*img.Stride : y*img.Stride+4*w]
		for x := range w {
			row[4*x], row[4*x+1], row[4*x+2], row[4*x+3] = uint8(x+seed), uint8(y*3), uint8(seed), 255
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSniffAndInspect(t *testing.T) {
	var jbuf, gbuf bytes.Buffer
	if err := jpeg.Encode(&jbuf, image.NewRGBA(image.Rect(0, 0, 4, 3)), nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.Encode(&gbuf, image.NewPaletted(image.Rect(0, 0, 5, 2), color.Palette{color.Black, color.White}), nil); err != nil {
		t.Fatal(err)
	}
	webp, err := os.ReadFile(filepath.Join("..", "logo", "testdata", "lossless-alpha.webp"))
	if err != nil {
		t.Skip("no webp fixture")
	}
	cases := []struct {
		name string
		b    []byte
		mime string
		w, h int
	}{
		{"png", pngOf(t, 7, 5, 0), PNG, 7, 5},
		{"jpeg", jbuf.Bytes(), JPEG, 4, 3},
		{"gif", gbuf.Bytes(), GIF, 5, 2},
		{"webp", webp, WEBP, 0, 0},
	}
	for _, c := range cases {
		info, err := Inspect(c.b)
		if err != nil || info.Mime != c.mime || (c.w > 0 && (info.Width != c.w || info.Height != c.h)) {
			t.Errorf("%s: %+v, %v", c.name, info, err)
		}
	}
	// Anything else is binary, whatever it is called: an SVG, HTML, a PDF.
	for _, b := range [][]byte{[]byte("<svg xmlns='http://www.w3.org/2000/svg'/>"), []byte("<html>"), []byte("%PDF-1.7"), nil, []byte("RIFF....WAVE")} {
		if info, err := Inspect(b); err == nil || info.Mime != Binary {
			t.Errorf("%q: %+v, %v", b, info, err)
		}
	}
}

func TestThumb(t *testing.T) {
	th, err := MakeThumb(pngOf(t, 1200, 600, 1))
	if err != nil || th.Mime != PNG || th.Width != ThumbSide || th.Height != ThumbSide/2 {
		t.Fatalf("landscape: %+v, %v", th, err)
	}
	if info, _ := Inspect(th.Data); info.Width != th.Width || info.Height != th.Height {
		t.Errorf("the thumbnail's bytes say %+v", info)
	}
	th, err = MakeThumb(pngOf(t, 300, 900, 2))
	if err != nil || th.Height != ThumbSide || th.Width != 160 {
		t.Fatalf("portrait: %+v, %v", th, err)
	}
	// Never enlarged.
	th, err = MakeThumb(pngOf(t, 40, 30, 3))
	if err != nil || th.Width != 40 || th.Height != 30 {
		t.Fatalf("small: %+v, %v", th, err)
	}
	// JPEG stays JPEG.
	var jbuf bytes.Buffer
	_ = jpeg.Encode(&jbuf, image.NewRGBA(image.Rect(0, 0, 900, 900)), nil)
	if th, err = MakeThumb(jbuf.Bytes()); err != nil || th.Mime != JPEG || th.Width != ThumbSide {
		t.Fatalf("jpeg: %+v, %v", th, err)
	}
	if _, err = MakeThumb([]byte("not an image")); err == nil {
		t.Error("garbage has a thumbnail")
	}
	if _, err = MakeThumb(pngOf(t, 8, 8, 0)[:40]); err == nil {
		t.Error("a truncated image has a thumbnail")
	}
}

// The memory cache holds at most MaxBytes, the least recently used out
// first; an image larger than the whole cache is never held.
func TestCacheIsBounded(t *testing.T) {
	c, err := New(Config{MaxBytes: 100_000})
	if err != nil {
		t.Fatal(err)
	}
	var hashes []string
	for i := range 40 {
		b := bytes.Repeat([]byte{byte(i), 1, 2, 3}, 2_500) // 10 kB each
		h := Hash(b)
		hashes = append(hashes, h)
		c.Put(h, b)
		if c.Bytes() > 100_000 {
			t.Fatalf("after %d images the cache holds %d bytes", i+1, c.Bytes())
		}
	}
	if c.Len() != 10 {
		t.Errorf("holds %d images, want the newest 10", c.Len())
	}
	if _, ok := c.Get(hashes[0]); ok {
		t.Error("the oldest image is still there")
	}
	if b, ok := c.Get(hashes[39]); !ok || Hash(b) != hashes[39] {
		t.Error("the newest image is gone")
	}
	// Recently read ones stay.
	c.Get(hashes[30])
	for i := 100; i < 108; i++ {
		b := bytes.Repeat([]byte{byte(i), 9}, 5_000)
		c.Put(Hash(b), b)
	}
	if _, ok := c.Get(hashes[30]); !ok {
		t.Error("a recently used image was dropped before older ones")
	}
	big := bytes.Repeat([]byte{7}, 200_000)
	c.Put(Hash(big), big)
	if _, ok := c.Get(Hash(big)); ok || c.Bytes() > 100_000 {
		t.Errorf("an image larger than the cache was held (%d bytes)", c.Bytes())
	}
	// A hash that is not one is not looked up (no path tricks in the disk cache).
	if _, ok := c.Get("../../etc/passwd"); ok {
		t.Error("a path was a hash")
	}
}

// Thumbnails share the bound.
func TestThumbsAreCachedAndBounded(t *testing.T) {
	c, _ := New(Config{MaxBytes: 40_000})
	loads := 0
	b := pngOf(t, 700, 500, 5)
	h := Hash(b)
	for range 3 {
		th, err := c.Thumb(h, func() ([]byte, error) { loads++; return b, nil })
		if err != nil || th.Width != ThumbSide {
			t.Fatal(th.Width, err)
		}
	}
	if loads != 1 {
		t.Errorf("loaded %d times", loads)
	}
	if _, err := c.Thumb(Hash([]byte("x")), func() ([]byte, error) { return []byte("y"), nil }); err == nil {
		t.Error("bytes that are not the hash's were cut")
	}
	for i := range 12 {
		bb := pngOf(t, 500, 400, 10+i)
		if _, err := c.Thumb(Hash(bb), func() ([]byte, error) { return bb, nil }); err != nil {
			t.Fatal(err)
		}
		if c.Bytes() > 40_000 {
			t.Fatalf("the cache holds %d bytes", c.Bytes())
		}
	}
}

func TestConcurrentThumbsCutOnce(t *testing.T) {
	c, _ := New(Config{})
	b := pngOf(t, 900, 700, 6)
	h := Hash(b)
	var mu sync.Mutex
	loads := 0
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Thumb(h, func() ([]byte, error) { mu.Lock(); loads++; mu.Unlock(); return b, nil }); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if loads != 1 {
		t.Errorf("loaded %d times", loads)
	}
}

// The disk cache is a 0700 directory of 0600 files, whatever the umask and
// whatever the directory was before; bytes come back from it after the
// memory lost them, and a file that does not match its name is dropped.
func TestDiskCache(t *testing.T) {
	old := parentUmask(0)
	defer parentUmask(old)
	dir := filepath.Join(t.TempDir(), "herdr-world", "img")
	if err := os.MkdirAll(dir, 0o755); err != nil { // a looser one already there
		t.Fatal(err)
	}
	c, err := New(Config{Dir: dir, MaxBytes: 20_000})
	if err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Errorf("directory mode %v", fi.Mode().Perm())
	}
	a, b := pngOf(t, 100, 100, 1), pngOf(t, 100, 100, 2)
	c.Put(Hash(a), a)
	c.Put(Hash(b), b)
	for _, x := range [][]byte{a, b} {
		fi, err := os.Stat(filepath.Join(dir, Hash(x)))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("file %v, %v", fi, err)
		}
	}
	// A new process: nothing in memory.
	c2, _ := New(Config{Dir: dir})
	if got, ok := c2.Get(Hash(a)); !ok || !bytes.Equal(got, a) {
		t.Error("the disk cache did not return the image")
	}
	// A file that is not its name is removed, not served.
	if err := os.WriteFile(filepath.Join(dir, Hash(b)), []byte("swapped"), 0o600); err != nil {
		t.Fatal(err)
	}
	c3, _ := New(Config{Dir: dir})
	if _, ok := c3.Get(Hash(b)); ok {
		t.Error("a file that does not match its hash was served")
	}
	if _, err := os.Stat(filepath.Join(dir, Hash(b))); err == nil {
		t.Error("it was not removed")
	}
	// Nothing but hashes and no temporary files are left.
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if !ValidHash(e.Name()) {
			t.Errorf("leftover %q", e.Name())
		}
	}
}

func TestDiskCacheIsBounded(t *testing.T) {
	dir := t.TempDir()
	c, _ := New(Config{Dir: dir, MaxDiskBytes: 6_000, MaxBytes: 1_000})
	for i := range 10 {
		b := bytes.Repeat([]byte{byte(i)}, 2_000)
		c.Put(Hash(b), b)
	}
	var total int64
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		fi, _ := e.Info()
		total += fi.Size()
	}
	if total > 6_000 {
		t.Errorf("the disk cache holds %d bytes", total)
	}
}

func TestReadFileRefusals(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readUnder(dir, dir); err == nil {
		t.Error("a directory was read")
	}
	link := filepath.Join(dir, "l.png")
	target := filepath.Join(dir, "t.png")
	_ = os.WriteFile(target, pngOf(t, 4, 4, 0), 0o600)
	_ = os.Symlink(target, link)
	if _, err := readUnder(dir, link); err == nil {
		t.Error("a symlink was followed")
	}
	if _, err := readUnder(dir, target); err != nil {
		t.Error(err)
	}
}
