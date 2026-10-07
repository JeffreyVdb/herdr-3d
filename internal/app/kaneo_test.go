package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/kaneo/kaneotest"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

const kaneoTestKey = "kn_app_SECRET_0123456789abcdef"

func ptrStr(s string) *string { return &s }

// kaneoNoKey fails when s holds the key.
func kaneoNoKey(t *testing.T, what, s string) {
	t.Helper()
	if strings.Contains(s, kaneoTestKey) || strings.Contains(s, "SECRET") {
		t.Errorf("the key is in %s", what)
	}
}

// #184: the settings reach a Kaneo instance through internal/kaneo's
// client: the test of an unsaved draft, the lists and the project check
// of a floor's save, with Kaneo's answers turned into the settings' kinds
// (a refused key, a forbidden workspace, a gone, archived or foreign
// project, an instance that cannot be reached), reads only, the key in no
// message.
func TestKaneoConnectorThroughTheSettings(t *testing.T) {
	ctx := context.Background()
	f := kaneotest.New(t, kaneoTestKey)
	svc, floors, err := Kaneo(kaneoconf.Options{File: filepath.Join(t.TempDir(), "kaneo.json")})
	if err != nil || floors == nil || !svc.View().Available {
		t.Fatalf("Kaneo = %v, %v", svc.View(), err)
	}
	var errs []string
	kind := func(err error) kaneoconf.Kind {
		if err != nil {
			errs = append(errs, err.Error())
		}
		return kaneoconf.KindOf(err)
	}

	if _, err := svc.Test(ctx, kaneoconf.Draft{URL: ptrStr(f.URL), Key: ptrStr("not-the-key")}); kind(err) != kaneoconf.KindUnauthorized {
		t.Fatalf("a wrong key = %v", err)
	}
	if _, err := svc.Test(ctx, kaneoconf.Draft{URL: ptrStr(f.URL + "/dashboard/workspace/ws_1"), Key: ptrStr(kaneoTestKey)}); kind(err) != kaneoconf.KindBadURL {
		t.Fatalf("a dashboard link = %v", err)
	}
	// The /api base written either way is the same instance.
	tested, err := svc.Test(ctx, kaneoconf.Draft{URL: ptrStr(f.URL + "/api/"), Key: ptrStr(kaneoTestKey)})
	if err != nil || tested.APIBase != f.URL+"/api" || tested.WebOrigin != f.URL || tested.User != "Alex" ||
		fmt.Sprint(tested.Workspaces) != "[{ws_1 Team team} {ws_2 Side side}]" {
		t.Fatalf("test = %+v, %v", tested, err)
	}
	if _, err := svc.Save(kaneoconf.Draft{URL: ptrStr(f.URL), Key: ptrStr(kaneoTestKey)}, kaneoconf.DefaultArg{Set: true, ID: ptrStr("ws_1")}); err != nil {
		t.Fatal(err)
	}
	ws, _, err := svc.Workspaces(ctx)
	if err != nil || len(ws) != 2 {
		t.Fatalf("workspaces = %+v, %v", ws, err)
	}
	ps, _, err := svc.Projects(ctx, "ws_1")
	if err != nil || len(ps) != 1 || ps[0] != (kaneoconf.Project{ID: "pr_1", WorkspaceID: "ws_1", Name: "Bridge", Slug: "KAN"}) {
		t.Fatalf("projects = %+v, %v", ps, err)
	}
	if p, err := svc.VerifyProject(ctx, "ws_1", "pr_1"); err != nil || p.Name != "Bridge" {
		t.Fatalf("verify = %+v, %v", p, err)
	}
	for project, want := range map[string]kaneoconf.Kind{"pr_old": kaneoconf.KindBadInput, "pr_x": kaneoconf.KindBadInput, "pr_gone": kaneoconf.KindNotFound} {
		if _, err := svc.VerifyProject(ctx, "ws_1", project); kind(err) != want {
			t.Errorf("verify %s = %v, want %s", project, err, want)
		}
	}
	f.Text("GET", "/project", 403, "Forbidden for Bearer "+kaneoTestKey)
	if _, _, err := svc.Projects(ctx, "ws_2"); kind(err) != kaneoconf.KindForbidden {
		t.Fatalf("a forbidden workspace = %v", err)
	}

	gone := kaneotest.New(t, kaneoTestKey)
	url := gone.URL
	gone.Close() // its address refuses connections
	if _, err := svc.Test(ctx, kaneoconf.Draft{URL: ptrStr(url), Key: ptrStr(kaneoTestKey)}); kind(err) != kaneoconf.KindUnreachable {
		t.Fatalf("an unreachable instance = %v", err)
	}

	if w := f.Writes(); len(w) != 0 {
		t.Fatalf("the settings wrote: %+v", w)
	}
	for i, e := range errs {
		kaneoNoKey(t, fmt.Sprintf("error %d", i), e)
	}
}

