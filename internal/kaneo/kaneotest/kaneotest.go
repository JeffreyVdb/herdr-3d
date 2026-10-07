// Package kaneotest is a fake Kaneo instance for tests above the provider
// (#184): an httptest server that answers the REST routes internal/kaneo
// calls with the provider's own fixtures (internal/kaneo/testdata, shaped
// after the deployed OpenAPI): workspaces ws_1 and ws_2, project pr_1
// ("Bridge", slug KAN) of ws_1 with its columns and a board of two task
// pages (the first with two related pages), an archived project pr_old,
// pr_x of ws_2, and task_1's detail and comments. A request without the
// key's Bearer header is answered 401 like Kaneo; a DELETE fails the test.
// Every request is recorded (never its Authorization header), and any route
// can be replaced.
package kaneotest

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

// Request is one request the fake answered.
type Request struct {
	Method, Path, Query, Body string
	// Authorized: it carried the key's Bearer header.
	Authorized bool
}

// Server is a fake Kaneo instance.
type Server struct {
	// URL is the instance's origin (plain http on loopback, which the
	// client accepts); its API base is URL + "/api".
	URL string

	t      testing.TB
	srv    *httptest.Server
	mu     sync.Mutex
	key    string
	routes map[string]http.HandlerFunc
	reqs   []Request
}

// New starts the fake instance accepting key, with the fixture routes.
func New(t testing.TB, key string) *Server {
	t.Helper()
	s := &Server{t: t, key: key, routes: map[string]http.HandlerFunc{}}
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.srv.Close)
	s.URL = s.srv.URL
	s.JSON("GET", "/auth/organization/list", 200, Fixture(t, "orgs.json"))
	s.JSON("GET", "/user/me", 200, Fixture(t, "me.json"))
	s.JSON("GET", "/project", 200, Fixture(t, "projects.json"))
	s.JSON("GET", "/project/pr_1", 200, Fixture(t, "project.json"))
	s.JSON("GET", "/project/pr_old", 200, strings.Replace(strings.Replace(Fixture(t, "project.json"), `"pr_1"`, `"pr_old"`, 1),
		`"archivedAt":null`, `"archivedAt":"2026-10-08T12:00:00.000Z"`, 1))
	s.JSON("GET", "/project/pr_x", 200, strings.Replace(strings.Replace(Fixture(t, "project.json"), `"pr_1"`, `"pr_x"`, 1),
		`"ws_1"`, `"ws_2"`, 1))
	s.JSON("GET", "/column/pr_1", 200, Fixture(t, "columns.json"))
	pages := map[string]string{
		"limit=100&page=1&relatedPage=1": Fixture(t, "board-p1-r1.json"),
		"limit=100&page=1&relatedPage=2": Fixture(t, "board-p1-r2.json"),
		"limit=100&page=2&relatedPage=1": Fixture(t, "board-p2-r1.json"),
	}
	s.On("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) {
		body, ok := pages[r.URL.RawQuery]
		if !ok {
			t.Errorf("kaneotest: unexpected board query %q", r.URL.RawQuery)
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, body)
	})
	s.JSON("GET", "/task/task_1", 200, Fixture(t, "task-detail.json"))
	s.JSON("GET", "/comment/task_1", 200, Fixture(t, "comments.json"))
	s.JSON("POST", "/comment/task_1", 200, Fixture(t, "comment-created.json"))
	s.JSON("PUT", "/task/status/task_1", 200, Fixture(t, "status-updated.json"))
	return s
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	path := r.URL.EscapedPath()
	s.mu.Lock()
	ok := r.Header.Get("Authorization") == "Bearer "+s.key
	s.reqs = append(s.reqs, Request{Method: r.Method, Path: path, Query: r.URL.RawQuery, Body: string(b), Authorized: ok})
	h := s.routes[r.Method+" "+path]
	s.mu.Unlock()
	switch {
	case r.Method == http.MethodDelete:
		s.t.Errorf("kaneotest: a DELETE was sent: %s", path)
		http.Error(w, "no", http.StatusMethodNotAllowed)
		return
	case !ok:
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, "Unauthorized")
		return
	case h == nil: // Kaneo's answer to an id it does not know
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, "Unknown task, or its workspace could not be determined")
		return
	}
	r.Body = io.NopCloser(strings.NewReader(string(b)))
	h(w, r)
}

// Close stops the fake: its address refuses connections from then on.
func (s *Server) Close() { s.srv.Close() }

// On routes method path ("/api" is added) to h.
func (s *Server) On(method, path string, h http.HandlerFunc) {
	s.mu.Lock()
	s.routes[method+" /api"+path] = h
	s.mu.Unlock()
}

// JSON answers method path with status and a JSON body.
func (s *Server) JSON(method, path string, status int, body string) {
	s.On(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

// Text answers method path with status and a text/plain body (how Kaneo
// sends its errors).
func (s *Server) Text(method, path string, status int, body string) {
	s.On(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

// Requests are the requests so far, in order.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.reqs)
}

// Count is how many requests were method path ("/api" is added).
func (s *Server) Count(method, path string) int {
	n := 0
	for _, r := range s.Requests() {
		if r.Method == method && r.Path == "/api"+path {
			n++
		}
	}
	return n
}

// Writes are the requests that were not GETs.
func (s *Server) Writes() []Request {
	var out []Request
	for _, r := range s.Requests() {
		if r.Method != http.MethodGet {
			out = append(out, r)
		}
	}
	return out
}

// Fixture is internal/kaneo/testdata/<name>.
func Fixture(t testing.TB, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("kaneotest: no source path")
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "testdata", name))
	if err != nil {
		t.Fatalf("kaneotest: fixture %s: %v", name, err)
	}
	return string(b)
}
