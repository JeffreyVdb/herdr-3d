package server_test

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #247: whether a floor's folder is a checkout of its repo.
func TestRepoCloned(t *testing.T) {
	t.Parallel()
	exists := map[string]bool{"/src/api": true, "/src/api/sub": true, "/src/web": true, "/src/plain": true, "/src/slow": true, "/src/fail": true}
	stat := func(dir string) error {
		if exists[dir] {
			return nil
		}
		return errors.New("no such directory")
	}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	origin := func(ctx context.Context, dir string) string {
		switch dir {
		case "/src/api", "/src/api/sub":
			return "Acme/API"
		case "/src/web":
			return "acme/web"
		case "/src/slow":
			select {
			case <-release:
			case <-ctx.Done():
			}
			return "acme/api"
		}
		return "" // no origin, not GitHub, or the lookup failed
	}
	for _, c := range []struct {
		name, dir, repo string
		want            bool
	}{
		{"a checkout of the repo", "/src/api", "acme/api", true},
		{"a different case and a .git suffix", "/src/api", "ACME/api.git", true},
		{"a subfolder of the checkout", "/src/api/sub", "acme/api", true},
		{"the folder is missing", "/src/gone", "acme/api", false},
		{"a checkout of another repo", "/src/web", "acme/api", false},
		{"no origin", "/src/plain", "acme/api", false},
		{"a lookup that fails", "/src/fail", "acme/api", false},
		{"a lookup that times out", "/src/slow", "acme/api", false},
		{"a folder with no repo", "/src/api", "", false},
		{"a repo with no folder", "", "acme/api", false},
	} {
		if got := server.RepoCloned(context.Background(), c.dir, c.repo, stat, origin, 50*time.Millisecond); got != c.want {
			t.Errorf("%s: cloned = %v, want %v", c.name, got, c.want)
		}
	}
}

// fakeDirs is a StatDir and a RepoOf that a test can change: the folders
// that exist and their origins; lookups of /src/ counted.
type fakeDirs struct {
	mu      sync.Mutex
	exists  map[string]bool
	origins map[string]string
	lookups int
}

func (f *fakeDirs) stat(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.exists[filepath.Clean(dir)] {
		return nil
	}
	return errors.New("no such directory")
}

func (f *fakeDirs) repoOf(_ context.Context, dir string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(dir, "/src/") { // not the suggester's worker cwds
		f.lookups++
	}
	return f.origins[dir]
}

func (f *fakeDirs) set(dir string, exists bool) {
	f.mu.Lock()
	f.exists[dir] = exists
	f.mu.Unlock()
}

