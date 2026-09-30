package upload_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/upload"
)

// dzReq is what the fake Drop Zone saw of one request.
type dzReq struct {
	order     []string // form names in wire order
	name      string
	filename  string
	ctype     string // the file part's Content-Type
	sum       [sha256.Size]byte
	size      int64
	complete  bool // the multipart body ended properly: a real Drop Zone stores the file
	mediaType string
}

// fakeDZ follows Drop Zone's handler: it parses the multipart stream and
// commits (answers with a path) only when the stream ends cleanly.
type fakeDZ struct {
	srv      *httptest.Server
	mu       sync.Mutex
	reqs     []dzReq
	Answer   string        // body of the 200 (default: a path and its LF)
	Status   int           // 0: 200
	Early    bool          // answer without reading the body
	Delay    time.Duration // wait before answering (until the request ends)
	Gate     chan struct{} // if set: the handler waits for it before reading
	Held     atomic.Int32  // requests waiting at the gate
	Redirect string
}

func newDZ(t *testing.T) *fakeDZ {
	t.Helper()
	d := &fakeDZ{Answer: "/home/dev/drops/2026-09/h3d-hire-1.png\n"}
	d.srv = httptest.NewServer(http.HandlerFunc(d.handle))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *fakeDZ) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/upload" {
		http.Error(w, "no", http.StatusNotFound)
		return
	}
	if d.Redirect != "" {
		http.Redirect(w, r, d.Redirect, http.StatusFound)
		return
	}
	if d.Gate != nil {
		d.Held.Add(1)
		select {
		case <-d.Gate:
		case <-r.Context().Done():
			return
		}
	}
	if d.Early {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(d.Answer))
		return
	}
	rq := dzReq{}
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	rq.mediaType = r.Header.Get("Content-Type")
	h := sha256.New()
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			rq.complete = true
			break
		}
		if err != nil {
			break
		}
		rq.order = append(rq.order, p.FormName())
		switch p.FormName() {
		case "name":
			b, _ := io.ReadAll(p)
			rq.name = string(b)
		case "file":
			rq.filename = p.FileName()
			rq.ctype = p.Header.Get("Content-Type")
			n, _ := io.Copy(h, p)
			rq.size = n
		}
	}
	_, _ = io.Copy(io.Discard, r.Body) // to the end of the chunked body: only then does the server watch the connection
	copy(rq.sum[:], h.Sum(nil))
	d.mu.Lock()
	d.reqs = append(d.reqs, rq)
	d.mu.Unlock()
	if !rq.complete {
		http.Error(w, "malformed multipart request", http.StatusBadRequest)
		return
	}
	if d.Delay > 0 {
		select {
		case <-time.After(d.Delay):
		case <-r.Context().Done():
			return
		}
	}
	if d.Status != 0 {
		http.Error(w, "storage error", d.Status)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(d.Answer))
}

func (d *fakeDZ) seen() []dzReq {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]dzReq(nil), d.reqs...)
}

// committed counts the requests a real Drop Zone would have stored.
func (d *fakeDZ) committed() int {
	n := 0
	for _, r := range d.seen() {
		if r.complete {
			n++
		}
	}
	return n
}

func service(t *testing.T, url string, mod ...func(*upload.Config)) *upload.Service {
	t.Helper()
	cfg := upload.Config{URL: url, Client: &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}}
	for _, m := range mod {
		m(&cfg)
	}
	s, err := upload.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var (
	pngHead  = []byte("\x89PNG\r\n\x1a\n")
	jpegHead = []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00")
	gifHead  = []byte("GIF89a")
	webpHead = []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")
)

func image(head []byte, n int) []byte {
	b := make([]byte, n)
	copy(b, head)
	for i := len(head); i < n; i++ {
		b[i] = byte(i * 7)
	}
	return b
}

// gen is an image of n bytes that is never held in memory.
type gen struct {
	head []byte
	n, i int64
}

func (g *gen) Read(p []byte) (int, error) {
	if g.i >= g.n {
		return 0, io.EOF
	}
	if int64(len(p)) > g.n-g.i {
		p = p[:g.n-g.i]
	}
	n := 0
	if g.i < int64(len(g.head)) {
		n = copy(p, g.head[g.i:])
	}
	for i := n; i < len(p); i += n {
		n = copy(p[i:], filler)
		if n == 0 {
			break
		}
	}
	g.i += int64(len(p))
	return len(p), nil
}

var filler = bytes.Repeat([]byte{'x'}, 32<<10)

