package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/screenshare"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// testJPEG is a w × h JPEG.
func testJPEG(t testing.TB, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x * 7), uint8(y * 3), 0x90, 0xff})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// screenBridge is a bridge with a frame directory and a running floor "s".
func screenBridge(t *testing.T, opts server.Options) (*bridge, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "herdr-world", "screen")
	if opts.ScreenDir == "" {
		opts.ScreenDir = dir
	} else if opts.ScreenDir == "-" {
		opts.ScreenDir = ""
	}
	b := startBridge(t, "", opts)
	b.floor("s", true)
	c := b.connect(proto.Hello{Client: "settle"})
	c.snapshot()
	return b, dir
}

// game connects a game and reports whether it shares.
func (b *bridge) game(sharing bool, surface string) *client {
	b.t.Helper()
	g, _ := b.gameEvents(sharing, surface)
	return g
}

// gameEvents is game, with the events its screen.share caused.
func (b *bridge) gameEvents(sharing bool, surface string) (*client, []proto.Event) {
	b.t.Helper()
	g := b.connect(proto.Hello{Client: "herdr-3d-game"})
	g.snapshot()
	evs, _ := g.mustAck(proto.CmdScreenShare, proto.ScreenShareArgs{Sharing: sharing, Surface: surface})
	return g, evs
}

// screenNow is the screen state a new client's snapshot has.
func (b *bridge) screenNow() proto.ScreenState {
	b.t.Helper()
	c := b.connect(proto.Hello{Client: "look"})
	s := c.snapshot()
	if s.World.Screen == nil {
		b.t.Fatal("no screen in the snapshot")
	}
	return *s.World.Screen
}

// untilMsg reads until a message of type typ (events included in between).
func (c *client) untilMsg(typ string) msg {
	c.t.Helper()
	for {
		if m := c.next(); m.env.T == typ {
			return m
		}
	}
}

// frameRequest reads the next screen.frame_request.
func (c *client) frameRequest() string {
	c.t.Helper()
	var r proto.ScreenFrameRequest
	_ = json.Unmarshal(c.untilMsg(proto.TScreenFrameRequest).raw, &r)
	if !screenshare.ValidID(r.ReqID) {
		c.t.Fatalf("frame request id %q", r.ReqID)
	}
	return r.ReqID
}

func (b *bridge) postFrame(id string, body []byte) (int, proto.Error) {
	b.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, "http://bridge/screen/frame/"+id, bytes.NewReader(body))
	req.Header.Set("Content-Type", "image/jpeg")
	resp, err := b.http().Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var e proto.Error
	_ = json.Unmarshal(data, &e)
	return resp.StatusCode, e
}

// grab sends screen.grab on c without waiting; reply reads its answer.
func (c *client) grab(reqID string, a proto.ScreenGrabArgs) {
	c.t.Helper()
	raw, _ := json.Marshal(a)
	c.send(proto.Command{T: proto.CmdScreenGrab, ReqID: reqID, Args: raw})
}

func (c *client) reply(reqID string) msg {
	c.t.Helper()
	for {
		m := c.next()
		if (m.env.T == proto.TAck || m.env.T == proto.TError) && m.env.ReqID == reqID {
			return m
		}
	}
}

func grabResult(t *testing.T, m msg) proto.ScreenGrabResult {
	t.Helper()
	if m.env.T != proto.TAck {
		t.Fatalf("grab failed: %s", m.raw)
	}
	var ack struct {
		Data proto.ScreenGrabResult `json:"data"`
	}
	_ = json.Unmarshal(m.raw, &ack)
	return ack.Data
}

func grabError(t *testing.T, m msg, code string) proto.Error {
	t.Helper()
	var e proto.Error
	_ = json.Unmarshal(m.raw, &e)
	if m.env.T != proto.TError || e.Code != code {
		t.Fatalf("got %s, want error %s", m.raw, code)
	}
	return e
}

func screenAudit(t *testing.T, b *bridge, cmd string) []store.AuditEntry {
	t.Helper()
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []store.AuditEntry
	for _, e := range log {
		if e.Cmd == cmd {
			out = append(out, e)
		}
	}
	return out
}

var nibble = proto.ScreenGrabArgs{Floor: "s", Requester: "Nibble"}

