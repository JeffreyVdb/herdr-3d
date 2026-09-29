package helper

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

const (
	testPort  = 7777 // the port the helper believes it serves on
	testToken = "0123456789abcdef0123456789abcdef"
)

// socketBridge dials a bridge socket directly and counts the dials.
type socketBridge struct {
	sock  string
	dials atomic.Int32
	state string
}

func (b *socketBridge) Dial(ctx context.Context) (net.Conn, error) {
	b.dials.Add(1)
	var d net.Dialer
	return d.DialContext(ctx, "unix", b.sock)
}

func (b *socketBridge) Status() Status {
	if b.state == "" {
		return Status{State: StateUp}
	}
	return Status{State: b.state}
}

func writeBundle(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":           "<!doctype html><title>h3d</title>",
		"assets/index-abc1.js": "console.log('h3d')",
		"assets/style-9f.css":  "body{}",
		"models/desk.glb":      "glTF",
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// helperServer runs the helper's handler on an httptest listener; requests
// carry whatever Host header the test picks.
func helperServer(t *testing.T, br Bridge, dev *url.URL) *httptest.Server {
	t.Helper()
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: br,
		Bundle: writeBundle(t), Dev: dev, Log: quietLog()})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func dialWS(ts *httptest.Server, host, origin, query string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws"+query, &websocket.DialOptions{Host: host, HTTPHeader: h})
}

func TestWSChecks(t *testing.T) {
	sock := filepath.Join(shortDir(t), "run", "bridge.sock")
	startBridge(t, sock)
	br := &socketBridge{sock: sock}
	ts := helperServer(t, br, nil)

	const (
		goodHost   = "127.0.0.1:7777"
		goodOrigin = "http://127.0.0.1:7777"
		goodQuery  = "?token=" + testToken
	)
	for name, tc := range map[string]struct{ host, origin, query string }{
		"wrong origin":           {goodHost, "http://evil.example", goodQuery},
		"origin on another port": {goodHost, "http://127.0.0.1:8888", goodQuery},
		"https origin":           {goodHost, "https://127.0.0.1:7777", goodQuery},
		"null origin":            {goodHost, "null", goodQuery},
		"no origin":              {goodHost, "", goodQuery},
		"wrong host":             {"evil.example:7777", goodOrigin, goodQuery},
		"rebound host":           {"attacker.example", goodOrigin, goodQuery},
		"host on another port":   {"127.0.0.1:7778", goodOrigin, goodQuery},
		"host without port":      {"127.0.0.1", goodOrigin, goodQuery},
		"no token":               {goodHost, goodOrigin, ""},
		"empty token":            {goodHost, goodOrigin, "?token="},
		"wrong token":            {goodHost, goodOrigin, "?token=" + strings.Repeat("0", len(testToken))},
		"token prefix":           {goodHost, goodOrigin, "?token=" + testToken[:10]},
		"token in another param": {goodHost, goodOrigin, "?t=" + testToken},
	} {
		t.Run(name, func(t *testing.T) {
			c, resp, err := dialWS(ts, tc.host, tc.origin, tc.query)
			if err == nil {
				c.CloseNow()
				t.Fatal("upgraded")
			}
			if resp == nil || resp.StatusCode != http.StatusForbidden {
				t.Fatalf("response = %+v, err %v; want 403", resp, err)
			}
		})
	}
	if n := br.dials.Load(); n != 0 {
		t.Fatalf("rejected requests reached the bridge %d times", n)
	}

	for _, ok := range []struct{ host, origin string }{
		{goodHost, goodOrigin},
		{"localhost:7777", "http://localhost:7777"},
		{"localhost:7777", goodOrigin}, // a page on 127.0.0.1 reaching localhost is still same-machine
	} {
		c, resp, err := dialWS(ts, ok.host, ok.origin, goodQuery)
		if err != nil {
			t.Fatalf("%+v: %v (%+v)", ok, err, resp)
		}
		expectWorld(t, c)
		c.CloseNow()
	}
}

