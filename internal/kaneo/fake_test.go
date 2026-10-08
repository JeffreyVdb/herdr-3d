package kaneo

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// testKey is the fake instance's key: no test output may hold it.
const testKey = "kn_live_SECRET_test_key_0123456789abcdef"

// fake is a Kaneo instance: routes answer by "METHOD /api/path", every
// request is recorded, a request without the key's Bearer header or any
// DELETE fails the test.
type fake struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	routes map[string]http.HandlerFunc
	reqs   []request
}

type request struct {
	method, path, query, auth, body string
}

func newFake(t *testing.T) *fake {
	t.Helper()
	f := &fake{t: t, routes: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fake) serve(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.reqs = append(f.reqs, request{method: r.Method, path: r.URL.EscapedPath(), query: r.URL.RawQuery,
		auth: r.Header.Get("Authorization"), body: string(b)})
	h := f.routes[r.Method+" "+r.URL.EscapedPath()]
	f.mu.Unlock()
	if r.Method == http.MethodDelete {
		f.t.Errorf("a DELETE was sent: %s", r.URL)
		http.Error(w, "no", http.StatusMethodNotAllowed)
		return
	}
	if got := r.Header.Get("Authorization"); got != "Bearer "+testKey {
		f.t.Errorf("%s %s: not the key's Bearer header (%d bytes)", r.Method, r.URL, len(got)) // never the header itself
	}
	if h == nil {
		f.t.Errorf("unexpected %s %s", r.Method, r.URL)
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	r.Body = io.NopCloser(strings.NewReader(string(b)))
	h(w, r)
}

// on routes method path ("/api/..." is added) to h.
func (f *fake) on(method, path string, h http.HandlerFunc) {
	f.mu.Lock()
	f.routes[method+" /api"+path] = h
	f.mu.Unlock()
}

// json answers method path with status and body.
func (f *fake) json(method, path string, status int, body string) {
	f.on(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

// text answers method path with status and a text/plain body (Kaneo's
// errors).
func (f *fake) text(method, path string, status int, body string) {
	f.on(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

// requests are the requests so far.
func (f *fake) requests() []request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]request(nil), f.reqs...)
}

// count is how many requests were "METHOD /api/path".
func (f *fake) count(method, path string) int {
	n := 0
	for _, r := range f.requests() {
		if r.method == method && r.path == "/api"+path {
			n++
		}
	}
	return n
}

// client is a client of the fake.
func (f *fake) client(t *testing.T) *Client {
	t.Helper()
	c, err := New(f.srv.URL, testKey, Options{Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noKey fails the test when s holds the key.
func noKey(t *testing.T, s string) {
	t.Helper()
	if strings.Contains(s, testKey) || strings.Contains(s, "SECRET") {
		t.Errorf("the key leaked: %q", strings.ReplaceAll(s, testKey, "<the key>"))
	}
}
