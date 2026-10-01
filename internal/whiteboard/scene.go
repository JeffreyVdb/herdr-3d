package whiteboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

// What a saved board is: the ordered Excalidraw elements, deletion
// tombstones included (an open client needs them to reconcile a delete), and
// the four appState keys Excalidraw itself marks as part of a stored scene.
// Everything else in a client's appState (selection, tool, zoom, menus,
// collaborators) is the session's, never the board's.

// Caps on what a save, a file and a render may be. docs/protocol.md "Whiteboard".
const (
	MaxScene      = 16 << 20  // bytes of a scene's JSON
	MaxElements   = 20000     // elements of a scene, tombstones included
	MaxFile       = 8 << 20   // bytes of one image file
	MaxFloorFiles = 256 << 20 // bytes of a floor's image files together
	MaxRender     = 16 << 20  // bytes of render.png
	MaxRenderSide = 2400      // px, the longest side of render.png
	MaxNote       = 4 << 10   // bytes of an agent's note
	maxCoord      = 1e7       // scene units; Excalidraw has no bound, a sane board does
	maxPixels     = 64 << 20  // decoded pixels of an image an agent pins
)

// ExcalidrawVersion is the editor the scenes are made with (game/package.json).
const ExcalidrawVersion = "0.18.1"

// elementTypes are the element types Excalidraw 0.18.1 stores (selection
// elements are never stored).
var elementTypes = map[string]bool{
	"rectangle": true, "diamond": true, "ellipse": true, "arrow": true, "line": true,
	"freedraw": true, "text": true, "image": true, "frame": true, "magicframe": true,
	"embeddable": true, "iframe": true,
}

// AppState is the part of Excalidraw's appState a board keeps.
type AppState struct {
	ViewBackgroundColor string   `json:"viewBackgroundColor"`
	GridSize            *float64 `json:"gridSize"`
	GridStep            int      `json:"gridStep"`
	GridModeEnabled     bool     `json:"gridModeEnabled"`
}

// DefaultAppState is Excalidraw's default for those keys.
func DefaultAppState() AppState {
	g := 20.0
	return AppState{ViewBackgroundColor: "#ffffff", GridSize: &g, GridStep: 5, GridModeEnabled: false}
}

