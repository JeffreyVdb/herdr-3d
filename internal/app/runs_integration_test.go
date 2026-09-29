//go:build integration

package app

// M6 runs: a write-code run as herdr shows it, without any agent: the
// workspaces are labelled and tagged the way the skill does it, and the
// reports are published by rename into a temporary runs directory.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func TestIntegrationRuns(t *testing.T) {
	s := startThrowaway(t)
	t.Logf("throwaway session %s", s.name)
	runsDir := t.TempDir()

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: &herdr.Client{Bin: s.bin},
			Only: regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$"),
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			RunsDir: runsDir, ReportPoll: 100 * time.Millisecond,
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
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-runs"}); err != nil {
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
	b.ack(proto.CmdFloorSettings, map[string]any{"session": s.name, "repo": "example/lab"}, 5*time.Second, nil)

	cwd := t.TempDir()
	create := func(label string) string {
		t.Helper()
		var created struct {
			Result struct {
				Workspace struct {
					WorkspaceID string `json:"workspace_id"`
				} `json:"workspace"`
			} `json:"result"`
		}
		if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"), &created); err != nil {
			t.Fatal(err)
		}
		ws := created.Result.Workspace.WorkspaceID
		st.waitFor("worker for "+label, eventDeadline, func(ev proto.Event) bool {
			return ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == ws
		})
		return ws
	}
	tag := func(ws string, tokens ...string) {
		t.Helper()
		args := []string{"--session", s.name, "workspace", "report-metadata", ws, "--source", "write-code"}
		for _, tok := range tokens {
			args = append(args, "--token", tok)
		}
		s.run(args...)
	}
	upsert := func(what string, ok func(w *proto.Worker) bool) *proto.Worker {
		t.Helper()
		return st.waitFor(what, 5*time.Second, func(ev proto.Event) bool {
			return ev.T == proto.EvWorkerUpsert && ok(ev.Worker)
		}).Worker
	}

	// Five employees at desks 0…4, the ORCH at 5 (pod 1); then desk 1
	// frees up, the lowest free desk, but not next to the ORCH.
	var plain []string
	for _, l := range []string{"p0", "p1", "p2", "p3", "p4"} {
		plain = append(plain, create(l))
	}
	const run = "20260929-0900-itrun"
	orchWS := create("ORCH|itrun")
	tag(orchWS, "h3d_role=orch", "h3d_run="+run, "h3d_phase=coding", "h3d_pass=1")
	orch := upsert("orch tagged", func(w *proto.Worker) bool { return w.WorkspaceID == orchWS && w.Phase == "coding" })
	if orch.DeskIndex != 5 || orch.Pass == nil || *orch.Pass != 1 || orch.OverCap || orch.Role != "orch" {
		t.Fatalf("orch = %+v", orch)
	}
	s.run("--session", s.name, "workspace", "close", plain[1])
	st.waitFor("p1 gone", eventDeadline, func(ev proto.Event) bool { return ev.T == proto.EvWorkerRemoved && ev.WorkspaceID == plain[1] })

	// A coder and a reviewer, tagged like write-code does right after
	// creating them.
	codeWS := create("CODE|itrun|7|r1")
	tag(codeWS, "h3d_role=code", "h3d_run="+run, "h3d_round=1", "h3d_report=code-itrun-r1.json",
		"h3d_harness=claude", "h3d_model=claude-opus-5-5", "h3d_effort=medium")
	code := upsert("coder tagged", func(w *proto.Worker) bool { return w.WorkspaceID == codeWS && w.Report != nil })
	reviewWS := create("REVIEW|itrun|7|r1")
	tag(reviewWS, "h3d_role=review", "h3d_run="+run, "h3d_round=1", "h3d_report=review-itrun-r1.json",
		"h3d_harness=codex", "h3d_model=gpt-6-sol", "h3d_effort=high")
	review := upsert("reviewer tagged", func(w *proto.Worker) bool { return w.WorkspaceID == reviewWS && w.Report != nil })
	want7 := proto.IssueRef{Repo: "example/lab", Number: 7}
	for _, w := range []*proto.Worker{code, review} {
		if w.OrchID != orch.ID || w.Round != 1 || w.Ticket != "7" || w.Issue == nil || *w.Issue != want7 ||
			w.Report.State != proto.ReportPending || w.DeskIndex/4 != 1 {
			t.Errorf("%s = %+v (report %+v)", w.Label, w, w.Report)
		}
	}
	if code.DeskIndex != 6 || review.DeskIndex != 7 {
		t.Errorf("desks: coder %d, reviewer %d; want 6, 7 next to the ORCH", code.DeskIndex, review.DeskIndex)
	}
	// A run started outside the game: a label only. The floor's only ORCH
	// is its orchestrator; pod 1 is full, so the nearest pod (0, desk 1).
	labelWS := create("CODE|other|8|r1")
	var label *proto.Worker
	for _, w := range dumpWorkers(t, ctx, sock) {
		if w.WorkspaceID == labelWS {
			label = &w
		}
		if w.WorkspaceID == orchWS && (w.Issue == nil || *w.Issue != want7) {
			t.Errorf("orch issue = %+v", w.Issue)
		}
	}
	if label == nil || label.OrchID != orch.ID || label.Issue == nil || label.Issue.Number != 8 || label.Report != nil || label.DeskIndex != 1 {
		t.Errorf("label-only coder = %+v", label)
	}

	// Reports, published by rename.
	publishReport := func(name, data string) {
		t.Helper()
		dir := filepath.Join(runsDir, run)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".tmp"), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(filepath.Join(dir, name+".tmp"), filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	publishReport("code-itrun-r1.json", `{"input_required":null,"summary":"done, head 0c0ffee","crucial_bits":[]}`)
	code = upsert("coder report", func(w *proto.Worker) bool {
		return w.WorkspaceID == codeWS && w.Report != nil && w.Report.State == proto.ReportReady
	})
	if code.Report.Summary != "done, head 0c0ffee" {
		t.Errorf("coder report = %+v", code.Report)
	}
	publishReport("review-itrun-r1.json", `{"verdict":"CHANGES_REQUIRED","input_required":null,"issues_found":[{"id":"R1","priority":"BLOCKER"}]}`)
	review = upsert("reviewer report", func(w *proto.Worker) bool {
		return w.WorkspaceID == reviewWS && w.Report != nil && w.Report.State == proto.ReportReady
	})
	if review.Report.Verdict != proto.VerdictChangesRequired || *review.Report.Blockers != 1 || *review.Report.Issues != 1 {
		t.Errorf("reviewer report = %+v", review.Report)
	}

	// Pass 3, waiting for the user: over the cap.
	tag(orchWS, "h3d_role=orch", "h3d_run="+run, "h3d_phase=waiting_user", "h3d_pass=3")
	upsert("orch over the cap", func(w *proto.Worker) bool { return w.WorkspaceID == orchWS && w.OverCap })
	// A fresh report path after input_required: pending again.
	tag(codeWS, "h3d_role=code", "h3d_run="+run, "h3d_round=1", "h3d_report=code-itrun-r1b.json")
	upsert("coder pending again", func(w *proto.Worker) bool {
		return w.WorkspaceID == codeWS && w.Report != nil && w.Report.State == proto.ReportPending
	})
	// An invalid report.
	publishReport("code-itrun-r1b.json", `["not an object"]`)
	upsert("coder report invalid", func(w *proto.Worker) bool {
		return w.WorkspaceID == codeWS && w.Report != nil && w.Report.State == proto.ReportInvalid && w.Report.Error != ""
	})
	// The coder leaves: its desk frees up.
	s.run("--session", s.name, "workspace", "close", codeWS)
	st.waitFor("coder gone", eventDeadline, func(ev proto.Event) bool { return ev.T == proto.EvWorkerRemoved && ev.WorkspaceID == codeWS })
	for _, w := range dumpWorkers(t, ctx, sock) {
		if w.WorkspaceID == orchWS && (!w.OverCap || w.Phase != "waiting_user") {
			t.Errorf("snapshot orch = %+v", w)
		}
		if w.WorkspaceID == reviewWS && (w.OrchID != orch.ID || w.Report == nil || w.Report.Verdict != proto.VerdictChangesRequired) {
			t.Errorf("snapshot reviewer = %+v", w)
		}
		if strings.HasPrefix(w.Label, "CODE|itrun") {
			t.Errorf("coder still there: %+v", w)
		}
	}
}

// dumpWorkers is the bridge's current snapshot's workers (herdr-world
// dump --once).
func dumpWorkers(t *testing.T, ctx context.Context, sock string) []proto.Worker {
	t.Helper()
	var out strings.Builder
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := dumpMain(dctx, "herdr-world", []string{"-socket", sock, "-once"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var snap proto.Snapshot
	if err := json.Unmarshal([]byte(out.String()), &snap); err != nil {
		t.Fatal(err)
	}
	return snap.World.Workers
}
