package helper

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/upload"
)

// captureBridge records what reaches the bridge's /upload, body included, and
// answers the bridge's ack.
type captureBridge struct {
	mu   sync.Mutex
	reqs []capturedUpload
}

type capturedUpload struct {
	Method, Path, Query, Host string
	Header                    http.Header
	Kept                      []byte // the first bytes of the body
	Total                     int64  // its whole length
}

func (c *captureBridge) seen() []capturedUpload {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]capturedUpload(nil), c.reqs...)
}

func startCaptureBridge(t *testing.T, keep int) (*socketBridge, *captureBridge) {
	t.Helper()
	sock := filepath.Join(shortDir(t), "capture.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c := &captureBridge{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		n, _ := io.Copy(&buf, io.LimitReader(r.Body, int64(keep)))
		rest, _ := io.Copy(io.Discard, r.Body)
		c.mu.Lock()
		c.reqs = append(c.reqs, capturedUpload{r.Method, r.URL.Path, r.URL.RawQuery, r.Host, r.Header.Clone(), buf.Bytes(), n + rest})
		c.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"t":"ack","data":{"path":"/d/x.png","mime":"image/png","size":1}}`))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return &socketBridge{sock: sock}, c
}

func uploadReq(t *testing.T, ts *httptest.Server, method, host, origin, path string, body io.Reader) (*http.Response, []byte) {
	t.Helper()
	resp, text := logoReq(t, ts, method, host, origin, path, body)
	return resp, []byte(text)
}

func errCode(t *testing.T, body []byte) string {
	t.Helper()
	var e struct{ T, Code, Message string }
	if err := json.Unmarshal(body, &e); err != nil || e.T != "error" || e.Message == "" {
		t.Fatalf("not an error object: %q", body)
	}
	return e.Code
}

func TestUploadChecks(t *testing.T) {
	const (
		goodHost   = "127.0.0.1:7777"
		goodOrigin = "http://127.0.0.1:7777"
		tok        = "&token=" + testToken
		q          = "/upload?n=1"
	)
	br, cap := startCaptureBridge(t, 64)
	ts := helperServer(t, br, nil)
	png := []byte("\x89PNG\r\n\x1a\nxyz")

	tests := []struct {
		name                       string
		method, host, origin, path string
		want                       int
	}{
		{"no token", "POST", goodHost, goodOrigin, q, 403},
		{"empty token", "POST", goodHost, goodOrigin, q + "&token=", 403},
		{"wrong token", "POST", goodHost, goodOrigin, q + "&token=" + strings.Repeat("0", len(testToken)), 403},
		{"token prefix", "POST", goodHost, goodOrigin, q + "&token=" + testToken[:8], 403},
		{"token in another param", "POST", goodHost, goodOrigin, q + "&t=" + testToken, 403},
		{"wrong host", "POST", "evil.example:7777", goodOrigin, q + tok, 403},
		{"rebound host", "POST", "attacker.example", goodOrigin, q + tok, 403},
		{"rebound host, no token", "POST", "attacker.example", "", q, 403},
		{"wrong origin", "POST", goodHost, "http://evil.example", q + tok, 403},
		{"null origin", "POST", goodHost, "null", q + tok, 403},
		{"origin on another port", "POST", goodHost, "http://127.0.0.1:8888", q + tok, 403},
		{"GET is not an upload method", "GET", goodHost, goodOrigin, q + tok, 405},
		{"PUT", "PUT", goodHost, goodOrigin, q + tok, 405},
		{"DELETE", "DELETE", goodHost, goodOrigin, q + tok, 405},
		{"PATCH", "PATCH", goodHost, goodOrigin, q + tok, 405},
		{"POST with the token and the origin", "POST", goodHost, goodOrigin, q + tok, 200},
		{"POST with the token, no origin (curl)", "POST", goodHost, "", q + tok, 200},
		{"POST on localhost", "POST", "localhost:7777", "http://localhost:7777", q + tok, 200},
	}
	passed := 0
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.method == "POST" || tc.method == "PUT" {
				body = bytes.NewReader(png)
			}
			resp, text := uploadReq(t, ts, tc.method, tc.host, tc.origin, tc.path, body)
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			switch tc.want {
			case 403:
				if ct := resp.Header.Get("Content-Type"); ct != "application/json" || errCode(t, text) != "forbidden" {
					t.Fatalf("a refusal is the protocol's error object: %s %q", ct, text)
				}
			case 405:
				if resp.Header.Get("Allow") != "POST" {
					t.Fatalf("Allow = %q", resp.Header.Get("Allow"))
				}
			}
		})
		if tc.want == 200 {
			passed++
		}
	}
	if n := len(cap.seen()); n != passed {
		t.Fatalf("the bridge saw %d requests, want %d: a refused one reached it", n, passed)
	}
}

// The body arrives whole; the token, Origin and Cookie stay in the helper and
// only ?label= and ?n= go on.
func TestUploadProxyForwardsBodyAndStrips(t *testing.T) {
	br, cap := startCaptureBridge(t, 1<<20)
	ts := helperServer(t, br, nil)
	img := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte("pixels"), 1000)...)

	req, _ := http.NewRequest("POST", ts.URL+"/upload?label=sunny-otter&n=4&x=1&token="+testToken+"&label=second", bytes.NewReader(img))
	req.Host = "127.0.0.1:7777"
	req.Header.Set("Origin", "http://127.0.0.1:7777")
	req.Header.Set("Cookie", "session=secret")
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Content-Type", "image/png")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"path":"/d/x.png"`) {
		t.Fatalf("response = %d %s", resp.StatusCode, body)
	}
	reqs := cap.seen()
	if len(reqs) != 1 {
		t.Fatalf("bridge saw %d requests", len(reqs))
	}
	r := reqs[0]
	if r.Method != "POST" || r.Path != "/upload" || r.Query != "label=sunny-otter&n=4" || r.Host != "herdr-world" {
		t.Fatalf("forwarded %+v", r)
	}
	if r.Total != int64(len(img)) || !bytes.HasPrefix(img, r.Kept) {
		t.Fatalf("the bridge got %d bytes, want %d", r.Total, len(img))
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

func TestUploadBodyLimit(t *testing.T) {
	br, cap := startCaptureBridge(t, 16)
	ts := helperServer(t, br, nil)
	const path = "/upload?n=1&token=" + testToken
	post := func(n int, chunked bool) (*http.Response, []byte) {
		var body io.Reader = &fill{n: n}
		if !chunked {
			body = bytes.NewReader(bytes.Repeat([]byte("x"), n))
		}
		return uploadReq(t, ts, "POST", "127.0.0.1:7777", "http://127.0.0.1:7777", path, body)
	}

	// The cap itself, and the slack after it, go to the bridge, which decides
	// exactly; with unknown length too.
	for _, tc := range []struct {
		n       int
		chunked bool
	}{{upload.MaxBytes, false}, {upload.MaxBytes, true}, {upload.MaxBytes + 1, true}, {maxUploadBody, true}} {
		before := len(cap.seen())
		resp, body := post(tc.n, tc.chunked)
		if resp.StatusCode != 200 {
			t.Fatalf("%d bytes (chunked %v): %d %s", tc.n, tc.chunked, resp.StatusCode, body)
		}
		reqs := cap.seen()
		if len(reqs) != before+1 || reqs[before].Total != int64(tc.n) {
			t.Fatalf("%d bytes: the bridge got %d", tc.n, reqs[before].Total)
		}
	}

	// Past the slack it is refused: by Content-Length before the bridge, or,
	// unknown length, cut off while streaming. Never a truncated success.
	before := len(cap.seen())
	resp, body := post(maxUploadBody+1, false)
	if resp.StatusCode != 413 || errCode(t, body) != "upload_too_large" {
		t.Fatalf("declared: %d %s", resp.StatusCode, body)
	}
	if n := len(cap.seen()); n != before {
		t.Fatalf("a body declared over the limit reached the bridge")
	}
	resp, body = post(maxUploadBody+1, true)
	if resp.StatusCode != 413 || errCode(t, body) != "upload_too_large" {
		t.Fatalf("chunked: %d %s", resp.StatusCode, body)
	}
	for _, r := range cap.seen()[before:] {
		if r.Total > maxUploadBody {
			t.Fatalf("the bridge was handed %d bytes, over the limit", r.Total)
		}
	}
}

// fill is n bytes without a length: a chunked upload.
type fill struct{ n, i int }

func (f *fill) Read(b []byte) (int, error) {
	if f.i >= f.n {
		return 0, io.EOF
	}
	if len(b) > f.n-f.i {
		b = b[:f.n-f.i]
	}
	for k := range b {
		b[k] = 'x'
	}
	f.i += len(b)
	return len(b), nil
}

func TestUploadBridgeDownIs502(t *testing.T) {
	br := &socketBridge{sock: filepath.Join(shortDir(t), "missing.sock"), state: StateBackoff}
	ts := helperServer(t, br, nil)
	resp, body := uploadReq(t, ts, "POST", "127.0.0.1:7777", "http://127.0.0.1:7777", "/upload?n=1&token="+testToken, strings.NewReader("x"))
	if resp.StatusCode != http.StatusBadGateway || errCode(t, body) != "bridge_unreachable" || !strings.Contains(string(body), "tunnel backoff") {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
}

// The route wins over the site fallback, also with a Vite dev upstream, and a
// wrong method never falls through to the game.
func TestUploadRouteBeatsTheSite(t *testing.T) {
	br, cap := startCaptureBridge(t, 16)
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the dev server got %s %s", r.Method, r.URL)
	}))
	defer dev.Close()
	u, _ := parseURL(dev.URL)
	ts := helperServer(t, br, u)
	if resp, _ := uploadReq(t, ts, "POST", "127.0.0.1:7777", "", "/upload?n=1&token="+testToken, strings.NewReader("x")); resp.StatusCode != 200 {
		t.Fatalf("POST: %d", resp.StatusCode)
	}
	if resp, _ := uploadReq(t, ts, "GET", "127.0.0.1:7777", "", "/upload", nil); resp.StatusCode != 405 {
		t.Fatalf("GET: %d", resp.StatusCode)
	}
	if len(cap.seen()) != 1 {
		t.Fatalf("bridge saw %d", len(cap.seen()))
	}
}
