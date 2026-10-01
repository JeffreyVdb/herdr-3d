package whiteboard

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

func pngOf(t testing.TB, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func newStore(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	// Real time: the file collection compares the clock with file mtimes.
	now := time.Now()
	s := New(filepath.Join(t.TempDir(), "whiteboards"))
	s.Now = func() time.Time { return now }
	return s, &now
}

// rect is a complete Excalidraw rectangle as the editor writes one.
func rect(id, index string, x, y float64, version int) string {
	return fmt.Sprintf(`{"id":%q,"type":"rectangle","x":%g,"y":%g,"width":100,"height":50,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,"groupIds":[],"frameId":null,"index":%q,"roundness":null,"seed":1,"version":%d,"versionNonce":7,"isDeleted":false,"boundElements":null,"updated":1,"link":null,"locked":false}`, id, x, y, index, version)
}

func imageEl(id, index, file string, deleted bool) string {
	return fmt.Sprintf(`{"id":%q,"type":"image","x":0,"y":0,"width":10,"height":10,"angle":0,"strokeColor":"transparent","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,"groupIds":[],"frameId":null,"index":%q,"roundness":null,"seed":1,"version":2,"versionNonce":7,"isDeleted":%t,"boundElements":null,"updated":1,"link":null,"locked":false,"fileId":%q,"status":"saved","scale":[1,1],"crop":null}`, id, index, deleted, file)
}

func scene(els ...string) []byte {
	return []byte(`{"elements":[` + strings.Join(els, ",") + `],"appState":{"viewBackgroundColor":"#fff8e7","gridSize":20,"gridStep":5,"gridModeEnabled":false,"selectedElementIds":{"r1":true},"zoom":{"value":2},"collaborators":[]}}`)
}

func save(t *testing.T, s *Store, floor string, base int64, sc []byte) Head {
	t.Helper()
	h, err := s.Save(floor, SaveInput{Base: base, Author: "Theo", Scene: sc, Render: pngOf(t, 40, 20, color.White)})
	if err != nil {
		t.Fatalf("save on %d: %v", base, err)
	}
	return h
}

func TestSaveAndReadBackAcrossStores(t *testing.T) {
	s, _ := newStore(t)
	h := save(t, s, "herdr-3d", 0, scene(rect("r1", "a0", 0, 0, 3)))
	if h.Version != 1 || h.RenderVersion != 1 || !h.Render || h.Stale() || h.Author != "Theo" {
		t.Fatalf("head %+v", h)
	}
	// A restart: a new store on the same directory.
	again := New(s.Root())
	b, err := again.Get("herdr-3d")
	if err != nil {
		t.Fatal(err)
	}
	if b.Version != 1 || len(b.Snapshot.Scene.Elements) != 1 || b.Snapshot.Scene.Type != "excalidraw" || b.Snapshot.Scene.Version != 2 {
		t.Fatalf("board %+v", b)
	}
	if !strings.Contains(string(b.Snapshot.Scene.Elements[0]), `"id":"r1"`) {
		t.Fatalf("element %s", b.Snapshot.Scene.Elements[0])
	}
	// Only the allowlisted appState: no selection, zoom or collaborators.
	if a := b.Snapshot.Scene.AppState; a.ViewBackgroundColor != "#fff8e7" || a.GridStep != 5 || a.GridSize == nil || *a.GridSize != 20 {
		t.Fatalf("appState %+v", a)
	}
	raw, _ := os.ReadFile(filepath.Join(s.Root(), "herdr-3d", "v", "1.json"))
	for _, leaked := range []string{"selectedElementIds", "zoom", "collaborators"} {
		if strings.Contains(string(raw), leaked) {
			t.Fatalf("%s stored: %s", leaked, raw)
		}
	}
	png, rv, err := again.Render("herdr-3d")
	if err != nil || rv != 1 || !bytes.Equal(png, pngOf(t, 40, 20, color.White)) {
		t.Fatalf("render %d bytes, v%d, %v", len(png), rv, err)
	}
}

func TestPermissions(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "herdr-3d", 0, scene(rect("r1", "a0", 0, 0, 1)))
	img := pngOf(t, 4, 4, color.Black)
	if _, _, err := s.PutFile("herdr-3d", Hash(img), img); err != nil {
		t.Fatal(err)
	}
	err := filepath.Walk(s.Root(), func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		want := os.FileMode(0o600)
		if fi.IsDir() {
			want = 0o700
		}
		if fi.Mode().Perm() != want {
			t.Errorf("%s is %v, want %v", p, fi.Mode().Perm(), want)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEmptyBoard(t *testing.T) {
	s, _ := newStore(t)
	b, err := s.Get("never-saved")
	if err != nil || b.Version != 0 || len(b.Snapshot.Scene.Elements) != 0 || b.Render || b.Stale() {
		t.Fatalf("%+v, %v", b, err)
	}
	if _, _, err := s.Render("never-saved"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("render: %v", err)
	}
	if _, err := os.Stat(s.Root()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a read made the directory: %v", err)
	}
}

func TestBaseVersionConflict(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "f", 0, scene(rect("r1", "a0", 0, 0, 1)))
	save(t, s, "f", 1, scene(rect("r1", "a0", 0, 0, 2)))
	_, err := s.Save("f", SaveInput{Base: 1, Scene: scene(rect("r1", "a0", 9, 9, 3)), Render: pngOf(t, 4, 4, color.White)})
	var c *ConflictError
	if !errors.As(err, &c) || c.Current != 2 {
		t.Fatalf("stale base: %v", err)
	}
	b, _ := s.Get("f")
	if b.Version != 2 || !strings.Contains(string(b.Snapshot.Scene.Elements[0]), `"version":2`) {
		t.Fatalf("the conflict overwrote: %+v", b.Head)
	}
	if _, err := s.Save("f", SaveInput{Base: 5, Scene: scene(), Render: pngOf(t, 4, 4, color.White)}); !errors.As(err, &c) {
		t.Fatalf("future base: %v", err)
	}
}

func TestHistoryKeepsLast20AndCollectsFiles(t *testing.T) {
	s, now := newStore(t)
	s.FileGrace = time.Minute
	imgs := make([]string, 25)
	for v := range int64(25) {
		b := pngOf(t, 2, 2, color.RGBA{uint8(v), 1, 2, 255})
		imgs[v] = Hash(b)
		if _, _, err := s.PutFile("f", imgs[v], b); err != nil {
			t.Fatal(err)
		}
		save(t, s, "f", v, scene(imageEl("i", "a0", imgs[v], false)))
	}
	// Within the grace, nothing is collected yet.
	if _, _, err := s.File("f", imgs[0]); err != nil {
		t.Fatalf("collected within the grace: %v", err)
	}
	*now = now.Add(time.Hour)
	save(t, s, "f", 25, scene(imageEl("i", "a0", imgs[24], false)))
	h, _ := s.Head("f")
	if h.Version != 26 || len(h.Retained) != Keep || h.Retained[0].Version != 7 || h.Retained[Keep-1].Version != 26 {
		t.Fatalf("head %d, retained %+v", h.Version, h.Retained)
	}
	ents, _ := os.ReadDir(filepath.Join(s.Root(), "f", "v"))
	if len(ents) != 2*Keep { // v/<n>.json and v/<n>.files.json
		t.Fatalf("%d version files on disk", len(ents))
	}
	// One render: the current one.
	if ents, _ := os.ReadDir(filepath.Join(s.Root(), "f", "renders")); len(ents) != 1 || ents[0].Name() != "26.png" {
		t.Fatalf("renders on disk %v", ents)
	}
	if _, err := s.Version("f", 6); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pruned version 6: %v", err)
	}
	if sn, err := s.Version("f", 7); err != nil || sn.Version != 7 {
		t.Fatalf("version 7: %+v %v", sn.Version, err)
	}
	// Files only versions 1-6 used are gone; those of 7-26 stay.
	for i, id := range imgs {
		_, _, err := s.File("f", id)
		if gone := i < 6; gone != (err != nil) {
			t.Errorf("file of version %d: %v", i+1, err)
		}
	}
}

func TestFilesAreStoredOnceByHash(t *testing.T) {
	s, _ := newStore(t)
	img := pngOf(t, 8, 8, color.RGBA{200, 10, 10, 255})
	id := Hash(img)
	stored, mime, err := s.PutFile("f", id, img)
	if err != nil || !stored || mime != "image/png" {
		t.Fatalf("first put: %v %s %v", stored, mime, err)
	}
	stored, _, err = s.PutFile("f", id, img)
	if err != nil || stored {
		t.Fatalf("second put: %v %v", stored, err)
	}
	// Two images using the same file, and a pin of the same bytes.
	save(t, s, "f", 0, scene(imageEl("i1", "a0", id, false), imageEl("i2", "a1", id, false)))
	if _, err := s.Pin("f", Pin{Author: "Nibble", Image: img}); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(filepath.Join(s.Root(), "f", "files"))
	if len(ents) != 1 || ents[0].Name() != id {
		t.Fatalf("files %v", ents)
	}
	b, mime, err := s.File("f", id)
	if err != nil || !bytes.Equal(b, img) || mime != "image/png" {
		t.Fatalf("file back: %v", err)
	}
}

func TestFileChecks(t *testing.T) {
	s, _ := newStore(t)
	img := pngOf(t, 8, 8, color.Black)
	if _, _, err := s.PutFile("f", Hash(img[:len(img)-1]), img); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("wrong hash: %v", err)
	}
	if _, _, err := s.PutFile("f", strings.ToUpper(Hash(img)), img); !errors.Is(err, ErrInvalid) {
		t.Fatalf("upper-case id: %v", err)
	}
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)
	if _, _, err := s.PutFile("f", Hash(svg), svg); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("svg: %v", err)
	}
	big := make([]byte, MaxFile+1)
	if _, _, err := s.PutFile("f", Hash(big), big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("big: %v", err)
	}
	// An image that is used must be there.
	missing := Hash([]byte("not stored"))
	if _, err := s.Save("f", SaveInput{Scene: scene(imageEl("i", "a0", missing, false)), Render: pngOf(t, 4, 4, color.White)}); !errors.Is(err, ErrMissingFile) {
		t.Fatalf("missing file: %v", err)
	}
	// A tombstone's may be gone.
	save(t, s, "f", 0, scene(imageEl("i", "a0", missing, true)))
}