// expectWorld says hello and expects the bridge's welcome and snapshot.
func expectWorld(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.SetReadLimit(proto.MaxMessage)
	hello, _ := json.Marshal(proto.Hello{T: proto.THello, Proto: proto.Version, Client: "helper-test"})
	if err := c.Write(ctx, websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	var w proto.Welcome
	if _, raw, err := c.Read(ctx); err != nil || json.Unmarshal(raw, &w) != nil || w.T != proto.TWelcome || w.Resume != proto.ResumeSnapshot {
		t.Fatalf("welcome = %s, %v", raw, err)
	}
	var snap proto.Snapshot
	if _, raw, err := c.Read(ctx); err != nil || json.Unmarshal(raw, &snap) != nil || snap.T != proto.TSnapshot ||
		len(snap.World.Floors) != 1 || snap.World.Floors[0].Session != "herdr-3d" {
		t.Fatalf("snapshot = %s, %v", raw, err)
	}
}

func TestBridgeDownIs502(t *testing.T) {
	br := &socketBridge{sock: filepath.Join(shortDir(t), "missing.sock"), state: StateBackoff}
	ts := helperServer(t, br, nil)
	_, resp, err := dialWS(ts, "127.0.0.1:7777", "http://127.0.0.1:7777", "?token="+testToken)
	if err == nil || resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("resp = %+v, err %v", resp, err)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "tunnel backoff") {
		t.Fatalf("body = %q", body)
	}
}

func get(t *testing.T, ts *httptest.Server, method, host, path string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestBundle(t *testing.T) {
	ts := helperServer(t, &socketBridge{state: StateConnecting}, nil)
	const host = "127.0.0.1:7777"
	for _, tc := range []struct {
		method, host, path string
		status             int
		ctype, cache, body string
	}{
		{"GET", host, "/", 200, "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"},
		{"GET", "localhost:7777", "/index.html", 200, "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"},
		{"GET", host, "/assets/index-abc1.js", 200, "text/javascript; charset=utf-8", "immutable", "console.log"},
		{"GET", host, "/assets/style-9f.css", 200, "text/css; charset=utf-8", "immutable", "body{}"},
		{"GET", host, "/models/desk.glb", 200, "model/gltf-binary", "no-cache", "glTF"},
		{"GET", host, "/city/floor/2", 200, "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"}, // app route
		{"GET", host, "/assets/", 200, "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"},      // no listings
		{"GET", host, "/missing.png", 404, "", "", ""},
		{"GET", host, "/../../etc/passwd", 200, "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"}, // cleaned: never leaves the bundle
		{"GET", host, "/../../etc/hosts.txt", 404, "", "", ""},
		{"HEAD", host, "/", 200, "text/html; charset=utf-8", "no-cache", ""},
		{"POST", host, "/", 405, "", "", ""},
		{"GET", "evil.example", "/", 403, "", "", ""},
		{"GET", "127.0.0.1:9999", "/healthz", 403, "", "", ""},
	} {
		resp, body := get(t, ts, tc.method, tc.host, tc.path)
		if resp.StatusCode != tc.status {
			t.Errorf("%s %s (Host %s): %d, want %d", tc.method, tc.path, tc.host, resp.StatusCode, tc.status)
			continue
		}
		if tc.status != 200 {
			continue
		}
		if ct := resp.Header.Get("Content-Type"); ct != tc.ctype {
			t.Errorf("%s: Content-Type %q, want %q", tc.path, ct, tc.ctype)
		}
		if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, tc.cache) {
			t.Errorf("%s: Cache-Control %q, want %q", tc.path, cc, tc.cache)
		}
		if !strings.Contains(body, tc.body) {
			t.Errorf("%s: body %q, want %q", tc.path, body, tc.body)
		}
	}

	resp, body := get(t, ts, "GET", host, "/healthz")
	var h struct{ Tunnel Status }
	if resp.StatusCode != http.StatusServiceUnavailable || json.Unmarshal([]byte(body), &h) != nil || h.Tunnel.State != StateConnecting {
		t.Fatalf("healthz = %d %s", resp.StatusCode, body)
	}
}

func TestDevUpstream(t *testing.T) {
	vite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = io.WriteString(w, "vite "+r.Host+" "+r.URL.RequestURI())
	}))
	t.Cleanup(vite.Close)
	u, _ := url.Parse(vite.URL)
	sock := filepath.Join(shortDir(t), "run", "bridge.sock")
	startBridge(t, sock)
	ts := helperServer(t, &socketBridge{sock: sock}, u)

	resp, body := get(t, ts, "GET", "127.0.0.1:7777", "/src/main.ts?t=1")
	if resp.StatusCode != 200 || body != "vite 127.0.0.1:7777 /src/main.ts?t=1" {
		t.Fatalf("dev proxy: %d %q", resp.StatusCode, body)
	}
	if resp, _ := get(t, ts, "GET", "evil.example", "/src/main.ts"); resp.StatusCode != 403 {
		t.Fatalf("dev proxy skipped the Host check: %d", resp.StatusCode)
	}
	// /ws still goes to the bridge, with the same checks.
	if _, resp, _ := dialWS(ts, "127.0.0.1:7777", "http://evil.example", "?token="+testToken); resp == nil || resp.StatusCode != 403 {
		t.Fatalf("dev mode /ws without a good origin: %+v", resp)
	}
	c, _, err := dialWS(ts, "127.0.0.1:7777", "http://127.0.0.1:7777", "?token="+testToken)
	if err != nil {
		t.Fatal(err)
	}
	c.CloseNow()
}