func TestScreenGrabRoundTrip(t *testing.T) {
	// Not parallel: it bounds a grab in wall-clock.
	b, dir := screenBridge(t, server.Options{})
	g, evs := b.gameEvents(true, proto.SurfaceWindow)
	if len(evs) != 1 || evs[0].T != proto.EvScreenState || !evs[0].Sharing || evs[0].Surface != proto.SurfaceWindow {
		t.Fatalf("screen.share events = %+v", evs)
	}
	cli := b.connect(proto.Hello{Client: "office-cli"})
	if s := cli.snapshot(); s.World.Screen == nil || !s.World.Screen.Sharing || s.World.Screen.Surface != proto.SurfaceWindow {
		t.Fatalf("snapshot screen = %+v", s.World.Screen)
	}
	start := time.Now()
	cli.grab("g1", nibble)
	id := g.frameRequest()
	frame := testJPEG(t, 640, 360)
	if code, e := b.postFrame(id, frame); code != http.StatusOK {
		t.Fatalf("POST frame: %d %+v", code, e)
	}
	res := grabResult(t, cli.reply("g1"))
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("round trip took %s", took)
	}
	if filepath.Dir(res.Path) != dir || res.W != 640 || res.H != 360 || res.Bytes != len(frame) || res.Surface != proto.SurfaceWindow {
		t.Fatalf("result %+v", res)
	}
	if res.Expires-res.At != screenshare.DefaultTTL.Milliseconds() {
		t.Fatalf("expires %d after at", res.Expires-res.At)
	}
	got, err := os.ReadFile(res.Path)
	if err != nil || !bytes.Equal(got, frame) {
		t.Fatalf("stored frame differs (%v)", err)
	}
	if fi, _ := os.Stat(res.Path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("frame mode %v", fi.Mode())
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", fi.Mode())
	}
	var toast proto.ScreenGrabbed
	_ = json.Unmarshal(g.untilMsg(proto.TScreenGrabbed).raw, &toast)
	if toast.Requester != "Nibble" || toast.Floor != "s" || toast.At != res.At {
		t.Fatalf("toast %+v", toast)
	}
	rows := screenAudit(t, b, proto.CmdScreenGrab)
	if len(rows) != 1 || !rows[0].OK || rows[0].Client != "office-cli" || !strings.Contains(rows[0].Args, `"requester":"Nibble"`) || !strings.Contains(rows[0].Args, `"w":640`) {
		t.Fatalf("audit %+v", rows)
	}
	// The same frame request is answered once.
	if code, _ := b.postFrame(id, frame); code != http.StatusNotFound {
		t.Fatalf("second POST: %d", code)
	}
	// Stopping: screen.state goes out to everyone.
	g.mustAck(proto.CmdScreenShare, proto.ScreenShareArgs{Sharing: false})
	if ev := cli.until(proto.EvScreenState); ev.Sharing || ev.Surface != "" {
		t.Fatalf("after stop: %+v", ev.ScreenState)
	}
}

func TestScreenGrabRefusals(t *testing.T) {
	t.Parallel()
	b, _ := screenBridge(t, server.Options{})
	cli := b.connect(proto.Hello{Client: "office-cli"})
	if s := cli.snapshot(); s.World.Screen == nil || s.World.Screen.Sharing {
		t.Fatalf("snapshot screen = %+v", s.World.Screen)
	}
	// No game connected (the CLI itself is a client, not a game).
	cli.grab("a", nibble)
	grabError(t, cli.reply("a"), proto.ErrNoClient)
	g := b.game(false, "")
	cli.grab("b", nibble)
	if e := grabError(t, cli.reply("b"), proto.ErrNotSharing); !strings.Contains(e.Message, "Share screen") {
		t.Fatalf("not_sharing message %q", e.Message)
	}
	g.mustAck(proto.CmdScreenShare, proto.ScreenShareArgs{Sharing: true, Surface: proto.SurfaceBrowser})
	for i, a := range []proto.ScreenGrabArgs{
		{Floor: "s"},
		{Floor: "s", Requester: "Nib\x1bble"},
		{Floor: "s", Requester: "Nib‮elbb"},
		{Floor: "s", Requester: " Nibble"},
		{Floor: "s", Requester: strings.Repeat("n", 65)},
		{Floor: "s", Requester: "\ufffd"}, // what json makes of invalid UTF-8
		{Requester: "Nibble"},
	} {
		id := fmt.Sprintf("bad%d", i)
		cli.grab(id, a)
		grabError(t, cli.reply(id), proto.ErrBadRequest)
	}
	cli.grab("u", proto.ScreenGrabArgs{Floor: "nope", Requester: "Nibble"})
	grabError(t, cli.reply("u"), proto.ErrUnknownSession)
	cli.mustError(proto.CmdScreenShare, proto.ScreenShareArgs{Sharing: true, Surface: "camera"}, proto.ErrBadRequest)
	cli.mustError(proto.CmdScreenFrame, proto.ScreenFrameArgs{ReqID: strings.Repeat("a", 32)}, proto.ErrBadRequest)
	rows := screenAudit(t, b, proto.CmdScreenGrab)
	if len(rows) != 10 {
		t.Fatalf("%d grab audit rows, want 10", len(rows))
	}
	for _, r := range rows {
		if r.OK || r.Error == "" {
			t.Fatalf("refused grab audited as %+v", r)
		}
	}
}

