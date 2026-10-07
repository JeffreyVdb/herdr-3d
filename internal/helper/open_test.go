package helper

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeOpener records the URLs it was asked to open.
type fakeOpener struct {
	mu   sync.Mutex
	urls []string
	err  error
}

func (f *fakeOpener) open(_ context.Context, u string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.urls = append(f.urls, u)
	return f.err
}

func (f *fakeOpener) opened() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.urls...)
}

func openServer(t *testing.T, f *fakeOpener, hosts []string) *httptest.Server {
	t.Helper()
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: &socketBridge{},
		Bundle: writeBundle(t), Log: quietLog(), Open: f.open, OpenHosts: hosts})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

type openReq struct{ host, origin, token, ctype, body, method string }

func goodOpen(body string) openReq {
	return openReq{host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", token: testToken, ctype: "application/json", body: body, method: "POST"}
}

func doOpen(t *testing.T, ts *httptest.Server, r openReq) int {
	t.Helper()
	req, err := http.NewRequest(r.method, ts.URL+"/api/open", strings.NewReader(r.body))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = r.host
	if r.origin != "" {
		req.Header.Set("Origin", r.origin)
	}
	if r.token != "" {
		req.Header.Set(OpenTokenHeader, r.token)
	}
	if r.ctype != "" {
		req.Header.Set("Content-Type", r.ctype)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestOpenAcceptsAllowlistedHTTPS(t *testing.T) {
	f := &fakeOpener{}
	ts := openServer(t, f, nil)
	for _, u := range []string{
		"https://github.com/JeffreyVdb/herdr-3d/issues/9",
		"https://GitHub.com/JeffreyVdb/herdr-3d/pull/31?diff=split#discussion",
	} {
		if got := doOpen(t, ts, goodOpen(`{"url":"`+u+`"}`)); got != http.StatusNoContent {
			t.Fatalf("%s: %d, want 204", u, got)
		}
	}
	if got := f.opened(); len(got) != 2 || got[0] != "https://github.com/JeffreyVdb/herdr-3d/issues/9" {
		t.Fatalf("opened %q", got)
	}
	// localhost is a valid Host header too, as for /ws.
	r := goodOpen(`{"url":"https://github.com/a/b"}`)
	r.host = "localhost:7777"
	if got := doOpen(t, ts, r); got != http.StatusNoContent {
		t.Fatalf("localhost host: %d", got)
	}
}

func TestOpenRefusals(t *testing.T) {
	f := &fakeOpener{}
	ts := openServer(t, f, nil)
	good := `{"url":"https://github.com/a/b"}`
	for name, tc := range map[string]struct {
		r    openReq
		want int
	}{
		"wrong host":     {func() openReq { r := goodOpen(good); r.host = "evil.example:7777"; return r }(), 403},
		"rebound host":   {func() openReq { r := goodOpen(good); r.host = "attacker.example"; return r }(), 403},
		"no origin":      {func() openReq { r := goodOpen(good); r.origin = ""; return r }(), 403},
		"foreign origin": {func() openReq { r := goodOpen(good); r.origin = "http://evil.example"; return r }(), 403},
		"other port":     {func() openReq { r := goodOpen(good); r.origin = "http://127.0.0.1:8888"; return r }(), 403},
		"no token":       {func() openReq { r := goodOpen(good); r.token = ""; return r }(), 403},
		"wrong token":    {func() openReq { r := goodOpen(good); r.token = strings.Repeat("0", len(testToken)); return r }(), 403},
		"token prefix":   {func() openReq { r := goodOpen(good); r.token = testToken[:10]; return r }(), 403},
		"form post": {func() openReq {
			r := goodOpen("url=https://github.com/a/b")
			r.ctype = "application/x-www-form-urlencoded"
			return r
		}(), 415},
		"text/plain":       {func() openReq { r := goodOpen(good); r.ctype = "text/plain"; return r }(), 415},
		"GET":              {func() openReq { r := goodOpen(""); r.method = "GET"; return r }(), 405},
		"not json":         {goodOpen(`nope`), 400},
		"unknown field":    {goodOpen(`{"url":"https://github.com/a/b","app":"Terminal"}`), 400},
		"empty":            {goodOpen(`{"url":""}`), 400},
		"http":             {goodOpen(`{"url":"http://github.com/a/b"}`), 400},
		"javascript":       {goodOpen(`{"url":"javascript:alert(1)"}`), 400},
		"file":             {goodOpen(`{"url":"file:///etc/passwd"}`), 400},
		"custom scheme":    {goodOpen(`{"url":"vscode://x/y"}`), 400},
		"other host":       {goodOpen(`{"url":"https://evil.example/a"}`), 400},
		"suffix host":      {goodOpen(`{"url":"https://github.com.evil.example/a"}`), 400},
		"subdomain":        {goodOpen(`{"url":"https://gist.github.com/a"}`), 400},
		"userinfo":         {goodOpen(`{"url":"https://github.com@evil.example/a"}`), 400},
		"credentials":      {goodOpen(`{"url":"https://user:pw@github.com/a"}`), 400},
		"port":             {goodOpen(`{"url":"https://github.com:8443/a"}`), 400},
		"control chars":    {goodOpen(`{"url":"https://github.com/a\nb"}`), 400},
		"too long":         {goodOpen(`{"url":"https://github.com/` + strings.Repeat("a", 2100) + `"}`), 400},
		"opaque":           {goodOpen(`{"url":"https:github.com/a"}`), 400},
		"scheme-relative":  {goodOpen(`{"url":"//github.com/a"}`), 400},
		"no scheme":        {goodOpen(`{"url":"github.com/a"}`), 400},
		"uppercase scheme": {goodOpen(`{"url":"HTTP://github.com/a"}`), 400},
	} {
		t.Run(name, func(t *testing.T) {
			if got := doOpen(t, ts, tc.r); got != tc.want {
				t.Fatalf("status %d, want %d", got, tc.want)
			}
		})
	}
	if got := f.opened(); len(got) != 0 {
		t.Fatalf("refused requests still opened %q", got)
	}
}

func TestOpenHostsListAndOpenerFailure(t *testing.T) {
	f := &fakeOpener{}
	ts := openServer(t, f, []string{"github.com", "monday.example"})
	if got := doOpen(t, ts, goodOpen(`{"url":"https://monday.example/boards/1/pulses/2"}`)); got != http.StatusNoContent {
		t.Fatalf("second provider host: %d", got)
	}
	f.err = errors.New("no browser")
	if got := doOpen(t, ts, goodOpen(`{"url":"https://github.com/a/b"}`)); got != http.StatusBadGateway {
		t.Fatalf("opener failure: %d, want 502", got)
	}
	// An empty (non-nil) list opens nothing.
	f2 := &fakeOpener{}
	ts2 := openServer(t, f2, []string{})
	if got := doOpen(t, ts2, goodOpen(`{"url":"https://github.com/a/b"}`)); got != http.StatusBadRequest || len(f2.opened()) != 0 {
		t.Fatalf("empty allowlist: %d, opened %q", got, f2.opened())
	}
}

// trustingBridge is a bridge whose last /healthz trusted some open hosts.
type trustingBridge struct {
	socketBridge
	mu    sync.Mutex
	hosts []string
}

func (b *trustingBridge) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Status{State: StateUp, OpenHosts: append([]string(nil), b.hosts...)}
}

func (b *trustingBridge) set(hosts ...string) {
	b.mu.Lock()
	b.hosts = hosts
	b.mu.Unlock()
}

// #184: "Open in Kaneo" opens the self-hosted instance the bridge names
// (through the tunnel), and only while it names it; the URL checks stay
// (https, no port, no credentials), and other hosts are still refused.
func TestOpenBridgeTrustedHost(t *testing.T) {
	f := &fakeOpener{}
	br := &trustingBridge{}
	s := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: br,
		Bundle: writeBundle(t), Log: quietLog(), Open: f.open})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	task := `{"url":"https://tasks.example.test/dashboard/workspace/w/project/p/task/t"}`
	if got := doOpen(t, ts, goodOpen(task)); got != http.StatusBadRequest {
		t.Fatalf("before the bridge names it: %d", got)
	}
	br.set("tasks.example.test")
	if got := doOpen(t, ts, goodOpen(task)); got != http.StatusNoContent {
		t.Fatalf("named by the bridge: %d", got)
	}
	for _, bad := range []string{`{"url":"http://tasks.example.test/x"}`, `{"url":"https://tasks.example.test:8443/x"}`,
		`{"url":"https://user:pw@tasks.example.test/x"}`, `{"url":"https://evil.example.test/x"}`} {
		if got := doOpen(t, ts, goodOpen(bad)); got != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", bad, got)
		}
	}
	if got := doOpen(t, ts, goodOpen(`{"url":"https://github.com/a/b/issues/1"}`)); got != http.StatusNoContent {
		t.Fatalf("github with a bridge host: %d", got)
	}
	br.set() // disconnected on the bridge
	if got := doOpen(t, ts, goodOpen(task)); got != http.StatusBadRequest {
		t.Fatalf("after the bridge dropped it: %d", got)
	}
	if n := len(f.opened()); n != 2 {
		t.Fatalf("opened %d URLs, want 2", n)
	}
}