func wantCode(t *testing.T, err error, want *upload.Error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want code %s", err, want.Code)
	}
	var ue *upload.Error
	if !errors.As(err, &ue) || ue.Message == "" {
		t.Fatalf("error %v has no friendly message", err)
	}
}

// noLeak fails if goroutines stay behind: the count is taken before, and
// polled back down after (the HTTP machinery needs a moment to wind up).
func noLeak(t *testing.T) func() {
	t.Helper()
	before := runtime.NumGoroutine()
	return func() {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			http.DefaultTransport.(*http.Transport).CloseIdleConnections()
			if n := runtime.NumGoroutine(); n <= before {
				return
			}
			if time.Now().After(deadline) {
				buf := make([]byte, 1<<16)
				buf = buf[:runtime.Stack(buf, true)]
				t.Fatalf("goroutines: %d before, %d after\n%s", before, runtime.NumGoroutine(), buf)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

func TestUploadWire(t *testing.T) {
	dz := newDZ(t)
	s := service(t, dz.srv.URL)
	img := image(pngHead, 5000)
	res, err := s.Upload(context.Background(), upload.Meta{Label: "Sunny Otter", N: 3}, bytes.NewReader(img))
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "/home/dev/drops/2026-09/h3d-hire-1.png" || res.Mime != "image/png" || res.Size != 5000 {
		t.Fatalf("result = %+v", res)
	}
	reqs := dz.seen()
	if len(reqs) != 1 {
		t.Fatalf("%d upstream requests, want 1", len(reqs))
	}
	r := reqs[0]
	if strings.Join(r.order, ",") != "name,file" {
		t.Errorf("wire order = %v, want name then exactly one file", r.order)
	}
	if r.name != "h3d-sunny-otter-3" || r.filename != "h3d-sunny-otter-3.png" || r.ctype != "image/png" {
		t.Errorf("name %q, filename %q, content type %q", r.name, r.filename, r.ctype)
	}
	if r.sum != sha256.Sum256(img) || r.size != 5000 || !r.complete {
		t.Errorf("bytes changed on the way: size %d complete %v", r.size, r.complete)
	}
	if !strings.HasPrefix(r.mediaType, "multipart/form-data; boundary=") {
		t.Errorf("Content-Type %q", r.mediaType)
	}
}

func TestUploadPathIsVerbatim(t *testing.T) {
	for _, tc := range []struct{ name, answer, want string }{
		{"plain", "/home/dev/drops/2026-09/h3d-hire-1.png\n", "/home/dev/drops/2026-09/h3d-hire-1.png"},
		{"spaces and unicode", "/home/jéff müller/My Drops/2026-09/h3d-hire-1 é.png\n", "/home/jéff müller/My Drops/2026-09/h3d-hire-1 é.png"},
		{"collision suffix", "/d/2026-09/h3d-hire-1-2.png\n", "/d/2026-09/h3d-hire-1-2.png"},
		{"no framing LF", "/d/a.png", "/d/a.png"},
		{"trailing space is part of the path", "/d/a.png \n", "/d/a.png "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dz := newDZ(t)
			dz.Answer = tc.answer
			res, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
			if err != nil || res.Path != tc.want {
				t.Fatalf("path = %q, %v; want %q", res.Path, err, tc.want)
			}
		})
	}
}

func TestUploadBadPaths(t *testing.T) {
	for _, tc := range []struct{ name, answer string }{
		{"empty", ""},
		{"only the LF", "\n"},
		{"relative", "drops/a.png\n"},
		{"multi-line", "/d/a.png\n/d/b.png\n"},
		{"two LFs", "/d/a.png\n\n"},
		{"CRLF", "/d/a.png\r\n"},
		{"closing bracket", "/d/a]b.png\n"},
		{"NUL", "/d/a\x00b.png\n"},
		{"ESC", "/d/a\x1b[31mb.png\n"},
		{"DEL", "/d/a\x7fb.png\n"},
		{"C1 control", "/d/a\u0085b.png\n"},
		{"invalid UTF-8", "/d/a\xffb.png\n"},
		{"json", `{"path":"/d/a.png"}` + "\n"},
		{"oversized answer", "/" + strings.Repeat("a", 9000) + "\n"},
		{"long path", "/" + strings.Repeat("a", 5000) + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dz := newDZ(t)
			dz.Answer = tc.answer
			res, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
			wantCode(t, err, upload.ErrDropZoneResponse)
			if res != (upload.Result{}) {
				t.Fatalf("result = %+v", res)
			}
		})
	}
}

func TestUploadSniffing(t *testing.T) {
	for _, tc := range []struct {
		name string
		head []byte
		mime string
		ext  string
	}{
		{"png", pngHead, "image/png", ".png"},
		{"jpeg", jpegHead, "image/jpeg", ".jpg"},
		{"gif", gifHead, "image/gif", ".gif"},
		{"webp", webpHead, "image/webp", ".webp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dz := newDZ(t)
			// The caller's own idea of the type (its Content-Type, a file name)
			// never reaches Service: only the bytes decide.
			res, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{Label: "x", N: 2}, bytes.NewReader(image(tc.head, 700)))
			if err != nil || res.Mime != tc.mime {
				t.Fatalf("got %+v, %v", res, err)
			}
			r := dz.seen()[0]
			if r.ctype != tc.mime || r.filename != "h3d-x-2"+tc.ext {
				t.Errorf("part: %q %q", r.ctype, r.filename)
			}
		})
	}
	// Short files are sniffed too (a tiny GIF is under 512 bytes).
	dz := newDZ(t)
	if _, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(gifHead)); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`)},
		{"svg with a prolog", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`)},
		{"html", []byte("<!DOCTYPE html><html><script>alert(1)</script></html>")},
		{"octet-stream", []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}},
		{"tiff", []byte("II*\x00\x08\x00\x00\x00abcdefgh")},
		{"heic", []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic")},
		{"pdf", []byte("%PDF-1.7\n")},
		{"zip", []byte("PK\x03\x04abcdefgh")},
		{"text", []byte("[Image #1: /etc/passwd]")},
		{"png signature cut short", pngHead[:6]},
		{"riff but not webp", []byte("RIFF\x24\x00\x00\x00WAVEfmt ")},
	} {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			dz := newDZ(t)
			_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(tc.body))
			wantCode(t, err, upload.ErrUnsupported)
			if n := len(dz.seen()); n != 0 {
				t.Fatalf("%d requests reached Drop Zone", n)
			}
		})
	}
}

