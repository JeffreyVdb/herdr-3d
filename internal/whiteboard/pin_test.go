package whiteboard

import (
	"encoding/json"
	"errors"
	"flag"
	"image/color"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/pinned-scene.json")

// Every field of an Excalidraw 0.18.1 element and its JSON type
// (packages/excalidraw/element/types.ts at v0.18.1): "null|string" may be
// either. docs/research/excalidraw-data.md, section 2.
var baseFields = map[string]string{
	"id": "string", "type": "string", "x": "number", "y": "number", "width": "number", "height": "number",
	"angle": "number", "strokeColor": "string", "backgroundColor": "string", "fillStyle": "string",
	"strokeWidth": "number", "strokeStyle": "string", "roughness": "number", "opacity": "number",
	"groupIds": "array", "frameId": "null|string", "index": "string", "roundness": "null|object",
	"seed": "number", "version": "number", "versionNonce": "number", "isDeleted": "bool",
	"boundElements": "null|array", "updated": "number", "link": "null|string", "locked": "bool",
	"customData": "object",
}

var typeFields = map[string]map[string]string{
	"image": {"fileId": "string", "status": "string", "scale": "array", "crop": "null|object"},
	"text": {"text": "string", "originalText": "string", "fontSize": "number", "fontFamily": "number",
		"textAlign": "string", "verticalAlign": "string", "containerId": "null|string", "autoResize": "bool", "lineHeight": "number"},
}

func jsonType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "bool"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "?"
}

// checkElement checks one pin is a complete, well-typed Excalidraw element.
func checkElement(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	typ, _ := m["type"].(string)
	want := map[string]string{}
	for k, v := range baseFields {
		want[k] = v
	}
	for k, v := range typeFields[typ] {
		want[k] = v
	}
	if typeFields[typ] == nil {
		t.Fatalf("pin of type %q", typ)
	}
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var wantKeys []string
	for k := range want {
		wantKeys = append(wantKeys, k)
	}
	sort.Strings(wantKeys)
	if !reflect.DeepEqual(keys, wantKeys) {
		t.Fatalf("%s fields\n got %v\nwant %v", typ, keys, wantKeys)
	}
	for k, w := range want {
		if got := jsonType(m[k]); !slices.Contains(strings.Split(w, "|"), got) {
			t.Errorf("%s.%s is %s, want %s", typ, k, got, w)
		}
	}
	for _, k := range []string{"seed", "version", "versionNonce", "updated"} {
		if f := m[k].(float64); f != float64(int64(f)) || f < 0 {
			t.Errorf("%s.%s = %v, not a non-negative integer", typ, k, f)
		}
	}
	if m["isDeleted"] != false || m["locked"] != false || m["opacity"] != 100.0 || m["version"].(float64) < 1 {
		t.Errorf("%s: %v", typ, m)
	}
	if typ == "image" {
		if s := m["status"]; s != "saved" {
			t.Errorf("status %v", s)
		}
		if sc := m["scale"].([]any); len(sc) != 2 || sc[0] != 1.0 || sc[1] != 1.0 {
			t.Errorf("scale %v", sc)
		}
		if !ValidFileID(m["fileId"].(string)) {
			t.Errorf("fileId %v", m["fileId"])
		}
	}
	if typ == "text" {
		if m["text"] != m["originalText"] || m["fontFamily"] != 5.0 || m["lineHeight"] != 1.25 || m["width"].(float64) <= 0 || m["height"].(float64) <= 0 {
			t.Errorf("text %v", m)
		}
		if !slices.Contains([]any{"left", "center", "right"}, m["textAlign"]) || !slices.Contains([]any{"top", "middle", "bottom"}, m["verticalAlign"]) {
			t.Errorf("align %v %v", m["textAlign"], m["verticalAlign"])
		}
	}
	herdr, _ := m["customData"].(map[string]any)["herdr"].(map[string]any)
	if herdr["kind"] != PinKindTag || herdr["author"] == "" {
		t.Errorf("customData %v", m["customData"])
	}
	return m
}