// #247: worker.repos lists the other floors of the worker's building with
// a stored repo or folder, in building order; the other buildings and the
// unassigned lot only with the shared switch on.
func TestWorkerRepos(t *testing.T) {
	t.Parallel()
	fd := &fakeDirs{exists: map[string]bool{"/src/api": true, "/src/docs": true, "/src/other": true, "/src/lib": true, "/src/lot": true, "/src/own": true},
		origins: map[string]string{"/src/api": "acme/api", "/src/other": "acme/not-lib"}}
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{StatDir: fd.stat, RepoOf: fd.repoOf})
	c := b.connect(proto.Hello{})
	c.snapshot()
	for _, s := range []string{"own", "api", "web", "docs", "bare", "gone", "suggested", "lib", "lot", "kaneo"} {
		b.floor(s, s != "docs", worker("w-"+s, s, "", "idle")) // docs is asleep: its settings still count
	}
	ids := map[string]string{}
	for len(ids) < 10 {
		if ev := c.event(); ev.T == proto.EvWorkerUpsert {
			ids[ev.Worker.Session] = ev.Worker.ID
		}
	}
	work := createBuilding(c, "Work")
	home := createBuilding(c, "Home")
	// Work in index order: web, own, api, docs, bare, gone, suggested, kaneo. Home: lib. The lot: lot.
	for i, s := range []string{"web", "own", "api", "docs", "bare", "gone", "suggested", "kaneo"} {
		c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: s, Building: &work, Index: ptr(i)})
	}
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "lib", Building: &home})
	set := func(s string, a proto.FloorSettingsArgs) {
		t.Helper()
		a.Session = s
		c.mustAck(proto.CmdFloorSettings, a)
	}
	set("own", proto.FloorSettingsArgs{Repo: proto.Some("acme/own"), DefaultCwd: proto.Some("/src/own")})
	set("api", proto.FloorSettingsArgs{Repo: proto.Some("acme/api"), DefaultCwd: proto.Some("/src/api")})
	set("web", proto.FloorSettingsArgs{Repo: proto.Some("acme/web")})
	set("docs", proto.FloorSettingsArgs{DefaultCwd: proto.Some("/src/docs")})
	set("lib", proto.FloorSettingsArgs{Repo: proto.Some("acme/lib"), DefaultCwd: proto.Some("/src/other")})
	set("lot", proto.FloorSettingsArgs{DefaultCwd: proto.Some("/src/lot")})
	// A Kaneo floor keeps its GitHub repo, and it is still its repo.
	set("kaneo", proto.FloorSettingsArgs{Repo: proto.Some("acme/board")})
	// A folder-only floor whose folder went missing after it was stored is hidden.
	fd.set("/src/gone-soon", true)
	set("gone", proto.FloorSettingsArgs{DefaultCwd: proto.Some("/src/gone-soon")})
	fd.set("/src/gone-soon", false)
	// "suggested" has no stored settings: whatever the bridge suggests for it is not listed.

	work1, home1 := "Work", "Home"
	ask := func(id string) []proto.RepoRef {
		t.Helper()
		_, m := c.command(proto.CmdWorkerRepos, "r-"+id, proto.WorkerReposArgs{ID: id})
		got := ackData[proto.WorkerRepos](t, m)
		if got.Repos == nil {
			t.Fatalf("repos is null: %s", m.raw)
		}
		return got.Repos
	}
	same := []proto.RepoRef{
		{Session: "web", Building: &work1, SameBuilding: true, Repo: "acme/web"},
		{Session: "api", Building: &work1, SameBuilding: true, Repo: "acme/api", Dir: "/src/api", Cloned: true},
		{Session: "docs", Building: &work1, SameBuilding: true, Dir: "/src/docs"},
		{Session: "kaneo", Building: &work1, SameBuilding: true, Repo: "acme/board"},
	}
	if got := ask(ids["own"]); !reflect.DeepEqual(got, same) {
		t.Fatalf("own floor's repos:\n got %+v\nwant %+v", got, same)
	}
	_, m := c.command(proto.CmdWorkerRepos, "shape", proto.WorkerReposArgs{ID: ids["web"]})
	if !strings.Contains(string(m.raw), `{"session":"own","building":"Work","same_building":true,"repo":"acme/own","dir":"/src/own","cloned":false}`) {
		t.Errorf("shape: %s", m.raw)
	}
	// An unassigned worker's floor is in no building: nothing, with the switch off.
	if got := ask(ids["lot"]); len(got) != 0 {
		t.Fatalf("unassigned, switch off: %+v", got)
	}

	// The switch on: the other buildings by sort, then the lot by name.
	evs, sm := c.command(proto.CmdRepoRefsSet, "on", proto.RepoRefsSetArgs{AllBuildings: ptr(true)})
	if sm.env.T != proto.TAck || len(evs) != 1 || evs[0].T != proto.EvRepoRefsUpdate || !strings.Contains(string(sm.raw), `"all_buildings":true`) {
		t.Fatalf("set: %s, events %+v", sm.raw, evs)
	}
	all := append(append([]proto.RepoRef{}, same...),
		proto.RepoRef{Session: "lib", Building: &home1, Repo: "acme/lib", Dir: "/src/other"},
		proto.RepoRef{Session: "lot", Dir: "/src/lot"})
	if got := ask(ids["own"]); !reflect.DeepEqual(got, all) {
		t.Fatalf("switch on:\n got %+v\nwant %+v", got, all)
	}
	lot := []proto.RepoRef{
		{Session: "own", Building: &work1, Repo: "acme/own", Dir: "/src/own"},
		{Session: "web", Building: &work1, Repo: "acme/web"},
		{Session: "api", Building: &work1, Repo: "acme/api", Dir: "/src/api", Cloned: true},
		{Session: "docs", Building: &work1, Dir: "/src/docs"},
		{Session: "kaneo", Building: &work1, Repo: "acme/board"},
		{Session: "lib", Building: &home1, Repo: "acme/lib", Dir: "/src/other"},
	}
	// From the lot, every building is another one: Work's floors come in building order.
	if got := ask(ids["lot"]); !reflect.DeepEqual(got, reorder(lot, "web", "own", "api", "docs", "kaneo", "lib")) {
		t.Fatalf("unassigned, switch on:\n got %+v", got)
	}

	// Origins are reused briefly: the asks above looked each folder up once.
	fd.mu.Lock()
	n := fd.lookups
	fd.mu.Unlock()
	if n != 3 { // /src/api, /src/own, /src/other
		t.Errorf("lookups = %d, want 3", n)
	}

	// Errors.
	c.mustError(proto.CmdWorkerRepos, proto.WorkerReposArgs{ID: "nope"}, proto.ErrUnknownWorker)
	c.mustError(proto.CmdWorkerRepos, map[string]any{"id": ids["own"], "query": "x"}, proto.ErrBadRequest)
	c.mustError(proto.CmdRepoRefsSet, map[string]any{}, proto.ErrBadRequest)
}

