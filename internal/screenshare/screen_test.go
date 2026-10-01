package screenshare

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// JPEG encodes a w × h test frame.
func JPEG(t testing.TB, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 0x80, 0xff})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestCheck(t *testing.T) {
	ok := JPEG(t, 320, 180)
	info, err := Check(ok)
	if err != nil || info != (Info{W: 320, H: 180, Bytes: len(ok)}) {
		t.Fatalf("Check(valid) = %+v, %v", info, err)
	}
	if info, err := Check(JPEG(t, MaxWidth, 8)); err != nil || info.W != MaxWidth {
		t.Fatalf("Check(1920 wide) = %+v, %v", info, err)
	}
	var pngb bytes.Buffer
	_ = png.Encode(&pngb, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	huge := append([]byte{0xFF, 0xD8, 0xFF}, make([]byte, MaxBytes)...)
	for _, c := range []struct {
		name string
		b    []byte
		want error
	}{
		{"empty", nil, ErrInvalid},
		{"png", pngb.Bytes(), ErrInvalid},
		{"text", []byte("hello, not a picture"), ErrInvalid},
		{"magic only", []byte{0xFF, 0xD8, 0xFF, 0xE0}, ErrInvalid},
		{"truncated", ok[:len(ok)/2], ErrInvalid},
		{"too wide", JPEG(t, MaxWidth+1, 8), ErrTooLarge},
		{"too tall", JPEG(t, 8, MaxHeight+1), ErrTooLarge},
		{"oversize", huge, ErrTooLarge},
	} {
		if _, err := Check(c.b); !errors.Is(err, c.want) {
			t.Errorf("%s: Check = %v, want %v", c.name, err, c.want)
		}
	}
}

// clock is a fake clock for the store.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

const idA, idB = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"

func TestFramesSaveModesAndTTL(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	dir := filepath.Join(t.TempDir(), "herdr-world", "screen")
	f, err := Open(dir, Options{TTL: 10 * time.Minute, Now: clk.now})
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode = %v, %v; want 0700", fi.Mode(), err)
	}
	b := JPEG(t, 64, 36)
	pa, err := f.Save(idA, b)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(pa) != dir || !strings.HasSuffix(pa, idA+".jpg") {
		t.Fatalf("path %s", pa)
	}
	if fi, _ := os.Stat(pa); fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v, want 0600", fi.Mode())
	}
	if got, _ := os.ReadFile(pa); !bytes.Equal(got, b) {
		t.Fatal("stored bytes differ")
	}
	clk.add(6 * time.Minute)
	pb, err := f.Save(idB, b)
	if err != nil {
		t.Fatal(err)
	}
	// Something that is not a frame stays, whatever its age.
	other := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(other, []byte("x"), 0o600)

	clk.add(4*time.Minute - time.Millisecond)
	if n, err := f.Sweep(); n != 0 || err != nil {
		t.Fatalf("sweep before the TTL: %d, %v", n, err)
	}
	clk.add(time.Millisecond) // A is 10 min old
	if n, err := f.Sweep(); n != 1 || err != nil {
		t.Fatalf("sweep at A's TTL: %d, %v", n, err)
	}
	if _, err := os.Stat(pa); !os.IsNotExist(err) {
		t.Fatal("A survived its TTL")
	}
	if _, err := os.Stat(pb); err != nil {
		t.Fatal("B went early")
	}
	clk.add(6 * time.Minute)
	if n, _ := f.Sweep(); n != 1 {
		t.Fatalf("sweep at B's TTL removed %d", n)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("a file that is not a frame was removed")
	}
	if _, err := f.Save("../escape", b); err == nil {
		t.Fatal("a bad id was saved")
	}
}

func TestFramesOpenSweepsAndTightens(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "frame-"+itoa(clk.now().Add(-11*time.Minute).UnixMilli())+"-"+idA+".jpg")
	fresh := filepath.Join(dir, "frame-"+itoa(clk.now().Add(-time.Minute).UnixMilli())+"-"+idB+".jpg")
	tmp := filepath.Join(dir, ".tmp-123")
	for _, p := range []string{old, fresh, tmp} {
		_ = os.WriteFile(p, []byte("x"), 0o600)
	}
	if _, err := Open(dir, Options{Now: clk.now}); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir not tightened: %v", fi.Mode())
	}
	for p, want := range map[string]bool{old: false, fresh: true, tmp: false} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}

func TestFramesOpenRefusesASymlink(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "screen")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(link, Options{}); err == nil {
		t.Fatal("Open followed a symlink")
	}
	if _, err := Open("relative/dir", Options{}); err == nil {
		t.Fatal("Open took a relative directory")
	}
}

func TestFramesRunSweeps(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	f, err := Open(t.TempDir(), Options{TTL: time.Minute, Now: clk.now})
	if err != nil {
		t.Fatal(err)
	}
	p, _ := f.Save(idA, []byte("x"))
	clk.add(time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx, time.Millisecond); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the janitor did not remove an expired frame")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
}

func TestDefaultDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/4242")
	if d, fb, err := DefaultDir(); d != "/run/user/4242/herdr-world/screen" || fb || err != nil {
		t.Fatalf("DefaultDir = %q, %v, %v", d, fb, err)
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	d, fb, err := DefaultDir()
	if err != nil {
		if !errors.Is(err, ErrNoRuntimeDir) || d != "" {
			t.Fatalf("DefaultDir without a runtime dir = %q, %v", d, err)
		}
		return
	}
	if !fb || !strings.HasPrefix(d, "/run/user/") {
		t.Fatalf("DefaultDir fallback = %q, %v", d, fb)
	}
}

func TestValidID(t *testing.T) {
	for id, want := range map[string]bool{idA: true, strings.ToUpper(idA): false, idA[:31]: false, idA + "0": false, "../" + idA[3:]: false, "": false} {
		if ValidID(id) != want {
			t.Errorf("ValidID(%q) = %v", id, !want)
		}
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