func TestScreenGrabWithoutFrameDir(t *testing.T) {
	t.Parallel()
	b, _ := screenBridge(t, server.Options{ScreenDir: "-"})
	b.game(true, proto.SurfaceMonitor)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	cli.snapshot()
	cli.grab("x", nibble)
	if e := grabError(t, cli.reply("x"), proto.ErrInternal); !strings.Contains(e.Message, "XDG_RUNTIME_DIR") {
		t.Fatalf("message %q", e.Message)
	}
}

func TestScreenGrabTimeout(t *testing.T) {
	// Not parallel: it bounds a grab in wall-clock.
	b, dir := screenBridge(t, server.Options{ScreenTimeout: 200 * time.Millisecond})
	g := b.game(true, proto.SurfaceWindow)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	cli.snapshot()
	start := time.Now()
	cli.grab("t", nibble)
	id := g.frameRequest()
	e := grabError(t, cli.reply("t"), proto.ErrFrameTimeout)
	if took := time.Since(start); took < 200*time.Millisecond || took > 3*time.Second {
		t.Fatalf("timed out after %s", took)
	}
	if !strings.Contains(e.Message, "200ms") {
		t.Fatalf("message %q", e.Message)
	}
	// A frame that comes after the grab gave up is refused and never stored.
	if code, _ := b.postFrame(id, testJPEG(t, 32, 32)); code != http.StatusNotFound {
		t.Fatalf("late POST: %d", code)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("stored %d files", len(ents))
	}
}

func TestScreenFrameRefused(t *testing.T) {
	t.Parallel()
	b, dir := screenBridge(t, server.Options{})
	g := b.game(true, proto.SurfaceBrowser)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	cli.snapshot()
	huge := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, screenshare.MaxBytes)...)
	for i, c := range []struct {
		body   []byte
		status int
		code   string
	}{
		{[]byte("<html>not a frame</html>"), http.StatusUnprocessableEntity, proto.ErrFrameInvalid},
		{testJPEG(t, 64, 64)[:100], http.StatusUnprocessableEntity, proto.ErrFrameInvalid},
		{testJPEG(t, screenshare.MaxWidth+8, 4), http.StatusRequestEntityTooLarge, proto.ErrFrameTooLarge},
		{huge, http.StatusRequestEntityTooLarge, proto.ErrFrameTooLarge},
	} {
		req := fmt.Sprintf("r%d", i)
		cli.grab(req, nibble)
		id := g.frameRequest()
		if status, e := b.postFrame(id, c.body); status != c.status || e.Code != c.code {
			t.Fatalf("case %d: POST %d %+v, want %d %s", i, status, e, c.status, c.code)
		}
		grabError(t, cli.reply(req), c.code)
	}
	if code, _ := b.postFrame(strings.Repeat("0", 32), testJPEG(t, 8, 8)); code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", code)
	}
	if code, _ := b.postFrame("../../etc", testJPEG(t, 8, 8)); code != http.StatusBadRequest && code != http.StatusNotFound {
		t.Fatalf("bad id: %d", code)
	}
	if code, _ := b.postFrame("ABCDEF0123456789ABCDEF0123456789", testJPEG(t, 8, 8)); code != http.StatusBadRequest {
		t.Fatalf("upper-case id: %d", code)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("stored %d files", len(ents))
	}
}

