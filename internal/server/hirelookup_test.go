package server_test

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #39: hire.commands and hire.files look up the folder a hire would get
// (the asked cwd, else the floor's default; a worktree hire's repository
// root), validated as worker.hire validates them, while another hire is in
// flight on the floor.
func TestHireLookups(t *testing.T) {
	t.Parallel()
	fc := &fakeCatalog{}
	ff := &fakeFiles{}
	hb := startHireBridge(t, func(o *server.Options) {
		o.Commands, o.Files = fc, ff
	})
	hb.git.repos["/home/u/repo/sub"] = "/home/u/repo"
	hb.floor("s2", false, worker("w9", "asleep", "", "unknown"))

	// A hire in flight on the floor (held at its workspace): lookups still answer.
	gate := make(chan struct{})
	hb.fl.createGate = gate
	hb.c.send(proto.Command{T: proto.CmdWorkerHire, ReqID: "held", Args: mustRaw(hireArgs(1))})
	for deadline := time.Now().Add(5 * time.Second); !slices.ContainsFunc(hb.fl.Calls(), func(s string) bool { return strings.HasPrefix(s, "create ") }); {
		if time.Now().After(deadline) {
			t.Fatal("the hire never reached its workspace")
		}
		time.Sleep(5 * time.Millisecond)
	}
	c := hb.connect(proto.Hello{Client: "lookups"})
	c.snapshot()

	_, m := c.command(proto.CmdHireCommands, "c1", proto.HireCommandsArgs{Session: "s", Harness: "codex"})
	if got := ackData[proto.WorkerCommands](t, m); len(got.Commands) != 1 || got.Commands[0].Name != "codex-skill" {
		t.Fatalf("hire.commands = %s", m.raw)
	}
	c.mustAck(proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "claude", Cwd: "/home/u/repo/sub/"})
	c.mustAck(proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "codex", Cwd: "/home/u/repo/sub", Worktree: true})
	_, m = c.command(proto.CmdHireFiles, "f1", proto.HireFilesArgs{Session: "s", Query: "my"})
	if got := ackData[proto.WorkerFiles](t, m); len(got.Files) != 1 || got.Source != proto.FilesSourceGit {
		t.Fatalf("hire.files = %s", m.raw)
	}
	c.mustAck(proto.CmdHireFiles, proto.HireFilesArgs{Session: "s", Cwd: "/home/u/repo/sub", Worktree: true, Query: "x", Limit: 500})
	c.mustAck(proto.CmdHireFiles, map[string]any{"session": "s", "query": "", "limit": 0})

	// The floor's default (the home directory here), a clean cwd, the worktree's repository root.
	fc.mu.Lock()
	asks := strings.Join(fc.asks, ", ")
	fc.mu.Unlock()
	if asks != "codex /home/u, claude /home/u/repo/sub, codex /home/u/repo" {
		t.Errorf("catalog asks = %q", asks)
	}
	ff.mu.Lock()
	fasks := strings.Join(ff.asks, ", ")
	ff.mu.Unlock()
	if fasks != "/home/u|my|30, /home/u/repo|x|100, /home/u||30" {
		t.Errorf("file asks = %q", fasks)
	}

	for _, bad := range []struct {
		cmd  string
		args any
		code string
	}{
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "nope", Harness: "claude"}, proto.ErrUnknownSession},
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s2", Harness: "claude"}, proto.ErrInvalidState},
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "bash"}, proto.ErrBadRequest},
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s"}, proto.ErrBadRequest},
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "claude", Cwd: "rel/dir"}, proto.ErrBadRequest},
		{proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "claude", Cwd: "/tmp", Worktree: true}, proto.ErrBadRequest},
		{proto.CmdHireCommands, map[string]any{"session": "s", "harness": "claude", "id": "w1"}, proto.ErrBadRequest},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "nope"}, proto.ErrUnknownSession},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "s2"}, proto.ErrInvalidState},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "s", Cwd: "rel"}, proto.ErrBadRequest},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "s", Cwd: "/tmp", Worktree: true}, proto.ErrBadRequest},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "s", Limit: -1}, proto.ErrBadRequest},
		{proto.CmdHireFiles, proto.HireFilesArgs{Session: "s", Query: strings.Repeat("é", proto.FilesMaxQuery+1)}, proto.ErrBadRequest},
	} {
		c.mustError(bad.cmd, bad.args, bad.code)
	}

	// The held hire goes on as if nothing was asked.
	close(gate)
	for {
		if m := hb.c.next(); m.env.T == proto.TAck || m.env.T == proto.TError {
			if m.env.T != proto.TAck || m.env.ReqID != "held" {
				t.Fatalf("held hire: %s", m.raw)
			}
			break
		}
	}

	// Not configured: internal, as worker.commands and worker.files.
	plain := startHireBridge(t, nil)
	plain.c.mustError(proto.CmdHireCommands, proto.HireCommandsArgs{Session: "s", Harness: "claude"}, proto.ErrInternal)
	plain.c.mustError(proto.CmdHireFiles, proto.HireFilesArgs{Session: "s"}, proto.ErrInternal)
}

