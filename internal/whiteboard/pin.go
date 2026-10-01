package whiteboard

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Agents' pins (M13; the office CLI of M14 calls Store.Pin): an image or a
// note appended to a floor's board as a complete Excalidraw 0.18.1 element,
// every field present (docs/research/excalidraw-data.md, section 2), on top
// of everything (a fresh fractional index), in a column right of what is
// there, tagged with who pinned it in customData.herdr.

// Pin kinds.
const (
	PinImage = "image"
	PinNote  = "note"
)

// PinKindTag is customData.herdr.kind on an agent's pin.
const PinKindTag = "agent-pin"

// Layout of the pins' column, in scene units.
const (
	pinGap      = 80  // between the content and the column
	pinGapY     = 40  // between two pins in the column
	pinMaxW     = 640 // an image is scaled down to fit this box
	pinMaxH     = 480
	noteSize    = 20   // font size
	noteLineH   = 1.25 // Excalifont's line height
	noteCharW   = 0.6  // a rough average glyph width in ems: the browser measures the real one
	noteMaxLine = 200
)

// Pin is what an agent pins: Image (bytes) or Note (text), by Author.
// RequestID, if set, makes a retry idempotent: the same id pins once.
type Pin struct {
	Author    string
	Image     []byte
	Note      string
	RequestID string
}

// Tag is the customData.herdr of a pin.
type Tag struct {
	Author    string `json:"author"`
	Kind      string `json:"kind"`
	RequestID string `json:"requestId,omitempty"`
	At        int64  `json:"at"`
}

// base holds the fields every Excalidraw element has, in its own order.
type base struct {
	ID              string                     `json:"id"`
	Type            string                     `json:"type"`
	X               float64                    `json:"x"`
	Y               float64                    `json:"y"`
	Width           float64                    `json:"width"`
	Height          float64                    `json:"height"`
	Angle           float64                    `json:"angle"`
	StrokeColor     string                     `json:"strokeColor"`
	BackgroundColor string                     `json:"backgroundColor"`
	FillStyle       string                     `json:"fillStyle"`
	StrokeWidth     float64                    `json:"strokeWidth"`
	StrokeStyle     string                     `json:"strokeStyle"`
	Roughness       float64                    `json:"roughness"`
	Opacity         float64                    `json:"opacity"`
	GroupIDs        []string                   `json:"groupIds"`
	FrameID         *string                    `json:"frameId"`
	Index           string                     `json:"index"`
	Roundness       *struct{}                  `json:"roundness"`
	Seed            int64                      `json:"seed"`
	Version         int64                      `json:"version"`
	VersionNonce    int64                      `json:"versionNonce"`
	IsDeleted       bool                       `json:"isDeleted"`
	BoundElements   *[]struct{}                `json:"boundElements"`
	Updated         int64                      `json:"updated"`
	Link            *string                    `json:"link"`
	Locked          bool                       `json:"locked"`
	CustomData      map[string]json.RawMessage `json:"customData"`
}

// ImageElement is an Excalidraw image element.
type ImageElement struct {
	base
	FileID string     `json:"fileId"`
	Status string     `json:"status"`
	Scale  [2]float64 `json:"scale"`
	Crop   *struct{}  `json:"crop"`
}

// TextElement is an Excalidraw text element (no container).
type TextElement struct {
	base
	Text          string  `json:"text"`
	OriginalText  string  `json:"originalText"`
	FontSize      float64 `json:"fontSize"`
	FontFamily    int     `json:"fontFamily"`
	TextAlign     string  `json:"textAlign"`
	VerticalAlign string  `json:"verticalAlign"`
	ContainerID   *string `json:"containerId"`
	AutoResize    bool    `json:"autoResize"`
	LineHeight    float64 `json:"lineHeight"`
}

// fontExcalifont is Excalidraw's font id of Excalifont, its default hand.
const fontExcalifont = 5

func newBase(typ, id, index string, x, y, w, h float64, tag Tag, now int64) base {
	td, _ := json.Marshal(tag)
	return base{
		ID: id, Type: typ, X: x, Y: y, Width: w, Height: h,
		StrokeColor: "#1e1e1e", BackgroundColor: "transparent", FillStyle: "solid",
		StrokeWidth: 2, StrokeStyle: "solid", Roughness: 1, Opacity: 100,
		GroupIDs: []string{}, Index: index, Seed: rand31(), Version: 1, VersionNonce: rand31(),
		Updated: now, CustomData: map[string]json.RawMessage{"herdr": td},
	}
}

