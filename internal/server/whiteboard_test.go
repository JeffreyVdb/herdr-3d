package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/whiteboard"
)

func wbPNG(t *testing.T, w, h int, c color.Color) []byte {
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

// wbBridge is a bridge with whiteboards under dir and a floor "herdr-3d".
func wbBridge(t *testing.T, dir, db, drops string) (*bridge, *client) {
	t.Helper()
	b := startBridge(t, db, server.Options{Whiteboards: whiteboard.New(dir), DropsRoot: drops})
	c := b.connect(proto.Hello{T: proto.THello, Proto: proto.Version, Client: "game"})
	c.snapshot()
	b.floor("herdr-3d", true)
	c.until(proto.EvFloorUpsert)
	return b, c
}

func (b *bridge) req(method, path, ctype string, body io.Reader) (int, []byte, http.Header) {
	b.t.Helper()
	req, err := http.NewRequest(method, "http://bridge"+path, body)
	if err != nil {
		b.t.Fatal(err)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := b.http().Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, resp.Header
}

// saveBody is a save's multipart body.
func saveBody(t *testing.T, scene string, render []byte) (string, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("scene", "scene.json")
	_, _ = fw.Write([]byte(scene))
	fw, _ = mw.CreateFormFile("render", "render.png")
	_, _ = fw.Write(render)
	_ = mw.Close()
	return mw.FormDataContentType(), &buf
}

func (b *bridge) wbSave(floor string, base int64, scene string, render []byte) (int, []byte) {
	b.t.Helper()
	ct, body := saveBody(b.t, scene, render)
	st, data, _ := b.req("POST", fmt.Sprintf("/whiteboard/%s/save?base=%d&author=You", floor, base), ct, body)
	return st, data
}

func errOf(t *testing.T, body []byte) (code string, version int64) {
	t.Helper()
	var e struct {
		T, Code string
		Version int64
	}
	if err := json.Unmarshal(body, &e); err != nil || e.T != "error" {
		t.Fatalf("not an error: %s", body)
	}
	return e.Code, e.Version
}

const drawn = `{"elements":[{"id":"r1","type":"rectangle","x":0,"y":0,"width":100,"height":50,"version":3,"versionNonce":1,"isDeleted":false,"index":"a0"}%s],"appState":{"viewBackgroundColor":"#ffffff","selectedElementIds":{"r1":true}}}`

func whiteboardEvent(t *testing.T, c *client) proto.WhiteboardUpdated {
	t.Helper()
	for {
		m := c.next()
		if m.env.T == proto.EvWhiteboardUpdated {
			var ev proto.WhiteboardUpdated
			if err := json.Unmarshal(m.raw, &ev); err != nil {
				t.Fatal(err)
			}
			return ev
		}
	}
}

// wbCommand sends a command and returns the whiteboard.updated it caused (nil:
// none) and its reply.
func wbCommand(c *client, typ, reqID string, args any) (*proto.WhiteboardUpdated, msg) {
	c.t.Helper()
	b, _ := json.Marshal(args)
	c.send(proto.Command{T: typ, ReqID: reqID, Args: b})
	var ev *proto.WhiteboardUpdated
	for {
		m := c.next()
		switch m.env.T {
		case proto.TAck, proto.TError:
			return ev, m
		case proto.EvWhiteboardUpdated:
			ev = &proto.WhiteboardUpdated{}
			_ = json.Unmarshal(m.raw, ev)
		}
	}
}

func TestWhiteboardSaveRestartAndRender(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "wb")
	db := filepath.Join(t.TempDir(), "world.db")
	b, c := wbBridge(t, dir, db, "")
	img := wbPNG(t, 30, 20, color.RGBA{220, 30, 30, 255})
	id := whiteboard.Hash(img)
	// The file goes up first (twice: stored once), then the save that uses it.
	for i, want := range []bool{true, false} {
		st, body, _ := b.req("PUT", "/whiteboard/herdr-3d/files/"+id, "image/png", bytes.NewReader(img))
		if st != 200 || !strings.Contains(string(body), fmt.Sprintf(`"stored":%t`, want)) {
			t.Fatalf("put %d: %d %s", i, st, body)
		}
	}
	image := fmt.Sprintf(`,{"id":"i1","type":"image","x":200,"y":0,"width":30,"height":20,"version":2,"versionNonce":4,"isDeleted":false,"index":"a1","fileId":%q,"status":"saved","scale":[1,1],"crop":null}`, id)
	render := wbPNG(t, 320, 120, color.White)
	st, body := b.wbSave("herdr-3d", 0, fmt.Sprintf(drawn, image), render)
	if st != 200 {
		t.Fatalf("save: %d %s", st, body)
	}
	ev := whiteboardEvent(t, c)
	if ev.Floor != "herdr-3d" || ev.Version != 1 || ev.Author != "You" || ev.Stale || !ev.Render || ev.RenderVersion != 1 {
		t.Fatalf("event %+v", ev)
	}
	b.stop()

	// A restart: the drawing, its file and its render are still there.
	b, _ = wbBridge(t, dir, db, "")
	st, body, _ = b.req("GET", "/whiteboard/herdr-3d", "", nil)
	if st != 200 {
		t.Fatalf("get: %d %s", st, body)
	}
	var got struct {
		Data struct {
			State   proto.WhiteboardState
			Version int64
			Scene   struct {
				Type     string
				Elements []json.RawMessage
				AppState map[string]any
			}
			Files   map[string]whiteboard.FileMeta
			History []map[string]any
		}
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	d := got.Data
	if d.Version != 1 || d.State.Version != 1 || len(d.Scene.Elements) != 2 || d.Scene.Type != "excalidraw" || d.Files[id].MimeType != "image/png" || len(d.History) != 1 {
		t.Fatalf("board %s", body)
	}
	if _, leaked := d.Scene.AppState["selectedElementIds"]; leaked {
		t.Fatalf("appState %v", d.Scene.AppState)
	}
	st, png, hd := b.req("GET", "/whiteboard/herdr-3d/render.png?v=1", "", nil)
	if st != 200 || !bytes.Equal(png, render) || hd.Get("Content-Type") != "image/png" || hd.Get("X-Render-Version") != "1" || hd.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("render: %d %v", st, hd)
	}
	if st, _, _ := b.req("GET", "/whiteboard/herdr-3d/render.png?v=7", "", nil); st != 404 {
		t.Fatalf("render of another version: %d", st)
	}
	st, file, hd := b.req("GET", "/whiteboard/herdr-3d/files/"+id, "", nil)
	if st != 200 || !bytes.Equal(file, img) || !strings.Contains(hd.Get("Cache-Control"), "immutable") {
		t.Fatalf("file: %d %v", st, hd)
	}
	ents, _ := os.ReadDir(filepath.Join(dir, "herdr-3d", "files"))
	if len(ents) != 1 {
		t.Fatalf("%d files stored", len(ents))
	}
	// Audit rows: the file once, the save.
	log, _ := b.st.AuditLog(context.Background())
	var cmds []string
	for _, r := range log {
		if strings.HasPrefix(r.Cmd, "whiteboard.") {
			cmds = append(cmds, r.Cmd)
			if strings.Contains(r.Args, "iVBOR") || len(r.Args) > 400 {
				t.Errorf("audit args carry content: %s", r.Args)
			}
		}
	}
	if strings.Join(cmds, ",") != "whiteboard.file,whiteboard.save" {
		t.Fatalf("audit %v", cmds)
	}
}

func TestWhiteboardConflictAndRefusals(t *testing.T) {
	t.Parallel()
	b, c := wbBridge(t, filepath.Join(t.TempDir(), "wb"), "", "")
	render := wbPNG(t, 10, 10, color.White)
	if st, body := b.wbSave("herdr-3d", 0, fmt.Sprintf(drawn, ""), render); st != 200 {
		t.Fatalf("save: %d %s", st, body)
	}
	whiteboardEvent(t, c)
	st, body := b.wbSave("herdr-3d", 0, fmt.Sprintf(drawn, ""), render)
	if code, v := errOf(t, body); st != 409 || code != proto.ErrWhiteboardConflict || v != 1 {
		t.Fatalf("stale base: %d %s", st, body)
	}
	cases := []struct {
		name, path, ctype string
		body              []byte
		status            int
		code              string
	}{
		{"unknown floor", "/whiteboard/nowhere/save?base=0", "", nil, 404, proto.ErrUnknownSession},
		{"bad floor", "/whiteboard/..%2Fetc/save?base=0", "", nil, 404, proto.ErrNotFound},
		{"no base", "/whiteboard/herdr-3d/save", "", nil, 400, proto.ErrBadRequest},
		{"not multipart", "/whiteboard/herdr-3d/save?base=1", "application/json", []byte(`{}`), 400, proto.ErrWhiteboardInvalid},
	}
	for _, tc := range cases {
		st, body, _ := b.req("POST", tc.path, tc.ctype, bytes.NewReader(tc.body))
		if st != tc.status {
			t.Errorf("%s: %d %s", tc.name, st, body)
			continue
		}
		if code, _ := errOf(t, body); code != tc.code {
			t.Errorf("%s: %s", tc.name, body)
		}
	}
	missing := strings.Repeat("0", 64)
	st, body = b.wbSave("herdr-3d", 1, fmt.Sprintf(drawn, fmt.Sprintf(`,{"id":"i","type":"image","version":1,"fileId":%q}`, missing)), render)
	if code, _ := errOf(t, body); st != 422 || code != proto.ErrWhiteboardMissingFile {
		t.Fatalf("missing file: %d %s", st, body)
	}
	st, body = b.wbSave("herdr-3d", 1, fmt.Sprintf(drawn, ""), []byte("not a png"))
	if code, _ := errOf(t, body); st != 415 || code != proto.ErrWhiteboardUnsupported {
		t.Fatalf("bad render: %d %s", st, body)
	}
	img := wbPNG(t, 2, 2, color.Black)
	st, body, _ = b.req("PUT", "/whiteboard/herdr-3d/files/"+whiteboard.Hash(append(img, 0)), "", bytes.NewReader(img))
	if code, _ := errOf(t, body); st != 422 || code != proto.ErrWhiteboardHash {
		t.Fatalf("wrong hash: %d %s", st, body)
	}
	st, body, _ = b.req("PUT", "/whiteboard/herdr-3d/files/"+strings.Repeat("a", 64), "", io.LimitReader(zeros{}, whiteboard.MaxFile+1))
	if code, _ := errOf(t, body); st != 413 || code != proto.ErrWhiteboardTooLarge {
		t.Fatalf("big file: %d %s", st, body)
	}
	if st, _, _ := b.req("GET", "/whiteboard/herdr-3d/files/..%2F..%2Fhead.json", "", nil); st != 404 {
		t.Fatalf("file traversal: %d", st)
	}
	// A failed save is audited too.
	log, _ := b.st.AuditLog(context.Background())
	fails := 0
	for _, r := range log {
		if r.Cmd == "whiteboard.save" && !r.OK {
			fails++
		}
	}
	if fails < 5 {
		t.Fatalf("%d failed saves audited", fails)
	}
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestWhiteboardCommandsAndPins(t *testing.T) {
	t.Parallel()
	b, c := wbBridge(t, filepath.Join(t.TempDir(), "wb"), "", "")
	_, ack := c.mustAck(proto.CmdWhiteboardGet, proto.WhiteboardArgs{Floor: "herdr-3d"})
	if d := ack.Data.(map[string]any); d["version"] != 0.0 || d["stale"] != false || d["render"] != false {
		t.Fatalf("empty board %v", d)
	}
	if st, body := b.wbSave("herdr-3d", 0, fmt.Sprintf(drawn, ""), wbPNG(t, 10, 10, color.White)); st != 200 {
		t.Fatalf("save %d %s", st, body)
	}
	whiteboardEvent(t, c)

	// An agent's note over the WebSocket, an image over HTTP (the CLI's ways).
	pe, m := wbCommand(c, proto.CmdWhiteboardPin, "p1", proto.WhiteboardPinArgs{Floor: "herdr-3d", Author: "Nibble", Note: "Look here", RequestID: "r1"})
	if m.env.T != proto.TAck {
		t.Fatalf("pin: %s", m.raw)
	}
	if pe == nil || pe.Version != 2 || !pe.Stale || pe.RenderVersion != 1 || len(pe.StalePins) != 1 || pe.StalePins[0].Author != "Nibble" || pe.StalePins[0].Note != "Look here" {
		t.Fatalf("pin event %+v", pe)
	}
	img := wbPNG(t, 64, 64, color.RGBA{0, 0, 255, 255})
	st, body, _ := b.req("POST", "/whiteboard/herdr-3d/pin?author=Crumpet&request_id=r2", "image/png", bytes.NewReader(img))
	if st != 200 || !strings.Contains(string(body), `"stale":true`) {
		t.Fatalf("http pin: %d %s", st, body)
	}
	ev := whiteboardEvent(t, c)
	if ev.Version != 3 || len(ev.StalePins) != 2 || ev.StalePins[1].Kind != "image" || ev.StalePins[1].File != whiteboard.Hash(img) {
		t.Fatalf("image pin event %+v", ev)
	}
	// The same request again pins nothing new and says nothing.
	st, body, _ = b.req("POST", "/whiteboard/herdr-3d/pin?author=Crumpet&request_id=r2", "image/png", bytes.NewReader(img))
	if st != 200 || !strings.Contains(string(body), `"repeated":true`) || !strings.Contains(string(body), `"version":3`) {
		t.Fatalf("repeat: %d %s", st, body)
	}
	st, body, _ = b.req("POST", "/whiteboard/herdr-3d/pin?author=x", "text/plain", strings.NewReader("   "))
	if code, _ := errOf(t, body); st != 400 || code != proto.ErrWhiteboardInvalid {
		t.Fatalf("empty note: %d %s", st, body)
	}
	if st, _, _ := b.req("POST", "/whiteboard/elsewhere/pin?author=x", "text/plain", strings.NewReader("hi")); st != 404 {
		t.Fatalf("pin on an unknown floor: %d", st)
	}

	c.mustError(proto.CmdWhiteboardClear, proto.WhiteboardClearArgs{Floor: "herdr-3d"}, proto.ErrConfirmationRequired)
	c.mustError(proto.CmdWhiteboardClear, proto.WhiteboardClearArgs{Floor: "nowhere", Confirm: true}, proto.ErrUnknownSession)
	ce, m := wbCommand(c, proto.CmdWhiteboardClear, "clear", proto.WhiteboardClearArgs{Floor: "herdr-3d", Confirm: true})
	if m.env.T != proto.TAck {
		t.Fatalf("clear: %s", m.raw)
	}
	if ce == nil || ce.Version != 4 || ce.Stale || ce.Render || ce.Author != "game" {
		t.Fatalf("clear event %+v", ce)
	}
	if st, _, _ := b.req("GET", "/whiteboard/herdr-3d/render.png", "", nil); st != 404 {
		t.Fatalf("render after clear: %d", st)
	}
	st, body, _ = b.req("GET", "/whiteboard/herdr-3d?version=3", "", nil)
	if st != 200 || !strings.Contains(string(body), "Look here") {
		t.Fatalf("history kept: %d %s", st, body)
	}
	log, _ := b.st.AuditLog(context.Background())
	var cmds []string
	for _, r := range log {
		if strings.HasPrefix(r.Cmd, "whiteboard.") && r.OK {
			cmds = append(cmds, r.Client+":"+r.Cmd)
		}
	}
	for _, r := range log {
		if strings.Contains(r.Args, "Look here") {
			t.Errorf("a note's text is in the audit log: %s", r.Args)
		}
	}
	want := "game:whiteboard.get,http:whiteboard.save,game:whiteboard.pin,http:whiteboard.pin,http:whiteboard.pin,game:whiteboard.clear"
	if strings.Join(cmds, ",") != want {
		t.Fatalf("audit\n got %v\nwant %s", cmds, want)
	}
}

func TestWhiteboardWithoutStore(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{T: proto.THello, Proto: proto.Version})
	c.snapshot()
	c.mustError(proto.CmdWhiteboardGet, proto.WhiteboardArgs{Floor: "x"}, proto.ErrUnsupported)
	if st, _, _ := b.req("GET", "/whiteboard/x", "", nil); st != 501 {
		t.Fatalf("GET without a store: %d", st)
	}
	c.mustError(proto.CmdDropsList, proto.DropsListArgs{}, proto.ErrDropsUnavailable)
}

func TestDropsListAndFile(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	img := wbPNG(t, 900, 300, color.RGBA{10, 200, 10, 255})
	if err := os.MkdirAll(filepath.Join(root, "2026-10"), 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(root, "2026-10", "shot.png")
	if err := os.WriteFile(p, img, 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	_ = os.WriteFile(filepath.Join(root, "2026-10", "notes.txt"), []byte("hi"), 0o600)
	_ = os.Chtimes(filepath.Join(root, "2026-10", "notes.txt"), old, old)
	b, c := wbBridge(t, filepath.Join(t.TempDir(), "wb"), "", root)
	_, ack := c.mustAck(proto.CmdDropsList, proto.DropsListArgs{Limit: 5})
	raw, _ := json.Marshal(ack.Data)
	var list proto.DropsList
	_ = json.Unmarshal(raw, &list)
	if len(list.Drops) != 2 || list.Drops[0].Path != p || !list.Drops[0].Image || list.Drops[1].Image || list.Drops[1].Reason != "not_image" {
		t.Fatalf("drops %s", raw)
	}
	c.mustError(proto.CmdDropsList, proto.DropsListArgs{Limit: 51}, proto.ErrBadRequest)
	st, body, hd := b.req("GET", "/drops/file?path="+url.QueryEscape(p), "", nil)
	if st != 200 || !bytes.Equal(body, img) || hd.Get("Content-Type") != "image/png" {
		t.Fatalf("drop: %d %v", st, hd)
	}
	st, body, hd = b.req("GET", "/drops/file?thumb=1&path="+url.QueryEscape(p), "", nil)
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(body)); st != 200 || err != nil || cfg.Width != 480 {
		t.Fatalf("thumb: %d %v %+v", st, err, cfg)
	}
	// #125: the thumbnail's type is its own (a PNG's may be a JPEG), and the header says it.
	if ct := hd.Get("Content-Type"); ct != imgcache.Sniff(body) {
		t.Errorf("thumb served as %q, its bytes are %q", ct, imgcache.Sniff(body))
	}
	outside := filepath.Join(t.TempDir(), "x.png")
	_ = os.WriteFile(outside, img, 0o600)
	for _, bad := range []string{outside, root + "/2026-10/../../x.png", "relative.png", filepath.Join(root, "2026-10", "notes.txt")} {
		if st, _, _ := b.req("GET", "/drops/file?path="+url.QueryEscape(bad), "", nil); st == 200 {
			t.Errorf("served %s", bad)
		}
	}
	// drops.list only reads.
	ents, _ := os.ReadDir(filepath.Join(root, "2026-10"))
	if len(ents) != 2 {
		t.Fatalf("the data directory changed: %v", ents)
	}
}
