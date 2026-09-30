package transcript

import (
	"bytes"
	"context"
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

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func pngBytes(t testing.TB, w, h, seed int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x + seed), G: uint8(y), B: uint8(seed * 7), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// jl marshals a line.
func jl(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

type m = map[string]any

func claudeUserLine(t testing.TB, uuid string, content ...any) string {
	return jl(t, m{"type": "user", "uuid": uuid, "timestamp": "2026-09-30T10:00:00.000Z", "message": m{"role": "user", "content": content}})
}

func claudeImg(mime string, data []byte) m {
	return m{"type": "image", "source": m{"type": "base64", "media_type": mime, "data": b64(data)}}
}

func claudeText(s string) m { return m{"type": "text", "text": s} }

// openLog reads a synthetic transcript with the images configured.
func openLog(t testing.TB, harness, content string, im *Images, cwd string) *Log {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := []Option{WithImages(im)}
	if cwd != "" {
		opts = append(opts, WithCwd(cwd))
	}
	l, err := Read(context.Background(), harness, path, opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	return l
}

func newImages(t testing.TB, max int64, roots ...string) *Images {
	t.Helper()
	c, err := imgcache.New(imgcache.Config{MaxBytes: max})
	if err != nil {
		t.Fatal(err)
	}
	return &Images{Cache: c, Roots: roots}
}

func all(t testing.TB, l *Log) []proto.TranscriptItem {
	t.Helper()
	p, err := l.Before(0, 500)
	if err != nil {
		t.Fatal(err)
	}
	return p.Items
}

func refsOf(it proto.TranscriptItem) []*proto.ImageRef {
	var out []*proto.ImageRef
	for _, p := range it.Parts {
		if p.Image != nil {
			out = append(out, p.Image)
		}
	}
	if it.Tool != nil {
		for _, p := range it.Tool.Images {
			if p.Image != nil {
				out = append(out, p.Image)
			}
		}
	}
	return out
}

// The image blocks of a Claude transcript: a paste in a user message is an
// input image, a Read of a PNG (in a tool_result) an image the agent
// viewed. Each has a hash, a type and a size, and no bytes.
func TestClaudeInlineImages(t *testing.T) {
	paste, viewed := pngBytes(t, 30, 20, 1), pngBytes(t, 64, 48, 2)
	content := claudeUserLine(t, "u1", claudeText("look [Image #1]"), claudeImg("image/png", paste)) +
		jl(t, m{"type": "assistant", "uuid": "a1", "timestamp": "2026-09-30T10:00:01.000Z", "message": m{"id": "msg_1", "content": []any{
			m{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": m{"file_path": "/x/y.png"}}}}}) +
		jl(t, m{"type": "user", "uuid": "u2", "timestamp": "2026-09-30T10:00:02.000Z", "message": m{"role": "user", "content": []any{
			m{"type": "tool_result", "tool_use_id": "toolu_1", "content": []any{claudeImg("image/png", viewed)}}}}})
	l := openLog(t, Claude, content, newImages(t, 0), "")
	items := all(t, l)
	if len(items) != 2 {
		t.Fatalf("%d items", len(items))
	}
	u := refsOf(items[0])
	if len(u) != 1 || u[0].Origin != proto.OriginInput || u[0].Kind != "" || u[0].Source != proto.ImageInline || u[0].Hash != imgcache.Hash(paste) ||
		u[0].Mime != "image/png" || u[0].Width != 30 || u[0].Height != 20 || u[0].Bytes != int64(len(paste)) ||
		u[0].ItemID != "u1" || u[0].Seq != 1 || u[0].TS == 0 || u[0].Unavailable {
		t.Errorf("paste = %+v", u)
	}
	v := refsOf(items[1])
	if len(v) != 1 || v[0].Origin != proto.OriginAgent || v[0].Kind != proto.KindViewed || v[0].Hash != imgcache.Hash(viewed) ||
		v[0].ItemID != "toolu_1" || v[0].Seq != 2 {
		t.Errorf("read = %+v", v)
	}
	if items[1].Tool.Images[0].Image != v[0] {
		t.Error("the tool's images are not the refs")
	}
	// No base64 anywhere in what the bridge sends.
	raw, _ := json.Marshal(items)
	for _, b := range [][]byte{paste, viewed} {
		if bytes.Contains(raw, []byte(b64(b)[:40])) {
			t.Error("the items carry base64")
		}
	}
	// Item in full: the same.
	it, ok, err := l.Item("toolu_1")
	if err != nil || !ok || len(refsOf(it)) != 1 {
		t.Errorf("item: %v %v %+v", ok, err, it)
	}
}

func TestBinaryAndBrokenInlineImages(t *testing.T) {
	svg := []byte("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
	content := claudeUserLine(t, "u1", claudeImg("image/png", svg), // labelled png, is an svg
		m{"type": "image", "source": m{"type": "base64", "media_type": "image/png", "data": "!!!not base64!!!"}},
		m{"type": "image", "source": m{"type": "url", "url": "https://example.com/x.png"}})
	im := newImages(t, 0)
	l := openLog(t, Claude, content, im, "")
	rs := refsOf(all(t, l)[0])
	if len(rs) != 3 {
		t.Fatalf("%d refs", len(rs))
	}
	if rs[0].Mime != "binary" || rs[0].Hash == "" || rs[0].Unavailable {
		t.Errorf("svg = %+v", rs[0])
	}
	if _, err := l.Image(rs[0].Hash); err == nil {
		t.Error("a binary was served")
	}
	if !rs[1].Unavailable || rs[1].Reason != "invalid" || rs[1].Hash != "" {
		t.Errorf("garbage = %+v", rs[1])
	}
	// A URL is text, never fetched.
	if !rs[2].Unavailable || rs[2].Reason != "not_allowed" || rs[2].Path != "https://example.com/x.png" {
		t.Errorf("url = %+v", rs[2])
	}
}

// A path marker becomes an image only under a root the bridge serves; a
// path outside, a symlink out of a root, a missing file and a file that is
// not an image are "not available", and what is not allowed is never read
// (nothing of it reaches the cache).
func TestPathImagesAndTheAllowlist(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	drops, secret, work := filepath.Join(base, "drops"), filepath.Join(base, "secret"), filepath.Join(base, "work")
	for _, d := range []string{drops, secret, work} {
		_ = os.MkdirAll(d, 0o755)
	}
	ok, hidden, inCwd := pngBytes(t, 12, 9, 3), pngBytes(t, 12, 9, 4), pngBytes(t, 12, 9, 5)
	_ = os.WriteFile(filepath.Join(drops, "ok.png"), ok, 0o644)
	_ = os.WriteFile(filepath.Join(secret, "secret.png"), hidden, 0o644)
	_ = os.WriteFile(filepath.Join(work, "shot.png"), inCwd, 0o644)
	_ = os.WriteFile(filepath.Join(drops, "text.png"), []byte("just text"), 0o644)
	_ = os.Symlink(filepath.Join(secret, "secret.png"), filepath.Join(drops, "escape.png"))
	marker := func(p string) string { return fmt.Sprintf("[Image #1: %s]", p) }
	paths := []string{filepath.Join(drops, "ok.png"), filepath.Join(secret, "secret.png"), filepath.Join(drops, "escape.png"),
		filepath.Join(drops, "gone.png"), filepath.Join(drops, "text.png"), filepath.Join(work, "shot.png"), "relative/x.png", drops + "/../secret/secret.png"}
	var content string
	for i, p := range paths {
		content += claudeUserLine(t, fmt.Sprintf("u%d", i), claudeText("see "+marker(p)+" ok?"))
	}
	im := newImages(t, 0, drops)
	l := openLog(t, Claude, content, im, work)
	items := all(t, l)
	want := []struct {
		reason string
		hash   string
	}{{"", imgcache.Hash(ok)}, {"not_allowed", ""}, {"not_allowed", ""}, {"missing", ""}, {"not_image", ""}, {"", imgcache.Hash(inCwd)},
		{"not_allowed", ""}, {"not_allowed", ""}}
	for i, w := range want {
		rs := refsOf(items[i])
		if len(rs) != 1 {
			t.Fatalf("item %d: %d refs (%+v)", i, len(rs), items[i].Parts)
		}
		r := rs[0]
		if r.Source != proto.ImagePath || r.Path != paths[i] || r.Origin != proto.OriginInput || r.Reason != w.reason || r.Hash != w.hash || r.Unavailable != (w.reason != "") {
			t.Errorf("%s: %+v", paths[i], r)
		}
		// The text around the marker stays.
		if len(items[i].Parts) != 3 || items[i].Parts[0].Text != "see " || items[i].Parts[2].Text != " ok?" {
			t.Errorf("parts = %+v", items[i].Parts)
		}
	}
	// The secret file's bytes are nowhere.
	if _, ok := im.Cache.Get(imgcache.Hash(hidden)); ok {
		t.Error("a file outside the roots was read into the cache")
	}
	// Available ones are served by hash.
	for _, b := range [][]byte{ok, inCwd} {
		got, err := l.Image(imgcache.Hash(b))
		if err != nil || !bytes.Equal(got, b) {
			t.Errorf("Image: %v", err)
		}
	}
	if _, err := l.Image(imgcache.Hash(hidden)); err == nil {
		t.Error("the secret was served")
	}
}

// Path images are read again from the file when the cache lost them, and
// only if it still is the file the hash was made of.
func TestPathImageReloadAndChange(t *testing.T) {
	drops, _ := filepath.EvalSymlinks(t.TempDir())
	a := pngBytes(t, 10, 10, 1)
	p := filepath.Join(drops, "a.png")
	_ = os.WriteFile(p, a, 0o644)
	im := newImages(t, 1) // holds nothing
	l := openLog(t, Claude, claudeUserLine(t, "u", claudeText("[Image #1: "+p+"]")), im, "")
	r := refsOf(all(t, l)[0])[0]
	im.Roots = []string{drops}
	r = refsOf(all(t, l)[0])[0]
	if r.Hash != imgcache.Hash(a) {
		t.Fatalf("ref = %+v", r)
	}
	if b, err := l.Image(r.Hash); err != nil || !bytes.Equal(b, a) {
		t.Fatalf("Image: %v", err)
	}
	_ = os.WriteFile(p, pngBytes(t, 10, 10, 9), 0o644)
	if _, err := l.Image(r.Hash); err == nil {
		t.Error("a changed file was served under the old hash")
	}
	_ = os.Remove(p)
	if _, err := l.Image(r.Hash); err == nil {
		t.Error("a removed file was served")
	}
}

// The cache stays within its bound however many images a transcript has,
// and an image the cache lost is read again from its line.
func TestImagesStayBoundedAndCanBeReread(t *testing.T) {
	var content string
	var imgs [][]byte
	for i := range 40 {
		b := pngBytes(t, 60, 60, i)
		imgs = append(imgs, b)
		content += claudeUserLine(t, fmt.Sprintf("u%d", i), claudeImg("image/png", b))
	}
	im := newImages(t, 4_000)
	l := openLog(t, Claude, content, im, "")
	items := all(t, l)
	if len(items) != 40 {
		t.Fatal(len(items))
	}
	if got := im.Cache.Bytes(); got > 4_000 {
		t.Fatalf("the cache holds %d bytes, bound is 4000", got)
	}
	// The first one was long evicted.
	h := refsOf(items[0])[0].Hash
	if _, ok := im.Cache.Get(h); ok {
		t.Fatal("expected the oldest to be evicted")
	}
	b, err := l.Image(h)
	if err != nil || !bytes.Equal(b, imgs[0]) {
		t.Fatalf("Image after eviction: %v", err)
	}
	th, err := l.Thumb(refsOf(items[5])[0].Hash)
	if err != nil || th.Width != 60 {
		t.Errorf("thumb: %+v %v", th, err)
	}
	if im.Cache.Bytes() > 4_000 {
		t.Error("the bound broke")
	}
	if _, err := l.Image(imgcache.Hash([]byte("unknown"))); err == nil {
		t.Error("a hash the log never showed was served")
	}
}

// The session's images, from the index: oldest first, each linking back
// to its item, from before the newest page as well.
func TestSessionImages(t *testing.T) {
	var content string
	for i := range 12 {
		if i%3 == 0 {
			content += claudeUserLine(t, fmt.Sprintf("u%d", i), claudeText("text"), claudeImg("image/png", pngBytes(t, 5, 5, i)), claudeImg("image/png", pngBytes(t, 6, 6, i)))
		} else {
			content += claudeUserLine(t, fmt.Sprintf("u%d", i), claudeText("no image"))
		}
	}
	l := openLog(t, Claude, content, newImages(t, 0), "")
	refs, more, err := l.Images(100)
	if err != nil || more || len(refs) != 8 {
		t.Fatalf("%d refs, more %v, %v", len(refs), more, err)
	}
	for i, r := range refs {
		wantItem := fmt.Sprintf("u%d", (i/2)*3)
		if r.ItemID != wantItem || r.Origin != proto.OriginInput || r.Hash == "" || r.Seq != int64((i/2)*3+1) || r.TS == 0 {
			t.Errorf("ref %d = %+v", i, r)
		}
	}
	refs, more, err = l.Images(3)
	if err != nil || !more || len(refs) != 3 || refs[2].ItemID != "u9" || refs[0].ItemID != "u6" {
		t.Errorf("newest 3: %+v more %v %v", refs, more, err)
	}
	// Only the items with images were read back (no text-only item parses images).
}

// Codex: input_image data URLs in a user message and in a tool output, a
// generated image, and a view_image call.
func TestCodexImages(t *testing.T) {
	user, out, gen := pngBytes(t, 8, 8, 1), pngBytes(t, 9, 9, 2), pngBytes(t, 10, 10, 3)
	dataURL := func(b []byte) string { return "data:image/png;base64," + b64(b) }
	drops, _ := filepath.EvalSymlinks(t.TempDir())
	genRoot := filepath.Join(drops, "generated_images")
	_ = os.MkdirAll(genRoot, 0o755)
	saved := filepath.Join(genRoot, "s", "call_2.png")
	_ = os.MkdirAll(filepath.Dir(saved), 0o755)
	_ = os.WriteFile(saved, pngBytes(t, 11, 11, 4), 0o644)
	viewFile := filepath.Join(drops, "elsewhere", "v.png")
	_ = os.MkdirAll(filepath.Dir(viewFile), 0o755)
	_ = os.WriteFile(viewFile, pngBytes(t, 7, 7, 5), 0o644)
	line := func(typ string, payload any) string {
		return jl(t, m{"timestamp": "2026-09-30T10:00:00.000Z", "type": typ, "payload": payload})
	}
	content := line("response_item", m{"type": "message", "id": "msg_u", "role": "user", "content": []any{
		m{"type": "input_text", "text": "<image name=[Image #1] path=\"/tmp/herdr-clipboard-images-1000/x.png\">"},
		m{"type": "input_image", "image_url": dataURL(user), "detail": "high"},
		m{"type": "input_text", "text": "</image>"}, m{"type": "input_text", "text": "[Image #1] what is this?"}}}) +
		line("response_item", m{"type": "function_call", "id": "fc_1", "name": "view_image", "arguments": `{"path":"/tmp/a.png"}`, "call_id": "call_1"}) +
		line("response_item", m{"type": "function_call_output", "call_id": "call_1", "output": []any{m{"type": "input_image", "image_url": dataURL(out)}}}) +
		line("event_msg", m{"type": "image_generation_end", "call_id": "call_gen", "status": "completed", "result": b64(gen), "saved_path": "/nowhere"}) +
		line("event_msg", m{"type": "image_generation_end", "call_id": "call_2", "status": "completed", "saved_path": saved}) +
		line("response_item", m{"type": "function_call", "id": "fc_2", "name": "view_image", "arguments": fmt.Sprintf(`{"path":%q}`, viewFile), "call_id": "call_v"}) +
		line("response_item", m{"type": "function_call_output", "call_id": "call_v", "output": "attached local image"}) +
		line("response_item", m{"type": "function_call", "id": "fc_3", "name": "view_image", "arguments": `{"path":"/etc/passwd"}`, "call_id": "call_bad"}) +
		line("response_item", m{"type": "function_call_output", "call_id": "call_bad", "output": "attached local image"})
	im := newImages(t, 0, genRoot)
	l := openLog(t, Codex, content, im, "")
	items := all(t, l)
	// items: user, tool(call_1), generated inline, generated saved, view_image path, view_image /etc/passwd
	if len(items) != 6 {
		for _, it := range items {
			t.Logf("%+v", it)
		}
		t.Fatalf("%d items", len(items))
	}
	if rs := refsOf(items[0]); len(rs) != 1 || rs[0].Origin != proto.OriginInput || rs[0].Hash != imgcache.Hash(user) {
		t.Errorf("user = %+v", rs)
	}
	if strings.Contains(textOf(items[0]), "herdr-clipboard") {
		t.Error("the <image> wrapper text shows")
	}
	if rs := refsOf(items[1]); len(rs) != 1 || rs[0].Origin != proto.OriginAgent || rs[0].Kind != proto.KindViewed || rs[0].Hash != imgcache.Hash(out) {
		t.Errorf("view_image output = %+v", rs)
	}
	if rs := refsOf(items[2]); len(rs) != 1 || items[2].Kind != proto.ItemAssistant || rs[0].Origin != proto.OriginAgent || rs[0].Kind != proto.KindGenerated ||
		rs[0].Hash != imgcache.Hash(gen) || rs[0].Source != proto.ImageInline {
		t.Errorf("generated inline = %+v", rs)
	}
	if rs := refsOf(items[3]); len(rs) != 1 || rs[0].Kind != proto.KindGenerated || rs[0].Source != proto.ImagePath || rs[0].Unavailable || rs[0].Hash == "" {
		t.Errorf("generated file = %+v", rs)
	}
	// A view_image whose output has no image: the file it named, exactly it.
	if rs := refsOf(items[4]); len(rs) != 1 || rs[0].Unavailable || rs[0].Path != viewFile || rs[0].Kind != proto.KindViewed || rs[0].Hash == "" {
		t.Errorf("view_image path = %+v", rs)
	}
	// ... and one that names something that is not an image is "not available".
	if rs := refsOf(items[5]); len(rs) != 1 || !rs[0].Unavailable || rs[0].Reason == "" {
		t.Errorf("view_image /etc/passwd = %+v", rs)
	}
	refs, _, _ := l.Images(50)
	if len(refs) != 6 {
		t.Errorf("session images = %d", len(refs))
	}
}

// Item ids and the ids images link to.
func TestImageRefIDsFollowTheItem(t *testing.T) {
	c := claudeUserLine(t, "u1", claudeImg("image/png", pngBytes(t, 3, 3, 0)))
	l := openLog(t, Claude, c, newImages(t, 0), "")
	items := all(t, l)
	if r := refsOf(items[0])[0]; r.ItemID != items[0].ID || r.Seq != items[0].Seq {
		t.Errorf("%+v vs %+v", r, items[0])
	}
}