func newImage(id, index string, x, y, w, h float64, file string, tag Tag, now int64) ImageElement {
	b := newBase("image", id, index, x, y, w, h, tag, now)
	b.StrokeColor = "transparent" // as Excalidraw's own newImageElement
	return ImageElement{base: b, FileID: file, Status: "saved", Scale: [2]float64{1, 1}}
}

func newText(id, index string, x, y float64, text string, tag Tag, now int64) TextElement {
	lines := strings.Split(text, "\n")
	longest := 0
	for _, l := range lines {
		longest = max(longest, utf8.RuneCountInString(l))
	}
	// Placeholders: the browser measures the text with the font loaded
	// (restoreElements with refreshDimensions) before it renders the board.
	w := math.Max(noteSize, math.Round(float64(longest)*noteSize*noteCharW))
	h := float64(len(lines)) * noteSize * noteLineH
	return TextElement{
		base: newBase("text", id, index, x, y, w, h, tag, now), Text: text, OriginalText: text,
		FontSize: noteSize, FontFamily: fontExcalifont, TextAlign: "left", VerticalAlign: "top",
		AutoResize: true, LineHeight: noteLineH,
	}
}

// cleanNote normalises an agent's note: LF line ends, no control characters
// but tabs (as spaces) and newlines, trailing blanks trimmed, at most
// noteMaxLine lines. Empty is an error.
func cleanNote(s string) (string, error) {
	if len(s) > MaxNote {
		return "", fmt.Errorf("%w: a note is at most %d bytes", ErrTooLarge, MaxNote)
	}
	if !utf8.ValidString(s) {
		return "", fmt.Errorf("%w: a note must be UTF-8 text", ErrInvalid)
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ReplaceAll(s, "\t", "    ")
	s = strings.Map(func(r rune) rune {
		if r != '\n' && (unicode.IsControl(r) || r == utf8.RuneError) {
			return -1
		}
		return r
	}, s)
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRightFunc(l, unicode.IsSpace)
	}
	if len(lines) > noteMaxLine {
		return "", fmt.Errorf("%w: a note is at most %d lines", ErrTooLarge, noteMaxLine)
	}
	out := strings.Join(lines, "\n")
	if out == "" {
		return "", fmt.Errorf("%w: the note is empty", ErrInvalid)
	}
	return out, nil
}

// fitPin is an image's size on the board: its own size, scaled down to fit
// pinMaxW × pinMaxH, never up.
func fitPin(w, h int) (float64, float64) {
	fw, fh := float64(w), float64(h)
	k := math.Min(1, math.Min(pinMaxW/fw, pinMaxH/fh))
	return math.Max(1, math.Round(fw*k)), math.Max(1, math.Round(fh*k))
}

// pinSpot is where the next pin goes: in a column pinGap right of the
// board's content (every live element that is not already a pin in that
// column), below the pins already in it; at 0,0 on an empty board.
func pinSpot(els []element) (float64, float64) {
	var live []element
	for _, e := range els {
		if !e.IsDeleted {
			live = append(live, e)
		}
	}
	if len(live) == 0 {
		return 0, 0
	}
	// Content is everything but the pins standing in the column, and the
	// column is right of the content: a pin moved into the drawing counts as
	// drawing. Each round can only move the column right, so it settles.
	inColumn := func(e element, col float64) bool {
		x0, _, _, _ := e.bounds()
		return e.pinKind() == PinKindTag && x0 >= col
	}
	col := math.Inf(-1)
	for range len(live) + 1 {
		right, any := math.Inf(-1), false
		for _, e := range live {
			if inColumn(e, col) {
				continue
			}
			_, _, x1, _ := e.bounds()
			right, any = math.Max(right, x1), true
		}
		next := 0.0
		if any {
			next = right + pinGap
		}
		if next == col {
			break
		}
		col = next
	}
	top, bottom, pins := math.Inf(1), math.Inf(-1), false
	for _, e := range live {
		_, y0, _, y1 := e.bounds()
		top = math.Min(top, y0)
		if inColumn(e, col) {
			bottom, pins = math.Max(bottom, y1), true
		}
	}
	if pins {
		return col, bottom + pinGapY
	}
	return col, top
}

// lastIndex is the highest valid index in the scene, tombstones included
// ("" when there is none).
func lastIndex(els []element) string {
	last := ""
	for _, e := range els {
		if e.Index != nil && ValidIndex(*e.Index) && *e.Index > last {
			last = *e.Index
		}
	}
	return last
}

func rand31() int64 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return int64(binary.BigEndian.Uint32(b[:]) & 0x7fffffff)
}

// newID is an element id in Excalidraw's alphabet (it uses 21-character
// nanoids; any unique string works).
func newID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return "pin_" + hex.EncodeToString(b[:])
}
