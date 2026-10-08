package kaneoconf_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

const (
	key1 = "kaneo-fixture-key-one-0001"
	key2 = "kaneo-fixture-key-two-0002"
)

func ptr[T any](v T) *T { return &v }

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func fixture() *kaneoconf.FakeConnector {
	return &kaneoconf.FakeConnector{Key: key1,
		WorkspaceList: []kaneoconf.Workspace{{ID: "ws1", Name: "Studio"}, {ID: "ws2", Name: "Home"}},
		ProjectList: []kaneoconf.Project{
			{ID: "p1", WorkspaceID: "ws1", Name: "Herdr", Slug: "HRD"},
			{ID: "p2", WorkspaceID: "ws2", Name: "Garden", Slug: "GDN"},
			{ID: "p3", WorkspaceID: "ws1", Name: "Old", Slug: "OLD", Archived: true},
		}}
}

func newSvc(t *testing.T, conn kaneoconf.Connector, file string, c *clock) *kaneoconf.Service {
	t.Helper()
	opts := kaneoconf.Options{File: file, Timeout: time.Second}
	if conn != nil {
		opts.Connector = conn
	}
	if c != nil {
		opts.Now = c.now
	}
	s, err := kaneoconf.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func kind(t *testing.T, err error, want kaneoconf.Kind) {
	t.Helper()
	if got := kaneoconf.KindOf(err); got != want {
		t.Fatalf("error kind = %q (%v), want %q", got, err, want)
	}
}

// connect tests and saves url + key with default.
func connect(t *testing.T, s *kaneoconf.Service, url, key string, def kaneoconf.DefaultArg) kaneoconf.View {
	t.Helper()
	d := kaneoconf.Draft{URL: ptr(url), Key: ptr(key)}
	if _, err := s.Test(context.Background(), d); err != nil {
		t.Fatalf("test: %v", err)
	}
	v, err := s.Save(d, def)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	return v
}

func TestSaveNeedsAPassingTestOfThatDraft(t *testing.T) {
	s := newSvc(t, fixture(), "", nil)
	d := kaneoconf.Draft{URL: ptr("https://tasks.example.test"), Key: ptr(key1)}
	_, err := s.Save(d, kaneoconf.DefaultArg{})
	kind(t, err, kaneoconf.KindTestRequired)

	res, err := s.Test(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	if res.APIBase != "https://tasks.example.test/api" || res.WebOrigin != "https://tasks.example.test" || len(res.Workspaces) != 2 {
		t.Fatalf("test result = %+v", res)
	}
	// An edited key (or URL) is another draft: its test is still due.
	_, err = s.Save(kaneoconf.Draft{URL: d.URL, Key: ptr(key2)}, kaneoconf.DefaultArg{})
	kind(t, err, kaneoconf.KindTestRequired)
	_, err = s.Save(kaneoconf.Draft{URL: ptr("https://other.example.test"), Key: d.Key}, kaneoconf.DefaultArg{})
	kind(t, err, kaneoconf.KindTestRequired)
	// The default must be one the test found.
	_, err = s.Save(d, kaneoconf.DefaultArg{Set: true, ID: ptr("ws-unknown")})
	kind(t, err, kaneoconf.KindBadInput)
	if v := s.View(); v.State != kaneoconf.StateOff || v.KeySet {
		t.Fatalf("a refused save changed the settings: %+v", v)
	}

	v, err := s.Save(d, kaneoconf.DefaultArg{Set: true, ID: ptr("ws2")})
	if err != nil {
		t.Fatal(err)
	}
	if v.State != kaneoconf.StateReady || !v.KeySet || v.DefaultWorkspace == nil || v.DefaultWorkspace.Name != "Home" || v.Generation != 1 {
		t.Fatalf("view = %+v", v)
	}
}

func TestTestPassesWithoutSavingAndAFailureKeepsTheSaved(t *testing.T) {
	f := fixture()
	s := newSvc(t, f, "", nil)
	connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{})
	before := s.View()
	for _, tc := range []struct {
		err  error
		want kaneoconf.Kind
	}{
		{provider.Errorf(provider.ErrUnauthorized, "401"), kaneoconf.KindUnauthorized},
		{provider.Errorf(provider.ErrForbidden, "403"), kaneoconf.KindForbidden},
		{kaneoconf.Unreachable(), kaneoconf.KindUnreachable},
		{&provider.RateLimitError{}, kaneoconf.KindRateLimited},
		{provider.Failed("500"), kaneoconf.KindFailed},
	} {
		f.Set(func(f *kaneoconf.FakeConnector) { f.Err = tc.err })
		_, err := s.Test(context.Background(), kaneoconf.Draft{Key: ptr(key2)})
		kind(t, err, tc.want)
	}
	if after := s.View(); !viewsEqual(before, after) {
		t.Fatalf("failed tests changed the settings: %+v → %+v", before, after)
	}
}

func viewsEqual(a, b kaneoconf.View) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func TestTimeoutIsClassified(t *testing.T) {
	f := fixture()
	f.Gate = make(chan struct{})
	s, err := kaneoconf.New(kaneoconf.Options{Connector: f, Timeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Test(context.Background(), kaneoconf.Draft{URL: ptr("https://tasks.example.test"), Key: ptr(key1)})
	kind(t, err, kaneoconf.KindTimeout)
}

// A blank key is the saved key, and only for the saved instance: the saved
// key never goes to another one, not even in a test.
func TestSavedKeyNeverGoesToAnotherInstance(t *testing.T) {
	f := fixture()
	s := newSvc(t, f, "", nil)
	connect(t, s, "https://tasks.example.test/api", key1, kaneoconf.DefaultArg{})

	if _, err := s.Test(context.Background(), kaneoconf.Draft{Key: ptr("")}); err != nil {
		t.Fatalf("test of the saved connection: %v", err)
	}
	// The same instance written as its origin is the same instance.
	if _, err := s.Test(context.Background(), kaneoconf.Draft{URL: ptr("https://tasks.example.test/")}); err != nil {
		t.Fatalf("test of the saved instance by its origin: %v", err)
	}
	n := len(f.Calls())
	_, err := s.Test(context.Background(), kaneoconf.Draft{URL: ptr("https://evil.example.test")})
	kind(t, err, kaneoconf.KindKeyRequired)
	_, err = s.Save(kaneoconf.Draft{URL: ptr("https://evil.example.test")}, kaneoconf.DefaultArg{})
	kind(t, err, kaneoconf.KindKeyRequired)
	if len(f.Calls()) != n {
		t.Fatal("a draft with another instance and no key made a call")
	}
	for _, c := range f.Calls() {
		if c.Key == key1 && c.APIBase != "https://tasks.example.test/api" {
			t.Fatalf("the saved key went to %s", c.APIBase)
		}
	}
	// With its own key the new instance can be tested and saved.
	if v := connect(t, s, "https://evil.example.test", key1, kaneoconf.DefaultArg{}); v.APIBase != "https://evil.example.test/api" || v.Generation != 2 {
		t.Fatalf("view = %+v", v)
	}
}

func TestFileIs0600AtomicAndSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "state", "kaneo.json")
	s := newSvc(t, fixture(), file, nil)
	connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{Set: true, ID: ptr("ws1")})
	fi, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %v, want 0600", fi.Mode().Perm())
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(file), "*.tmp")); len(left) > 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	again := newSvc(t, fixture(), file, nil)
	v := again.View()
	if v.State != kaneoconf.StateReady || !v.KeySet || v.APIBase != "https://tasks.example.test/api" || v.DefaultWorkspace == nil || v.DefaultWorkspace.ID != "ws1" || v.Generation != 1 {
		t.Fatalf("view after restart = %+v", v)
	}
	if _, key, ok := again.Credentials(1); !ok || key != key1 {
		t.Fatal("the key did not survive the restart")
	}
	// A file others can read is tightened when read.
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	newSvc(t, fixture(), file, nil)
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode after load = %v", fi.Mode().Perm())
	}
}

