// Package screenshare holds the bridge's side of the screen-share TV (M13, #15)
// that is not the hub: the check of a frame the game sends (a JPEG of at most
// MaxWidth × MaxHeight pixels and MaxBytes bytes) and the store the frames go
// to, a private directory on tmpfs whose files live for TTL. Pure Go; the hub
// (internal/server) asks the game for a frame and hands it here.
// docs/protocol.md "Screen share".
package screenshare

import (
	"bytes"
	"errors"
	"fmt"
	"image/jpeg"
)

// Bounds of one frame. The game draws at most 1920 px wide (keeping the
// aspect) and caps a very tall source at MaxHeight; a JPEG of that at
// quality 0.8 is a few hundred KiB, so MaxBytes leaves room for a noisy one.
const (
	MaxWidth  = 1920
	MaxHeight = 4096
	MaxBytes  = 8 << 20
)

// Why a frame is refused.
var (
	ErrInvalid  = errors.New("not a valid JPEG")
	ErrTooLarge = errors.New("frame too large")
)

// Info is what a valid frame is.
type Info struct {
	W, H  int
	Bytes int
}

// jpegMagic is the start of every JPEG (SOI and the first marker's 0xFF).
var jpegMagic = []byte{0xFF, 0xD8, 0xFF}

// Check validates a frame: the JPEG magic bytes, the size cap, dimensions
// within MaxWidth × MaxHeight read from the header before anything is
// decoded, and then a full decode, so a truncated or corrupt file is refused
// rather than stored. Errors wrap ErrInvalid or ErrTooLarge.
func Check(b []byte) (Info, error) {
	if len(b) > MaxBytes {
		return Info{}, fmt.Errorf("%w: %d bytes, at most %d", ErrTooLarge, len(b), MaxBytes)
	}
	if !bytes.HasPrefix(b, jpegMagic) {
		return Info{}, fmt.Errorf("%w: it does not start like one", ErrInvalid)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return Info{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if cfg.Width < 1 || cfg.Height < 1 {
		return Info{}, fmt.Errorf("%w: %d × %d pixels", ErrInvalid, cfg.Width, cfg.Height)
	}
	if cfg.Width > MaxWidth || cfg.Height > MaxHeight {
		return Info{}, fmt.Errorf("%w: %d × %d pixels, at most %d × %d", ErrTooLarge, cfg.Width, cfg.Height, MaxWidth, MaxHeight)
	}
	// The header bounds what decoding costs (at most MaxWidth × MaxHeight).
	if _, err := jpeg.Decode(bytes.NewReader(b)); err != nil {
		return Info{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return Info{W: cfg.Width, H: cfg.Height, Bytes: len(b)}, nil
}