func TestPinsAreValidElementsOnTheRight(t *testing.T) {
	s, _ := newStore(t)
	// A drawing: a rectangle up to x 300, a line whose points reach x 500, and a tombstone far right (ignored).
	line := `{"id":"l1","type":"line","x":100,"y":-40,"width":400,"height":10,"version":1,"versionNonce":1,"isDeleted":false,"index":"a1","points":[[0,0],[400,10]]}`
	gone := strings.Replace(rect("dead", "a3", 5000, 0, 2), `"isDeleted":false`, `"isDeleted":true`, 1)
	save(t, s, "f", 0, scene(rect("r1", "a0", 200, 0, 1), line, gone))
	img := pngOf(t, 1280, 720, color.RGBA{30, 90, 200, 255})
	r1, err := s.Pin("f", Pin{Author: "Nibble", Image: img, RequestID: "req-1"})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := s.Pin("f", Pin{Author: "Crumpet", Note: "Review the layout\r\nthen\tship it\x07  "})
	if err != nil {
		t.Fatal(err)
	}
	if r2.Head.Version != 3 || !r2.Head.Stale() || r2.Head.RenderVersion != 1 || len(r2.Head.StalePins) != 2 {
		t.Fatalf("head %+v", r2.Head)
	}
	if sp := r2.Head.StalePins; sp[0].Kind != PinImage || sp[0].Author != "Nibble" || sp[0].File != Hash(img) || sp[1].Kind != PinNote || sp[1].Note != "Review the layout then ship it" {
		t.Fatalf("stale pins %+v", sp)
	}
	im := checkElement(t, r1.Elements[0])
	tx := checkElement(t, r2.Elements[0])
	// Right of the line's points (x 500) plus the gap; the tombstone does not count.
	if im["x"] != 580.0 || im["y"] != -40.0 || im["width"] != 640.0 || im["height"] != 360.0 {
		t.Fatalf("image at %v,%v %vx%v", im["x"], im["y"], im["width"], im["height"])
	}
	// The note goes below the image, in the same column.
	if tx["x"] != 580.0 || tx["y"] != -40.0+360+pinGapY {
		t.Fatalf("note at %v,%v", tx["x"], tx["y"])
	}
	if tx["text"] != "Review the layout\nthen    ship it" {
		t.Fatalf("text %q", tx["text"])
	}
	// On top of everything, tombstones included: after a3.
	b, _ := s.Get("f")
	var idx []string
	for _, raw := range b.Snapshot.Scene.Elements {
		var e element
		_ = json.Unmarshal(raw, &e)
		idx = append(idx, *e.Index)
	}
	if !slices.Equal(idx, []string{"a0", "a1", "a3", "a4", "a5"}) || !slices.IsSorted(idx) {
		t.Fatalf("indices %v", idx)
	}
	if _, ok := b.Snapshot.Files[Hash(img)]; !ok {
		t.Fatalf("manifest %v", b.Snapshot.Files)
	}
	// A save with a fresh render makes it current again.
	h := save(t, s, "f", 3, scene(rect("r1", "a0", 200, 0, 1)))
	if h.Stale() || len(h.StalePins) != 0 {
		t.Fatalf("after save %+v", h)
	}
}

