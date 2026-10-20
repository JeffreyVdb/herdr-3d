package imgcache

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

// photoOf is a w x h image with per-pixel noise over a gradient, as a
// photograph or a busy screenshot cut down: lossless bytes are many times
// the JPEG ones. alpha < 255 makes its left half that translucent.
func photoOf(w, h, seed int, alpha uint8) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	r := uint32(seed*2654435761 + 1)
	for y := range h {
		for x := range w {
			r = r*1664525 + 1013904223
			n := uint8(r >> 27) // 0..31
			i := img.PixOffset(x, y)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = uint8(x/3)+n, uint8(y/3)+n, uint8(seed*40)+n, 255
			if x < w/2 {
				img.Pix[i+3] = alpha
			}
		}
	}
	return img
}

// uiOf is a w x h flat interface screenshot: a white page, a grey bar and
// rows of dark one-pixel "text" strokes. Its PNG is smaller than its JPEG.
func uiOf(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 255, 255, 255, 255
	}
	set := func(x, y int, c [3]uint8) {
		i := img.PixOffset(x, y)
		img.Pix[i], img.Pix[i+1], img.Pix[i+2] = c[0], c[1], c[2]
	}
	for y := range min(h, 24) {
		for x := range w {
			set(x, y, [3]uint8{230, 232, 236})
		}
	}
	for row := 40; row+9 < h; row += 16 {
		for x := 12; x < w-12; x++ {
			if (x/7)%5 == 4 { // a space between words
				continue
			}
			for dy := range 9 {
				if (x*7+dy*3+row)%4 == 0 {
					set(x, row+dy, [3]uint8{30, 30, 40})
				}
			}
		}
	}
	return img
}

