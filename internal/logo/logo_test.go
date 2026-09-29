package logo

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
)

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// alphaPNG is a w x h image, transparent except a half-transparent red pixel
// in the middle.
func alphaPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	m.SetNRGBA(w/2, h/2, color.NRGBA{R: 255, A: 128})
	return encodePNG(t, m)
}

func decode(t *testing.T, b []byte) image.Image {
	t.Helper()
	m, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("stored bytes are not a PNG: %v", err)
	}
	return m
}

func alphaAt(m image.Image, x, y int) uint32 {
	_, _, _, a := m.At(x, y).RGBA()
	return a >> 8
}

func TestNormalizeRaster(t *testing.T) {
	lossless, err := os.ReadFile("testdata/lossless-alpha.webp")
	if err != nil {
		t.Fatal(err)
	}
	lossy, err := os.ReadFile("testdata/lossy-alpha.webp")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name         string
		in           []byte
		source       string
		w, h         int
		cornerClear  bool
		wantSameSize bool
	}{
		{"png wide is scaled to 1024", alphaPNG(t, 2048, 1024), "png", 1024, 512, true, false},
		{"png tall is scaled to 1024", alphaPNG(t, 500, 2000), "png", 256, 1024, true, false},
		{"png square is scaled to 1024", alphaPNG(t, 3000, 3000), "png", 1024, 1024, true, false},
		{"png small is never enlarged", alphaPNG(t, 40, 30), "png", 40, 30, true, true},
		{"png of exactly the cap is untouched", alphaPNG(t, 1024, 700), "png", 1024, 700, true, true},
		{"png one pixel tall keeps a pixel", alphaPNG(t, 8000, 1), "png", 1024, 1, false, false},
		{"lossless webp with alpha", lossless, "webp", 75, 100, true, true},
		{"lossy webp with alpha", lossy, "webp", 400, 301, true, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, err := Normalize(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if r.Source != tc.source || r.W != tc.w || r.H != tc.h {
				t.Fatalf("got %s %dx%d, want %s %dx%d", r.Source, r.W, r.H, tc.source, tc.w, tc.h)
			}
			m := decode(t, r.PNG)
			if m.Bounds().Dx() != tc.w || m.Bounds().Dy() != tc.h {
				t.Fatalf("PNG is %v", m.Bounds())
			}
			if tc.cornerClear && alphaAt(m, 0, 0) != 0 {
				t.Fatalf("alpha lost: corner alpha = %d", alphaAt(m, 0, 0))
			}
			if r.Hash != Hash(r.PNG) || len(r.Hash) != 64 {
				t.Fatalf("hash = %q", r.Hash)
			}
		})
	}
}

func TestSmallPNGKeepsItsPixels(t *testing.T) {
	r, err := Normalize(alphaPNG(t, 40, 30))
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, r.PNG)
	_, _, _, a := m.At(20, 15).RGBA()
	if a>>8 < 127 || a>>8 > 129 {
		t.Fatalf("centre alpha = %d, want 128", a>>8)
	}
}

func TestHashFollowsTheImage(t *testing.T) {
	a, err := Normalize(alphaPNG(t, 64, 32))
	if err != nil {
		t.Fatal(err)
	}
	again, err := Normalize(alphaPNG(t, 64, 32))
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash != again.Hash {
		t.Fatalf("the same image hashed to %s and %s", a.Hash, again.Hash)
	}
	m := image.NewNRGBA(image.Rect(0, 0, 64, 32))
	m.SetNRGBA(3, 3, color.NRGBA{B: 255, A: 255})
	b, err := Normalize(encodePNG(t, m))
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash == b.Hash {
		t.Fatal("different images share a hash")
	}
}

