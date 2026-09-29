package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/logo"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

func (b *bridge) http() *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", b.sock)
		},
	}}
}

// logoReq sends one request to /logo/{id} and returns the status, body and headers.
func (b *bridge) logoReq(method, id string, body io.Reader, query string) (int, []byte, http.Header) {
	b.t.Helper()
	req, err := http.NewRequest(method, "http://bridge/logo/"+id+query, body)
	if err != nil {
		b.t.Fatal(err)
	}
	resp, err := b.http().Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, resp.Header
}

func logoErrCode(t *testing.T, body []byte) string {
	t.Helper()
	var e proto.Error
	if err := json.Unmarshal(body, &e); err != nil || e.T != proto.TError {
		t.Fatalf("not an error body: %s", body)
	}
	return e.Code
}

func testPNG(t *testing.T, w, h int, c color.NRGBA) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	m.SetNRGBA(w/2, h/2, c)
	var b bytes.Buffer
	if err := png.Encode(&b, m); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestLogoSetFetchClear(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	id := createBuilding(c, "Work")

	// No logo yet.
	if st, body, _ := b.logoReq("GET", id, nil, ""); st != 404 || logoErrCode(t, body) != proto.ErrNotFound {
		t.Fatalf("GET without a logo: %d %s", st, body)
	}

	// Set one: a 2000 x 500 PNG is stored at 1024 x 256, and the building
	// upsert carries the hash.
	st, body, _ := b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 2000, 500, color.NRGBA{R: 255, A: 255})), "")
	if st != 200 {
		t.Fatalf("PUT: %d %s", st, body)
	}
	var ack struct {
		Data struct {
			Logo string `json:"logo"`
			W, H int
		}
	}
	if err := json.Unmarshal(body, &ack); err != nil || len(ack.Data.Logo) != 64 || ack.Data.W != 1024 || ack.Data.H != 256 {
		t.Fatalf("PUT reply = %s (%v)", body, err)
	}
	ev := c.until(proto.EvBuildingUpsert)
	if ev.Building.ID != id || ev.Building.Logo != ack.Data.Logo {
		t.Fatalf("building.upsert = %+v", ev.Building)
	}
	hash := ack.Data.Logo

	// Fetch it: the stored PNG, whose sha256 is the hash.
	st, png1, hd := b.logoReq("GET", id, nil, "")
	if st != 200 || hd.Get("Content-Type") != "image/png" || logo.Hash(png1) != hash {
		t.Fatalf("GET: %d %s, hash %s want %s", st, hd.Get("Content-Type"), logo.Hash(png1), hash)
	}
	if m, err := png.Decode(bytes.NewReader(png1)); err != nil || m.Bounds().Dx() != 1024 || m.Bounds().Dy() != 256 {
		t.Fatalf("stored PNG: %v %v", m.Bounds(), err)
	}
	if hd.Get("Cache-Control") != "no-cache" || hd.Get("ETag") != `"`+hash+`"` || hd.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers without ?h: %v", hd)
	}
	// With the current hash the URL is immutable; with another it is not.
	if _, _, hd = b.logoReq("GET", id, nil, "?h="+hash); hd.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control with the current hash = %q", hd.Get("Cache-Control"))
	}
	// A hash that is not the current one gets no image at all (see TestLogoStaleHash).
	if st, body, hd = b.logoReq("GET", id, nil, "?h=deadbeef"); st != 404 || logoErrCode(t, body) != proto.ErrNotFound || hd.Get("Cache-Control") != "no-store" || hd.Get("ETag") != "" {
		t.Fatalf("GET with a stale hash: %d %s %v", st, body, hd)
	}
	req, _ := http.NewRequest("GET", "http://bridge/logo/"+id, nil)
	req.Header.Set("If-None-Match", `"`+hash+`"`)
	if resp, err := b.http().Do(req); err != nil || resp.StatusCode != 304 {
		t.Fatalf("If-None-Match: %v %v", resp, err)
	}

	// A new snapshot has the hash too.
	if got := b.connect(proto.Hello{}).snapshot().World.Buildings[0].Logo; got != hash {
		t.Fatalf("snapshot logo = %q", got)
	}

	// A different image changes the hash; the same image does not.
	st, body, _ = b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 2000, 500, color.NRGBA{B: 255, A: 255})), "")
	ev = c.until(proto.EvBuildingUpsert)
	if st != 200 || ev.Building.Logo == "" || ev.Building.Logo == hash {
		t.Fatalf("second PUT: %d %s, hash %q", st, body, ev.Building.Logo)
	}
	second := ev.Building.Logo
	b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 2000, 500, color.NRGBA{B: 255, A: 255})), "")
	if got, _ := b.st.LogoOf(context.Background(), id); got.Hash != second {
		t.Fatalf("the same image changed the hash: %s vs %s", got.Hash, second)
	}

	// Clear it.
	st, body, _ = b.logoReq("DELETE", id, nil, "")
	if st != 200 {
		t.Fatalf("DELETE: %d %s", st, body)
	}
	ev = c.until(proto.EvBuildingUpsert)
	if ev.Building.Logo != "" {
		t.Fatalf("building after clear = %+v", ev.Building)
	}
	if st, _, _ = b.logoReq("GET", id, nil, ""); st != 404 {
		t.Fatalf("GET after clear: %d", st)
	}
	if st, _, _ = b.logoReq("DELETE", id, nil, ""); st != 200 {
		t.Fatalf("clearing twice: %d", st)
	}

	// The changes are in the audit log, without the image.
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, e := range log {
		if strings.HasPrefix(e.Cmd, "building.logo.") {
			cmds = append(cmds, e.Cmd)
			if len(e.Args) > 300 {
				t.Errorf("audit args are %d bytes", len(e.Args))
			}
		}
	}
	if strings.Join(cmds, " ") != "building.logo.set building.logo.set building.logo.set building.logo.clear building.logo.clear" {
		t.Fatalf("audit = %v", cmds)
	}
}

