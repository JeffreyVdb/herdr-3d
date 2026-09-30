package helper

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"time"

	"encoding/json"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// echoBridge is a bridge that only records what reaches it on /logo/ and
// answers 200 with a small JSON body.
type echoBridge struct {
	mu   sync.Mutex
	reqs []echoReq
}

type echoReq struct {
	Method, Path, Query, Host string
	Header                    http.Header
	Bytes                     int
}

func (e *echoBridge) seen() []echoReq {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]echoReq(nil), e.reqs...)
}

func startEchoBridge(t *testing.T) (*socketBridge, *echoBridge) {
	t.Helper()
	sock := filepath.Join(shortDir(t), "echo.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	e := &echoBridge{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		e.mu.Lock()
		e.reqs = append(e.reqs, echoReq{r.Method, r.URL.Path, r.URL.RawQuery, r.Host, r.Header.Clone(), int(n)})
		e.mu.Unlock()
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"t":"ack"}`))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return &socketBridge{sock: sock}, e
}

func logoReq(t *testing.T, ts *httptest.Server, method, host, origin, path string, body io.Reader) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Header.Set("Cookie", "session=secret")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestLogoChecks(t *testing.T) {
	const (
		goodHost   = "127.0.0.1:7777"
		goodOrigin = "http://127.0.0.1:7777"
		tok        = "?token=" + testToken
	)
	br, echo := startEchoBridge(t)
	ts := helperServer(t, br, nil)

	tests := []struct {
		name                       string
		method, host, origin, path string
		want                       int
	}{
		// Refused before the bridge.
		{"GET no token", "GET", goodHost, "", "/logo/b_1", 403},
		{"GET empty token", "GET", goodHost, "", "/logo/b_1?token=", 403},
		{"GET wrong token", "GET", goodHost, "", "/logo/b_1?token=" + strings.Repeat("0", len(testToken)), 403},
		{"GET token prefix", "GET", goodHost, "", "/logo/b_1?token=" + testToken[:8], 403},
		{"GET token in another param", "GET", goodHost, "", "/logo/b_1?t=" + testToken, 403},
		{"GET wrong host", "GET", "evil.example:7777", "", "/logo/b_1" + tok, 403},
		{"GET rebound host", "GET", "attacker.example", goodOrigin, "/logo/b_1" + tok, 403},
		{"GET wrong origin", "GET", goodHost, "http://evil.example", "/logo/b_1" + tok, 403},
		{"GET null origin", "GET", goodHost, "null", "/logo/b_1" + tok, 403},
		{"GET origin on another port", "GET", goodHost, "http://127.0.0.1:8888", "/logo/b_1" + tok, 403},
		{"PUT no token", "PUT", goodHost, goodOrigin, "/logo/b_1", 403},
		{"PUT wrong token", "PUT", goodHost, goodOrigin, "/logo/b_1?token=x", 403},
		{"PUT wrong origin", "PUT", goodHost, "http://evil.example", "/logo/b_1" + tok, 403},
		{"PUT null origin", "PUT", goodHost, "null", "/logo/b_1" + tok, 403},
		{"PUT wrong host", "PUT", "evil.example:7777", goodOrigin, "/logo/b_1" + tok, 403},
		{"DELETE no token", "DELETE", goodHost, goodOrigin, "/logo/b_1", 403},
		{"DELETE wrong origin", "DELETE", goodHost, "http://evil.example", "/logo/b_1" + tok, 403},
		{"POST is not a logo method", "POST", goodHost, goodOrigin, "/logo/b_1" + tok, 405},
		{"PATCH is not a logo method", "PATCH", goodHost, goodOrigin, "/logo/b_1" + tok, 405},
		// Passed on.
		{"GET absent origin", "GET", goodHost, "", "/logo/b_1" + tok, 200},
		{"GET same origin", "GET", goodHost, goodOrigin, "/logo/b_1" + tok, 200},
		{"GET localhost", "GET", "localhost:7777", "http://localhost:7777", "/logo/b_1" + tok, 200},
		{"PUT same origin", "PUT", goodHost, goodOrigin, "/logo/b_1" + tok, 200},
		{"PUT absent origin with the token", "PUT", goodHost, "", "/logo/b_1" + tok, 200},
		{"DELETE same origin", "DELETE", goodHost, goodOrigin, "/logo/b_1" + tok, 200},
	}
	passed := 0
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.method == "PUT" {
				body = strings.NewReader("png bytes")
			}
			resp, _ := logoReq(t, ts, tc.method, tc.host, tc.origin, tc.path, body)
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
		})
		if tc.want == 200 {
			passed++
		}
	}
	if n := br.dials.Load(); n == 0 || len(echo.seen()) != passed {
		t.Fatalf("the bridge saw %d requests (%d dials), want %d: rejected requests reached it", len(echo.seen()), n, passed)
	}
}

// The token, Origin and Cookie stay in the helper; only the building id and
// the ?h= hash go on.
func TestLogoProxyStripsAndForwards(t *testing.T) {
	br, echo := startEchoBridge(t)
	ts := helperServer(t, br, nil)
	resp, body := logoReq(t, ts, "GET", "127.0.0.1:7777", "http://127.0.0.1:7777", "/logo/b_abc?h=deadbeef&token="+testToken+"&x=1", nil)
	if resp.StatusCode != 200 || body != `{"t":"ack"}` {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("the bridge's Cache-Control was lost: %v", resp.Header)
	}
	reqs := echo.seen()
	if len(reqs) != 1 {
		t.Fatalf("bridge saw %d requests", len(reqs))
	}
	r := reqs[0]
	if r.Method != "GET" || r.Path != "/logo/b_abc" || r.Query != "h=deadbeef" || r.Host != "herdr-world" {
		t.Fatalf("forwarded %+v", r)
	}
	for _, h := range []string{"Origin", "Cookie", "Authorization"} {
		if v := r.Header.Get(h); v != "" {
			t.Errorf("%s = %q was forwarded", h, v)
		}
	}
	if strings.Contains(r.Query, testToken) {
		t.Error("the token was forwarded")
	}
}

func TestLogoUploadLimit(t *testing.T) {
	br, echo := startEchoBridge(t)
	ts := helperServer(t, br, nil)
	const path = "/logo/b_1?token=" + testToken
	put := func(n int, chunked bool) (*http.Response, string) {
		var body io.Reader = strings.NewReader(strings.Repeat("x", n))
		if chunked {
			body = io.MultiReader(body)
		}
		return logoReq(t, ts, "PUT", "127.0.0.1:7777", "http://127.0.0.1:7777", path, body)
	}
	// Exactly the limit goes through, with all its bytes.
	if resp, _ := put(maxLogoUpload, false); resp.StatusCode != 200 {
		t.Fatalf("1 MiB: %d", resp.StatusCode)
	}
	if reqs := echo.seen(); len(reqs) != 1 || reqs[0].Bytes != maxLogoUpload {
		t.Fatalf("bridge got %+v", reqs)
	}
	// One byte more is refused before the bridge (Content-Length), and when
	// streamed (chunked) it is cut off, never truncated to 200.
	for _, chunked := range []bool{false, true} {
		resp, body := put(maxLogoUpload+1, chunked)
		var e struct{ Code string }
		if resp.StatusCode != 413 || json.Unmarshal([]byte(body), &e) != nil || e.Code != "logo_too_large" {
			t.Fatalf("chunked=%v: %d %q", chunked, resp.StatusCode, body)
		}
	}
	// A refused upload may have started at the bridge, but never as a success.
	for _, r := range echo.seen()[1:] {
		t.Logf("bridge saw a partial upload of %d bytes", r.Bytes)
	}
}

func TestLogoBridgeDownIs502(t *testing.T) {
	br := &socketBridge{sock: filepath.Join(shortDir(t), "missing.sock"), state: StateBackoff}
	ts := helperServer(t, br, nil)
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		var body io.Reader
		if method == "PUT" {
			body = strings.NewReader("x")
		}
		resp, text := logoReq(t, ts, method, "127.0.0.1:7777", "http://127.0.0.1:7777", "/logo/b_1?token="+testToken, body)
		if resp.StatusCode != http.StatusBadGateway || !strings.Contains(text, "tunnel backoff") {
			t.Fatalf("%s: %d %q", method, resp.StatusCode, text)
		}
	}
}

// The logo routes win over the site fallback, also with a Vite dev upstream.
func TestLogoRoutesBeatTheSite(t *testing.T) {
	br, echo := startEchoBridge(t)
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the dev server got %s %s", r.Method, r.URL)
	}))
	defer dev.Close()
	u, _ := parseURL(dev.URL)
	ts := helperServer(t, br, u)
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if resp, _ := logoReq(t, ts, method, "127.0.0.1:7777", "", "/logo/b_1?token="+testToken, strings.NewReader("")); resp.StatusCode != 200 {
			t.Fatalf("%s: %d", method, resp.StatusCode)
		}
	}
	if resp, _ := logoReq(t, ts, "POST", "127.0.0.1:7777", "", "/logo/b_1?token="+testToken, nil); resp.StatusCode != 405 {
		t.Fatalf("POST: %d", resp.StatusCode)
	}
	if len(echo.seen()) != 3 {
		t.Fatalf("bridge saw %d", len(echo.seen()))
	}
}

func parseURL(s string) (*url.URL, error) { return url.Parse(s) }

// The whole path with a real bridge: create a building over the protocol, set
// and fetch its logo through the helper, and see the hash in an event.
func TestLogoThroughTheHelperToARealBridge(t *testing.T) {
	sock := filepath.Join(shortDir(t), "run", "bridge.sock")
	startBridge(t, sock)
	ts := helperServer(t, &socketBridge{sock: sock}, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := proto.Dial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "logo-test"}); err != nil {
		t.Fatal(err)
	}
	if err := conn.Send(ctx, map[string]any{"t": proto.CmdBuildingCreate, "req_id": "1", "args": map[string]any{"name": "Work"}}); err != nil {
		t.Fatal(err)
	}
	var id string
	for id == "" {
		env, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if env.T == proto.TAck {
			var ack proto.Ack
			_ = json.Unmarshal(raw, &ack)
			id = ack.Data.(map[string]any)["id"].(string)
		}
	}

	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 30, 10))); err != nil {
		t.Fatal(err)
	}
	path := "/logo/" + id + "?token=" + testToken
	resp, body := logoReq(t, ts, "PUT", "127.0.0.1:7777", "http://127.0.0.1:7777", path, bytes.NewReader(pngBytes.Bytes()))
	if resp.StatusCode != 200 {
		t.Fatalf("PUT: %d %s", resp.StatusCode, body)
	}
	var ack struct{ Data struct{ Logo string } }
	if err := json.Unmarshal([]byte(body), &ack); err != nil || len(ack.Data.Logo) != 64 {
		t.Fatalf("PUT reply = %s", body)
	}
	// The event with the hash arrives on the WebSocket.
	for {
		env, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if env.T == proto.EvBuildingUpsert {
			var ev proto.Event
			_ = json.Unmarshal(raw, &ev)
			if ev.Building.Logo != ack.Data.Logo {
				t.Fatalf("event = %s", raw)
			}
			break
		}
	}
	resp, got := logoReq(t, ts, "GET", "127.0.0.1:7777", "", path+"&h="+ack.Data.Logo, nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || !strings.HasPrefix(got, "\x89PNG") ||
		resp.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("GET: %d %v", resp.StatusCode, resp.Header)
	}
	if resp, _ := logoReq(t, ts, "DELETE", "127.0.0.1:7777", "http://127.0.0.1:7777", path, nil); resp.StatusCode != 200 {
		t.Fatalf("DELETE: %d", resp.StatusCode)
	}
	if resp, _ := logoReq(t, ts, "GET", "127.0.0.1:7777", "", path, nil); resp.StatusCode != 404 {
		t.Fatalf("GET after DELETE: %d", resp.StatusCode)
	}
}
