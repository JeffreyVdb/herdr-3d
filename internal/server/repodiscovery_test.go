package server_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// gitRepo makes a repository with a commit at dir, with origin ("": none).
func gitRepo(t *testing.T, dir, origin string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("commit", "-q", "--allow-empty", "-m", "one")
	if origin != "" {
		run("remote", "add", "origin", origin)
	}
	return dir
}

func discoveryService(t *testing.T) *repodisc.Service {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	svc := repodisc.New(ctx, repodisc.Options{Git: &gitops.Git{Timeout: repodisc.DefaultGitTimeout}})
	t.Cleanup(func() {
		cancel()
		svc.Wait()
	})
	return svc
}

func discoveryOf(t *testing.T, raw json.RawMessage) proto.RepoDiscovery {
	t.Helper()
	var v proto.RepoDiscovery
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// #54: the discovery settings: off with the default interval until set,
// checked field by field, published to every client, kept over a restart;
// a scan's repositories in worker.repos and hire.repos with the floors'.
func TestRepoDiscovery(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dev := filepath.Join(root, "dev ü")
	x := gitRepo(t, filepath.Join(dev, "org", "x"), "git@github.com:Acme/X.git")
	local := gitRepo(t, filepath.Join(dev, "local"), "")

	db := filepath.Join(t.TempDir(), "world.db")
	fd := &fakeDirs{exists: map[string]bool{"/src/w": true}, origins: map[string]string{}}
	b := startBridge(t, db, server.Options{StatDir: fd.stat, RepoOf: fd.repoOf, RepoDiscovery: discoveryService(t)})
	a := b.connect(proto.Hello{Client: "a"})
	snap := a.snapshot().World.RepoDiscovery
	if snap == nil || len(snap.Roots) != 0 || snap.IntervalMinutes != 10 || snap.Status.State != proto.RepoDiscoveryOff {
		t.Fatalf("fresh = %+v", snap)
	}
	other := b.connect(proto.Hello{Client: "other"})
	other.snapshot()

	// Field-specific refusals; nothing stored.
	for _, c := range []struct {
		args any
		want string
	}{
		{map[string]any{}, "roots or interval_minutes is required"},
		{proto.RepoDiscoverySetArgs{Roots: &[]string{"dev"}}, "Scan folder 1 must be an absolute path"},
		{proto.RepoDiscoverySetArgs{Roots: &[]string{dev, dev + "/"}}, "Scan folder 2 is the same as folder 1"},
		{proto.RepoDiscoverySetArgs{IntervalMinutes: ptr(0)}, "from 1 to 1440"},
		{map[string]any{"roots": []string{dev}, "depth": 3}, "unknown field"},
	} {
		_, m := a.command(proto.CmdRepoDiscoverySet, "bad", c.args)
		if m.env.T != proto.TError || !strings.Contains(string(m.raw), proto.ErrBadRequest) || !strings.Contains(string(m.raw), c.want) {
			t.Errorf("set %+v: %s", c.args, m.raw)
		}
	}

	// The floors: one names x's repository (not cloned), one a plain folder.
	for _, s := range []string{"own", "url", "plain"} {
		b.floor(s, true, worker("w-"+s, s, "", "idle"))
	}
	ids := map[string]string{}
	for len(ids) < 3 {
		if ev := a.event(); ev.T == proto.EvWorkerUpsert {
			ids[ev.Worker.Session] = ev.Worker.ID
		}
	}
	work := createBuilding(a, "Work")
	for i, s := range []string{"own", "url", "plain"} {
		a.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: s, Building: &work, Index: ptr(i)})
	}
	a.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "url", Repo: proto.Some("acme/x")})
	a.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "plain", DefaultCwd: proto.Some("/src/w")})

	evs, ack := a.mustAck(proto.CmdRepoDiscoverySet, proto.RepoDiscoverySetArgs{Roots: &[]string{dev + "/"}, IntervalMinutes: ptr(25)})
	set := discoveryOf(t, mustMarshal(t, ack.Data))
	if !reflect.DeepEqual(set.Roots, []string{dev}) || set.IntervalMinutes != 25 || len(set.Status.Roots) != 1 {
		t.Fatalf("set ack = %+v", set)
	}
	heard := false
	for _, e := range evs {
		heard = heard || e.T == proto.EvRepoDiscoveryUpdate
	}
	if !heard {
		t.Fatalf("set events = %+v", evs)
	}
	for {
		if m := other.next(); m.env.T == proto.EvRepoDiscoveryUpdate {
			if !strings.Contains(string(m.raw), `"interval_minutes":25`) {
				t.Fatalf("other heard %s", m.raw)
			}
			break
		}
	}
	if row := auditRow(t, b, proto.CmdRepoDiscoverySet); !row.Done || !row.OK {
		t.Errorf("audit = %+v", row)
	}

	// The scan ends; its repositories merge with the floors'.
	var v proto.RepoDiscovery
	for deadline := time.Now().Add(10 * time.Second); ; {
		_, ack := a.mustAck(proto.CmdRepoDiscoveryGet, nil)
		v = discoveryOf(t, mustMarshal(t, ack.Data))
		if v.Status.State == proto.RepoDiscoveryIdle && v.Status.Repositories == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no scan: %+v", v)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if v.Status.Roots[0].State != proto.RepoRootOK || v.Status.Roots[0].Checkouts != 2 || v.Status.LastSuccessAt == nil {
		t.Fatalf("after the scan: %+v", v.Status)
	}
	work1 := "Work"
	want := []proto.RepoRef{
		{ID: "gh:acme/x", Source: "floor", Session: "url", Floor: "url", Building: &work1, SameBuilding: true, Repo: "acme/x", Dir: x, Cloned: true, Checkouts: 1},
		{ID: "dir:/src/w", Source: "floor", Session: "plain", Floor: "plain", Building: &work1, SameBuilding: true, Dir: "/src/w"},
		{ID: "git:" + filepath.Join(local, ".git"), Source: "discovered", Dir: local, Checkouts: 1},
	}
	repos := func(cmd string, args any) []proto.RepoRef {
		t.Helper()
		_, m := a.command(cmd, "r", args)
		return ackData[proto.WorkerRepos](t, m).Repos
	}
	if got := repos(proto.CmdWorkerRepos, proto.WorkerReposArgs{ID: ids["own"]}); !reflect.DeepEqual(got, want) {
		t.Fatalf("worker.repos:\n got %+v\nwant %+v", got, want)
	}
	if got := repos(proto.CmdHireRepos, proto.HireReposArgs{Session: "own"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("hire.repos:\n got %+v\nwant %+v", got, want)
	}

	// A new clone shows after a refresh: the revision moves (an open popup asks again).
	gitRepo(t, filepath.Join(dev, "new"), "")
	rev := v.Status.Revision
	a.mustAck(proto.CmdRepoDiscoveryRefresh, nil)
	for deadline := time.Now().Add(10 * time.Second); ; {
		m := other.next()
		if m.env.T == proto.EvRepoDiscoveryUpdate {
			var u proto.RepoDiscoveryUpdate
			if err := json.Unmarshal(m.raw, &u); err != nil {
				t.Fatal(err)
			}
			if u.Status.Revision > rev && u.Status.Repositories == 3 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("no new revision")
		}
	}
	// Removing the root takes its repositories away at once.
	a.mustAck(proto.CmdRepoDiscoverySet, proto.RepoDiscoverySetArgs{Roots: &[]string{}})
	if got := repos(proto.CmdWorkerRepos, proto.WorkerReposArgs{ID: ids["own"]}); len(got) != 2 || got[0].Dir != "" || got[0].Cloned {
		t.Fatalf("after removing the root: %+v", got)
	}
	a.mustAck(proto.CmdRepoDiscoverySet, proto.RepoDiscoverySetArgs{Roots: &[]string{dev, "/nowhere"}})
	b.stop()

	// Over a restart: the settings, and the first scan from them (the
	// missing root an error, the other fine).
	b2 := startBridge(t, db, server.Options{StatDir: fd.stat, RepoOf: fd.repoOf, RepoDiscovery: discoveryService(t)})
	c := b2.connect(proto.Hello{})
	if rd := c.snapshot().World.RepoDiscovery; rd == nil || !reflect.DeepEqual(rd.Roots, []string{dev, "/nowhere"}) || rd.IntervalMinutes != 25 {
		t.Fatalf("after restart = %+v", rd)
	}
	for deadline := time.Now().Add(10 * time.Second); ; {
		_, ack := c.mustAck(proto.CmdRepoDiscoveryGet, nil)
		v = discoveryOf(t, mustMarshal(t, ack.Data))
		if v.Status.State == proto.RepoDiscoveryIdle && len(v.Status.Roots) == 2 && v.Status.Roots[1].State == proto.RepoRootError {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no scan after restart: %+v", v)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if v.Status.Roots[0].State != proto.RepoRootOK || v.Status.Repositories != 3 || !strings.Contains(v.Status.Roots[1].Error, "does not exist") {
		t.Fatalf("after restart: %+v", v.Status)
	}
}

// A bridge without discovery: no repo_discovery in the snapshot, the
// commands unsupported, worker.repos the floors only.
func TestRepoDiscoveryUnsupported(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	if rd := c.snapshot().World.RepoDiscovery; rd != nil {
		t.Fatalf("snapshot has %+v", rd)
	}
	c.mustError(proto.CmdRepoDiscoveryGet, nil, proto.ErrUnsupported)
	c.mustError(proto.CmdRepoDiscoverySet, proto.RepoDiscoverySetArgs{Roots: &[]string{"/x"}}, proto.ErrUnsupported)
	c.mustError(proto.CmdRepoDiscoveryRefresh, nil, proto.ErrUnsupported)
}
