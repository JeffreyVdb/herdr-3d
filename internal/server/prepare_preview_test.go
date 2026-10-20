package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// slowFetch is the time a slow origin takes to answer `git fetch origin`.
const slowFetch = 250 * time.Millisecond

// slowFetchGit is a fakeGit whose fetch takes slowFetch: a slow origin,
// without a network or credentials.
type slowFetchGit struct{ *fakeGit }

func (g slowFetchGit) Fetch(ctx context.Context, dir string) error {
	select {
	case <-time.After(slowFetch):
		return g.fakeGit.Fetch(ctx, dir)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// previewBridge is launchBridge (floor "s" in the repository /home/u/lab)
// with an origin whose fetch is slow.
func previewBridge(t *testing.T) (*hireBridge, proto.World) {
	t.Helper()
	hb := startHireBridge(t, func(o *server.Options) {
		o.Prompts = &fakePrompts{}
		o.Git = slowFetchGit{o.Git.(*fakeGit)}
	})
	hb.git.repos["/home/u/lab"] = "/home/u/lab"
	hb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	return hb, hb.connect(proto.Hello{}).snapshot().World
}

func fetches(g *fakeGit) int {
	n := 0
	for _, c := range g.Calls() {
		if strings.HasPrefix(c, "fetch ") {
			n++
		}
	}
	return n
}

// #134: the hire and start-run dialogs open (and, start-run, follow every
// edit) without waiting for origin; an older client's prepare still fetches.
func TestPreparePreviewDoesNotWaitForFetch(t *testing.T) {
	t.Parallel()
	hb, w := previewBridge(t)
	if !w.PreparePreview {
		t.Fatal("the snapshot does not advertise prepare_preview")
	}
	extra := "Keep it small."
	cases := []struct {
		cmd  string
		open func(preview bool) any
		edit any // a later prepare of the same dialog (start-run: a field typed)
		git  func(m msg) *proto.HireGit
	}{
		{
			cmd:  proto.CmdHirePrepare,
			open: func(p bool) any { return proto.HirePrepareArgs{Session: "s", Preview: p} },
			edit: proto.HirePrepareArgs{Session: "s", Cwd: "/home/u/lab", Preview: true},
			git:  func(m msg) *proto.HireGit { return ackData[proto.HirePrepareResult](t, m).Git },
		},
		{
			cmd:  proto.CmdRunPrepare,
			open: func(p bool) any { return proto.RunPrepareArgs{Session: "s", Preview: p} },
			edit: proto.RunPrepareArgs{Session: "s", Issue: json.RawMessage("3"), Extra: extra, Preview: true},
			git:  func(m msg) *proto.HireGit { return ackData[proto.RunPrepareResult](t, m).Git },
		},
	}
	for _, tc := range cases {
		timed := func(what string, args any) (*proto.HireGit, time.Duration) {
			start := time.Now()
			_, m := hb.c.command(tc.cmd, what, args)
			g := tc.git(m)
			d := time.Since(start)
			t.Logf("%s %s: %s", tc.cmd, what, d.Round(10*time.Microsecond))
			return g, d
		}
		before := fetches(hb.git)
		for _, step := range []struct {
			what string
			args any
		}{{"first open", tc.open(true)}, {"repeated open", tc.open(true)}, {"edit", tc.edit}} {
			g, _ := timed(step.what, step.args)
			if g == nil || !g.Preview || g.Fetched || g.FetchError != "" || g.RepoRoot != "/home/u/lab" || g.DefaultBranch != "main" || g.BaseSHA == "" {
				t.Fatalf("%s %s: git = %+v", tc.cmd, step.what, g)
			}
		}
		// The absence of a fetch is the check; a wall clock would flake on a loaded host.
		if n := fetches(hb.git) - before; n != 0 {
			t.Fatalf("%s: %d fetches in previews", tc.cmd, n)
		}
		// Without preview (a client before #134, Fetch again, a recheck): today's fetch.
		g, d := timed("without preview (before #134)", tc.open(false))
		if g == nil || g.Preview || !g.Fetched || fetches(hb.git)-before != 1 || d < slowFetch {
			t.Fatalf("%s without preview: git = %+v after %s", tc.cmd, g, d)
		}
	}
}

// #134: a preview never lets a worktree branch from a stale origin: a
// worktree hire or run fetches first and refuses a failed fetch.
func TestPreviewThenWorktreeStillFetches(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	hb.git.fetchErr = errors.New("origin is offline")
	_, m := hb.c.command(proto.CmdHirePrepare, "hp", proto.HirePrepareArgs{Session: "s", Preview: true})
	if g := ackData[proto.HirePrepareResult](t, m).Git; g == nil || !g.Preview || g.Fetched || g.FetchError != "" {
		t.Fatalf("hire preview of an offline origin: %+v", g)
	}
	if g := runPrepare(t, hb.c, proto.RunPrepareArgs{Session: "s", Preview: true}).Git; g == nil || !g.Preview || g.Fetched || g.FetchError != "" {
		t.Fatalf("run preview of an offline origin: %+v", g)
	}
	if n := fetches(hb.git); n != 0 {
		t.Fatalf("%d fetches in previews", n)
	}

	a := hireArgs(0)
	a.Worktree = true
	hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrFetchFailed)
	orch := buildTeam.Orch
	start := proto.RunStartArgs{Session: "s", DeskIndex: ptr(1), Text: "Tidy the lobby", Orch: &orch, Preset: w.Presets[0].ID, Worktree: ptr(true)}
	hb.c.mustError(proto.CmdRunStart, start, proto.ErrFetchFailed)
	if n, calls := fetches(hb.git), hb.fl.Calls(); n != 2 || len(calls) != 0 {
		t.Fatalf("offline origin: %d fetches, floor calls %v", n, calls)
	}
	// The fetching prepare (Fetch again, the recheck after the refusal) says why.
	if g := runPrepare(t, hb.c, proto.RunPrepareArgs{Session: "s"}).Git; g == nil || g.Preview || g.Fetched || g.FetchError != "origin is offline" {
		t.Fatalf("run.prepare without preview: %+v", g)
	}

	// Origin back: both fetch, then branch from origin/main.
	hb.git.fetchErr = nil
	hb.c.mustAck(proto.CmdWorkerHire, a)
	hb.c.mustAck(proto.CmdRunStart, start)
	worktrees := 0
	for _, c := range hb.fl.Calls() {
		if strings.HasPrefix(c, "worktree s /home/u/lab ") && strings.Contains(c, " origin/main ") {
			worktrees++
		}
	}
	if n := fetches(hb.git); n != 5 || worktrees != 2 {
		t.Fatalf("online origin: %d fetches, %d worktrees from origin/main: %v", n, worktrees, hb.fl.Calls())
	}
}
