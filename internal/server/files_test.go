package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakeFiles plays fileindex.Index: one match per ask echoing it, asks
// recorded, dirs that hang until released.
type fakeFiles struct {
	mu   sync.Mutex
	asks []string // "dir|query|limit"
	fail bool
	hang map[string]chan struct{}
}

func (f *fakeFiles) Files(ctx context.Context, dir, query string, limit int) (*proto.WorkerFiles, error) {
	f.mu.Lock()
	f.asks = append(f.asks, fmt.Sprintf("%s|%s|%d", dir, query, limit))
	fail, hang := f.fail, f.hang[dir]
	f.mu.Unlock()
	if hang != nil {
		select {
		case <-hang:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if fail {
		return nil, errors.New("listing failed: git ls-files: boom")
	}
	return &proto.WorkerFiles{Files: []proto.FileMatch{{Path: "docs/my file #1?.md", Kind: proto.FileKindFile, Indices: []int{5, 6}}},
		Source: proto.FilesSourceGit}, nil
}

func TestWorkerFiles(t *testing.T) {
	release := make(chan struct{})
	ff := &fakeFiles{hang: map[string]chan struct{}{"/home/u/slow": release}}
	b := startBridge(t, "", server.Options{Files: ff})
	c := b.connect(proto.Hello{})
	c.snapshot()
	wt := worker("w2", "b", "", "idle")
	wt.Worktree = &proto.Worktree{RepoRoot: "/home/u/repo", CheckoutPath: "/home/u/repo-wt", Linked: true}
	slow := worker("w5", "slow", "", "working")
	slow.Cwd = "/home/u/slow"
	noCwd := worker("w6", "nocwd", "", "idle")
	noCwd.Cwd = ""
	b.floor("s1", true, worker("w1", "a", "", "idle"), wt, slow, noCwd)
	b.floor("s2", false, worker("w4", "d", "", "unknown"))
	ids := map[string]string{}
	for len(ids) < 5 {
		if ev := c.event(); ev.T == proto.EvWorkerUpsert {
			ids[ev.Worker.WorkspaceID] = ev.Worker.ID
		}
	}

	_, m := c.command(proto.CmdWorkerFiles, "f1", proto.WorkerFilesArgs{ID: ids["w1"], Query: "my file"})
	got := ackData[proto.WorkerFiles](t, m)
	if len(got.Files) != 1 || got.Files[0].Path != "docs/my file #1?.md" || got.Source != proto.FilesSourceGit {
		t.Fatalf("ack = %+v", got)
	}
	if !strings.Contains(string(m.raw), `"files":[{"path":"docs/my file #1?.md","kind":"file","indices":[5,6]}],"source":"git","reason":null`) {
		t.Errorf("shape: %s", m.raw)
	}
	// limit: absent 30, 0 30, over 100 clamped, a worktree's checkout.
	c.command(proto.CmdWorkerFiles, "f2", map[string]any{"id": ids["w2"], "query": "", "limit": 0})
	c.command(proto.CmdWorkerFiles, "f3", proto.WorkerFilesArgs{ID: ids["w1"], Query: "x", Limit: 500})
	c.command(proto.CmdWorkerFiles, "f4", proto.WorkerFilesArgs{ID: ids["w1"], Query: "x", Limit: 7})
	c.command(proto.CmdWorkerFiles, "f5", proto.WorkerFilesArgs{ID: ids["w1"], Query: strings.Repeat("é", proto.FilesMaxQuery)})

	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: ids["w1"], Limit: -1}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: ids["w1"], Query: strings.Repeat("a", proto.FilesMaxQuery+1)},
		proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerFiles, map[string]any{"id": ids["w1"], "cwd": "/etc"}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: "nope"}, proto.ErrUnknownWorker)
	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: ids["w4"]}, proto.ErrInvalidState) // floor asleep
	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: ids["w6"]}, proto.ErrInvalidState) // no directory
	if row := auditRow(t, b, proto.CmdWorkerFiles); !row.Done || row.OK {
		t.Errorf("audit = %+v", row)
	}

	// The index runs off the hub: a slow one holds up nothing else.
	c.send(proto.Command{T: proto.CmdWorkerFiles, ReqID: "slow", Args: json.RawMessage(`{"id":"` + ids["w5"] + `","query":"a"}`)})
	evs, m := c.command(proto.CmdBuildingCreate, "b1", proto.BuildingCreateArgs{Name: "Work"})
	if m.env.T != proto.TAck || len(evs) != 1 {
		t.Fatalf("building.create behind a slow worker.files: %s", m.raw)
	}
	close(release)
	if m := c.next(); m.env.T != proto.TAck || m.env.ReqID != "slow" {
		t.Fatalf("slow reply = %s", m.raw)
	}

	ff.mu.Lock()
	asks := strings.Join(ff.asks, ", ")
	ff.mu.Unlock()
	if want := "/home/u/w1|my file|30, /home/u/repo-wt||30, /home/u/w1|x|100, /home/u/w1|x|7, /home/u/w1|" +
		strings.Repeat("é", proto.FilesMaxQuery) + "|30, /home/u/slow|a|30"; asks != want {
		t.Errorf("asks = %q\nwant %q", asks, want)
	}

	// No index at all: files_failed.
	ff.mu.Lock()
	ff.fail = true
	ff.mu.Unlock()
	c.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: ids["w1"], Query: "a"}, proto.ErrFilesFailed)

	// Not configured: internal.
	b2 := startBridge(t, "", server.Options{})
	c2 := b2.connect(proto.Hello{})
	c2.snapshot()
	b2.floor("s1", true, worker("w1", "a", "", "idle"))
	c2.mustError(proto.CmdWorkerFiles, proto.WorkerFilesArgs{ID: c2.until(proto.EvWorkerUpsert).Worker.ID}, proto.ErrInternal)
}