func TestUploadSizeLimits(t *testing.T) {
	t.Run("exactly MaxBytes", func(t *testing.T) {
		dz := newDZ(t)
		res, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, &gen{head: pngHead, n: upload.MaxBytes})
		if err != nil || res.Size != upload.MaxBytes {
			t.Fatalf("got %+v, %v", res, err)
		}
		if r := dz.seen()[0]; r.size != upload.MaxBytes || !r.complete {
			t.Fatalf("upstream size %d complete %v", r.size, r.complete)
		}
	})
	t.Run("one byte over", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, &gen{head: pngHead, n: upload.MaxBytes + 1})
		wantCode(t, err, upload.ErrTooLarge)
		// Drop Zone saw an unfinished body: it stores nothing.
		if dz.committed() != 0 {
			t.Fatal("an over-size image was committed")
		}
	})
	t.Run("far over", func(t *testing.T) {
		dz := newDZ(t)
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, &gen{head: pngHead, n: 3 * upload.MaxBytes})
		wantCode(t, err, upload.ErrTooLarge)
		if dz.committed() != 0 {
			t.Fatal("an over-size image was committed")
		}
	})
	t.Run("the caller's own cap error", func(t *testing.T) {
		// An http.MaxBytesReader in front (the bridge's) reports the same.
		dz := newDZ(t)
		rec := httptest.NewRecorder()
		body := http.MaxBytesReader(rec, io.NopCloser(&gen{head: pngHead, n: 10_000}), 4096)
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, body)
		wantCode(t, err, upload.ErrTooLarge)
		if dz.committed() != 0 {
			t.Fatal("committed")
		}
	})
	t.Run("empty", func(t *testing.T) {
		dz := newDZ(t)
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, strings.NewReader(""))
		wantCode(t, err, upload.ErrBadRequest)
		if len(dz.seen()) != 0 {
			t.Fatal("reached Drop Zone")
		}
	})
	t.Run("cut off in the middle", func(t *testing.T) {
		dz := newDZ(t)
		r := io.MultiReader(bytes.NewReader(image(pngHead, 2000)), iotestErr{errors.New("connection reset")})
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, r)
		wantCode(t, err, upload.ErrBadRequest)
		if dz.committed() != 0 {
			t.Fatal("a cut-off image was committed")
		}
	})
	t.Run("bad number", func(t *testing.T) {
		dz := newDZ(t)
		for _, n := range []int{0, -1, 10000} {
			_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: n}, bytes.NewReader(image(pngHead, 10)))
			wantCode(t, err, upload.ErrBadRequest)
		}
	})
}