func TestMalformedFileIsNeverOverwritten(t *testing.T) {
	file := filepath.Join(t.TempDir(), "kaneo.json")
	if err := os.WriteFile(file, []byte("{not json "+key1), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := kaneoconf.New(kaneoconf.Options{File: file})
	if err == nil {
		t.Fatal("a malformed file loaded")
	}
	if strings.Contains(err.Error(), key1) {
		t.Fatal("the load error holds the file's key")
	}
	if b, _ := os.ReadFile(file); !strings.HasPrefix(string(b), "{not json") {
		t.Fatal("the malformed file was changed")
	}
}

// The key is in no view, no error and no Tested result: only key_set.
func TestKeyIsNeverShown(t *testing.T) {
	f := fixture()
	s := newSvc(t, f, "", nil)
	v := connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{})
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), key1) || !strings.Contains(string(b), `"key_set":true`) {
		t.Fatalf("view = %s", b)
	}
	// A connector that echoes the key in an error is scrubbed.
	f.Set(func(f *kaneoconf.FakeConnector) { f.Err = errors.New("GET /api failed: Authorization: Bearer " + key1) })
	_, err := s.Test(context.Background(), kaneoconf.Draft{})
	if err == nil || strings.Contains(err.Error(), key1) {
		t.Fatalf("error = %v", err)
	}
	_, _, err = s.Workspaces(context.Background())
	if err == nil || strings.Contains(err.Error(), key1) {
		t.Fatalf("error = %v", err)
	}
}

