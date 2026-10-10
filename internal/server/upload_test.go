package server_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/upload"
)

// dropZone is a stand-in for Drop Zone: it reads the multipart request the way
// the real one does and answers a path only when the body ended properly.
type dropZone struct {
	srv *httptest.Server
	mu  sync.Mutex
	got []dzUpload
}

type dzUpload struct {
	name, filename string
	body           []byte
	complete       bool
}

func startDropZone(t *testing.T) *dropZone {
	t.Helper()
	d := &dropZone{}
	d.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		var u dzUpload
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				u.complete = true
				break
			}
			if err != nil {
				break
			}
			b, _ := io.ReadAll(p)
			if p.FormName() == "name" {
				u.name = string(b)
			} else {
				u.filename, u.body = p.FileName(), b
			}
		}
		_, _ = io.Copy(io.Discard, r.Body)
		d.mu.Lock()
		d.got = append(d.got, u)
		d.mu.Unlock()
		if !u.complete {
			http.Error(w, "malformed multipart request", http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, "/home/dev/drops/2026-09/%s\n", u.filename)
	}))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *dropZone) uploads() []dzUpload {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]dzUpload(nil), d.got...)
}

func (d *dropZone) committed() int {
	n := 0
	for _, u := range d.uploads() {
		if u.complete {
			n++
		}
	}
	return n
}

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

func uploadBridge(t *testing.T, dropzoneURL string) *bridge {
	t.Helper()
	svc, err := upload.New(upload.Config{URL: dropzoneURL})
	if err != nil {
		t.Fatal(err)
	}
	return startBridgeWith(t, "", server.Options{}, func(s *server.Server) { s.SetUploader(svc) })
}