func TestSaveChecks(t *testing.T) {
	s, _ := newStore(t)
	ok := pngOf(t, 4, 4, color.White)
	bad := []struct {
		name   string
		scene  []byte
		render []byte
		want   error
	}{
		{"not json", []byte(`{"elements":`), ok, ErrInvalid},
		{"not an object", scene(`[1]`), ok, ErrInvalid},
		{"string x", scene(`{"id":"r","type":"rectangle","x":"0","version":1}`), ok, ErrInvalid},
		{"unknown type", scene(`{"id":"r","type":"script","version":1}`), ok, ErrInvalid},
		{"bad id", scene(`{"id":"../x","type":"rectangle","version":1}`), ok, ErrInvalid},
		{"no version", scene(`{"id":"r","type":"rectangle"}`), ok, ErrInvalid},
		{"duplicate id", scene(rect("r", "a0", 0, 0, 1), rect("r", "a1", 0, 0, 1)), ok, ErrInvalid},
		{"bad index", scene(rect("r", "garbage!", 0, 0, 1)), ok, ErrInvalid},
		{"huge coordinate", scene(rect("r", "a0", 1e9, 0, 1)), ok, ErrInvalid},
		{"bad file id", scene(imageEl("i", "a0", "../../etc/passwd", false)), ok, ErrInvalid},
		{"too big", append(scene(), make([]byte, MaxScene)...), ok, ErrTooLarge},
		{"render not png", scene(), []byte("GIF89a......"), ErrUnsupported},
		{"render too wide", scene(), pngOf(t, MaxRenderSide+1, 1, color.White), ErrTooLarge},
		{"render truncated", scene(), ok[:30], ErrInvalid},
	}
	for _, c := range bad {
		if _, err := s.Save("f", SaveInput{Scene: c.scene, Render: c.render}); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
	many := make([]string, MaxElements+1)
	for i := range many {
		many[i] = fmt.Sprintf(`{"id":"e%d","type":"line","version":1}`, i)
	}
	if _, err := s.Save("f", SaveInput{Scene: scene(many...), Render: ok}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too many elements: %v", err)
	}
	if h, _ := s.Head("f"); h.Version != 0 {
		t.Fatalf("a refused save was stored: %+v", h)
	}
}

func TestFloorNamesCannotEscape(t *testing.T) {
	s, _ := newStore(t)
	for _, f := range []string{"", ".", "..", "...", "../x", "a/b", "/etc", "-rf", "a\x00b", strings.Repeat("x", 65), "a b"} {
		if ValidFloor(f) {
			t.Errorf("ValidFloor(%q)", f)
		}
		if _, err := s.Save(f, SaveInput{Scene: scene(), Render: pngOf(t, 2, 2, color.White)}); !errors.Is(err, ErrInvalidFloor) {
			t.Errorf("save %q: %v", f, err)
		}
		if _, err := s.Get(f); !errors.Is(err, ErrInvalidFloor) {
			t.Errorf("get %q: %v", f, err)
		}
		if _, _, err := s.File(f, Hash(nil)); !errors.Is(err, ErrInvalidFloor) {
			t.Errorf("file %q: %v", f, err)
		}
		if _, err := s.Pin(f, Pin{Note: "x"}); !errors.Is(err, ErrInvalidFloor) {
			t.Errorf("pin %q: %v", f, err)
		}
	}
	for _, f := range []string{"herdr-3d", "a..b", "x.y_z", "demo-m6"} {
		if !ValidFloor(f) {
			t.Errorf("ValidFloor(%q) = false", f)
		}
	}
	if _, _, err := s.File("f", "../head.json"); !errors.Is(err, ErrNotFound) {
		t.Errorf("file id traversal: %v", err)
	}
}

func TestSymlinkedFilesAreNotRead(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "f", 0, scene())
	secret := filepath.Join(t.TempDir(), "secret.png")
	img := pngOf(t, 2, 2, color.Black)
	if err := os.WriteFile(secret, img, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(s.Root(), "f", "files", Hash(img))); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.File("f", Hash(img)); err == nil {
		t.Fatal("read through a symlink")
	}
}