func TestPinRequestIsIdempotent(t *testing.T) {
	s, _ := newStore(t)
	a, err := s.Pin("f", Pin{Author: "Nibble", Note: "once", RequestID: "r-1"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Pin("f", Pin{Author: "Nibble", Note: "once", RequestID: "r-1"})
	if err != nil || !b.Repeated || b.Head.Version != a.Head.Version || string(b.Elements[0]) != string(a.Elements[0]) {
		t.Fatalf("retry: %+v %v", b, err)
	}
}

func TestPinOnEmptyBoardAndColumnStacking(t *testing.T) {
	s, _ := newStore(t)
	r, _ := s.Pin("f", Pin{Author: "A", Note: "first"})
	m := checkElement(t, r.Elements[0])
	if m["x"] != 0.0 || m["y"] != 0.0 || m["index"] != "a0" {
		t.Fatalf("first pin %v,%v %v", m["x"], m["y"], m["index"])
	}
	// Only pins on the board: the next one goes below in the same column.
	r, _ = s.Pin("f", Pin{Author: "B", Note: "two\nlines"})
	m = checkElement(t, r.Elements[0])
	if m["x"] != 0.0 || m["y"] != 25.0+pinGapY || m["index"] != "a1" || m["height"] != 50.0 {
		t.Fatalf("second pin %v,%v %v h%v", m["x"], m["y"], m["index"], m["height"])
	}
}

func TestPinRefusals(t *testing.T) {
	s, _ := newStore(t)
	for _, c := range []struct {
		p    Pin
		want error
	}{
		{Pin{}, ErrInvalid},
		{Pin{Note: " \n\t "}, ErrInvalid},
		{Pin{Note: strings.Repeat("x", MaxNote+1)}, ErrTooLarge},
		{Pin{Note: strings.Repeat("x\n", noteMaxLine+1)}, ErrTooLarge},
		{Pin{Note: "\xff"}, ErrInvalid},
		{Pin{Image: []byte("<svg/>")}, ErrUnsupported},
		{Pin{Image: pngOf(t, 2, 2, color.Black)[:20]}, ErrInvalid},
		{Pin{Image: pngOf(t, 2, 2, color.Black), Note: "both"}, ErrInvalid},
		{Pin{Note: "x", RequestID: strings.Repeat("r", 129)}, ErrInvalid},
	} {
		if _, err := s.Pin("f", c.p); !errors.Is(err, c.want) {
			t.Errorf("%+v: %v, want %v", c.p.Note, err, c.want)
		}
	}
	if h, _ := s.Head("f"); h.Version != 0 {
		t.Fatalf("a refused pin was stored")
	}
}

// TestPinnedSceneFixture writes (with -update) or checks the scene the game's
// vitest feeds through Excalidraw's own restoreElements
// (game/src/whiteboard/goPins.test.ts): a drawn rectangle, an image pin and
// a note pin as this package makes them. The check is on the shape (every
// field and its type), since ids, seeds and nonces are random.
func TestPinnedSceneFixture(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "f", 0, scene(rect("drawn", "a0", 0, 0, 3)))
	img := pngOf(t, 64, 32, color.RGBA{47, 107, 240, 255})
	if _, err := s.Pin("f", Pin{Author: "Nibble", Image: img, RequestID: "fixture-image"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pin("f", Pin{Author: "Nibble", Note: "Review the layout\nbefore Friday"}); err != nil {
		t.Fatal(err)
	}
	b, _ := s.Get("f")
	const path = "testdata/pinned-scene.json"
	type fixture struct {
		Elements []json.RawMessage   `json:"elements"`
		Files    map[string]FileMeta `json:"files"`
		PNG      []byte              `json:"png"`
	}
	got := fixture{Elements: b.Snapshot.Scene.Elements, Files: b.Snapshot.Files, PNG: img}
	if *update {
		out, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./internal/whiteboard -run TestPinnedSceneFixture -update)", err)
	}
	var want fixture
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	shape := func(els []json.RawMessage) []map[string]string {
		var out []map[string]string
		for _, e := range els {
			var m map[string]any
			_ = json.Unmarshal(e, &m)
			sh := map[string]string{}
			for k, v := range m {
				sh[k] = jsonType(v)
			}
			out = append(out, sh)
		}
		return out
	}
	if !reflect.DeepEqual(shape(got.Elements), shape(want.Elements)) {
		t.Fatalf("the pins' shape changed: run with -update and check the game's goPins test")
	}
	for _, e := range want.Elements[1:] {
		checkElement(t, e)
	}
}
