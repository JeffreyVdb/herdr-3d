//go:build integration

package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// TestIntegrationRunStart (M6 launch) starts two orchestrators with
// run.start in a throwaway session, each in a worktree of a local
// repository with a bare "origin": a Claude one on an issue and a Codex one
// on free text, both with cheap models picked in the command over the
// preset's, and an explicit multi-line prompt (no write-code run starts).
// Each must answer with what only the whole prompt tells it, so the prompt
// arrived intact as one prompt. It checks the desk, the ack, run_launch and
// last_preset, and that a reported h3d_run token fills run_launch.run_id.
func TestIntegrationRunStart(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	for _, bin := range []string{"claude", "codex"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s is not installed", bin)
		}
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	repoName := "h3d-it-repo-" + hex.EncodeToString(rnd[:])
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(filepath.Join(home, ".herdr", "worktrees", repoName)) })
	s := startThrowaway(t)
	t.Logf("throwaway session %s, repo %s", s.name, repoName)

	root := t.TempDir()
	origin, repo := filepath.Join(root, "origin.git"), filepath.Join(root, repoName)
	gitIn(t, root, "init", "-q", "--bare", origin)
	gitIn(t, root, "clone", "-q", origin, repo)
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "one")
	gitIn(t, repo, "push", "-q", "origin", "HEAD:main")
	gitIn(t, repo, "remote", "set-head", "origin", "main")

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	db := filepath.Join(t.TempDir(), "world.db")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	opts := server.HireOptions()
	opts.Claude.Models = append(opts.Claude.Models, cheapClaude)
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: db, Herdr: &herdr.Client{Bin: s.bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only}, Git: &gitops.Git{}, HireOptions: &opts,
		})
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	<-ready
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-run"}); err != nil {
		t.Fatal(err)
	}
	st := &stream{t: t, msgs: make(chan []byte, 4096)}
	go func() {
		defer close(st.msgs)
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			st.msgs <- raw
		}
	}()
	st.waitFor("running floor", 10*time.Second, func(ev proto.Event) bool {
		return ev.T == proto.EvFloorUpsert && ev.Floor.Session == s.name && ev.Floor.State == "running"
	})
	b := &bridgeConn{t: t, conn: conn, st: st}
	b.ack(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: s.name, Repo: proto.Some("h3d-it/lab"),
		DefaultCwd: proto.Some(repo)}, 10*time.Second, nil)

	// The dialog: Build team by default, the issue on the floor's repo.
	var prep proto.RunPrepareResult
	b.ack(proto.CmdRunPrepare, map[string]any{"session": s.name, "issue": "#3"}, 30*time.Second, &prep)
	if !strings.HasPrefix(prep.Prompt, "/write-code https://github.com/h3d-it/lab/issues/3\n\nTeam:\n- coders: claude claude-opus-5-5, effort medium\n") ||
		prep.Label != "ORCH|issue-3" || prep.Preset == "" || prep.Orch == nil || prep.Orch.Model != "claude-opus-5-5" ||
		prep.Cwd != repo || prep.Git == nil || !prep.Git.Fetched {
		t.Fatalf("run.prepare = %+v", prep)
	}

	rst, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	defer rst.Close()

	// A Claude orchestrator on the issue; a Codex one on free text.
	for _, tc := range []struct {
		desk   int
		ticket map[string]any
		orch   proto.Hire
		label  string
		words  [2]string
	}{
		{2, map[string]any{"issue": 3}, proto.Hire{Harness: "claude", Model: cheapClaude, Effort: "low"}, "ORCH|issue-3",
			[2]string{"AMBER", "CORAL"}},
		{3, map[string]any{"text": "Tidy the lobby\nand the stairs"}, proto.Hire{Harness: "codex", Model: cheapCodex, Effort: "low"},
			"ORCH|tidy-the", [2]string{"MAPLE", "RIVER"}},
	} {
		prompt := "This is a delivery test of a multi-line prompt. Do not use any tools.\n" +
			"The first word is " + tc.words[0] + ".\n\n" +
			"The second word is " + tc.words[1] + ".\n" +
			"Reply with only the two words joined by a hyphen, and nothing else."
		args := map[string]any{"session": s.name, "desk_index": tc.desk, "orch": tc.orch, "preset": prep.Preset, "prompt": prompt}
		for k, v := range tc.ticket {
			args[k] = v
		}
		start := time.Now()
		var res proto.RunStartResult
		evs := b.ack(proto.CmdRunStart, args, 90*time.Second, &res)
		t.Logf("%s orchestrator acked after %s", tc.orch.Harness, time.Since(start))
		w := upsertOf(evs, res.ID)
		if w == nil || w.DeskIndex != tc.desk || w.Label != tc.label || w.Model != tc.orch.Model || w.Harness != tc.orch.Harness ||
			w.HiredAt == 0 || w.Worktree == nil || !w.Worktree.Linked {
			t.Fatalf("orchestrator = %+v", w)
		}
		if res.Prompt != prompt || res.Prompted == nil || !*res.Prompted || !strings.HasPrefix(res.LaunchID, "l_") ||
			!strings.HasPrefix(res.Branch, "h3d/") || res.Trust != proto.TrustApproved {
			t.Fatalf("run.start ack = %+v", res)
		}
		lastPreset := false
		for _, ev := range evs {
			lastPreset = lastPreset || (ev.T == proto.EvFloorUpsert && ev.Floor.Session == s.name && ev.Floor.LastPreset == prep.Preset)
		}
		if tc.desk == 2 && !lastPreset {
			t.Fatalf("no floor.upsert with last_preset before the first ack")
		}
		l, ok, err := rst.RunLaunchByWorker(ctx, res.ID)
		if err != nil || !ok || l.ID != res.LaunchID || l.PresetName != "Build team" || l.RunID != "" || l.Session != s.name {
			t.Fatalf("run_launch = %+v %v %v", l, ok, err)
		}

		// The answer needs every line of the prompt.
		answered := func(ev proto.Event) bool {
			return ev.T == proto.EvWorkerStatus && ev.ID == res.ID && (ev.Status == "done" || ev.Status == "idle") && ev.PrevStatus == "working"
		}
		found := false
		for _, ev := range evs {
			found = found || answered(ev)
		}
		if !found {
			st.waitFor(tc.orch.Harness+" answered", 120*time.Second, answered)
		}
		want := strings.ToLower(tc.words[0] + "-" + tc.words[1])
		var screen string
		for deadline := time.Now().Add(15 * time.Second); ; {
			screen = string(s.run("--session", s.name, "pane", "read", res.WorkspaceID+":p1", "--source", "visible"))
			if strings.Contains(strings.ToLower(screen), want) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never answered %q; screen:\n%s", tc.orch.Harness, want, screen)
			}
			time.Sleep(500 * time.Millisecond)
		}
		t.Logf("%s answered %s", tc.orch.Harness, want)

		// The orchestrator's first h3d_run token fills run_launch.run_id.
		run := "20260929-it-" + tc.orch.Harness
		s.run("--session", s.name, "workspace", "report-metadata", res.WorkspaceID, "--source", "h3d-it",
			"--token", "h3d_role=orch", "--token", "h3d_run="+run)
		st.waitFor("h3d_run token", 10*time.Second, func(ev proto.Event) bool {
			return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID && ev.Worker.Tokens["h3d_run"] == run
		})
		for deadline := time.Now().Add(5 * time.Second); ; {
			l, _, err := rst.RunLaunchByWorker(ctx, res.ID)
			if err == nil && l.RunID == run {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("run_launch.run_id = %+v, %v; want %s", l, err, run)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}

	// Both starts are audited like hires, with their launch.
	log, err := rst.AuditLog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range log {
		if e.Cmd == proto.CmdRunStart {
			n++
			var r struct {
				Launch string `json:"launch"`
			}
			if !e.OK || !e.Done || json.Unmarshal([]byte(e.Result), &r) != nil || r.Launch == "" {
				t.Errorf("audit row = %+v", e)
			}
		}
	}
	if n != 2 {
		t.Fatalf("%d run.start audit rows, want 2", n)
	}
}
