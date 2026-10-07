package kaneo

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

func TestNew(t *testing.T) {
	c, err := New("https://tasks.example.com/api/", testKey, Options{})
	if err != nil || c.APIBase() != "https://tasks.example.com/api" || c.timeout != DefaultTimeout {
		t.Fatalf("New = %+v, %v", c, err)
	}
	if _, err := New("ftp://tasks.example.com", testKey, Options{}); !errors.Is(err, provider.ErrBadInput) {
		t.Fatalf("a bad URL: %v", err)
	}
	if _, err := New("https://tasks.example.com", "  ", Options{}); !errors.Is(err, provider.ErrBadInput) {
		t.Fatalf("no key: %v", err)
	}
}

// The connection test only reads: the workspace list, then the key's owner.
func TestConnectionTest(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/auth/organization/list", 200, fixture(t, "orgs.json"))
	f.json("GET", "/user/me", 200, fixture(t, "me.json"))
	r, err := f.client(t).Test(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []Workspace{{ID: "ws_1", Name: "Team", Slug: "team"}, {ID: "ws_2", Name: "Side", Slug: "side"}}
	if len(r.Workspaces) != 2 || r.Workspaces[0] != want[0] || r.Workspaces[1] != want[1] || r.User != "Alex" || r.Latency <= 0 {
		t.Fatalf("test = %+v", r)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[0].path != "/api/auth/organization/list" || reqs[1].path != "/api/user/me" {
		t.Fatalf("requests = %+v", reqs)
	}
	for _, q := range reqs {
		if q.method != "GET" || q.body != "" || q.query != "" {
			t.Errorf("the test wrote: %+v", q)
		}
	}
}

func TestConnectionTestWithoutWorkspacesOrUser(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/auth/organization/list", 200, `[]`)
	f.text("GET", "/user/me", 404, "User not found")
	r, err := f.client(t).Test(context.Background())
	if err != nil || r.Workspaces == nil || len(r.Workspaces) != 0 || r.User != "" {
		t.Fatalf("test = %+v, %v", r, err)
	}
	// A refused key fails the test before the owner is asked.
	f.text("GET", "/auth/organization/list", 401, "Unauthorized")
	if _, err := f.client(t).Test(context.Background()); !errors.Is(err, provider.ErrUnauthorized) {
		t.Fatalf("a refused key: %v", err)
	}
	if n := f.count("GET", "/user/me"); n != 1 {
		t.Fatalf("/user/me asked %d times", n)
	}
}

func TestStatusKinds(t *testing.T) {
	for _, tc := range []struct {
		status int
		kind   error
	}{
		{400, provider.ErrBadInput},
		{401, provider.ErrUnauthorized},
		{403, provider.ErrForbidden},
		{404, provider.ErrNotFound},
		{409, provider.ErrStale},
		{422, provider.ErrBadInput},
		{500, provider.ErrFailed},
		{502, provider.ErrFailed},
		{503, provider.ErrFailed},
	} {
		f := newFake(t)
		f.text("GET", "/auth/organization/list", tc.status, "Task list request took too long")
		_, err := f.client(t).Workspaces(context.Background())
		if !errors.Is(err, tc.kind) {
			t.Errorf("HTTP %d = %v, want %v", tc.status, err, tc.kind)
			continue
		}
		for _, other := range []error{provider.ErrBadInput, provider.ErrUnauthorized, provider.ErrForbidden, provider.ErrNotFound,
			provider.ErrStale, provider.ErrFailed} {
			if other != tc.kind && errors.Is(err, other) {
				t.Errorf("HTTP %d is also %v", tc.status, other)
			}
		}
		if !strings.Contains(err.Error(), "took too long") {
			t.Errorf("HTTP %d lost Kaneo's words: %v", tc.status, err)
		}
	}
	// 401 may be a used-up quota: the message does not call the key invalid
	// for good.
	f := newFake(t)
	f.text("GET", "/auth/organization/list", 401, "Unauthorized")
	_, err := f.client(t).Workspaces(context.Background())
	if !strings.Contains(err.Error(), "quota") {
		t.Fatalf("401 = %v", err)
	}
}

func TestRateLimit(t *testing.T) {
	f := newFake(t)
	retry := ""
	f.on("GET", "/auth/organization/list", func(w http.ResponseWriter, r *http.Request) {
		if retry != "" {
			w.Header().Set("Retry-After", retry)
		}
		w.WriteHeader(429)
		io.WriteString(w, "Too Many Requests")
	})
	c := f.client(t)
	var rl *provider.RateLimitError
	for _, tc := range []struct {
		header string
		want   time.Time // zero: none
	}{
		{"", time.Time{}},
		{"30", time.Now().Add(30 * time.Second)},
		{"Wed, 21 Oct 2026 07:28:00 GMT", time.Date(2026, 10, 21, 7, 28, 0, 0, time.UTC)},
		{"soon", time.Time{}},
	} {
		retry = tc.header
		_, err := c.Workspaces(context.Background())
		if !errors.As(err, &rl) {
			t.Fatalf("429 (%q) = %v", tc.header, err)
		}
		if d := rl.ResetAt.Sub(tc.want); tc.want.IsZero() != rl.ResetAt.IsZero() || d < -2*time.Second || d > 2*time.Second {
			t.Errorf("429 (%q) resets at %v, want %v", tc.header, rl.ResetAt, tc.want)
		}
	}
}

// No error holds the key, however Kaneo echoes it.
func TestErrorsNeverHoldTheKey(t *testing.T) {
	for _, status := range []int{400, 401, 403, 409, 429, 500} {
		f := newFake(t)
		f.on("GET", "/auth/organization/list", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			io.WriteString(w, "bad header "+r.Header.Get("Authorization")+" key="+testKey)
		})
		_, err := f.client(t).Workspaces(context.Background())
		if err == nil {
			t.Fatalf("HTTP %d: no error", status)
		}
		noKey(t, err.Error())
		if status != 429 && !strings.Contains(err.Error(), "[key]") {
			t.Errorf("HTTP %d: %v", status, err)
		}
	}
	// A JSON error body too.
	f := newFake(t)
	f.json("GET", "/auth/organization/list", 500, `{"message":"Internal Server Error `+testKey+`"}`)
	_, err := f.client(t).Workspaces(context.Background())
	noKey(t, err.Error())
}

// A redirect is not followed: the key would go along.
func TestRedirectIsNotFollowed(t *testing.T) {
	f := newFake(t)
	f.on("GET", "/auth/organization/list", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/api/elsewhere", http.StatusFound)
	})
	_, err := f.client(t).Workspaces(context.Background())
	if !errors.Is(err, provider.ErrFailed) || !strings.Contains(err.Error(), "redirects") {
		t.Fatalf("redirect = %v", err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests", n)
	}
}

func TestTimeoutAndCancel(t *testing.T) {
	f := newFake(t)
	f.on("GET", "/auth/organization/list", func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	c, err := New(f.srv.URL, testKey, Options{Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = c.Workspaces(context.Background())
	if !errors.Is(err, provider.ErrFailed) || !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 3*time.Second {
		t.Fatalf("timeout = %v after %v", err, time.Since(start))
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	c, _ = New(f.srv.URL, testKey, Options{Timeout: 10 * time.Second})
	start = time.Now()
	_, err = c.Workspaces(ctx)
	if !errors.Is(err, provider.ErrFailed) || !errors.Is(err, context.Canceled) || time.Since(start) > 3*time.Second {
		t.Fatalf("cancel = %v after %v", err, time.Since(start))
	}
	noKey(t, err.Error())
}

func TestUnreachableAndUnreadable(t *testing.T) {
	f := newFake(t)
	url := f.srv.URL
	f.srv.Close()
	c, _ := New(url, testKey, Options{Timeout: time.Second})
	_, err := c.Workspaces(context.Background())
	if !errors.Is(err, provider.ErrFailed) {
		t.Fatalf("unreachable = %v", err)
	}
	noKey(t, err.Error())

	f = newFake(t)
	f.json("GET", "/auth/organization/list", 200, `{"not":"an array"}`)
	if _, err := f.client(t).Workspaces(context.Background()); !errors.Is(err, provider.ErrFailed) {
		t.Fatalf("unreadable = %v", err)
	}
	f.on("GET", "/auth/organization/list", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "[")
		io.WriteString(w, strings.Repeat(" ", maxAnswerBytes))
		io.WriteString(w, "]")
	})
	if _, err := f.client(t).Workspaces(context.Background()); !errors.Is(err, provider.ErrFailed) || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("too large = %v", err)
	}
}

func TestProjects(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/project", 200, fixture(t, "projects.json"))
	c := f.client(t)
	ps, err := c.Projects(context.Background(), "ws_1", false)
	if err != nil || len(ps) != 1 || ps[0] != (Project{ID: "pr_1", WorkspaceID: "ws_1", Name: "Bridge", Slug: "KAN"}) {
		t.Fatalf("projects = %+v, %v", ps, err)
	}
	ps, err = c.Projects(context.Background(), "ws_1", true)
	if err != nil || len(ps) != 2 || !ps[1].Archived || ps[1].ID != "pr_old" {
		t.Fatalf("with archived = %+v, %v", ps, err)
	}
	reqs := f.requests()
	if reqs[0].query != "workspaceId=ws_1" || reqs[1].query != "includeArchived=true&workspaceId=ws_1" {
		t.Fatalf("queries = %q, %q", reqs[0].query, reqs[1].query)
	}
	f.text("GET", "/project", 403, "No access to the workspace")
	if _, err := c.Projects(context.Background(), "ws_9", false); !errors.Is(err, provider.ErrForbidden) {
		t.Fatalf("403 = %v", err)
	}
	if _, err := c.Projects(context.Background(), "", false); !errors.Is(err, provider.ErrBadInput) {
		t.Fatalf("no workspace = %v", err)
	}
}

func TestProjectIn(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/project/pr_1", 200, fixture(t, "project.json"))
	f.text("GET", "/project/pr_gone", 400, "Unknown project")
	f.text("GET", "/project/pr_private", 403, "No access to the project's workspace")
	c := f.client(t)
	ctx := context.Background()
	if p, err := c.ProjectIn(ctx, "ws_1", "pr_1"); err != nil || p.Slug != "KAN" || p.Name != "Bridge" {
		t.Fatalf("project = %+v, %v", p, err)
	}
	if _, err := c.ProjectIn(ctx, "ws_2", "pr_1"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("another workspace's = %v", err)
	}
	if _, err := c.ProjectIn(ctx, "ws_1", "pr_gone"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("an unknown project = %v", err)
	}
	if _, err := c.ProjectIn(ctx, "ws_1", "pr_private"); !errors.Is(err, provider.ErrForbidden) {
		t.Fatalf("out of reach = %v", err)
	}
	for _, r := range f.requests() {
		if r.method != "GET" {
			t.Errorf("%+v", r)
		}
	}
}
