// Package logo turns an uploaded building logo into the PNG the bridge
// stores: PNG, WebP and a restricted SVG subset in, one straight-alpha PNG
// (long edge at most MaxEdge, never enlarged, aspect kept) out. It is pure Go
// (no cgo) and only the bridge links it; h3d-helper just proxies bytes.
//
// The type comes from the bytes (magic numbers, the XML root), never from a
// file name or a client MIME type. Every limit is checked before the costly
// step: the size before parsing, the pixel budget (DecodeConfig) before a
// decode, the whole SVG document (svg.go) before oksvg compiles geometry.
//
// Two boundaries keep an upload from hurting the bridge. What an SVG may
// contain is decided by the allowlist sanitiser (svg.go), in the bridge. What
// drawing it may cost is decided by a killable child process (worker.go): oksvg
// and rasterx take no context and their cost cannot be bounded from the
// source, so the bridge never runs them itself; it hands the sanitised copy to
// a re-executed copy of its own binary and kills that at a deadline. PNG and
// WebP are decoded in the bridge: their cost is bounded by the pixel caps
// checked on the header first.
package logo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"math"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// Limits.
const (
	MaxInput  = 1 << 20    // bytes of an upload
	MaxEdge   = 1024       // px, long edge of the stored PNG
	maxSide   = 8192       // px, per side of a PNG or WebP input
	maxPixels = 16_000_000 // px, of a PNG or WebP input
)

// The four ways a logo is refused; errors wrap exactly one of them.
var (
	ErrTooLarge    = errors.New("logo too large")   // bytes or pixels over the limit
	ErrUnsupported = errors.New("logo unsupported") // not PNG, WebP or a plain SVG; animated; SVG features we do not render
	ErrInvalid     = errors.New("logo invalid")     // cannot be decoded: empty, corrupt, truncated, draws nothing
	ErrBusy        = errors.New("logo busy")        // the conversion did not get a slot in time
)

// ErrTimeout marks an SVG that the render worker did not finish drawing before
// its deadline (it was killed). It always comes together with ErrUnsupported:
// retrying does not help, the document has to be simpler.
var ErrTimeout = errors.New("logo render timeout")

func tooLarge(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrTooLarge, fmt.Sprintf(format, a...))
}
func unsupported(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrUnsupported, fmt.Sprintf(format, a...))
}
func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// Result is a normalised logo.
type Result struct {
	PNG    []byte
	Hash   string // sha256 (hex) of PNG
	W, H   int
	Source string // what came in: "png", "webp" or "svg"
}

// Hash is the logo hash of stored PNG bytes: lower-case hex sha256.
func Hash(png []byte) string {
	sum := sha256.Sum256(png)
	return hex.EncodeToString(sum[:])
}

// svgStage draws a sanitised SVG (the canonical copy) and returns the stored
// PNG. Converter runs it in a child process; tests and the worker itself run
// it in-process (renderSVGPNG).
type svgStage func(clean []byte) (Result, error)

// normalize converts an upload to the stored PNG, with svg drawing the SVGs.
// It does no concurrency limiting: Converter does that.
func normalize(data []byte, svg svgStage) (res Result, err error) {
	defer func() { // a decoder bug must not take the bridge down
		if r := recover(); r != nil {
			res, err = Result{}, invalid("cannot process this image")
		}
	}()
	if len(data) == 0 {
		return Result{}, invalid("empty upload")
	}
	if len(data) > MaxInput {
		return Result{}, tooLarge("the file is over %d bytes", MaxInput)
	}
	var img image.Image
	source := ""
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		source = "png"
		img, err = decodeRaster(data, png.DecodeConfig, png.Decode)
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		source = "webp"
		if webpAnimated(data) {
			return Result{}, unsupported("animated WebP is not supported")
		}
		img, err = decodeRaster(data, webp.DecodeConfig, webp.Decode)
	default:
		if !looksLikeSVG(data) {
			return Result{}, unsupported("not a PNG, WebP or SVG image")
		}
		clean, err := sanitizeSVG(data) // in the bridge: oksvg only ever sees this copy
		if err != nil {
			return Result{}, err
		}
		return svg(clean)
	}
	if err != nil {
		return Result{}, err
	}
	return encodeResult(img, source)
}

func encodeResult(img image.Image, source string) (Result, error) {
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return Result{}, invalid("cannot encode the image: %v", err)
	}
	b := img.Bounds()
	return Result{PNG: out.Bytes(), Hash: Hash(out.Bytes()), W: b.Dx(), H: b.Dy(), Source: source}, nil
}

// fitSize is the stored size of a w x h source: the long edge at most
// MaxEdge, aspect kept, both sides at least 1. A raster is never enlarged; a
// vector (enlarge) is drawn at the full MaxEdge, so a 24 x 24 icon is sharp on
// a 3 m sign.
func fitSize(w, h float64, enlarge bool) (int, int, error) {
	if !(w > 0 && h > 0) || math.IsInf(w, 0) || math.IsInf(h, 0) || w > 1e6 || h > 1e6 {
		return 0, 0, invalid("the image has no usable size")
	}
	s := MaxEdge / math.Max(w, h)
	if !enlarge {
		s = math.Min(1, s)
	}
	return max(1, int(math.Round(w*s))), max(1, int(math.Round(h*s))), nil
}

func decodeRaster(data []byte, config func(r io.Reader) (image.Config, error), decode func(r io.Reader) (image.Image, error)) (image.Image, error) {
	c, err := config(bytes.NewReader(data))
	if err != nil {
		return nil, invalid("cannot read the image header: %v", err)
	}
	if c.Width <= 0 || c.Height <= 0 {
		return nil, invalid("the image is empty")
	}
	if c.Width > maxSide || c.Height > maxSide || int64(c.Width)*int64(c.Height) > maxPixels {
		return nil, tooLarge("%d x %d px is over the limit (%d px a side, %d megapixels)", c.Width, c.Height, maxSide, maxPixels/1_000_000)
	}
	src, err := decode(bytes.NewReader(data))
	if err != nil {
		return nil, invalid("cannot decode the image: %v", err)
	}
	if src.Bounds().Dx() != c.Width || src.Bounds().Dy() != c.Height {
		return nil, invalid("the image header and body disagree")
	}
	w, h, err := fitSize(float64(c.Width), float64(c.Height), false)
	if err != nil {
		return nil, err
	}
	if w == c.Width && h == c.Height {
		return src, nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst, nil
}

// webpAnimated reports whether a RIFF/WEBP file is animated: the VP8X
// animation flag, or an ANIM / ANMF chunk anywhere in the container.
func webpAnimated(b []byte) bool {
	if len(b) >= 21 && string(b[12:16]) == "VP8X" && b[20]&0x02 != 0 {
		return true
	}
	for off := 12; off+8 <= len(b); {
		id := string(b[off : off+4])
		if id == "ANIM" || id == "ANMF" {
			return true
		}
		n := int(uint32(b[off+4]) | uint32(b[off+5])<<8 | uint32(b[off+6])<<16 | uint32(b[off+7])<<24)
		off += 8 + n + n&1
	}
	return false
}