func TestNormalizeRefusals(t *testing.T) {
	jpg := func() []byte {
		var b bytes.Buffer
		_ = jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
		return b.Bytes()
	}()
	good := alphaPNG(t, 200, 100)
	lossless, _ := os.ReadFile("testdata/lossless-alpha.webp")
	tests := []struct {
		name string
		in   []byte
		want error
	}{
		{"empty", nil, ErrInvalid},
		{"over 1 MiB", append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, MaxInput)...), ErrTooLarge},
		{"jpeg", jpg, ErrUnsupported},
		{"gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), ErrUnsupported},
		{"plain text", []byte("hello, logo"), ErrUnsupported},
		{"html", []byte("<html><body>x</body></html>"), ErrUnsupported},
		{"xml that is not svg", []byte(`<?xml version="1.0"?><note/>`), ErrUnsupported},
		{"png signature only", []byte("\x89PNG\r\n\x1a\n"), ErrInvalid},
		{"png truncated in the header", good[:20], ErrInvalid},
		{"png truncated in the data", good[:len(good)-40], ErrInvalid},
		{"png with a bad chunk", corrupt(good), ErrInvalid},
		{"webp signature only", []byte("RIFF\x04\x00\x00\x00WEBP"), ErrInvalid},
		{"webp truncated", lossless[:len(lossless)/2], ErrInvalid},
		{"png over 8192 px wide", pngHeader(9000, 10), ErrTooLarge},
		{"png over 16 Mpx", pngHeader(5000, 5000), ErrTooLarge},
		{"png of zero width", pngHeader(0, 10), ErrInvalid},
		{"animated webp (VP8X flag)", animatedWebP(true), ErrUnsupported},
		{"animated webp (ANMF chunk)", animatedWebP(false), ErrUnsupported},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Normalize(tc.in)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// corrupt flips a byte in the first IDAT chunk's data.
func corrupt(png []byte) []byte {
	out := bytes.Clone(png)
	i := bytes.Index(out, []byte("IDAT"))
	out[i+8] ^= 0xff
	return out
}

// pngHeader is a PNG whose IHDR claims w x h and that stops there: enough for
// DecodeConfig, which is all the pixel budget needs.
func pngHeader(w, h uint32) []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 6 // 8-bit RGBA
	writeChunk(&b, "IHDR", ihdr)
	return b.Bytes()
}

func writeChunk(b *bytes.Buffer, kind string, data []byte) {
	_ = binary.Write(b, binary.BigEndian, uint32(len(data)))
	b.WriteString(kind)
	b.Write(data)
	crc := crc32IEEE(append([]byte(kind), data...))
	_ = binary.Write(b, binary.BigEndian, crc)
}

func animatedWebP(flag bool) []byte {
	var body bytes.Buffer
	body.WriteString("WEBP")
	if flag {
		body.WriteString("VP8X")
		_ = binary.Write(&body, binary.LittleEndian, uint32(10))
		body.Write([]byte{0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0}) // animation flag, 1x1
	} else {
		body.WriteString("VP8X")
		_ = binary.Write(&body, binary.LittleEndian, uint32(10))
		body.Write(make([]byte, 10))
		body.WriteString("ANMF")
		_ = binary.Write(&body, binary.LittleEndian, uint32(0))
	}
	var out bytes.Buffer
	out.WriteString("RIFF")
	_ = binary.Write(&out, binary.LittleEndian, uint32(body.Len()))
	out.Write(body.Bytes())
	return out.Bytes()
}

func TestConverterLimits(t *testing.T) {
	c := NewConverter(1, 50*time.Millisecond)
	// Occupy the only slot, as a conversion that will not end.
	c.slots <- struct{}{}
	_, err := c.Convert(context.Background(), alphaPNG(t, 10, 10))
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	<-c.slots
	r, err := c.Convert(context.Background(), alphaPNG(t, 10, 10))
	if err != nil || r.W != 10 {
		t.Fatalf("free slot: %+v, %v", r, err)
	}
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.slots <- struct{}{}
	if _, err := c.Convert(ctx, alphaPNG(t, 10, 10)); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestNormalizePanicIsInvalid(t *testing.T) {
	// A decoder panic must not escape; the deferred recover turns it into ErrInvalid.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Normalize panicked: %v", r)
		}
	}()
	for _, in := range [][]byte{
		[]byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\xff", 64)),
		[]byte("RIFF\xff\xff\xff\xffWEBPVP8L" + strings.Repeat("\xff", 64)),
		[]byte("RIFF\xff\xff\xff\xffWEBPVP8 " + strings.Repeat("\x00", 64)),
	} {
		if _, err := Normalize(in); err == nil {
			t.Fatal("garbage was accepted")
		}
	}
}
