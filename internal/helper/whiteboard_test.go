package helper

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// M13: the whiteboard's routes and a drop's bytes reach the bridge only with
// the token (and the helper's own Origin when one is sent), with only their
// own query parameters; the agents' pin route and anything else under
// /whiteboard/ or /drops/ never does.
func TestWhiteboardRoutes(t *testing.T) {
	const (
		host   = "127.0.0.1:7777"
		origin = "http://127.0.0.1:7777"
		tok    = "token=" + testToken
	)
	br, cap := startCaptureBridge(t, 64)
	ts := helperServer(t, br, nil)
	id := strings.Repeat("ab", 32)
	tests := []struct {
		name, method, origin, path string
		want                       int
		path2, query               string // what the bridge sees
	}{
		{"board", "GET", "", "/whiteboard/herdr-3d?version=3&x=1&" + tok, 200, "/whiteboard/herdr-3d", "version=3"},
		{"save", "POST", origin, "/whiteboard/herdr-3d/save?base=4&author=You&" + tok, 200, "/whiteboard/herdr-3d/save", "author=You&base=4"},
		{"render", "GET", "", "/whiteboard/herdr-3d/render.png?v=4&" + tok, 200, "/whiteboard/herdr-3d/render.png", "v=4"},
		{"file get", "GET", "", "/whiteboard/herdr-3d/files/" + id + "?" + tok, 200, "/whiteboard/herdr-3d/files/" + id, ""},
		{"file put", "PUT", origin, "/whiteboard/herdr-3d/files/" + id + "?" + tok, 200, "/whiteboard/herdr-3d/files/" + id, ""},
		{"drop", "GET", "", "/drops/file?path=%2Fhome%2Fx%2Fdrops%2Fa.png&thumb=1&" + tok, 200, "/drops/file", "path=%2Fhome%2Fx%2Fdrops%2Fa.png&thumb=1"},
		{"no token", "GET", "", "/whiteboard/herdr-3d", 403, "", ""},
		{"wrong origin", "POST", "http://evil.example", "/whiteboard/herdr-3d/save?base=1&" + tok, 403, "", ""},
		{"agents' pin", "POST", origin, "/whiteboard/herdr-3d/pin?author=x&" + tok, 404, "", ""},
		{"unknown route", "GET", "", "/whiteboard/herdr-3d/v/1.json?" + tok, 404, "", ""},
		{"delete a board", "DELETE", origin, "/whiteboard/herdr-3d?" + tok, 404, "", ""},
		{"other drops route", "GET", "", "/drops/list?" + tok, 404, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before := len(cap.seen())
			var body io.Reader
			if tc.method != "GET" {
				body = bytes.NewReader([]byte("body"))
			}
			resp, text := uploadReq(t, ts, tc.method, host, tc.origin, tc.path, body)
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d, want %d: %s", resp.StatusCode, tc.want, text)
			}
			seen := cap.seen()
			if tc.want != 200 {
				if len(seen) != before {
					t.Fatalf("a refused request reached the bridge: %+v", seen[len(seen)-1])
				}
				if errCode(t, text) == "" {
					t.Fatal("no code")
				}
				return
			}
			r := seen[len(seen)-1]
			if r.Path != tc.path2 || r.Query != tc.query || r.Host != "herdr-world" || r.Method != tc.method {
				t.Fatalf("forwarded %+v", r)
			}
			if r.Header.Get("Origin") != "" || strings.Contains(r.Query, testToken) {
				t.Fatalf("forwarded the origin or the token: %+v", r)
			}
		})
	}
}

func TestWhiteboardBodyLimits(t *testing.T) {
	br, cap := startCaptureBridge(t, 16)
	ts := helperServer(t, br, nil)
	id := strings.Repeat("cd", 32)
	resp, text := uploadReq(t, ts, "PUT", "127.0.0.1:7777", "", "/whiteboard/f/files/"+id+"?token="+testToken, &fill{n: maxWhiteboardFile + 1})
	if resp.StatusCode != 413 || errCode(t, text) != "whiteboard_too_large" {
		t.Fatalf("oversize file: %d %s", resp.StatusCode, text)
	}
	resp, _ = uploadReq(t, ts, "PUT", "127.0.0.1:7777", "", "/whiteboard/f/files/"+id+"?token="+testToken, bytes.NewReader(make([]byte, maxWhiteboardFile)))
	if resp.StatusCode != 200 {
		t.Fatalf("file at the cap: %d", resp.StatusCode)
	}
	// A streamed oversize body is cut off at the cap (the bridge may see its
	// start, then an error, never more); the one at the cap arrives whole.
	seen := cap.seen()
	if last := seen[len(seen)-1]; last.Total != maxWhiteboardFile || last.Header.Get("Content-Length") == "" {
		t.Fatalf("bridge saw %+v", last)
	}
	for _, r := range seen {
		if r.Total > maxWhiteboardFile {
			t.Fatalf("the bridge got %d bytes", r.Total)
		}
	}
}