func encPNG(t testing.TB, img image.Image) []byte {
	t.Helper()
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
	if err != nil || th.Width != ThumbSide || th.Height != ThumbSide/2 {
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

// #125: what a thumbnail is encoded as. A JPEG stays JPEG; an opaque PNG,
// GIF or WebP is JPEG unless its lossless bytes are at most pngKeepPct % of
// the JPEG ones (flat interface screenshots: exact pixels for little more);
// a thumbnail with transparency is PNG, its alpha kept.
func TestThumbCodecPolicy(t *testing.T) {
	var gbuf bytes.Buffer
	if err := gif.Encode(&gbuf, uiOf(300, 200), nil); err != nil {
		t.Fatal(err)
	}
	var jbuf bytes.Buffer
	if err := jpeg.Encode(&jbuf, uiOf(600, 400), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		src  []byte
		mime string
	}{
		{"an opaque photo-like png, cut down", encPNG(t, photoOf(1200, 800, 1, 255)), JPEG},
		{"an opaque photo-like png within the size", encPNG(t, photoOf(400, 300, 2, 255)), JPEG},
		{"a flat interface png within the size", encPNG(t, uiOf(460, 300)), PNG},
		{"a flat interface png, cut down", encPNG(t, uiOf(1440, 900)), PNG},
		{"a flat gif", gbuf.Bytes(), PNG},
		{"a translucent photo-like png", encPNG(t, photoOf(1200, 800, 3, 128)), PNG},
		{"a jpeg of a flat interface", jbuf.Bytes(), JPEG},
	}
	for _, c := range cases {
		th, err := MakeThumb(c.src)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if th.Mime != c.mime || Sniff(th.Data) != c.mime {
			t.Errorf("%s: %s (bytes sniff as %s), want %s", c.name, th.Mime, Sniff(th.Data), c.mime)
		}
		if info, _ := Inspect(th.Data); info.Width != th.Width || info.Height != th.Height {
			t.Errorf("%s: %dx%d, the bytes say %+v", c.name, th.Width, th.Height, info)
		}
	}
	// The kept PNG is the exact pixels: a flat screenshot within the size is
	// what it was.
	ui := uiOf(460, 300)
	th, _ := MakeThumb(encPNG(t, ui))
	got, err := png.Decode(bytes.NewReader(th.Data))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []image.Point{{0, 0}, {20, 45}, {100, 50}, {459, 299}} {
		r1, g1, b1, a1 := ui.At(p.X, p.Y).RGBA()
		r2, g2, b2, a2 := got.At(p.X, p.Y).RGBA()
		if r1 != r2 || g1 != g2 || b1 != b2 || a1 != a2 {
			t.Errorf("pixel %v changed", p)
		}
	}
	// Transparency is kept, not put on white.
	th, _ = MakeThumb(encPNG(t, photoOf(1200, 800, 3, 128)))
	img, err := png.Decode(bytes.NewReader(th.Data))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(10, 10).RGBA(); a>>8 < 120 || a>>8 > 136 {
		t.Errorf("the translucent half has alpha %d", a>>8)
	}
	if _, _, _, a := img.At(th.Width-10, 10).RGBA(); a>>8 != 255 {
		t.Errorf("the opaque half has alpha %d", a>>8)
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

// cutCounter makes c count its thumbnail cuts.
func cutCounter(c *Cache) *atomic.Int64 {
	var n atomic.Int64
	c.cut = func(b []byte) (Thumb, error) { n.Add(1); return MakeThumb(b) }
	return &n
}

func noLoad(t *testing.T) func() ([]byte, error) {
	return func() ([]byte, error) {
		t.Error("the image was loaded")
		return nil, errors.New("no load")
	}
}

// #125: a thumbnail is kept on disk, apart from the images, in a 0700
// directory per variant of the algorithm, as a 0600 file; a new process
// (a bridge restart) serves it without loading the image or cutting it.
func TestThumbsSurviveARestart(t *testing.T) {
	old := parentUmask(0)
	defer parentUmask(old)
	dir := t.TempDir()
	b := encPNG(t, photoOf(900, 600, 4, 255))
	h := Hash(b)
	c, _ := New(Config{Dir: dir})
	first, err := c.Thumb(h, func() ([]byte, error) { return b, nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(dir, "t"), filepath.Join(dir, "t", thumbVariant)} {
		if fi, err := os.Stat(d); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v %v", d, fi, err)
		}
	}
	if fi, err := os.Stat(filepath.Join(dir, "t", thumbVariant, h)); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("thumbnail file %v, %v", fi, err)
	}
	// The originals' layer sees nothing of it: only the image at the top.
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if e.Name() != h && e.Name() != "t" {
			t.Errorf("leftover %q", e.Name())
		}
	}
	// The image is gone from the disk too: the thumbnail does not need it.
	if err := os.Remove(filepath.Join(dir, h)); err != nil {
		t.Fatal(err)
	}
	c2, _ := New(Config{Dir: dir})
	cuts := cutCounter(c2)
	got, err := c2.Thumb(h, noLoad(t))
	if err != nil || got.Mime != first.Mime || got.Width != first.Width || got.Height != first.Height || !bytes.Equal(got.Data, first.Data) {
		t.Fatalf("after a restart: %s %dx%d %d bytes, %v; want %s %dx%d %d bytes", got.Mime, got.Width, got.Height, len(got.Data), err, first.Mime, first.Width, first.Height, len(first.Data))
	}
	if cuts.Load() != 0 {
		t.Errorf("cut %d times", cuts.Load())
	}
	// Then from memory.
	if _, err := c2.Thumb(h, noLoad(t)); err != nil || c2.thumbDiskReads.Load() != 1 {
		t.Errorf("%v; %d disk reads", err, c2.thumbDiskReads.Load())
	}
}

// Another algorithm version's or setting's thumbnails are removed on first
// use; what does not belong in the variant's directory too.
func TestStaleThumbVariantsAreRemoved(t *testing.T) {
	dir := t.TempDir()
	b := pngOf(t, 600, 400, 7)
	h := Hash(b)
	stale := filepath.Join(dir, "t", "v0-480px-q82")
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(stale, h), []byte("an old thumbnail"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "t", "stray"), []byte("x"), 0o600)
	cur := filepath.Join(dir, "t", thumbVariant)
	_ = os.MkdirAll(cur, 0o700)
	_ = os.WriteFile(filepath.Join(cur, ".tmp-123"), []byte("half written"), 0o600)
	c, _ := New(Config{Dir: dir})
	if _, err := c.Thumb(h, func() ([]byte, error) { return b, nil }); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(filepath.Join(dir, "t"))
	if len(ents) != 1 || ents[0].Name() != thumbVariant {
		t.Errorf("t/ holds %v", ents)
	}
	ents, _ = os.ReadDir(cur)
	if len(ents) != 1 || ents[0].Name() != h {
		t.Errorf("the variant holds %v", ents)
	}
	// The variant names every setting.
	for _, want := range []string{fmt.Sprintf("v%d-", thumbVersion), fmt.Sprintf("%dpx", ThumbSide), fmt.Sprintf("q%d", jpegQuality), fmt.Sprintf("png%d", pngKeepPct), fmt.Sprintf("z%d", -pngLevel)} {
		if !strings.Contains(thumbVariant, want) {
			t.Errorf("variant %q does not say %q", thumbVariant, want)
		}
	}
}

// A damaged thumbnail file, or one that is another image's, is a miss: it
// is removed and the thumbnail cut again.
func TestDamagedThumbFileIsCutAgain(t *testing.T) {
	dir := t.TempDir()
	a, b := encPNG(t, photoOf(700, 500, 5, 255)), encPNG(t, uiOf(700, 500))
	c, _ := New(Config{Dir: dir})
	for _, x := range [][]byte{a, b} {
		if _, err := c.Thumb(Hash(x), func() ([]byte, error) { return x, nil }); err != nil {
			t.Fatal(err)
		}
	}
	path := func(x []byte) string { return filepath.Join(dir, "t", thumbVariant, Hash(x)) }
	good, _ := os.ReadFile(path(a))
	damage := map[string]func([]byte) []byte{
		"a flipped payload byte": func(f []byte) []byte { f[len(f)-10] ^= 1; return f },
		"truncated":              func(f []byte) []byte { return f[:len(f)/2] },
		"a header only":          func(f []byte) []byte { return f[:20] },
		"empty":                  func([]byte) []byte { return nil },
		"another image's file":   func([]byte) []byte { f, _ := os.ReadFile(path(b)); return f },
		"the image itself":       func([]byte) []byte { return a },
	}
	for name, d := range damage {
		if err := os.WriteFile(path(a), d(bytes.Clone(good)), 0o600); err != nil {
			t.Fatal(err)
		}
		c2, _ := New(Config{Dir: dir})
		cuts := cutCounter(c2)
		th, err := c2.Thumb(Hash(a), func() ([]byte, error) { return a, nil })
		if err != nil || cuts.Load() != 1 {
			t.Errorf("%s: %v, cut %d times", name, err, cuts.Load())
			continue
		}
		if f, _ := os.ReadFile(path(a)); !bytes.Equal(f, good) {
			t.Errorf("%s: the file was not written again", name)
		}
		if Sniff(th.Data) != th.Mime {
			t.Errorf("%s: served %s as %s", name, Sniff(th.Data), th.Mime)
		}
	}
}

// The thumbnails' disk has its own bound: the least recently used go
// first, and the images are never touched for it.
func TestThumbDiskIsBounded(t *testing.T) {
	dir := t.TempDir()
	var srcs [][]byte
	for i := range 8 {
		srcs = append(srcs, encPNG(t, photoOf(500, 400, 10+i, 255)))
	}
	probe, _ := MakeThumb(srcs[0])
	per := int64(len(probe.Data)) + 100
	c, _ := New(Config{Dir: dir, MaxThumbDiskBytes: 3 * per, MaxBytes: 1 << 20})
	base := time.Now().Add(-time.Hour)
	for i, b := range srcs[:3] {
		if _, err := c.Thumb(Hash(b), func() ([]byte, error) { return b, nil }); err != nil {
			t.Fatal(err)
		}
		// Older first, a second apart (mtime is the recency).
		at := base.Add(time.Duration(i) * time.Second)
		_ = os.Chtimes(filepath.Join(dir, "t", thumbVariant, Hash(b)), at, at)
	}
	// A restart, then the oldest is read: it becomes the newest.
	c, _ = New(Config{Dir: dir, MaxThumbDiskBytes: 3 * per, MaxBytes: 1 << 20})
	if _, err := c.Thumb(Hash(srcs[0]), noLoad(t)); err != nil {
		t.Fatal(err)
	}
	for _, b := range srcs[3:] {
		if _, err := c.Thumb(Hash(b), func() ([]byte, error) { return b, nil }); err != nil {
			t.Fatal(err)
		}
	}
	var total int64
	held := map[string]bool{}
	ents, _ := os.ReadDir(filepath.Join(dir, "t", thumbVariant))
	for _, e := range ents {
		fi, _ := e.Info()
		total += fi.Size()
		held[e.Name()] = true
	}
	if total > 3*per {
		t.Errorf("the thumbnails take %d bytes, bound %d", total, 3*per)
	}
	if held[Hash(srcs[1])] || held[Hash(srcs[2])] {
		t.Error("an older thumbnail outlived a recently read one")
	}
	if !held[Hash(srcs[7])] {
		t.Error("the newest thumbnail is gone")
	}
	for _, b := range srcs {
		if fi, err := os.Stat(filepath.Join(dir, Hash(b))); err != nil || fi.Size() != int64(len(b)) {
			t.Errorf("an image was touched: %v", err)
		}
	}
}

// One hash asked for at once is one disk read, or one cut.
func TestConcurrentThumbsReadTheDiskOnce(t *testing.T) {
	dir := t.TempDir()
	b := encPNG(t, photoOf(900, 700, 6, 255))
	h := Hash(b)
	c, _ := New(Config{Dir: dir})
	cuts := cutCounter(c)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if _, err := c.Thumb(h, func() ([]byte, error) { return b, nil }); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if cuts.Load() != 1 {
		t.Errorf("cut %d times", cuts.Load())
	}
	c2, _ := New(Config{Dir: dir})
	cuts = cutCounter(c2)
	for range 8 {
		wg.Go(func() {
			if th, err := c2.Thumb(h, noLoad(t)); err != nil || len(th.Data) == 0 {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if cuts.Load() != 0 || c2.thumbDiskReads.Load() != 1 {
		t.Errorf("cut %d times, read the disk %d times", cuts.Load(), c2.thumbDiskReads.Load())
	}
}

// A memory-only cache keeps no thumbnail anywhere but memory; what fails
// to cut fails as before and leaves nothing on disk.
func TestThumbFailuresAndMemoryOnly(t *testing.T) {
	c, _ := New(Config{})
	b := pngOf(t, 600, 400, 8)
	if _, err := c.Thumb(Hash(b), func() ([]byte, error) { return b, nil }); err != nil || c.thumbDiskReads.Load() != 0 {
		t.Fatalf("%v, %d disk reads", err, c.thumbDiskReads.Load())
	}
	dir := t.TempDir()
	d, _ := New(Config{Dir: dir})
	garbage := []byte("not an image at all")
	if _, err := d.Thumb(Hash(garbage), func() ([]byte, error) { return garbage, nil }); !errors.Is(err, ErrNotImage) {
		t.Errorf("garbage: %v", err)
	}
	// A header that claims more pixels than are decoded.
	huge := pngOf(t, 4, 4, 0)
	binary.BigEndian.PutUint32(huge[16:], 20_000)
	binary.BigEndian.PutUint32(huge[20:], 20_000)
	binary.BigEndian.PutUint32(huge[29:], crc32.ChecksumIEEE(huge[12:29]))
	if _, err := d.Thumb(Hash(huge), func() ([]byte, error) { return huge, nil }); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
	gone := errors.New("missing")
	if _, err := d.Thumb(Hash([]byte("elsewhere")), func() ([]byte, error) { return nil, gone }); !errors.Is(err, gone) {
		t.Errorf("missing: %v", err)
	}
	if ents, _ := os.ReadDir(filepath.Join(dir, "t", thumbVariant)); len(ents) != 0 {
		t.Errorf("failures left %v", ents)
	}
}

// t/ (or the variant's directory) that is a symlink or a file is removed,
// never followed: what it points at is left alone.
func TestThumbDirIsNeverFollowed(t *testing.T) {
	dir, elsewhere := t.TempDir(), t.TempDir()
	keep := filepath.Join(elsewhere, "keep")
	_ = os.WriteFile(keep, []byte("not the cache's"), 0o644)
	if err := os.Symlink(elsewhere, filepath.Join(dir, "t")); err != nil {
		t.Fatal(err)
	}
	b := pngOf(t, 600, 400, 9)
	c, _ := New(Config{Dir: dir})
	if _, err := c.Thumb(Hash(b), func() ([]byte, error) { return b, nil }); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(filepath.Join(dir, "t")); err != nil || !fi.IsDir() {
		t.Errorf("t/ is %v, %v", fi, err)
	}
	if fi, err := os.Stat(keep); err != nil || fi.Mode().Perm() != 0o644 {
		t.Errorf("the link's target was touched: %v %v", fi, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "t", thumbVariant, Hash(b))); err != nil {
		t.Error(err)
	}
	// The variant's directory as a file.
	dir2 := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir2, "t"), 0o700)
	_ = os.WriteFile(filepath.Join(dir2, "t", thumbVariant), []byte("x"), 0o600)
	c2, _ := New(Config{Dir: dir2})
	if _, err := c2.Thumb(Hash(b), func() ([]byte, error) { return b, nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir2, "t", thumbVariant, Hash(b))); err != nil {
		t.Error(err)
	}
}