func TestClearKeepsHistory(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "f", 0, scene(rect("r1", "a0", 0, 0, 4), rect("r2", "a1", 0, 0, 1)))
	h, err := s.Clear("f", "Theo")
	if err != nil {
		t.Fatal(err)
	}
	if h.Version != 2 || h.Render || h.Stale() || h.RenderVersion != 2 {
		t.Fatalf("head %+v", h)
	}
	if _, _, err := s.Render("f"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("render after clear: %v", err)
	}
	b, _ := s.Get("f")
	if len(b.Snapshot.Scene.Elements) != 2 {
		t.Fatalf("elements %d", len(b.Snapshot.Scene.Elements))
	}
	for _, raw := range b.Snapshot.Scene.Elements {
		var e element
		_ = json.Unmarshal(raw, &e)
		if !e.IsDeleted || (e.ID == "r1" && e.Version != 5) {
			t.Fatalf("not a tombstone: %s", raw)
		}
	}
	if old, err := s.Version("f", 1); err != nil || len(old.Scene.Elements) != 2 {
		t.Fatalf("history: %v", err)
	}
	// A second clear drops the tombstones.
	h, _ = s.Clear("f", "Theo")
	b, _ = s.Get("f")
	if h.Version != 3 || len(b.Snapshot.Scene.Elements) != 0 {
		t.Fatalf("second clear: v%d, %d elements", h.Version, len(b.Snapshot.Scene.Elements))
	}
}