type iotestErr struct{ err error }

func (e iotestErr) Read([]byte) (int, error) { return 0, e.err }

func TestUploadUpstreamFailures(t *testing.T) {
	img := func() io.Reader { return bytes.NewReader(image(pngHead, 3000)) }

	t.Run("connection refused", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		s := service(t, dz.srv.URL)
		dz.srv.Close()
		_, err := s.Upload(context.Background(), upload.Meta{N: 1}, img())
		wantCode(t, err, upload.ErrDropZoneDown)
	})
	t.Run("500", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		dz.Status = 500
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, img())
		wantCode(t, err, upload.ErrDropZoneDown)
		if strings.Contains(err.Error(), "storage error") {
			t.Fatalf("Drop Zone's own words leaked: %v", err)
		}
	})
	t.Run("redirect is not followed", func(t *testing.T) {
		other := newDZ(t)
		dz := newDZ(t)
		dz.Redirect = other.srv.URL + "/upload"
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, img())
		wantCode(t, err, upload.ErrDropZoneDown)
		if len(other.seen()) != 0 {
			t.Fatal("the image was replayed to the redirect target")
		}
	})
	t.Run("slow answer", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		dz.Delay = 5 * time.Second
		s := service(t, dz.srv.URL, func(c *upload.Config) { c.Timeout = 300 * time.Millisecond })
		start := time.Now()
		_, err := s.Upload(context.Background(), upload.Meta{N: 1}, img())
		wantCode(t, err, upload.ErrTimeout)
		if time.Since(start) > 3*time.Second {
			t.Fatalf("took %s", time.Since(start))
		}
	})
	t.Run("stalled body", func(t *testing.T) {
		// The client stops sending: the deadline ends the upload. The reader is
		// left blocked here on purpose; it is freed at the end.
		dz := newDZ(t)
		release := make(chan struct{})
		s := service(t, dz.srv.URL, func(c *upload.Config) { c.Timeout = 300 * time.Millisecond })
		body := io.MultiReader(bytes.NewReader(image(pngHead, 2000)), blockingReader{release})
		start := time.Now()
		_, err := s.Upload(context.Background(), upload.Meta{N: 1}, body)
		wantCode(t, err, upload.ErrTimeout)
		if time.Since(start) > 4*time.Second {
			t.Fatalf("took %s", time.Since(start))
		}
		if dz.committed() != 0 {
			t.Fatal("committed")
		}
		close(release)
	})
	t.Run("stalled before the first byte", func(t *testing.T) {
		dz := newDZ(t)
		release := make(chan struct{})
		s := service(t, dz.srv.URL, func(c *upload.Config) { c.Timeout = 200 * time.Millisecond })
		_, err := s.Upload(context.Background(), upload.Meta{N: 1}, blockingReader{release})
		wantCode(t, err, upload.ErrTimeout)
		close(release)
	})
	t.Run("early answer", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		dz.Early = true
		// Big enough that the answer comes with most of the body unread.
		_, err := service(t, dz.srv.URL).Upload(context.Background(), upload.Meta{N: 1}, &gen{head: pngHead, n: 8 << 20})
		if !errors.Is(err, upload.ErrDropZoneResponse) && !errors.Is(err, upload.ErrDropZoneDown) {
			t.Fatalf("early answer was taken as a success or an odd error: %v", err)
		}
	})
	t.Run("cancelled mid-stream", func(t *testing.T) {
		dz := newDZ(t)
		defer noLeak(t)()
		ctx, cancel := context.WithCancel(context.Background())
		var read atomic.Int64
		src := &slowGen{gen: gen{head: pngHead, n: 20 << 20}, read: &read, cancelAt: 1 << 20, cancel: cancel}
		_, err := service(t, dz.srv.URL).Upload(ctx, upload.Meta{N: 1}, src)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
		if dz.committed() != 0 {
			t.Fatal("a cancelled image was committed")
		}
		if read.Load() >= 20<<20 {
			t.Fatal("the whole image was read after the cancel")
		}
	})
	t.Run("cancelled before it starts", func(t *testing.T) {
		dz := newDZ(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service(t, dz.srv.URL).Upload(ctx, upload.Meta{N: 1}, img())
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	})
}

type blockingReader struct{ release chan struct{} }

