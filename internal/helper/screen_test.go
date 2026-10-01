package helper

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestScreenFrameChecks(t *testing.T) {
	const (
		goodHost   = "127.0.0.1:7777"
		goodOrigin = "http://127.0.0.1:7777"
		id         = "0123456789abcdef0123456789abcdef"
		path       = "/screen/frame/" + id + "?token=" + testToken
	)
	br, cap := startCaptureBridge(t, 16)
	ts := helperServer(t, br, nil)
	jpg := []byte("\xFF\xD8\xFF\xE0fake")
	tests := []struct {
		name                       string
		method, host, origin, path string
		want                       int
	}{
		{"no token", "POST", goodHost, goodOrigin, "/screen/frame/" + id, 403},
		{"wrong token", "POST", goodHost, goodOrigin, "/screen/frame/" + id + "?token=" + strings.Repeat("0", len(testToken)), 403},
		{"wrong host", "POST", "evil.example:7777", goodOrigin, path, 403},
		{"wrong origin", "POST", goodHost, "http://evil.example", path, 403},
		{"GET", "GET", goodHost, goodOrigin, path, 405},
		{"PUT", "PUT", goodHost, goodOrigin, path, 405},
		{"another screen path", "POST", goodHost, goodOrigin, "/screen/other?token=" + testToken, 405},
		{"bad id", "POST", goodHost, goodOrigin, "/screen/frame/ABC?token=" + testToken, 400},
		{"POST with the token and the origin", "POST", goodHost, goodOrigin, path, 200},
		{"POST with the token, no origin", "POST", goodHost, "", path, 200},
	}
	passed := 0
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, text := uploadReq(t, ts, tc.method, tc.host, tc.origin, tc.path, bytes.NewReader(jpg))
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tc.want, text)
			}
			if tc.want == 403 && errCode(t, text) != "forbidden" {
				t.Fatalf("refusal %q", text)
			}
		})
		if tc.want == 200 {
			passed++
		}
	}
	seen := cap.seen()
	if len(seen) != passed {
		t.Fatalf("the bridge saw %d requests, want %d", len(seen), passed)
	}
	for _, r := range seen {
		if r.Path != "/screen/frame/"+id || r.Query != "" || r.Header.Get("Origin") != "" || !bytes.Equal(r.Kept, jpg) {
			t.Fatalf("forwarded %+v", r)
		}
	}
}

func TestScreenFrameTooLarge(t *testing.T) {
	br, cap := startCaptureBridge(t, 16)
	ts := helperServer(t, br, nil)
	path := "/screen/frame/0123456789abcdef0123456789abcdef?token=" + testToken
	resp, text := uploadReq(t, ts, "POST", "127.0.0.1:7777", "", path, bytes.NewReader(make([]byte, maxFrameBody+1)))
	if resp.StatusCode != http.StatusRequestEntityTooLarge || errCode(t, text) != "frame_too_large" {
		t.Fatalf("oversize: %d %s", resp.StatusCode, text)
	}
	// Streamed without a length: counted, never truncated.
	resp, text = uploadReq(t, ts, "POST", "127.0.0.1:7777", "", path, io.MultiReader(bytes.NewReader(make([]byte, maxFrameBody)), strings.NewReader("x")))
	if resp.StatusCode != http.StatusRequestEntityTooLarge || errCode(t, text) != "frame_too_large" {
		t.Fatalf("streamed oversize: %d %s", resp.StatusCode, text)
	}
	for _, r := range cap.seen() {
		if r.Total > maxFrameBody {
			t.Fatalf("the bridge got %d bytes", r.Total)
		}
	}
}