var colorRe = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32})$`)

// cleanAppState keeps the allowlisted keys of a client's appState, each
// checked; a bad or absent value falls back to the default.
func cleanAppState(raw json.RawMessage) AppState {
	out := DefaultAppState()
	if len(raw) == 0 {
		return out
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return out
	}
	var s string
	if json.Unmarshal(m["viewBackgroundColor"], &s) == nil && colorRe.MatchString(s) {
		out.ViewBackgroundColor = s
	}
	var f float64
	if v, ok := m["gridSize"]; ok && string(v) == "null" {
		out.GridSize = nil
	} else if json.Unmarshal(v, &f) == nil && f >= 1 && f <= 1000 {
		out.GridSize = &f
	}
	var n int
	if json.Unmarshal(m["gridStep"], &n) == nil && n >= 1 && n <= 100 {
		out.GridStep = n
	}
	var b bool
	if json.Unmarshal(m["gridModeEnabled"], &b) == nil {
		out.GridModeEnabled = b
	}
	return out
}

// Scene is a board's content in Excalidraw's scene shape (type
// "excalidraw", format version 2). Elements are kept verbatim, as the client
// or the pin code wrote them.
type Scene struct {
	Type     string            `json:"type"`
	Version  int               `json:"version"`
	Source   string            `json:"source"`
	Elements []json.RawMessage `json:"elements"`
	AppState AppState          `json:"appState"`
}

func emptyScene() Scene {
	return Scene{Type: "excalidraw", Version: 2, Source: "herdr-3d", Elements: []json.RawMessage{}, AppState: DefaultAppState()}
}

// FileMeta describes one stored image file (its bytes are files/<id>).
type FileMeta struct {
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	Created  int64  `json:"created"` // unix ms
}

// element is what the store reads of an element: enough to check its shape,
// lay out pins and find the files it uses. Decoding into typed fields is
// the type check (a string x is an error).
type element struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	X            float64         `json:"x"`
	Y            float64         `json:"y"`
	Width        float64         `json:"width"`
	Height       float64         `json:"height"`
	Version      int64           `json:"version"`
	VersionNonce int64           `json:"versionNonce"`
	IsDeleted    bool            `json:"isDeleted"`
	Index        *string         `json:"index"`
	FileID       *string         `json:"fileId"`
	Points       [][2]float64    `json:"points"`
	CustomData   json.RawMessage `json:"customData"`
}

// bounds is the element's box in scene units: x/y/width/height, or for a
// linear element the box of its points (which may lie left of or above x/y).
func (e element) bounds() (x0, y0, x1, y1 float64) {
	if len(e.Points) > 0 && (e.Type == "arrow" || e.Type == "line" || e.Type == "freedraw") {
		x0, y0, x1, y1 = math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, p := range e.Points {
			x0, y0 = min(x0, e.X+p[0]), min(y0, e.Y+p[1])
			x1, y1 = max(x1, e.X+p[0]), max(y1, e.Y+p[1])
		}
		return
	}
	return e.X, e.Y, e.X + e.Width, e.Y + e.Height
}

// pinKind is the customData tag an agent's pin carries ("" for anything else).
func (e element) pinKind() string {
	if len(e.CustomData) == 0 {
		return ""
	}
	var c struct {
		Herdr struct {
			Kind string `json:"kind"`
		} `json:"herdr"`
	}
	if json.Unmarshal(e.CustomData, &c) != nil {
		return ""
	}
	return c.Herdr.Kind
}

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// parseElement checks one element of a client's scene.
func parseElement(raw json.RawMessage) (element, error) {
	var e element
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return e, fmt.Errorf("an element is not a JSON object")
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return e, fmt.Errorf("an element has a field of the wrong type: %v", err)
	}
	if !idRe.MatchString(e.ID) {
		return e, fmt.Errorf("an element id must be 1-64 of A-Z a-z 0-9 _ -")
	}
	if !elementTypes[e.Type] {
		return e, fmt.Errorf("element %s: unknown type %q", e.ID, clip(e.Type))
	}
	if e.Version < 1 {
		return e, fmt.Errorf("element %s: version must be at least 1", e.ID)
	}
	for _, v := range []float64{e.X, e.Y, e.Width, e.Height} {
		if math.Abs(v) > maxCoord {
			return e, fmt.Errorf("element %s: a coordinate is out of range", e.ID)
		}
	}
	if e.Index != nil && !ValidIndex(*e.Index) {
		return e, fmt.Errorf("element %s: index %q is not a fractional index", e.ID, clip(*e.Index))
	}
	if e.Type == "image" && e.FileID != nil && *e.FileID != "" && !ValidFileID(*e.FileID) {
		return e, fmt.Errorf("element %s: fileId must be the sha256 (hex) of the image's bytes", e.ID)
	}
	return e, nil
}

// ValidFileID reports whether s is a file id: 64 lower-case hex digits.
func ValidFileID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// fileRefs lists the file ids images use, live ones first; tombstones'
// files are kept too (an undo may bring them back), but they need not exist.
func fileRefs(els []element) (live, dead []string) {
	seenLive, seenDead := map[string]bool{}, map[string]bool{}
	for _, e := range els {
		if e.Type != "image" || e.FileID == nil || *e.FileID == "" {
			continue
		}
		id := *e.FileID
		if e.IsDeleted {
			if !seenDead[id] {
				seenDead[id] = true
				dead = append(dead, id)
			}
		} else if !seenLive[id] {
			seenLive[id] = true
			live = append(live, id)
		}
	}
	return live, dead
}

func clip(s string) string {
	if len(s) <= 40 {
		return s
	}
	for i := 40; i > 0; i-- {
		if utf8.RuneStart(s[i]) {
			return s[:i] + "…"
		}
	}
	return ""
}

// parseScene checks a client's scene: its elements (shape, unique ids) and
// appState (kept to the allowlist).
func parseScene(raw []byte) ([]json.RawMessage, []element, AppState, error) {
	if len(raw) > MaxScene {
		return nil, nil, AppState{}, fmt.Errorf("%w: the scene is over %d bytes", ErrTooLarge, MaxScene)
	}
	var in struct {
		Elements []json.RawMessage `json:"elements"`
		AppState json.RawMessage   `json:"appState"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := d.Decode(&in); err != nil {
		return nil, nil, AppState{}, fmt.Errorf("%w: the scene is not a JSON object with elements: %v", ErrInvalid, err)
	}
	if in.Elements == nil {
		in.Elements = []json.RawMessage{}
	}
	if len(in.Elements) > MaxElements {
		return nil, nil, AppState{}, fmt.Errorf("%w: the scene has %d elements (at most %d)", ErrTooLarge, len(in.Elements), MaxElements)
	}
	els := make([]element, len(in.Elements))
	seen := make(map[string]bool, len(in.Elements))
	for i, r := range in.Elements {
		e, err := parseElement(r)
		if err != nil {
			return nil, nil, AppState{}, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		if seen[e.ID] {
			return nil, nil, AppState{}, fmt.Errorf("%w: element id %s is used twice", ErrInvalid, e.ID)
		}
		seen[e.ID] = true
		els[i] = e
		in.Elements[i] = compact(r)
	}
	return in.Elements, els, cleanAppState(in.AppState), nil
}

func compact(r json.RawMessage) json.RawMessage {
	var b bytes.Buffer
	if json.Compact(&b, r) != nil {
		return r
	}
	return b.Bytes()
}

// cleanAuthor is who a change is attributed to: printable, at most 64
// bytes, "someone" when nothing is left.
func cleanAuthor(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == utf8.RuneError {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	for len(s) > 64 {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	if s == "" {
		return "someone"
	}
	return s
}