// #39: hire.repos is worker.repos for a worker of the floor: the same
// scope (its own floor left out, its building first), on an asleep floor too.
func TestHireRepos(t *testing.T) {
	t.Parallel()
	fd := &fakeDirs{exists: map[string]bool{"/src/api": true, "/src/lib": true, "/src/own": true},
		origins: map[string]string{"/src/api": "acme/api"}}
	b := startBridge(t, filepath.Join(t.TempDir(), "world.db"), server.Options{StatDir: fd.stat, RepoOf: fd.repoOf})
	c := b.connect(proto.Hello{})
	c.snapshot()
	for _, s := range []string{"own", "api", "lib"} {
		b.floor(s, s != "own", worker("w-"+s, s, "", "idle"))
	}
	ids := map[string]string{}
	for len(ids) < 3 {
		if ev := c.event(); ev.T == proto.EvWorkerUpsert {
			ids[ev.Worker.Session] = ev.Worker.ID
		}
	}
	work := createBuilding(c, "Work")
	home := createBuilding(c, "Home")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "own", Building: &work, Index: ptr(0)})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "api", Building: &work, Index: ptr(1)})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "lib", Building: &home})
	for s, a := range map[string]proto.FloorSettingsArgs{
		"own": {Repo: proto.Some("acme/own"), DefaultCwd: proto.Some("/src/own")},
		"api": {Repo: proto.Some("acme/api"), DefaultCwd: proto.Some("/src/api")},
		"lib": {DefaultCwd: proto.Some("/src/lib")},
	} {
		a.Session = s
		c.mustAck(proto.CmdFloorSettings, a)
	}
	repos := func(cmd string, args any) []proto.RepoRef {
		t.Helper()
		_, m := c.command(cmd, "r", args)
		got := ackData[proto.WorkerRepos](t, m)
		if got.Repos == nil {
			t.Fatalf("%s: repos is null: %s", cmd, m.raw)
		}
		return got.Repos
	}
	check := func() {
		t.Helper()
		for s, id := range ids {
			hire, worker := repos(proto.CmdHireRepos, proto.HireReposArgs{Session: s}), repos(proto.CmdWorkerRepos, proto.WorkerReposArgs{ID: id})
			if !reflect.DeepEqual(hire, worker) {
				t.Errorf("%s: hire.repos %+v, worker.repos %+v", s, hire, worker)
			}
			if slices.ContainsFunc(hire, func(r proto.RepoRef) bool { return r.Session == s }) {
				t.Errorf("%s lists itself: %+v", s, hire)
			}
		}
	}
	// "own" is asleep: its floor's lookups still answer (stored settings only).
	if got := repos(proto.CmdHireRepos, proto.HireReposArgs{Session: "own"}); len(got) != 1 || got[0].Session != "api" || !got[0].Cloned {
		t.Fatalf("own's repos = %+v", got)
	}
	check()
	c.mustAck(proto.CmdRepoRefsSet, proto.RepoRefsSetArgs{AllBuildings: ptr(true)})
	if got := repos(proto.CmdHireRepos, proto.HireReposArgs{Session: "own"}); len(got) != 2 || got[1].Session != "lib" {
		t.Fatalf("own's repos, every building = %+v", got)
	}
	check()

	c.mustError(proto.CmdHireRepos, proto.HireReposArgs{Session: "nope"}, proto.ErrUnknownSession)
	c.mustError(proto.CmdHireRepos, map[string]any{"session": "own", "query": "x"}, proto.ErrBadRequest)
}