// A floor is a herdr session: the names are the same set.
func TestFloorNamesAreSessionNames(t *testing.T) {
	for _, f := range []string{"", ".", "..", "-x", "x-", "a.b", "a/b", "A_z-9", strings.Repeat("s", 64), strings.Repeat("s", 65), "é", "a b", "..x"} {
		if ValidFloor(f) != herdr.ValidSessionName(f) {
			t.Errorf("%q: floor %v, session %v", f, ValidFloor(f), herdr.ValidSessionName(f))
		}
	}
}

// head.json does not grow with the files of the kept versions: a scene of 900
// images saved past Keep versions stays readable (the head used to list every
// version's files and outgrew the 1 MiB it is read with).
func TestHeadStaysSmallWithManyFiles(t *testing.T) {
	s, _ := newStore(t)
	els := make([]string, 900)
	for i := range els {
		b := pngOf(t, 1, 1, color.RGBA{R: byte(i), G: byte(i >> 8), A: 255})
		if _, _, err := s.PutFile("f", Hash(b), b); err != nil {
			t.Fatal(err)
		}
		els[i] = imageEl(fmt.Sprintf("im%d", i), "a0", Hash(b), false)
	}
	sc := scene(els...)
	for v := range int64(Keep + 2) {
		save(t, s, "f", v, sc)
		if _, err := s.Get("f"); err != nil {
			t.Fatalf("get after save %d: %v", v+1, err)
		}
	}
	fi, err := os.Stat(filepath.Join(s.Root(), "f", "head.json"))
	if err != nil || fi.Size() > 16<<10 {
		t.Fatalf("head.json %d bytes, %v", fi.Size(), err)
	}
	// The collection still knows each kept version's files: none is gone.
	if ents, _ := os.ReadDir(filepath.Join(s.Root(), "f", "files")); len(ents) != 900 {
		t.Fatalf("%d files kept", len(ents))
	}
}