func TestListenLoopbackOnly(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", ":0", "192.168.1.10:0", "localhost:0", "example.com:0", "127.0.0.1"} {
		if ln, err := ListenLoopback(addr); err == nil {
			ln.Close()
			t.Errorf("%s accepted", addr)
		}
	}
	ln, err := ListenLoopback("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
}

// TestEmbeddedBundle serves the game from an fs.FS (the copy embedded in the
// binary) the same way as from a directory.
func TestEmbeddedBundle(t *testing.T) {
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken,
		Bridge: &socketBridge{state: StateConnecting}, Log: quietLog(),
		BundleFS: fstest.MapFS{
			"index.html":           {Data: []byte("<!doctype html><title>h3d</title>")},
			"assets/index-abc1.js": {Data: []byte("console.log('h3d')")},
		}})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	const host = "127.0.0.1:7777"

	for _, tc := range []struct {
		path, ctype, cache, body string
	}{
		{"/", "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"},
		{"/city/floor/2", "text/html; charset=utf-8", "no-cache", "<title>h3d</title>"},
		{"/assets/index-abc1.js", "text/javascript; charset=utf-8", "immutable", "console.log"},
	} {
		resp, body := get(t, ts, "GET", host, tc.path)
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != tc.ctype ||
			!strings.Contains(resp.Header.Get("Cache-Control"), tc.cache) || !strings.Contains(body, tc.body) {
			t.Errorf("%s: %d %q %q %q", tc.path, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Cache-Control"), body)
		}
	}
	if resp, _ := get(t, ts, "GET", host, "/missing.png"); resp.StatusCode != 404 {
		t.Errorf("/missing.png: %d, want 404", resp.StatusCode)
	}
}

func TestMusicDir(t *testing.T) {
	music := t.TempDir()
	if err := os.MkdirAll(filepath.Join(music, "house"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(music, "house", "a.ogg"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A secret next to the music dir must stay unreachable.
	if err := os.WriteFile(filepath.Join(filepath.Dir(music), "secret.ogg"), []byte("no"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken,
		Bridge: &socketBridge{state: StateConnecting}, Log: quietLog(), MusicDir: music,
		BundleFS: fstest.MapFS{
			"index.html":            {Data: []byte("<!doctype html><title>h3d</title>")},
			"music/house/game.ogg":  {Data: []byte("from the game")},
			"music/house/other.ogg": {Data: []byte("from the game")},
		}})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	const host = "127.0.0.1:7777"

	resp, body := get(t, ts, "GET", host, "/music/house/a.ogg")
	if resp.StatusCode != 200 || body != "0123456789" || resp.Header.Get("Content-Type") != "audio/ogg" ||
		resp.Header.Get("Cache-Control") != "no-cache" || resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("track: %d %q %q %q %q", resp.StatusCode, body, resp.Header.Get("Content-Type"), resp.Header.Get("Cache-Control"), resp.Header.Get("Accept-Ranges"))
	}

	req, _ := http.NewRequest("GET", ts.URL+"/music/house/a.ogg", nil)
	req.Host = host
	req.Header.Set("Range", "bytes=2-4")
	rr, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	rb, _ := io.ReadAll(rr.Body)
	rr.Body.Close()
	if rr.StatusCode != http.StatusPartialContent || string(rb) != "234" {
		t.Errorf("range: %d %q, want 206 \"234\"", rr.StatusCode, rb)
	}

	// Not in the music dir: the game's own file, else 404.
	if _, body := get(t, ts, "GET", host, "/music/house/game.ogg"); body != "from the game" {
		t.Errorf("fallthrough body %q", body)
	}
	if resp, _ := get(t, ts, "GET", host, "/music/house/none.ogg"); resp.StatusCode != 404 {
		t.Errorf("missing track: %d, want 404", resp.StatusCode)
	}
	// A directory is not a file, and dot-dot stays inside.
	for _, p := range []string{"/music/house/", "/music/../secret.ogg", "/music/%2e%2e/secret.ogg"} {
		if resp, body := get(t, ts, "GET", host, p); body == "no" || (resp.StatusCode == 200 && strings.Contains(body, "0123")) {
			t.Errorf("%s leaked %q", p, body)
		}
	}
	if resp, _ := get(t, ts, "GET", "evil.example", "/music/house/a.ogg"); resp.StatusCode != 403 {
		t.Errorf("wrong Host: %d, want 403", resp.StatusCode)
	}
}