// reorder returns refs with the given sessions first, in that order.
func reorder(refs []proto.RepoRef, sessions ...string) []proto.RepoRef {
	out := make([]proto.RepoRef, 0, len(refs))
	for _, s := range sessions {
		for _, r := range refs {
			if r.Session == s {
				out = append(out, r)
			}
		}
	}
	return out
}

// #247: the shared switch is off by default, survives a restart, and a
// change goes to every client (audited).
func TestRepoRefsSwitch(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	a := b.connect(proto.Hello{Client: "a"})
	if rr := a.snapshot().World.RepoRefs; rr == nil || rr.AllBuildings {
		t.Fatalf("fresh switch = %+v", rr)
	}
	other := b.connect(proto.Hello{Client: "other"})
	other.snapshot()
	_, ack := a.mustAck(proto.CmdRepoRefsGet, nil)
	if ack.Data.(map[string]any)["all_buildings"] != false {
		t.Fatalf("get = %+v", ack.Data)
	}
	evs, _ := a.mustAck(proto.CmdRepoRefsSet, proto.RepoRefsSetArgs{AllBuildings: ptr(true)})
	if len(evs) != 1 || evs[0].T != proto.EvRepoRefsUpdate {
		t.Fatalf("set events = %+v", evs)
	}
	if m := other.next(); m.env.T != proto.EvRepoRefsUpdate || !strings.Contains(string(m.raw), `"all_buildings":true`) {
		t.Fatalf("other client heard %s", m.raw)
	}
	// The same value again: nothing to publish.
	if evs, _ := a.mustAck(proto.CmdRepoRefsSet, proto.RepoRefsSetArgs{AllBuildings: ptr(true)}); len(evs) != 0 {
		t.Fatalf("no-op events = %+v", evs)
	}
	if row := auditRow(t, b, proto.CmdRepoRefsSet); !row.Done || !row.OK {
		t.Errorf("audit = %+v", row)
	}
	b.stop()

	b2 := startBridge(t, db, server.Options{})
	if rr := b2.connect(proto.Hello{}).snapshot().World.RepoRefs; rr == nil || !rr.AllBuildings {
		t.Fatalf("after restart = %+v", rr)
	}
}