func (b blockingReader) Read([]byte) (int, error) {
	<-b.release
	return 0, io.EOF
}

// slowGen cancels the upload once it has produced cancelAt bytes.
type slowGen struct {
	gen
	read     *atomic.Int64
	cancelAt int64
	cancel   context.CancelFunc
}

func (s *slowGen) Read(p []byte) (int, error) {
	n, err := s.gen.Read(p)
	if s.read.Add(int64(n)) >= s.cancelAt {
		s.cancel()
		time.Sleep(time.Millisecond)
	}
	return n, err
}

func TestUploadConcurrencyLimit(t *testing.T) {
	dz := newDZ(t)
	defer noLeak(t)()
	dz.Gate = make(chan struct{})
	s := service(t, dz.srv.URL, func(c *upload.Config) { c.MaxConcurrent = 2 })

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
			errs <- err
		}()
	}
	// Both are at Drop Zone, so both hold a slot: a third is refused at once.
	for dz.Held.Load() < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	_, err := s.Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
	wantCode(t, err, upload.ErrBusy)
	close(dz.Gate)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// The slots are back.
	if _, err := s.Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100))); err != nil {
		t.Fatalf("after the others finished: %v", err)
	}
}

func TestUploadReleasesSlotsOnEveryExit(t *testing.T) {
	dz := newDZ(t)
	defer noLeak(t)()
	s := service(t, dz.srv.URL, func(c *upload.Config) { c.MaxConcurrent = 1; c.Timeout = 300 * time.Millisecond })
	ok := func() error {
		_, err := s.Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
		return err
	}
	fail := []func(){
		func() { // unsupported
			_, _ = s.Upload(context.Background(), upload.Meta{N: 1}, strings.NewReader("hello"))
		},
		func() { // empty
			_, _ = s.Upload(context.Background(), upload.Meta{N: 1}, strings.NewReader(""))
		},
		func() { // over the cap
			_, _ = s.Upload(context.Background(), upload.Meta{N: 1}, &gen{head: pngHead, n: upload.MaxBytes + 1})
		},
		func() { // cancelled
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			_, _ = s.Upload(ctx, upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
		},
		func() { // Drop Zone fails
			dz.Status = 500
			_, _ = s.Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 100)))
			dz.Status = 0
		},
	}
	for i, f := range fail {
		f()
		if err := ok(); err != nil {
			t.Fatalf("after failure %d the slot is still held: %v", i, err)
		}
	}
}

func TestStem(t *testing.T) {
	for _, tc := range []struct {
		label string
		n     int
		want  string
	}{
		{"sunny-otter", 1, "h3d-sunny-otter-1"},
		{"Sunny Otter", 2, "h3d-sunny-otter-2"},
		{"", 3, "h3d-hire-3"},
		{"  ", 3, "h3d-hire-3"},
		{"!!!", 4, "h3d-hire-4"},
		{"日本語", 4, "h3d-hire-4"},
		{"../../etc/passwd", 5, "h3d-etc-passwd-5"},
		{"a\r\nb\x00c\"d'e", 6, "h3d-a-b-c-d-e-6"},
		{"a---b___c", 7, "h3d-a-b-c-7"},
		{"--lead-and-trail--", 8, "h3d-lead-and-trail-8"},
		{"abcdefghijklmnopqrstuvwxyz0123456789", 9, "h3d-abcdefghijklmnopqrstuvwx-9"},
		{"abcdefghijklmnopqrstuvw-yz", 9, "h3d-abcdefghijklmnopqrstuvw-9"},
		{"Ünï", 10, "h3d-n-10"},
	} {
		if got := upload.Stem(tc.label, tc.n); got != tc.want {
			t.Errorf("Stem(%q, %d) = %q, want %q", tc.label, tc.n, got, tc.want)
		}
	}
}

func TestNewChecksTheURL(t *testing.T) {
	for _, u := range []string{"", "127.0.0.1:8080", "ftp://x", "http://", "http://u:p@h:1", "http://h:1?x=1", "://bad"} {
		if _, err := upload.New(upload.Config{URL: u}); err == nil {
			t.Errorf("New(%q) accepted", u)
		}
	}
	dz := newDZ(t)
	// A trailing slash on the base URL does not double up.
	if _, err := service(t, dz.srv.URL+"/").Upload(context.Background(), upload.Meta{N: 1}, bytes.NewReader(image(pngHead, 50))); err != nil {
		t.Fatal(err)
	}
}
