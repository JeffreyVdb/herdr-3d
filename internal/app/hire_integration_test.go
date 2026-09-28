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
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Cheap agents only, and only here: the real hire_options stay as they are.
const (
	cheapClaude = "claude-haiku-4-5-20251001"
	cheapCodex  = "gpt-6-luna"
)

// gitIn runs git in dir for the test itself (setup and checks).
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=h3d-it", "-c", "user.email=h3d-it@example.com",
		"-c", "init.defaultBranch=main", "-C", dir}, args...)...)
	cmd.Env = append(herdr.CleanEnv(os.Environ()), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// bridgeConn is a protocol client of the bridge under test.
type bridgeConn struct {
	t    *testing.T
	conn *proto.Conn
	st   *stream
	n    int
}

// command sends a command and returns the events before its reply, and
// the reply.
func (b *bridgeConn) command(typ string, args any, within time.Duration) ([]proto.Event, proto.Envelope, []byte) {
	b.t.Helper()
	b.n++
	raw, err := json.Marshal(args)
	if err != nil {
		b.t.Fatal(err)
	}
	cmd := proto.Command{T: typ, ReqID: typ + "-" + strconv.Itoa(b.n), Args: raw}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.conn.Send(ctx, cmd); err != nil {
		b.t.Fatal(err)
	}
	var evs []proto.Event
	deadline := time.After(within)
	for {
		select {
		case msg, open := <-b.st.msgs:
			if !open {
				b.t.Fatalf("connection closed waiting for the %s reply", typ)
			}
			var env proto.Envelope
			_ = json.Unmarshal(msg, &env)
			if env.ReqID == cmd.ReqID && (env.T == proto.TAck || env.T == proto.TError) {
				return evs, env, msg
			}
			var ev proto.Event
			if json.Unmarshal(msg, &ev) == nil && ev.Seq > 0 {
				evs = append(evs, ev)
			}
		case <-deadline:
			b.t.Fatalf("no reply to %s within %s", typ, within)
		}
	}
}

func (b *bridgeConn) ack(typ string, args any, within time.Duration, data any) []proto.Event {
	b.t.Helper()
	evs, env, raw := b.command(typ, args, within)
	if env.T != proto.TAck {
		b.t.Fatalf("%s: %s", typ, raw)
	}
	if data != nil {
		var a struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || json.Unmarshal(a.Data, data) != nil {
			b.t.Fatalf("%s: bad ack %s", typ, raw)
		}
	}
	b.t.Logf("%s: %s", typ, raw)
	return evs
}

func (b *bridgeConn) refuse(typ string, args any, code string) proto.Error {
	b.t.Helper()
	_, env, raw := b.command(typ, args, 30*time.Second)
	var e proto.Error
	_ = json.Unmarshal(raw, &e)
	if env.T != proto.TError || e.Code != code {
		b.t.Fatalf("%s: got %s, want error %s", typ, raw, code)
	}
	b.t.Logf("%s refused: %s", typ, raw)
	return e
}

func upsertOf(evs []proto.Event, id string) *proto.Worker {
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id {
			return ev.Worker
		}
	}
	return nil
}