func TestScreenGrabsConcurrent(t *testing.T) {
	t.Parallel()
	b, _ := screenBridge(t, server.Options{})
	g := b.game(true, proto.SurfaceMonitor)
	clis := make([]*client, 4)
	for i := range clis {
		clis[i] = b.connect(proto.Hello{Client: fmt.Sprintf("cli%d", i)})
		clis[i].snapshot()
		clis[i].grab("c", proto.ScreenGrabArgs{Floor: "s", Requester: fmt.Sprintf("Worker%d", i)})
	}
	ids := map[string]bool{}
	var order []string
	for range clis {
		id := g.frameRequest()
		if ids[id] {
			t.Fatalf("req_id %s twice", id)
		}
		ids[id] = true
		order = append(order, id)
	}
	// A fifth grab while four wait is refused, not queued.
	extra := b.connect(proto.Hello{Client: "extra"})
	extra.snapshot()
	extra.grab("e", nibble)
	grabError(t, extra.reply("e"), proto.ErrBusy)
	// Answered in reverse, concurrently, each with a size of its own.
	var wg sync.WaitGroup
	for i, id := range order {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, e := b.postFrame(id, testJPEG(t, 100+i, 50)); code != http.StatusOK {
				t.Errorf("POST %d: %d %+v", i, code, e)
			}
		}()
	}
	wg.Wait()
	widths := map[int]bool{}
	paths := map[string]bool{}
	for _, c := range clis {
		res := grabResult(t, c.reply("c"))
		widths[res.W] = true
		paths[res.Path] = true
	}
	if len(widths) != 4 || len(paths) != 4 {
		t.Fatalf("widths %v paths %v", widths, paths)
	}
}

func TestScreenGameGoesAwayMidRequest(t *testing.T) {
	// Not parallel: it bounds a grab in wall-clock.
	b, _ := screenBridge(t, server.Options{ScreenTimeout: 30 * time.Second})
	g := b.game(true, proto.SurfaceWindow)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	cli.snapshot()
	cli.grab("d", nibble)
	id := g.frameRequest()
	start := time.Now()
	g.conn.CloseNow()
	grabError(t, cli.reply("d"), proto.ErrNoClient)
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the grab waited %s for a gone game", took)
	}
	if st := b.screenNow(); st.Sharing {
		t.Fatalf("still sharing after the game left: %+v", st)
	}
	if code, _ := b.postFrame(id, testJPEG(t, 16, 16)); code != http.StatusNotFound {
		t.Fatalf("POST after the game left: %d", code)
	}
	cli.grab("d2", nibble)
	grabError(t, cli.reply("d2"), proto.ErrNoClient)
}

func TestScreenStopOrGameRefusalMidRequest(t *testing.T) {
	t.Parallel()
	b, _ := screenBridge(t, server.Options{ScreenTimeout: 30 * time.Second})
	g := b.game(true, proto.SurfaceWindow)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	cli.snapshot()
	// The game cannot take a frame (its source is paused).
	cli.grab("m", nibble)
	id := g.frameRequest()
	other := b.game(false, "")
	other.mustError(proto.CmdScreenFrame, proto.ScreenFrameArgs{ReqID: id, Error: "unavailable"}, proto.ErrNotFound) // not its request
	g.mustAck(proto.CmdScreenFrame, proto.ScreenFrameArgs{ReqID: id, Error: "unavailable", Message: "the shared window is minimised\x07"})
	if e := grabError(t, cli.reply("m"), proto.ErrFrameUnavailable); !strings.Contains(e.Message, "minimised") || strings.ContainsRune(e.Message, 7) {
		t.Fatalf("message %q", e.Message)
	}
	g.mustError(proto.CmdScreenFrame, proto.ScreenFrameArgs{ReqID: id, Error: "unavailable"}, proto.ErrNotFound)
	// Stop sharing while a grab waits.
	cli.grab("s", nibble)
	g.frameRequest()
	g.mustAck(proto.CmdScreenShare, proto.ScreenShareArgs{Sharing: false})
	grabError(t, cli.reply("s"), proto.ErrNotSharing)
}

