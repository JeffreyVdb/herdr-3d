package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakeChanges plays gitops.Git.Changes: a result or an error per dir, and
// dirs that hang until released.
type fakeChanges struct {
	mu      sync.Mutex
	results map[string]*proto.WorkerChanges
	errs    map[string]error
	hang    map[string]chan struct{}
	dirs    []string
}

func (f *fakeChanges) Changes(ctx context.Context, dir string) (*proto.WorkerChanges, error) {
	f.mu.Lock()
	f.dirs = append(f.dirs, dir)
	res, err, hang := f.results[dir], f.errs[dir], f.hang[dir]
	f.mu.Unlock()
	if hang != nil {
		select {
		case <-hang:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, err
	}
	if res == nil {
		return nil, gitops.ErrNotRepo
	}
	return res, nil
}

func TestWorkerChanges(t *testing.T) {
	branch := "feat/x"
	want := &proto.WorkerChanges{Cwd: "/home/u/w1", Branch: &branch, Head: strings.Repeat("a", 40), Ahead: 1,
		Base:  &proto.ChangesBase{Ref: "origin/main", SHA: strings.Repeat("b", 40)},
		Files: []proto.ChangedFile{{Path: "a.go", Index: ".", Worktree: "M", Insertions: 2, Deletions: 1}},
		Stat:  proto.ChangesStat{Files: 1, Insertions: 2, Deletions: 1}, Diff: "diff --git a/a.go b/a.go\n", DiffBytes: 25,
		Omitted: []string{}}
	release := make(chan struct{})
	fc := &fakeChanges{
		results: map[string]*proto.WorkerChanges{"/home/u/w1": want, "/home/u/slow": want},
		errs: map[string]error{"/home/u/w3": fmt.Errorf("%w (10s): git status: timed out after 10s",
			gitops.ErrChangesTimeout)},
		hang: map[string]chan struct{}{"/home/u/slow": release},
	}
	b := startBridge(t, "", server.Options{Changes: fc})
	slow := worker("w5", "slow", "", "working")
	slow.Cwd = "/home/u/slow"
	noCwd := worker("w6", "nocwd", "", "idle")
	noCwd.Cwd = ""
	b.floor("s1", true, worker("w1", "a", "", "idle"), worker("w2", "b", "", "idle"), worker("w3", "c", "", "idle"), slow, noCwd)
	b.floor("s2", false, worker("w4", "d", "", "unknown"))
	c := b.connect(proto.Hello{})
	ids := map[string]string{}
	for _, w := range c.snapshot().World.Workers {
		ids[w.WorkspaceID] = w.ID
	}

	_, m := c.command(proto.CmdWorkerChanges, "c1", proto.WorkerArgs{ID: ids["w1"]})
	var ack struct {
		T    string              `json:"t"`
		Data proto.WorkerChanges `json:"data"`
	}
	if err := json.Unmarshal(m.raw, &ack); err != nil || ack.T != proto.TAck {
		t.Fatalf("reply = %s", m.raw)
	}
	if !reflect.DeepEqual(ack.Data, *want) {
		t.Fatalf("ack data = %+v\nwant %+v", ack.Data, *want)
	}
	if !strings.Contains(string(m.raw), `"upstream":null`) || !strings.Contains(string(m.raw), `"index":".","worktree":"M"`) {
		t.Errorf("shape: %s", m.raw)
	}

	c.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: "nope"}, proto.ErrUnknownWorker)
	c.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: ids["w2"]}, proto.ErrNotARepo)
	c.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: ids["w3"]}, proto.ErrChangesFailed)
	c.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: ids["w4"]}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: ids["w6"]}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerChanges, map[string]any{"id": ids["w1"], "cwd": "/etc"}, proto.ErrBadRequest)
	if row := auditRow(t, b, proto.CmdWorkerChanges); !row.Done || row.OK || !strings.Contains(row.Error, "bad args") {
		t.Errorf("audit = %+v", row)
	}

	// Git runs off the hub: a slow one holds up nothing else.
	c.send(proto.Command{T: proto.CmdWorkerChanges, ReqID: "slow", Args: json.RawMessage(`{"id":"` + ids["w5"] + `"}`)})
	evs, m := c.command(proto.CmdBuildingCreate, "b1", proto.BuildingCreateArgs{Name: "Work"})
	if m.env.T != proto.TAck || len(evs) != 1 {
		t.Fatalf("building.create behind a slow worker.changes: %s", m.raw)
	}
	close(release)
	if m := c.next(); m.env.T != proto.TAck || m.env.ReqID != "slow" {
		t.Fatalf("slow reply = %s", m.raw)
	}
	// Only ever the bridge's own record of the worker's directory.
	fc.mu.Lock()
	dirs := fc.dirs
	fc.mu.Unlock()
	if strings.Join(dirs, " ") != "/home/u/w1 /home/u/w2 /home/u/w3 /home/u/slow" {
		t.Errorf("dirs = %q", dirs)
	}

	// Not configured: internal.
	b2 := startBridge(t, "", server.Options{})
	b2.floor("s1", true, worker("w1", "a", "", "idle"))
	c2 := b2.connect(proto.Hello{})
	id := c2.snapshot().World.Workers[0].ID
	c2.mustError(proto.CmdWorkerChanges, proto.WorkerArgs{ID: id}, proto.ErrInternal)
}