// paneArgv is the argv of the foreground process of a pane.
func paneArgv(t *testing.T, s *throwaway, pane string) []string {
	t.Helper()
	var resp struct {
		Result struct {
			ProcessInfo herdr.ProcessInfo `json:"process_info"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "pane", "process-info", "--pane", pane), &resp); err != nil {
		t.Fatal(err)
	}
	for _, p := range resp.Result.ProcessInfo.Foreground {
		if len(p.Argv) > 1 {
			return p.Argv
		}
	}
	return nil
}

func containsRun(argv []string, run ...string) bool {
	for i := 0; i+len(run) <= len(argv); i++ {
		if slices.Equal(argv[i:i+len(run)], run) {
			return true
		}
	}
	return false
}

// TestIntegrationHireAndSendHome hires real (cheap) agents through the
// bridge into a throwaway session: a Codex worker in a worktree branched
// from a freshly fetched local "origin" (the test pushes a commit there
// first) and a Claude worker in a plain workspace, both through the trust
// dialog of a directory they have never seen. It checks the desk, the
// marker, the native args, the remembered choice and the capacity guard,
// then sends them home: dirty and unpushed trees are refused a delete,
// clean ones can go, the agents exit gracefully and every step is audited.
func TestIntegrationHireAndSendHome(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	for _, bin := range []string{"claude", "codex"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s is not installed", bin)
		}
	}
	// A repository only this test uses; herdr puts its worktrees in
	// ~/.herdr/worktrees/<repo name>/, removed at the end (after the
	// session is gone: cleanups run last-registered first).
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
	origin, repo, other := filepath.Join(root, "origin.git"), filepath.Join(root, repoName), filepath.Join(root, "other")
	gitIn(t, root, "init", "-q", "--bare", origin)
	gitIn(t, root, "clone", "-q", origin, repo)
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "one")
	gitIn(t, repo, "push", "-q", "origin", "HEAD:main")
	gitIn(t, repo, "remote", "set-head", "origin", "main")
	localHead := gitIn(t, repo, "rev-parse", "HEAD")

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
			Control: &herdr.Control{Herdr: s.bin, Only: only}, Git: &gitops.Git{},
			Caps: server.Caps{FloorSoft: 1, FloorHard: 2, HostSoft: 100, HostHard: 200}, HireOptions: &opts,
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
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-hire"}); err != nil {
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

	// Someone merges a commit to the remote; the local clone does not have
	// it. The dialog shows the fetched base.
	gitIn(t, root, "clone", "-q", origin, other)
	gitIn(t, other, "commit", "-q", "--allow-empty", "-m", "merged upstream")
	gitIn(t, other, "push", "-q", "origin", "HEAD:main")
	merged := gitIn(t, other, "rev-parse", "HEAD")
	var prep proto.HirePrepareResult
	b.ack(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: s.name, Cwd: repo}, 30*time.Second, &prep)
	if prep.Git == nil || !prep.Git.Fetched || prep.Git.DefaultBranch != "main" || prep.Git.BaseSHA != merged ||
		prep.ChoiceSource != proto.ChoiceNone || prep.Capacity.Floor != (proto.CapacityCount{Count: 0, Soft: 1, Hard: 2}) {
		t.Fatalf("hire.prepare = %+v (git %+v)", prep, prep.Git)
	}

	// Hire a Codex worker into its own worktree at desk 2, with a first task.
	desk := 2
	start := time.Now()
	var hired proto.HireResult
	evs := b.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: s.name, DeskIndex: &desk, Harness: "codex",
		Model: cheapCodex, Effort: "low", Label: prep.Label, Cwd: repo, Worktree: true,
		Prompt: "Reply with exactly the word: pong"}, 60*time.Second, &hired)
	w := upsertOf(evs, hired.ID)
	if w == nil {
		t.Fatalf("no worker.upsert for %s before the ack", hired.ID)
	}
	t.Logf("codex hire acked after %s", time.Since(start))
	if w.DeskIndex != 2 || w.Name != prep.Label || w.HiredAt == 0 || w.Model != cheapCodex || w.Effort != "low" ||
		w.Worktree == nil || !w.Worktree.Linked {
		t.Fatalf("hired worker = %+v", w)
	}
	if hired.Trust != proto.TrustApproved || hired.Prompted == nil || !*hired.Prompted || hired.BaseSHA != merged ||
		!strings.HasPrefix(hired.Branch, "h3d/") {
		t.Fatalf("hire ack = %+v", hired)
	}
	checkout := w.Worktree.CheckoutPath
	gitIn(t, checkout, "merge-base", "--is-ancestor", merged, "HEAD") // it has the merged commit
	if got := gitIn(t, repo, "rev-parse", "HEAD"); got != localHead {
		t.Fatalf("the local checkout moved: %s", got)
	}
	marker := "h3d-" + strings.ReplaceAll(hired.ID, "-", "")[:12]
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == hired.ID && ev.Worker.PaneLabel == marker
	}) {
		t.Fatalf("no upsert with the marker %s before the ack", marker)
	}
	if argv := paneArgv(t, s, hired.WorkspaceID+":p1"); !containsRun(argv, "-m", cheapCodex, "-c", "model_reasoning_effort=low") ||
		!slices.Contains(argv, "--dangerously-bypass-approvals-and-sandbox") {
		t.Fatalf("codex argv = %q", argv)
	}
	// Let its one short turn finish.
	answered := func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerStatus && ev.ID == hired.ID && (ev.Status == "done" || ev.Status == "idle") && ev.PrevStatus == "working"
	}
	if !slices.ContainsFunc(evs, answered) {
		st.waitFor("codex answered", 90*time.Second, answered)
	}

	// Send home, dirty: a warning, never a delete.
	if err := os.WriteFile(filepath.Join(checkout, "notes.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var fp proto.FirePrepareResult
	b.ack(proto.CmdFirePrepare, proto.WorkerArgs{ID: hired.ID}, 30*time.Second, &fp)
	if fp.CanDelete || !slices.Contains(fp.Dirty, "?? notes.txt") || fp.Branch != hired.Branch || fp.Worktree == nil {
		t.Fatalf("dirty fire.prepare = %+v", fp)
	}
	b.refuse(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: hired.ID, Worktree: proto.FireDelete}, proto.ErrNotClean)
	// Committed but not pushed: still no delete.
	gitIn(t, checkout, "add", "notes.txt")
	gitIn(t, checkout, "commit", "-q", "-m", "notes")
	b.ack(proto.CmdFirePrepare, proto.WorkerArgs{ID: hired.ID}, 30*time.Second, &fp)
	if fp.CanDelete || fp.Unpushed != 1 || len(fp.Dirty) != 0 {
		t.Fatalf("unpushed fire.prepare = %+v", fp)
	}
	b.refuse(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: hired.ID, Worktree: proto.FireDeleteBranch}, proto.ErrNotClean)
	if _, err := os.Stat(checkout); err != nil {
		t.Fatalf("the worktree went: %v", err)
	}
	// Pushed: it can go, with its branch.
	gitIn(t, checkout, "push", "-q", "origin", hired.Branch)
	b.ack(proto.CmdFirePrepare, proto.WorkerArgs{ID: hired.ID}, 30*time.Second, &fp)
	if !fp.CanDelete {
		t.Fatalf("clean fire.prepare = %+v", fp)
	}
	var fired proto.FireResult
	evs = b.ack(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: hired.ID, Worktree: proto.FireDeleteBranch}, 60*time.Second, &fired)
	if fired.Worktree != proto.WorktreeDelBranch || !fired.Released {
		t.Fatalf("fire ack = %+v", fired)
	}
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerRemoved && ev.ID == hired.ID && ev.Reason == proto.RemovedSentHome
	}) {
		t.Fatalf("no worker.removed sent_home before the ack: %+v", evs)
	}
	if _, err := os.Stat(checkout); !os.IsNotExist(err) {
		t.Fatalf("the worktree is still there: %v", err)
	}
	if out := gitIn(t, repo, "branch", "--list", hired.Branch); out != "" {
		t.Fatalf("branch still there: %q", out)
	}

	// herdr opened the repository's main checkout as a workspace for the
	// worktree group; it is a worker too. Remembered choice: codex.
	b.ack(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: s.name}, 30*time.Second, &prep)
	if prep.ChoiceSource != proto.ChoiceLast || prep.Choice == nil || prep.Choice.Model != cheapCodex {
		t.Fatalf("remembered choice = %+v", prep)
	}
	floorCount := prep.Capacity.Floor.Count

	// Hire a Claude worker (plain workspace, a directory Claude never saw)
	// at desk 3: at the desk within 5 s, trust dialog answered, native args.
	fresh := t.TempDir()
	desk = 3
	start = time.Now()
	evs = b.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: s.name, DeskIndex: &desk, Harness: "claude",
		Model: cheapClaude, Effort: "low", Cwd: fresh, Prompt: "Reply with exactly the word: pong"}, 60*time.Second, &hired)
	took := time.Since(start)
	w = upsertOf(evs, hired.ID)
	if w == nil || w.DeskIndex != 3 || w.Model != cheapClaude || w.Effort != "low" || w.Harness != "claude" {
		t.Fatalf("claude worker = %+v", w)
	}
	seenAfter := time.UnixMilli(w.StatusSince).Sub(start)
	t.Logf("claude hire: worker at desk %d after ~%s, acked after %s, trust %s", w.DeskIndex, seenAfter, took, hired.Trust)
	if seenAfter > 5*time.Second {
		t.Errorf("worker at its desk after %s, want within 5 s", seenAfter)
	}
	if hired.Trust != proto.TrustApproved {
		t.Errorf("trust = %q, want approved (a fresh directory)", hired.Trust)
	}
	if hired.Prompted == nil || !*hired.Prompted {
		t.Fatalf("claude prompt not sent: %+v", hired)
	}
	answered = func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerStatus && ev.ID == hired.ID && (ev.Status == "done" || ev.Status == "idle") && ev.PrevStatus == "working"
	}
	if !slices.ContainsFunc(evs, answered) {
		st.waitFor("claude answered", 90*time.Second, answered)
	}
	argv := paneArgv(t, s, hired.WorkspaceID+":p1")
	if !containsRun(argv, "--model", cheapClaude, "--effort", "low", "--permission-mode", "bypassPermissions", "--name", w.Label) {
		t.Fatalf("claude argv = %q", argv)
	}

	// Capacity: above the soft cap the dialog warns; at the hard cap a hire
	// is refused.
	b.ack(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: s.name}, 30*time.Second, &prep)
	if prep.Capacity.Floor.Count != floorCount+1 || prep.Capacity.Floor.Count <= prep.Capacity.Floor.Soft {
		t.Fatalf("capacity = %+v", prep.Capacity)
	}
	desk = 4
	if e := b.refuse(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: s.name, DeskIndex: &desk, Harness: "claude",
		Model: cheapClaude, Effort: "low", Cwd: fresh}, proto.ErrCapacity); !strings.Contains(e.Message, "max-workers-per-floor") {
		t.Fatalf("capacity message = %q", e.Message)
	}

	// Send the Claude worker home: /exit, workspace closed, desk freed.
	evs = b.ack(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: hired.ID}, 60*time.Second, &fired)
	if fired.Worktree != proto.WorktreeKept || !fired.Released {
		t.Fatalf("fire ack = %+v", fired)
	}
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerRemoved && ev.ID == hired.ID && ev.Reason == proto.RemovedSentHome
	}) {
		t.Fatalf("no sent_home removal: %+v", evs)
	}
	var list struct {
		Result struct {
			Workspaces []struct {
				WorkspaceID string `json:"workspace_id"`
			} `json:"workspaces"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "list"), &list); err != nil {
		t.Fatal(err)
	}
	for _, ws := range list.Result.Workspaces {
		if ws.WorkspaceID == hired.WorkspaceID {
			t.Fatalf("workspace %s still open", ws.WorkspaceID)
		}
	}
	// Its place is free again.
	var again proto.HirePrepareResult
	b.ack(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: s.name}, 30*time.Second, &again)
	if again.Capacity.Floor.Count != floorCount {
		t.Fatalf("capacity after sending home = %+v", again.Capacity)
	}

	// Every hire, refusal and send-home is in the audit log, with its steps.
	rst, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	defer rst.Close()
	log, err := rst.AuditLog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		if e.Cmd == proto.CmdWorkerHire || e.Cmd == proto.CmdWorkerFire {
			rows = append(rows, e.Cmd+" "+strconv.FormatBool(e.OK))
			t.Logf("audit %s ok=%v %s %s", e.Cmd, e.OK, e.Error, e.Result)
			if !e.Done {
				t.Errorf("audit row not done: %+v", e)
			}
		}
	}
	want := []string{"worker.hire true", "worker.fire false", "worker.fire false", "worker.fire true", "worker.hire true",
		"worker.hire false", "worker.fire true"}
	if !slices.Equal(rows, want) {
		t.Fatalf("audit rows = %q, want %q", rows, want)
	}
}