func (b *bridge) upload(method, query string, body io.Reader) (int, []byte, http.Header) {
	b.t.Helper()
	req, err := http.NewRequest(method, "http://bridge/upload"+query, body)
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

// rawUpload writes a hand-made request on the socket, for a Content-Length
// that lies, and reads the status and body of the answer.
func (b *bridge) rawUpload(head string, body []byte, closeWrite bool) (int, []byte) {
	b.t.Helper()
	c, err := net.Dial("unix", b.sock)
	if err != nil {
		b.t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write(append([]byte(head+"\r\n\r\n"), body...)); err != nil {
		b.t.Fatal(err)
	}
	if closeWrite {
		_ = c.(*net.UnixConn).CloseWrite()
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

func TestUploadEndToEnd(t *testing.T) {
	t.Parallel()
	dz := startDropZone(t)
	b := uploadBridge(t, dz.srv.URL)
	img := append(append([]byte{}, pngMagic...), []byte("PIXELS-that-must-never-be-logged")...)

	st, body, hd := b.upload("POST", "?label=Sunny%20Otter&n=2", bytes.NewReader(img))
	if st != 200 {
		t.Fatalf("status %d: %s", st, body)
	}
	if hd.Get("Content-Type") != "application/json" || hd.Get("Cache-Control") != "no-store" {
		t.Errorf("headers: %v", hd)
	}
	var ack struct {
		T    string
		Data struct {
			Path, Mime string
			Size       int
		}
	}
	if err := json.Unmarshal(body, &ack); err != nil {
		t.Fatal(err, string(body))
	}
	want := "/home/dev/drops/2026-09/h3d-sunny-otter-2.png"
	if ack.Data.Path != want || ack.Data.Mime != "image/png" || ack.Data.Size != len(img) {
		t.Fatalf("answer = %s", body)
	}
	got := dz.uploads()
	if len(got) != 1 || got[0].name != "h3d-sunny-otter-2" || !bytes.Equal(got[0].body, img) || !got[0].complete {
		t.Fatalf("Drop Zone saw %+v", got)
	}

	// The audit log has the numbers and the outcome, never the image or the path.
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 1 || log[0].Cmd != "image.upload" || !log[0].OK || log[0].Client != "http" {
		t.Fatalf("audit = %+v", log)
	}
	row := fmt.Sprintf("%+v", log[0])
	for _, leak := range []string{"PIXELS", "must-never", "drops", "89504e47", "iVBOR"} {
		if strings.Contains(row, leak) {
			t.Errorf("audit row leaks %q: %s", leak, row)
		}
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(log[0].Args), &args); err != nil || args["label"] != "Sunny Otter" || args["n"] != float64(2) || args["mime"] != "image/png" || args["size"] != float64(len(img)) {
		t.Errorf("audit args = %s", log[0].Args)
	}
}

func TestUploadDoesNotTrustTheClientsType(t *testing.T) {
	t.Parallel()
	dz := startDropZone(t)
	b := uploadBridge(t, dz.srv.URL)
	req, _ := http.NewRequest("POST", "http://bridge/upload?n=1", bytes.NewReader(append(pngMagic, 1, 2, 3)))
	req.Header.Set("Content-Type", "text/html")
	resp, err := b.http().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("a PNG labelled text/html: %d", resp.StatusCode)
	}
	req, _ = http.NewRequest("POST", "http://bridge/upload?n=2", strings.NewReader("<svg xmlns='http://www.w3.org/2000/svg'/>"))
	req.Header.Set("Content-Type", "image/png")
	resp, err = b.http().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 415 {
		t.Fatalf("an SVG labelled image/png: %d", resp.StatusCode)
	}
}

func TestUploadRefusals(t *testing.T) {
	t.Parallel()
	dz := startDropZone(t)
	b := uploadBridge(t, dz.srv.URL)
	png := func() io.Reader { return bytes.NewReader(append(append([]byte{}, pngMagic...), 1, 2, 3)) }

	for _, tc := range []struct {
		name   string
		query  string
		body   io.Reader
		status int
		code   string
	}{
		{"empty body", "?n=1", strings.NewReader(""), 400, "bad_request"},
		{"no n", "", png(), 400, "bad_request"},
		{"n is zero", "?n=0", png(), 400, "bad_request"},
		{"n is negative", "?n=-3", png(), 400, "bad_request"},
		{"n is not a number", "?n=abc", png(), 400, "bad_request"},
		{"n is huge", "?n=999999999999999999999", png(), 400, "bad_request"},
		{"svg", "?n=1", strings.NewReader(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 415, "upload_unsupported"},
		{"html", "?n=1", strings.NewReader("<html><script>1</script></html>"), 415, "upload_unsupported"},
		{"octet stream", "?n=1", bytes.NewReader([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9}), 415, "upload_unsupported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, body, _ := b.upload("POST", tc.query, tc.body)
			if st != tc.status || logoErrCode(t, body) != tc.code {
				t.Fatalf("status %d: %s", st, body)
			}
			var e proto.Error
			_ = json.Unmarshal(body, &e)
			if e.Message == "" {
				t.Fatal("no friendly message")
			}
		})
	}
	if n := len(dz.uploads()); n != 0 {
		t.Fatalf("%d refused uploads reached Drop Zone", n)
	}

	// The refusals are audited too, as failures.
	log, _ := b.st.AuditLog(context.Background())
	if len(log) != 9 {
		t.Fatalf("audit rows = %d, want 9", len(log))
	}
	for _, e := range log {
		if e.OK || e.Cmd != "image.upload" || e.Error == "" {
			t.Fatalf("audit row = %+v", e)
		}
	}

	// Other methods are refused by the router.
	for _, m := range []string{"GET", "PUT", "DELETE", "PATCH"} {
		if st, _, hd := b.upload(m, "?n=1", nil); st != 405 || !strings.Contains(hd.Get("Allow"), "POST") {
			t.Errorf("%s /upload: %d (Allow %q)", m, st, hd.Get("Allow"))
		}
	}
}

// pattern is an image of n bytes that has no Content-Length: the client sends it chunked.
type pattern struct{ n, i int }

func (p *pattern) Read(b []byte) (int, error) {
	if p.i >= p.n {
		return 0, io.EOF
	}
	if len(b) > p.n-p.i {
		b = b[:p.n-p.i]
	}
	for k := range b {
		if p.i+k < len(pngMagic) {
			b[k] = pngMagic[p.i+k]
		} else {
			b[k] = 'x'
		}
	}
	p.i += len(b)
	return len(b), nil
}

func TestUploadSizeCap(t *testing.T) {
	t.Parallel()
	dz := startDropZone(t)
	b := uploadBridge(t, dz.srv.URL)

	t.Run("exactly the cap, no Content-Length", func(t *testing.T) {
		st, body, _ := b.upload("POST", "?n=1", &pattern{n: upload.MaxBytes})
		if st != 200 {
			t.Fatalf("status %d: %s", st, body)
		}
		if u := dz.uploads(); len(u) != 1 || len(u[0].body) != upload.MaxBytes || !u[0].complete {
			t.Fatalf("Drop Zone got %d uploads", len(u))
		}
	})
	before := len(dz.uploads())
	t.Run("one byte over, no Content-Length", func(t *testing.T) {
		st, body, _ := b.upload("POST", "?n=1", &pattern{n: upload.MaxBytes + 1})
		if st != 413 || logoErrCode(t, body) != "upload_too_large" {
			t.Fatalf("status %d: %s", st, body)
		}
	})
	t.Run("declared over the cap", func(t *testing.T) {
		st, body := b.rawUpload(fmt.Sprintf("POST /upload?n=1 HTTP/1.1\r\nHost: bridge\r\nContent-Length: %d\r\nConnection: close", upload.MaxBytes+1), pngMagic, true)
		if st != 413 || logoErrCode(t, body) != "upload_too_large" {
			t.Fatalf("status %d: %s", st, body)
		}
	})
	t.Run("declared small, sent big", func(t *testing.T) {
		// The server reads what it was promised and no more: an honest 8 bytes.
		st, body := b.rawUpload("POST /upload?n=1 HTTP/1.1\r\nHost: bridge\r\nContent-Length: 8\r\nConnection: close", append(append([]byte{}, pngMagic...), bytes.Repeat([]byte("y"), 4096)...), false)
		if st != 200 {
			t.Fatalf("status %d: %s", st, body)
		}
	})
	t.Run("declared big, cut short", func(t *testing.T) {
		st, body := b.rawUpload("POST /upload?n=1 HTTP/1.1\r\nHost: bridge\r\nContent-Length: 10000000\r\nConnection: close", append(append([]byte{}, pngMagic...), bytes.Repeat([]byte("y"), 4096)...), true)
		if st != 400 || logoErrCode(t, body) != "bad_request" {
			t.Fatalf("status %d: %s", st, body)
		}
	})
	// Of all of those, one (the 8-byte one) was stored, and nothing was stored twice or half.
	for i, u := range dz.uploads()[before:] {
		if u.complete && len(u.body) != 8 {
			t.Errorf("upload %d: a %d-byte image was committed", i, len(u.body))
		}
	}
	if n := dz.committed(); n != 2 {
		t.Fatalf("committed = %d, want 2 (the cap-sized one and the 8-byte one)", n)
	}
}

func TestUploadDropZoneDown(t *testing.T) {
	t.Parallel()
	dz := startDropZone(t)
	b := uploadBridge(t, dz.srv.URL)
	dz.srv.Close()
	st, body, _ := b.upload("POST", "?n=1", bytes.NewReader(append(pngMagic, 1)))
	if st != 502 || logoErrCode(t, body) != "dropzone_unavailable" {
		t.Fatalf("status %d: %s", st, body)
	}
	var e proto.Error
	_ = json.Unmarshal(body, &e)
	if !strings.Contains(e.Message, "Drop Zone") || strings.Contains(e.Message, "127.0.0.1") || strings.Contains(e.Message, "refused") {
		t.Errorf("message = %q: friendly, and no upstream address or Go error text", e.Message)
	}
}

func TestUploadWithoutADropZone(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	st, body, _ := b.upload("POST", "?n=1", bytes.NewReader(append(pngMagic, 1)))
	if st != 502 || logoErrCode(t, body) != "dropzone_unavailable" {
		t.Fatalf("status %d: %s", st, body)
	}
}

// fakeUploader answers what it is told.
type fakeUploader struct {
	res upload.Result
	err error
}

func (f fakeUploader) Upload(_ context.Context, _ upload.Meta, src io.Reader) (upload.Result, error) {
	_, _ = io.Copy(io.Discard, src)
	return f.res, f.err
}

func TestUploadErrorMapping(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{upload.ErrBusy, 429, "upload_busy"},
		{upload.ErrTimeout, 504, "upload_timeout"},
		{upload.ErrDropZoneResponse, 502, "dropzone_bad_response"},
		{upload.ErrDropZoneDown, 502, "dropzone_unavailable"},
		{fmt.Errorf("wrapped: %w", upload.ErrTooLarge), 413, "upload_too_large"},
		{errors.New("something else, with /secret/paths"), 500, "internal"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			b := startBridgeWith(t, "", server.Options{}, func(s *server.Server) { s.SetUploader(fakeUploader{err: tc.err}) })
			st, body, hd := b.upload("POST", "?n=1", bytes.NewReader(pngMagic))
			if st != tc.status || logoErrCode(t, body) != tc.code {
				t.Fatalf("status %d: %s", st, body)
			}
			if strings.Contains(string(body), "secret") {
				t.Fatalf("an internal error leaked: %s", body)
			}
			if (tc.status == 429) != (hd.Get("Retry-After") != "") {
				t.Errorf("Retry-After = %q", hd.Get("Retry-After"))
			}
		})
	}
}