// GET /logo/A?h=H1 after A was replaced must not answer with the new image:
// the caller would cache it under H1. It gets not_found (and no image), and
// the request without ?h= or with the new hash still works.
func TestLogoStaleHash(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	id := createBuilding(c, "Work")
	put := func(col color.NRGBA) string {
		t.Helper()
		if st, body, _ := b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 64, 64, col)), ""); st != 200 {
			t.Fatalf("PUT: %d %s", st, body)
		}
		return c.until(proto.EvBuildingUpsert).Building.Logo
	}
	h1 := put(color.NRGBA{R: 255, A: 255})
	if st, body, _ := b.logoReq("GET", id, nil, "?h="+h1); st != 200 || logo.Hash(body) != h1 {
		t.Fatalf("GET with the current hash: %d", st)
	}
	h2 := put(color.NRGBA{B: 255, A: 255})
	if h1 == h2 {
		t.Fatal("the hash did not change")
	}
	st, body, hd := b.logoReq("GET", id, nil, "?h="+h1)
	if st != 404 || logoErrCode(t, body) != proto.ErrNotFound || hd.Get("Content-Type") == "image/png" || hd.Get("ETag") != "" || hd.Get("Cache-Control") != "no-store" {
		t.Fatalf("GET with the replaced hash: %d %s %v", st, body, hd)
	}
	if bytes.HasPrefix(body, []byte("\x89PNG")) {
		t.Fatal("the stale request got an image")
	}
	if st, body, _ := b.logoReq("GET", id, nil, "?h="+h2); st != 200 || logo.Hash(body) != h2 {
		t.Fatalf("GET with the new hash: %d", st)
	}
	if st, body, _ := b.logoReq("GET", id, nil, ""); st != 200 || logo.Hash(body) != h2 {
		t.Fatalf("GET without a hash: %d", st)
	}
}

func TestLogoLimitsAndTypes(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	id := createBuilding(c, "Work")

	var jpg bytes.Buffer
	_ = jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	good := testPNG(t, 64, 64, color.NRGBA{G: 255, A: 255})
	over := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, logo.MaxInput)...)

	tests := []struct {
		name string
		id   string
		body io.Reader
		want int
		code string
	}{
		{"over 1 MiB (Content-Length)", id, bytes.NewReader(over), 413, proto.ErrLogoTooLarge},
		{"over 1 MiB (chunked)", id, io.MultiReader(bytes.NewReader(over)), 413, proto.ErrLogoTooLarge},
		{"one byte over", id, bytes.NewReader(append(bytes.Clone(good), make([]byte, logo.MaxInput)...)), 413, proto.ErrLogoTooLarge},
		{"jpeg", id, bytes.NewReader(jpg.Bytes()), 415, proto.ErrLogoUnsupported},
		{"text", id, strings.NewReader("hello"), 415, proto.ErrLogoUnsupported},
		{"svg with text", id, strings.NewReader(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><text>x</text></svg>`), 415, proto.ErrLogoUnsupported},
		{"truncated png", id, bytes.NewReader(good[:30]), 422, proto.ErrLogoInvalid},
		{"empty", id, bytes.NewReader(nil), 422, proto.ErrLogoInvalid},
		{"unknown building", "b_nope", bytes.NewReader(good), 404, proto.ErrNotFound},
		{"bad id", "a.b", bytes.NewReader(good), 404, proto.ErrNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st, body, _ := b.logoReq("PUT", tc.id, tc.body, "")
			if st != tc.want || logoErrCode(t, body) != tc.code {
				t.Fatalf("PUT: %d %s, want %d %s", st, body, tc.want, tc.code)
			}
		})
	}
	// Nothing was stored by any of them.
	if _, err := b.st.LogoOf(context.Background(), id); err == nil {
		t.Fatal("a refused upload was stored")
	}
	// Exactly 1 MiB is accepted by the size check (it then fails as a PNG).
	if st, body, _ := b.logoReq("PUT", id, bytes.NewReader(append(bytes.Clone(good), make([]byte, logo.MaxInput-len(good))...)), ""); st == 413 {
		t.Fatalf("a 1 MiB file was refused as too large: %s", body)
	}
	// Other methods and unknown routes.
	if st, _, _ := b.logoReq("POST", id, nil, ""); st != 405 {
		t.Fatalf("POST: %d", st)
	}
	if st, _, _ := b.logoReq("GET", "", nil, ""); st != 404 {
		t.Fatalf("GET /logo/: %d", st)
	}
}

func TestDeletingTheBuildingDeletesItsLogo(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	id := createBuilding(c, "Work")
	if st, body, _ := b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 10, 10, color.NRGBA{A: 255})), ""); st != 200 {
		t.Fatalf("PUT: %d %s", st, body)
	}
	c.until(proto.EvBuildingUpsert)
	c.mustAck(proto.CmdBuildingDelete, proto.BuildingDeleteArgs{ID: id})
	if st, _, _ := b.logoReq("GET", id, nil, ""); st != 404 {
		t.Fatalf("GET after the building is gone: %d", st)
	}
	if _, err := b.st.LogoOf(context.Background(), id); err == nil {
		t.Fatal("the logo outlived its building")
	}
	if st, _, _ := b.logoReq("PUT", id, bytes.NewReader(testPNG(t, 10, 10, color.NRGBA{A: 255})), ""); st != 404 {
		t.Fatalf("PUT for a deleted building: %d", st)
	}
}
