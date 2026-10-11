package server_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func seededPNG(t *testing.T, w, h, seed int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x + seed), G: uint8(y), B: uint8(seed * 5), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func claudeImageLine(t *testing.T, uuid string, data []byte, extra ...any) string {
	t.Helper()
	content := append([]any{map[string]any{"type": "text", "text": "hello " + uuid}, map[string]any{"type": "image",
		"source": map[string]any{"type": "base64", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(data)}}}, extra...)
	b, err := json.Marshal(map[string]any{"type": "user", "uuid": uuid, "timestamp": "2026-09-30T10:00:00.000Z",
		"message": map[string]any{"role": "user", "content": content}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

// transcript.image serves only the hashes this connection was sent, as a
// thumbnail (longest side 480) or in full (12 MiB of base64 at most);
// transcript.images lists every image of the session, also the ones older
// than the watch's window, with no bytes; the client never names a path.
func TestTranscriptImages(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-7777-4777-8777-777777777771"
	base, _ := filepath.EvalSymlinks(t.TempDir())
	dir, drops, secret := filepath.Join(base, "projects"), filepath.Join(base, "drops"), filepath.Join(base, "secret")
	_ = os.MkdirAll(drops, 0o755)
	_ = os.MkdirAll(secret, 0o755)
	big, small, marked, hidden := seededPNG(t, 900, 600, 1), seededPNG(t, 20, 10, 2), seededPNG(t, 30, 30, 3), seededPNG(t, 30, 30, 4)
	_ = os.WriteFile(filepath.Join(drops, "m.png"), marked, 0o644)
	_ = os.WriteFile(filepath.Join(secret, "s.png"), hidden, 0o644)
	// A PNG header and 9.5 MB: 12.7 MB of base64, over the cap for a full image.
	huge := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 9_500_000)...)

	content := claudeImageLine(t, "u1", big) + claudeImageLine(t, "u2", small) +
		claudeImageLine(t, "u3", huge) +
		claudeImageLine(t, "u4", small) + // the same image twice
		func() string {
			b, _ := json.Marshal(map[string]any{"type": "user", "uuid": "u5", "timestamp": "2026-09-30T10:00:05.000Z", "message": map[string]any{
				"role": "user", "content": fmt.Sprintf("[Image #1: %s] and [Image #2: %s]", filepath.Join(drops, "m.png"), filepath.Join(secret, "s.png"))}})
			return string(b) + "\n"
		}()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, content)

	cache, err := imgcache.New(imgcache.Config{Dir: filepath.Join(base, "cache")})
	if err != nil {
		t.Fatal(err)
	}
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 20 * time.Millisecond, Images: &transcript.Images{Cache: cache, Roots: []string{drops}}},
		TranscriptFlush: 10 * time.Millisecond})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	b.floor("s1", true, w1)
	id := workerID(t, c, sess)

	// The watch shows only the newest item; the older images are not sent.
	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Limit: 1})
	res := decode[proto.TranscriptWatchResult](t, ack)
	if len(res.Items) != 1 || res.Items[0].ID != "u5" {
		t.Fatalf("watch = %+v", res)
	}
	var marker, denied *proto.ImageRef
	for _, p := range res.Items[0].Parts {
		if p.Image != nil && marker == nil {
			marker = p.Image
		} else if p.Image != nil {
			denied = p.Image
		}
	}
	if marker == nil || denied == nil || marker.Hash != imgcache.Hash(marked) || marker.Source != proto.ImagePath || denied.Unavailable != true ||
		denied.Reason != "not_allowed" || denied.Hash != "" {
		t.Fatalf("u5 images = %+v %+v", marker, denied)
	}
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), base64.StdEncoding.EncodeToString(marked)[:30]) {
		t.Fatal("the ack carries image bytes")
	}

	imageArgs := func(hash, size string) proto.TranscriptImageArgs {
		return proto.TranscriptImageArgs{ID: id, Hash: hash, Size: size}
	}
	// A hash of an older item was not sent yet: not found, and the same for a hash never in the transcript.
	c.mustError(proto.CmdTranscriptImage, imageArgs(imgcache.Hash(big), "thumb"), proto.ErrNotFound)
	c.mustError(proto.CmdTranscriptImage, imageArgs(imgcache.Hash([]byte("nothing")), "thumb"), proto.ErrNotFound)
	// The image the ack showed: thumb and full.
	_, ack = c.mustAck(proto.CmdTranscriptImage, imageArgs(marker.Hash, "thumb"))
	got := decode[proto.TranscriptImageResult](t, ack)
	data, _ := base64.StdEncoding.DecodeString(got.Data)
	if got.Mime != "image/png" || got.Width != 30 || got.Height != 30 || got.Size != "thumb" || !bytes.HasPrefix(data, []byte("\x89PNG")) {
		t.Fatalf("thumb = %+v", got)
	}
	_, ack = c.mustAck(proto.CmdTranscriptImage, imageArgs(marker.Hash, "full"))
	got = decode[proto.TranscriptImageResult](t, ack)
	if data, _ = base64.StdEncoding.DecodeString(got.Data); !bytes.Equal(data, marked) || got.Size != "full" || got.Bytes != len(marked) {
		t.Fatalf("full = %d bytes", len(data))
	}
	// Bad arguments; never a path.
	c.mustError(proto.CmdTranscriptImage, imageArgs("nothex", "thumb"), proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptImage, imageArgs(marker.Hash, "huge"), proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptImage, map[string]any{"id": id, "hash": marker.Hash, "size": "full", "path": filepath.Join(secret, "s.png")}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: "nope", Hash: marker.Hash, Size: "full"}, proto.ErrUnknownWorker)

	// The session's images, oldest first, with no bytes.
	_, ack = c.mustAck(proto.CmdTranscriptImages, proto.TranscriptImagesArgs{ID: id})
	list := decode[proto.TranscriptImagesResult](t, ack)
	if list.HasMore || len(list.Images) != 6 {
		t.Fatalf("%d images: %+v", len(list.Images), list)
	}
	ids := []string{"u1", "u2", "u3", "u4", "u5", "u5"}
	for i, want := range ids {
		if list.Images[i].ItemID != want || list.Images[i].Origin != proto.OriginInput {
			t.Errorf("image %d = %+v", i, list.Images[i])
		}
	}
	if list.Images[1].Hash != list.Images[3].Hash || list.Images[1].Hash != imgcache.Hash(small) {
		t.Error("the same image twice has two hashes")
	}
	raw, _ = json.Marshal(list)
	if len(raw) > 4000 {
		t.Errorf("the list is %d bytes: does it carry bytes?", len(raw))
	}
	// Now the older ones were sent: thumbs (also cut from a big image), a full.
	_, ack = c.mustAck(proto.CmdTranscriptImage, imageArgs(list.Images[0].Hash, "thumb"))
	if got = decode[proto.TranscriptImageResult](t, ack); got.Width != 480 || got.Height != 320 {
		t.Errorf("thumb of a 900x600 = %dx%d", got.Width, got.Height)
	}
	_, ack = c.mustAck(proto.CmdTranscriptImage, imageArgs(list.Images[0].Hash, "full"))
	if data, _ = base64.StdEncoding.DecodeString(decode[proto.TranscriptImageResult](t, ack).Data); !bytes.Equal(data, big) {
		t.Error("full is not the original")
	}
	// Over 12 MiB of base64: too_large, and the thumbnail is the fallback.
	hugeHash := list.Images[2].Hash
	if hugeHash != imgcache.Hash(huge) {
		t.Fatalf("huge = %+v", list.Images[2])
	}
	c.mustError(proto.CmdTranscriptImage, imageArgs(hugeHash, "full"), proto.ErrTooLarge)

	// The list follows a cursor: pages of whole items, newest first, each
	// older run in front, and the bad arguments are refused.
	_, ack = c.mustAck(proto.CmdTranscriptImages, proto.TranscriptImagesArgs{ID: id, Limit: 2})
	first := decode[proto.TranscriptImagesResult](t, ack)
	if !first.HasMore || first.Cursor == "" || len(first.Images) != 2 || first.Images[1].ItemID != "u5" {
		t.Fatalf("first page = %+v", first)
	}
	var paged []proto.ImageRef
	paged = append(paged, first.Images...)
	for cur, n := first.Cursor, 0; cur != ""; n++ {
		if n > 10 {
			t.Fatal("the cursor does not end")
		}
		_, ack = c.mustAck(proto.CmdTranscriptImages, proto.TranscriptImagesArgs{ID: id, Before: cur, Limit: 2})
		pg := decode[proto.TranscriptImagesResult](t, ack)
		paged = append(append([]proto.ImageRef(nil), pg.Images...), paged...)
		if cur = ""; pg.HasMore {
			cur = pg.Cursor
		}
	}
	if len(paged) != len(list.Images) {
		t.Fatalf("paged %d images, the whole list has %d", len(paged), len(list.Images))
	}
	for i := range paged {
		if paged[i].ItemID != list.Images[i].ItemID || paged[i].Hash != list.Images[i].Hash {
			t.Errorf("paged %d = %+v, want %+v", i, paged[i], list.Images[i])
		}
	}
	c.mustError(proto.CmdTranscriptImages, map[string]any{"id": id, "before": "nope"}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptImages, map[string]any{"id": id, "limit": proto.MaxSessionImages + 1}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptImages, map[string]any{"id": id, "limit": -1}, proto.ErrBadRequest)

	// Another connection was sent none of it.
	c2 := b.connect(proto.Hello{})
	c2.snapshot()
	c2.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Limit: 1})
	c2.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Hash: list.Images[0].Hash, Size: "thumb"}, proto.ErrNotFound)
	c2.mustAck(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Hash: marker.Hash, Size: "thumb"})
	// Not watching: invalid_state.
	c2.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id})
	c2.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Hash: marker.Hash, Size: "thumb"}, proto.ErrInvalidState)
	c2.mustError(proto.CmdTranscriptImages, proto.TranscriptImagesArgs{ID: id}, proto.ErrInvalidState)

	// A live push with an image makes its hash fetchable.
	fresh := seededPNG(t, 16, 16, 9)
	appendLine(t, path, claudeImageLine(t, "u6", fresh))
	p, cl := c.push(id)
	if cl.Reason != "" || len(p.Items) != 1 {
		t.Fatalf("push = %+v %+v", p, cl)
	}
	var pushed string
	for _, part := range p.Items[0].Parts {
		if part.Image != nil {
			pushed = part.Image.Hash
		}
	}
	if pushed != imgcache.Hash(fresh) {
		t.Fatalf("pushed hash %q", pushed)
	}
	c.mustAck(proto.CmdTranscriptImage, imageArgs(pushed, "thumb"))

	// The disk cache is a private directory of private files.
	if fi, err := os.Stat(cache.Dir()); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("cache dir %v %v", fi, err)
	}
	ents, _ := os.ReadDir(cache.Dir())
	if len(ents) == 0 {
		t.Error("nothing in the disk cache")
	}
	for _, e := range ents {
		if fi, _ := e.Info(); fi.Mode().Perm() != 0o600 {
			t.Errorf("%s has mode %v", e.Name(), fi.Mode().Perm())
		}
	}
	// The audit log has no image commands, and no content.
	rows, _ := b.st.AuditLog(t.Context())
	for _, r := range rows {
		if r.Cmd == proto.CmdTranscriptImage || r.Cmd == proto.CmdTranscriptImages {
			t.Errorf("audited %s", r.Cmd)
		}
	}
}