func TestGenerationMovesWithTheConnectionOnly(t *testing.T) {
	s := newSvc(t, fixture(), "", nil)
	v := connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{})
	if v.Generation != 1 {
		t.Fatalf("generation = %d", v.Generation)
	}
	// Only the default changes: the floors' boards stay.
	if v = connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{Set: true, ID: ptr("ws2")}); v.Generation != 1 {
		t.Fatalf("generation after a default change = %d", v.Generation)
	}
	// Saving without naming the default keeps it while the key reaches it.
	if v = connect(t, s, "https://tasks.example.test", "", kaneoconf.DefaultArg{}); v.DefaultWorkspace == nil || v.DefaultWorkspace.ID != "ws2" {
		t.Fatalf("default = %+v", v.DefaultWorkspace)
	}
	v, err := s.Clear()
	if err != nil {
		t.Fatal(err)
	}
	if v.State != kaneoconf.StateOff || v.KeySet || v.Generation != 2 || v.DefaultWorkspace != nil {
		t.Fatalf("view after clear = %+v", v)
	}
	if _, ok := s.Link(); ok {
		t.Fatal("a cleared connection still links")
	}
	_, _, err = s.Workspaces(context.Background())
	kind(t, err, kaneoconf.KindNotConfigured)
}

func TestRuntimeUnauthorizedPausesUntilRepaired(t *testing.T) {
	c := &clock{t: time.UnixMilli(1_000_000)}
	f := fixture()
	s := newSvc(t, f, "", c)
	v := connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{})
	until := s.Unauthorized(v.Generation)
	if !until.Equal(c.t.Add(kaneoconf.DefaultCooldown)) {
		t.Fatalf("paused until %v", until)
	}
	if v := s.View(); v.State != kaneoconf.StatePaused || v.PausedUntil != until.UnixMilli() || v.LastError == nil || v.LastError.Kind != kaneoconf.KindUnauthorized {
		t.Fatalf("view = %+v", v)
	}
	if s.Unauthorized(v.Generation+5) != (time.Time{}) {
		t.Fatal("a report of an older generation paused")
	}
	// A test of the saved connection that passes ends the pause.
	if _, err := s.Test(context.Background(), kaneoconf.Draft{}); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); v.State != kaneoconf.StateReady || v.LastError != nil {
		t.Fatalf("view after a passing test = %+v", v)
	}
	s.Unauthorized(v.Generation)
	s.Recovered(v.Generation)
	if s.View().State != kaneoconf.StateReady {
		t.Fatal("a recovered poll did not end the pause")
	}
}

func TestProjectsAndVerify(t *testing.T) {
	c := &clock{t: time.UnixMilli(1_000_000)}
	f := fixture()
	s := newSvc(t, f, "", c)
	_, _, err := s.Projects(context.Background(), "ws1")
	kind(t, err, kaneoconf.KindNotConfigured)
	connect(t, s, "https://tasks.example.test", key1, kaneoconf.DefaultArg{})
	ps, _, err := s.Projects(context.Background(), "ws1")
	if err != nil || len(ps) != 1 || ps[0].ID != "p1" {
		t.Fatalf("projects = %+v, %v", ps, err)
	}
	n := len(f.Calls())
	if _, _, err := s.Projects(context.Background(), "ws1"); err != nil || len(f.Calls()) != n {
		t.Fatal("a list asked again within the cache's time called Kaneo")
	}
	c.t = c.t.Add(time.Minute)
	if _, _, err := s.Projects(context.Background(), "ws1"); err != nil || len(f.Calls()) != n+1 {
		t.Fatal("an old list was not asked again")
	}
	if p, gen, err := s.VerifyProject(context.Background(), "ws1", "p1"); err != nil || p.Name != "Herdr" || gen != s.View().Generation {
		t.Fatalf("verify = %+v (generation %d), %v", p, gen, err)
	}
	_, _, err = s.VerifyProject(context.Background(), "ws2", "p1")
	kind(t, err, kaneoconf.KindBadInput)
	_, _, err = s.VerifyProject(context.Background(), "ws1", "p3")
	kind(t, err, kaneoconf.KindBadInput)
	_, _, err = s.VerifyProject(context.Background(), "ws1", "gone")
	kind(t, err, kaneoconf.KindNotFound)
	f.Set(func(f *kaneoconf.FakeConnector) { f.Err = provider.Errorf(provider.ErrForbidden, "403") })
	_, _, err = s.VerifyProject(context.Background(), "ws1", "p1")
	kind(t, err, kaneoconf.KindForbidden)
}

func TestNoConnectorAnswersUnsupported(t *testing.T) {
	s := newSvc(t, nil, "", nil)
	if v := s.View(); v.Available || v.State != kaneoconf.StateOff {
		t.Fatalf("view = %+v", v)
	}
	_, err := s.Test(context.Background(), kaneoconf.Draft{URL: ptr("https://x.test"), Key: ptr(key1)})
	kind(t, err, kaneoconf.KindUnsupported)
}