// #184: KaneoFloors gives a Kaneo floor internal/kaneo's tracker while the
// floor names the saved generation; its identity is the instance, the
// workspace, the project and the generation, never the key; floors of one
// project share it, and a new connection makes new ones.
func TestKaneoFloors(t *testing.T) {
	ctx := context.Background()
	f := kaneotest.New(t, kaneoTestKey)
	svc, floors, err := Kaneo(kaneoconf.Options{File: filepath.Join(t.TempDir(), "kaneo.json")})
	if err != nil {
		t.Fatal(err)
	}
	src := server.BoardSource{Session: "s", Tracker: server.TrackerKaneo, KaneoWorkspace: "ws_1", KaneoProject: "pr_1"}
	if _, _, ok := floors(src); ok {
		t.Fatal("a tracker without a connection")
	}
	save := func(key string) int64 {
		t.Helper()
		d := kaneoconf.Draft{URL: ptrStr(f.URL), Key: ptrStr(key)}
		if _, err := svc.Test(ctx, d); err != nil {
			t.Fatal(err)
		}
		v, err := svc.Save(d, kaneoconf.DefaultArg{})
		if err != nil {
			t.Fatal(err)
		}
		return v.Generation
	}
	gen := save(kaneoTestKey)
	l, _ := svc.Link()
	src.KaneoAPIBase, src.KaneoWebOrigin, src.KaneoGeneration = l.APIBase, l.WebOrigin, gen
	tr, key, ok := floors(src)
	if !ok || tr.Info().ID != "kaneo" || tr.Info().Capabilities.Close || key != fmt.Sprintf("kaneo:%s/api|ws_1|pr_1|g%d", f.URL, gen) {
		t.Fatalf("tracker = %+v %q %v", tr, key, ok)
	}
	kaneoNoKey(t, "the identity", key)
	if again, _, _ := floors(server.BoardSource{Session: "t", Tracker: server.TrackerKaneo, KaneoAPIBase: l.APIBase,
		KaneoGeneration: gen, KaneoWorkspace: "ws_1", KaneoProject: "pr_1"}); again != tr {
		t.Fatal("two floors of one project got two trackers")
	}
	other := src
	other.KaneoProject = "pr_x"
	if tr2, key2, _ := floors(other); tr2 == tr || key2 == key {
		t.Fatal("another project shares the tracker")
	}
	stale := src
	stale.KaneoGeneration = gen - 1
	if _, _, ok := floors(stale); ok {
		t.Fatal("a tracker of another generation")
	}
	before := len(f.Requests())
	if _, _, ok := floors(src); !ok || len(f.Requests()) != before {
		t.Fatal("building a tracker called Kaneo")
	}
	b, err := tr.Board(ctx)
	if err != nil || len(b.Cards) != 7 || b.Columns[0].Kind != "planned" || b.Columns[len(b.Columns)-1].Kind != "archived" ||
		b.Cards[0].URL != f.URL+"/dashboard/workspace/ws_1/project/pr_1/task/task_1" {
		t.Fatalf("board = %+v, %v", b, err)
	}

	// A disconnect and a new connection are a new generation: new
	// trackers, and the old ones are gone.
	if _, err := svc.Clear(); err != nil {
		t.Fatal(err)
	}
	gen2 := save(kaneoTestKey)
	if _, _, ok := floors(src); ok {
		t.Fatal("the old generation still builds")
	}
	src.KaneoGeneration = gen2
	tr3, key3, ok := floors(src)
	if !ok || tr3 == tr || key3 == key || !strings.HasSuffix(key3, fmt.Sprintf("|g%d", gen2)) {
		t.Fatalf("after a new key: %v %q", ok, key3)
	}
	kaneoNoKey(t, "the identity", key3)
	if _, err := svc.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := floors(src); ok {
		t.Fatal("a tracker after the disconnect")
	}
}