// failHead makes the store's next head.json write fail, as a crash between a
// commit's new files and its head would.
func failHead(t *testing.T) {
	t.Helper()
	writeFile = func(path string, data []byte) error {
		if filepath.Base(path) == "head.json" {
			return errors.New("injected head write failure")
		}
		return writeAtomic(path, data)
	}
	t.Cleanup(func() { writeFile = writeAtomic })
}

// A save or a clear whose head.json is not written leaves the previous
// version current with its own render, across a restart too.
func TestInterruptedCommitKeepsVersionAndRender(t *testing.T) {
	s, _ := newStore(t)
	black, white := pngOf(t, 1, 1, color.Black), pngOf(t, 2, 2, color.White)
	if _, err := s.Save("f", SaveInput{Base: 0, Scene: scene(), Render: black}); err != nil {
		t.Fatal(err)
	}
	check := func(when string, st *Store) {
		t.Helper()
		b, err := st.Get("f")
		if err != nil || b.Version != 1 || len(b.Snapshot.Scene.Elements) != 0 {
			t.Fatalf("%s: board v%d %d elements, %v", when, b.Version, len(b.Snapshot.Scene.Elements), err)
		}
		png, v, err := st.Render("f")
		if err != nil || v != 1 || !bytes.Equal(png, black) {
			t.Fatalf("%s: render v%d, the old one %v, %v", when, v, bytes.Equal(png, black), err)
		}
	}
	failHead(t)
	if _, err := s.Save("f", SaveInput{Base: 1, Scene: scene(rect("r", "a0", 0, 0, 1)), Render: white}); err == nil {
		t.Fatal("the save did not fail")
	}
	check("after a failed save", s)
	if _, err := s.Clear("f", "Theo"); err == nil {
		t.Fatal("the clear did not fail")
	}
	check("after a failed clear", s)
	writeFile = writeAtomic
	check("after a restart", New(s.Root()))
	// The next save takes the version the failed one would have had, with its own render.
	h, err := s.Save("f", SaveInput{Base: 1, Scene: scene(rect("r", "a0", 0, 0, 1)), Render: white})
	if err != nil || h.Version != 2 {
		t.Fatalf("save after: %+v %v", h, err)
	}
	if png, v, err := s.Render("f"); err != nil || v != 2 || !bytes.Equal(png, white) {
		t.Fatalf("render after: v%d %v", v, err)
	}
	if ents, _ := os.ReadDir(filepath.Join(s.Root(), "f", "renders")); len(ents) != 1 {
		t.Fatalf("renders on disk %v", ents)
	}
}

// head.json lists the newest maxStalePins pins, however many agents pin
// before a client renders the board.
func TestStalePinsAreBounded(t *testing.T) {
	s, _ := newStore(t)
	save(t, s, "f", 0, scene())
	for i := range maxStalePins + 20 {
		if _, err := s.Pin("f", Pin{Author: "Nibble", Note: fmt.Sprintf("note %d %s", i, strings.Repeat("x", 300))}); err != nil {
			t.Fatal(err)
		}
	}
	h, err := s.Head("f")
	if err != nil || len(h.StalePins) != maxStalePins || !h.Stale() {
		t.Fatalf("head: %d stale pins, stale %v, %v", len(h.StalePins), h.Stale(), err)
	}
	if last := h.StalePins[maxStalePins-1]; last.Version != h.Version || !strings.HasPrefix(last.Note, fmt.Sprintf("note %d ", maxStalePins+19)) {
		t.Fatalf("newest stale pin %+v", last)
	}
}