func TestScreenLatestSharerIsAsked(t *testing.T) {
	t.Parallel()
	b, _ := screenBridge(t, server.Options{})
	first := b.game(true, proto.SurfaceWindow)
	second := b.game(true, proto.SurfaceBrowser)
	cli := b.connect(proto.Hello{Client: "office-cli"})
	if s := cli.snapshot(); s.World.Screen.Surface != proto.SurfaceBrowser {
		t.Fatalf("snapshot surface %q", s.World.Screen.Surface)
	}
	cli.grab("l", nibble)
	id := second.frameRequest()
	if code, _ := b.postFrame(id, testJPEG(t, 20, 20)); code != http.StatusOK {
		t.Fatal(code)
	}
	if res := grabResult(t, cli.reply("l")); res.Surface != proto.SurfaceBrowser {
		t.Fatalf("surface %q", res.Surface)
	}
	second.conn.CloseNow()
	if ev := cli.until(proto.EvScreenState); !ev.Sharing || ev.Surface != proto.SurfaceWindow {
		t.Fatalf("after the second left: %+v", ev.ScreenState)
	}
	if st := b.screenNow(); !st.Sharing || st.Surface != proto.SurfaceWindow {
		t.Fatalf("snapshot after the second left: %+v", st)
	}
	cli.grab("l2", nibble)
	id = first.frameRequest()
	if code, _ := b.postFrame(id, testJPEG(t, 20, 20)); code != http.StatusOK {
		t.Fatal(code)
	}
	grabResult(t, cli.reply("l2"))
}

// fakeClock is the bridge clock of the TTL test.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestScreenFramesExpire(t *testing.T) {
	t.Parallel()
	clk := &fakeClock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	b, dir := screenBridge(t, server.Options{Now: clk.Now, ScreenSweep: 5 * time.Millisecond})
	g := b.game(true, proto.SurfaceWindow)
	done := make(chan struct{})
	var res proto.ScreenGrabResult
	var gerr error
	go func() {
		// The Go entry point (M14's CLI), audited as its caller.
		res, gerr = b.hub.GrabScreen(context.Background(), "office", nibble)
		close(done)
	}()
	id := g.frameRequest()
	if code, _ := b.postFrame(id, testJPEG(t, 48, 27)); code != http.StatusOK {
		t.Fatal(code)
	}
	<-done
	if gerr != nil || filepath.Dir(res.Path) != dir {
		t.Fatalf("GrabScreen = %+v, %v", res, gerr)
	}
	if rows := screenAudit(t, b, proto.CmdScreenGrab); len(rows) != 1 || rows[0].Client != "office" || !rows[0].OK {
		t.Fatalf("audit %+v", rows)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(res.Path); err != nil {
		t.Fatal("the frame went before its TTL")
	}
	clk.Add(screenshare.DefaultTTL)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(res.Path); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the frame outlived its TTL")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestScreenFramesSweptAtStartup(t *testing.T) {
	t.Parallel()
	clk := &fakeClock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	dir := filepath.Join(t.TempDir(), "screen")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, fmt.Sprintf("frame-%d-%s.jpg", clk.Now().Add(-time.Hour).UnixMilli(), strings.Repeat("a", 32)))
	_ = os.WriteFile(old, []byte("x"), 0o600)
	screenBridge(t, server.Options{Now: clk.Now, ScreenDir: dir})
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("an expired frame survived the bridge's start")
	}
}

func TestScreenGrabClientCall(t *testing.T) {
	t.Parallel()
	b, dir := screenBridge(t, server.Options{})
	cli := b.connect(proto.Hello{Client: "office-cli"})
	var gerr *proto.ScreenGrabError
	if _, err := cli.conn.ScreenGrab(context.Background(), nibble); !errors.As(err, &gerr) || gerr.Code != proto.ErrNoClient {
		t.Fatalf("ScreenGrab without a game = %v", err)
	}
	g := b.game(true, proto.SurfaceMonitor)
	go func() {
		id := g.frameRequest()
		b.postFrame(id, testJPEG(t, 30, 20))
	}()
	res, err := cli.conn.ScreenGrab(context.Background(), nibble)
	if err != nil || filepath.Dir(res.Path) != dir || res.W != 30 {
		t.Fatalf("ScreenGrab = %+v, %v", res, err)
	}
}
