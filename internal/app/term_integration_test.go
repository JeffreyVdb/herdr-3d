//go:build integration

package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
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

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// runErr is run for a command that may fail (agent start of an agent
// that stops at a dialog): same guard, the error is returned.
func (s *throwaway) runErr(args ...string) ([]byte, error) {
	s.t.Helper()
	if len(args) < 2 || args[0] != "--session" || args[1] != s.name || !strings.HasPrefix(s.name, "h3d-it-") {
		panic("integration test tried to run herdr outside its throwaway session: " + strings.Join(args, " "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.bin, args...)
	cmd.Env = s.env
	return cmd.CombinedOutput()
}

// observers counts the `terminal session observe` processes of session
// that are alive, and the herdr children of this process that died
// unreaped (zombies).
func observers(t *testing.T, session string) (live, zombies int) {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		t.Fatal(err)
	}
	self := strconv.Itoa(os.Getpid())
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		dir := filepath.Join("/proc", e.Name())
		if cmdline, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil {
			args := strings.Split(string(bytes.TrimRight(cmdline, "\x00")), "\x00")
			if slices.Contains(args, session) && slices.Contains(args, "observe") && slices.Contains(args, "terminal") {
				live++
				continue
			}
		}
		stat, err := os.ReadFile(filepath.Join(dir, "stat"))
		if err != nil {
			continue
		}
		// pid (comm) state ppid …
		s := string(stat)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		fields := strings.Fields(s[i+1:])
		if len(fields) > 1 && fields[0] == "Z" && fields[1] == self && strings.Contains(s[:i], "(herdr") {
			zombies++
		}
	}
	return live, zombies
}

func waitObservers(t *testing.T, session string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		live, zombies := observers(t, session)
		if live == want && zombies == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d observers (%d unreaped), want %d", live, zombies, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// next reads the next message that matches ok (frames, closings, events).
func (st *stream) next(what string, within time.Duration, ok func(env proto.Envelope, raw []byte) bool) []byte {
	st.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case raw, open := <-st.msgs:
			if !open {
				st.t.Fatalf("connection closed while waiting for %s", what)
			}
			var env proto.Envelope
			if json.Unmarshal(raw, &env) == nil && ok(env, raw) {
				return raw
			}
		case <-deadline:
			st.t.Fatalf("no %s within %v", what, within)
		}
	}
}

func (st *stream) frame(id string, within time.Duration) proto.TerminalFrame {
	st.t.Helper()
	var f proto.TerminalFrame
	raw := st.next("a frame of "+id, within, func(env proto.Envelope, raw []byte) bool {
		return env.T == proto.TTerminalFrame && json.Unmarshal(raw, &f) == nil && f.ID == id
	})
	if bytes.Contains(raw, []byte(`"seq"`)) {
		st.t.Fatalf("a frame with a seq: %.200s", raw)
	}
	return f
}

var ansiRe = regexp.MustCompile(`\x1b(\[[0-9;?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78DEHMc])`)

// plain is a frame's text without its escape sequences.
func plain(t *testing.T, f proto.TerminalFrame) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		t.Fatal(err)
	}
	return ansiRe.ReplaceAllString(string(b), "")
}

// workerOf waits for the worker labelled label, in a snapshot or an
// upsert.
func (b *bridgeConn) workerOf(label string, within time.Duration) *proto.Worker {
	b.t.Helper()
	var w *proto.Worker
	b.st.next("worker "+label, within, func(env proto.Envelope, raw []byte) bool {
		switch env.T {
		case proto.TSnapshot:
			var snap proto.Snapshot
			_ = json.Unmarshal(raw, &snap)
			for i := range snap.World.Workers {
				if sw := &snap.World.Workers[i]; sw.Label == label && sw.PaneID != "" {
					w = sw
				}
			}
		case proto.EvWorkerUpsert:
			var ev proto.Event
			if json.Unmarshal(raw, &ev) == nil && ev.Worker.Label == label && ev.Worker.PaneID != "" {
				w = ev.Worker
			}
		}
		return w != nil
	})
	return w
}

func isStatus(ev proto.Event, id string, want []string) bool {
	switch {
	case ev.T == proto.EvWorkerStatus && ev.ID == id:
		return slices.Contains(want, ev.Status)
	case ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id:
		return slices.Contains(want, ev.Worker.Status)
	}
	return false
}

// status waits for the worker to have one of want: among before (the
// events that came with a command's reply), else next.
func (b *bridgeConn) status(before []proto.Event, id string, within time.Duration, want ...string) {
	b.t.Helper()
	if slices.ContainsFunc(before, func(ev proto.Event) bool { return isStatus(ev, id, want) }) {
		return
	}
	b.st.waitFor(id+" "+strings.Join(want, "|"), within, func(ev proto.Event) bool { return isStatus(ev, id, want) })
}

// question waits for the worker's question of kind: among before, else
// next.
func (b *bridgeConn) question(before []proto.Event, id, kind string, within time.Duration) *proto.Question {
	b.t.Helper()
	var q *proto.Question
	match := func(ev proto.Event) bool {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Question != nil && ev.Worker.Question.Kind == kind {
			q = ev.Worker.Question
		}
		return q != nil
	}
	if !slices.ContainsFunc(before, match) {
		b.st.waitFor(kind+" question of "+id, within, match)
	}
	b.t.Logf("question: %+v", q)
	return q
}

// TestIntegrationLaptops drives the laptops against a real herdr in a
// throwaway session: a plain shell's screen through terminal.watch, typed
// into with worker.keys; no observer outlives 20 watch/unwatch cycles, a
// closed connection or a closed workspace; a cheap Claude (haiku, low)
// blocked on its trust dialog gets a question that worker.answer resolves
// (a stale hash refused), then worker.prompt (queued while it works) and
// a tool permission prompt answered through its question.
func TestIntegrationLaptops(t *testing.T) {
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("claude is not installed")
	}
	s := startThrowaway(t)
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	marker := "h3d-echo-" + hex.EncodeToString(rnd[:])
	t.Logf("throwaway session %s", s.name)

	shellDir := t.TempDir()
	s.run("--session", s.name, "workspace", "create", "--cwd", shellDir, "--label", "shell", "--no-focus")

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	db := filepath.Join(t.TempDir(), "world.db")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: db, Herdr: &herdr.Client{Bin: s.bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only}, MaxWatches: 2,
		})
	}()
	stopped := false
	stopBridge := func() {
		if !stopped {
			stopped = true
			cancel()
			if err := <-served; err != nil {
				t.Errorf("Serve: %v", err)
			}
		}
	}
	t.Cleanup(stopBridge)
	<-ready
	connect := func(client string) (*bridgeConn, *proto.Conn) {
		dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
		conn, err := proto.Dial(dctx, sock)
		dcancel()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Hello(ctx, proto.Hello{Client: client}); err != nil {
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
		return &bridgeConn{t: t, conn: conn, st: st}, conn
	}
	b, conn := connect("integration-laptops")
	defer conn.CloseNow()
	sh := b.workerOf("shell", 10*time.Second)

	// 1. The shell's screen: a full frame, then diffs showing what
	// worker.keys typed.
	var watched proto.TerminalWatchResult
	b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: sh.ID, Fps: 10}, 10*time.Second, &watched)
	if watched.Pane != sh.PaneID || watched.Cols < 80 || watched.Rows < 24 {
		t.Fatalf("watch ack = %+v", watched)
	}
	first := b.st.frame(sh.ID, 10*time.Second)
	if !first.Full || first.N != 1 || first.Cols != watched.Cols || first.Rows != watched.Rows {
		t.Fatalf("first frame = %+v", first)
	}
	if live, _ := observers(t, s.name); live != 1 {
		t.Fatalf("%d observers while watching one pane", live)
	}
	// Typed through worker.keys; its frames may come before its ack.
	keys, _ := json.Marshal(proto.WorkerKeysArgs{ID: sh.ID, Input: []proto.InputItem{
		{Text: ptrTo("echo " + marker + " | tr a-z A-Z")}, {Key: ptrTo("enter")}}})
	if err := conn.Send(ctx, proto.Command{T: proto.CmdWorkerKeys, ReqID: "keys-1", Args: keys}); err != nil {
		t.Fatal(err)
	}
	want := strings.ToUpper(marker) // only the command's output has it in upper case
	var seen strings.Builder
	diffs, acked := 0, false
	for !acked || !strings.Contains(seen.String(), want) {
		raw := b.st.next("the output of worker.keys", 10*time.Second, func(env proto.Envelope, raw []byte) bool {
			return env.T == proto.TTerminalFrame || env.ReqID == "keys-1"
		})
		var env proto.Envelope
		_ = json.Unmarshal(raw, &env)
		if env.ReqID == "keys-1" {
			if env.T != proto.TAck {
				t.Fatalf("worker.keys: %s", raw)
			}
			acked = true
			continue
		}
		var f proto.TerminalFrame
		_ = json.Unmarshal(raw, &f)
		if !f.Full {
			diffs++
		}
		seen.WriteString(plain(t, f))
	}
	if diffs == 0 {
		t.Fatal("the output came in no diff frame")
	}
	// Bad input is refused before anything is typed.
	b.refuse(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: sh.ID, Input: []proto.InputItem{{Text: ptrTo("ls\n")}}}, proto.ErrBadRequest)
	b.refuse(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: sh.ID, Input: []proto.InputItem{{Key: ptrTo("insert")}}}, proto.ErrBadRequest)
	b.refuse(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: sh.ID, Text: "hi"}, proto.ErrInvalidState) // a plain shell

	// 2. No leaked observers: 20 watch/unwatch cycles, a connection
	// closed mid-watch, a workspace closed while watched.
	b.ack(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: sh.ID}, 10*time.Second, nil)
	waitObservers(t, s.name, 0)
	for i := range 20 {
		b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: sh.ID}, 10*time.Second, nil)
		if f := b.st.frame(sh.ID, 10*time.Second); !f.Full {
			t.Fatalf("cycle %d: first frame not full", i)
		}
		b.ack(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: sh.ID}, 10*time.Second, nil)
	}
	waitObservers(t, s.name, 0)
	t.Log("20 watch/unwatch cycles: no observer left")

	b2, conn2 := connect("integration-laptops-2")
	b2.workerOf("shell", 10*time.Second)
	b2.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: sh.ID}, 10*time.Second, nil)
	b2.st.frame(sh.ID, 10*time.Second)
	waitObservers(t, s.name, 1)
	conn2.CloseNow()
	waitObservers(t, s.name, 0)
	t.Log("a connection closed mid-watch: no observer left")

	doomedDir := t.TempDir()
	s.run("--session", s.name, "workspace", "create", "--cwd", doomedDir, "--label", "doomed", "--no-focus")
	doomed := b.workerOf("doomed", 10*time.Second)
	b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: doomed.ID}, 10*time.Second, nil)
	b.st.frame(doomed.ID, 10*time.Second)
	b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: sh.ID}, 10*time.Second, nil)
	b.refuse(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: sh.ID + "x"}, proto.ErrUnknownWorker)
	s.run("--session", s.name, "workspace", "close", doomed.WorkspaceID)
	var closed proto.TerminalClosed
	b.st.next("terminal.closed", 10*time.Second, func(env proto.Envelope, raw []byte) bool {
		return env.T == proto.TTerminalClosed && json.Unmarshal(raw, &closed) == nil && closed.ID == doomed.ID
	})
	if closed.Reason != proto.ClosedWorkerRemoved {
		t.Fatalf("closed = %+v", closed)
	}
	waitObservers(t, s.name, 1) // the shell's watch goes on
	b.ack(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: sh.ID}, 10*time.Second, nil)
	waitObservers(t, s.name, 0)
	t.Log("a workspace closed while watched: terminal.closed worker_removed, no observer left")

	// 3. A cheap Claude in a folder it has not seen stops at its trust
	// dialog: blocked, with a trust question.
	claudeDir := t.TempDir()
	s.run("--session", s.name, "workspace", "create", "--cwd", claudeDir, "--label", "claude", "--no-focus")
	cl := b.workerOf("claude", 10*time.Second)
	out, err := s.runErr("--session", s.name, "agent", "start", "h3d-laptop", "--kind", "claude", "--pane", cl.PaneID,
		"--timeout", "30000", "--", "--model", cheapClaude, "--effort", "low", "--permission-mode", "default")
	t.Logf("agent start: %v %s", err, out)
	q := b.question(nil, cl.ID, proto.QuestionTrust, 60*time.Second)
	yes := 0
	for _, c := range q.Choices {
		if c.Label == "Yes, I trust this folder" {
			yes = c.N
		}
	}
	if yes == 0 || !strings.Contains(q.Text, "trust") || len(q.Excerpt) == 0 {
		t.Fatalf("trust question = %+v", q)
	}
	b.refuse(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: cl.ID, Hash: "0000000000000000", Choice: yes}, proto.ErrStale)
	b.refuse(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: cl.ID, Text: "hi"}, proto.ErrInvalidState) // blocked
	var answer proto.AnswerResult
	evs := b.ack(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: cl.ID, Hash: q.Hash, Choice: yes}, 15*time.Second, &answer)
	if !answer.Resolved || !slices.Equal(answer.Sent, []string{"down", "enter"}) {
		t.Fatalf("trust answer = %+v", answer)
	}
	b.status(evs, cl.ID, 30*time.Second, "idle", "done")
	time.Sleep(3 * time.Second) // Claude drops an Enter right after its trust dialog

	// 4. worker.prompt: submitted to the idle agent; a second one while it
	// works is queued.
	var pr proto.PromptResult
	evs = b.ack(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: cl.ID,
		Text: "Write a 200-word story about a lighthouse keeper. Use no tools."}, 30*time.Second, &pr)
	if pr.Queued {
		t.Fatalf("first prompt = %+v", pr)
	}
	b.status(evs, cl.ID, 15*time.Second, "working")
	evs = b.ack(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: cl.ID, Text: "--then reply with exactly the word: pong"},
		30*time.Second, &pr)
	if !pr.Queued || pr.Retried {
		t.Fatalf("second prompt = %+v", pr)
	}
	b.status(evs, cl.ID, 120*time.Second, "idle", "done")
	t.Logf("prompts: submitted, then queued; the agent went back to %s", "idle/done")

	// 5. A tool permission prompt (no bypass): a permission question;
	// choice 1 runs it.
	probe := filepath.Join(claudeDir, "h3d-perm-"+hex.EncodeToString(rnd[:])+".txt")
	evs = b.ack(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: cl.ID,
		Text: "Use the Bash tool to run exactly this command: touch " + probe}, 30*time.Second, nil)
	q = b.question(evs, cl.ID, proto.QuestionPermission, 90*time.Second)
	if len(q.Choices) < 2 || q.Choices[0].Label != "Yes" || !strings.HasSuffix(q.Text, "?") {
		t.Fatalf("permission question = %+v", q)
	}
	b.ack(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: cl.ID, Hash: q.Hash, Choice: 1}, 15*time.Second, &answer)
	if !answer.Resolved || !slices.Equal(answer.Sent, []string{"1"}) {
		t.Fatalf("permission answer = %+v", answer)
	}
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if _, err := os.Stat(probe); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the approved command did not run: no %s", probe)
		}
	}

	// Every laptop command is audited, without what was typed.
	stopBridge()
	waitObservers(t, s.name, 0)
	rst, err := store.Open(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer rst.Close()
	log, err := rst.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, e := range log {
		counts[e.Cmd]++
		if strings.Contains(e.Args, marker) || strings.Contains(e.Args, "lighthouse") || strings.Contains(e.Args, "pong") {
			t.Errorf("typed text in the audit log: %s %s", e.Cmd, e.Args)
		}
	}
	t.Logf("audit: %v", counts)
	if counts[proto.CmdTerminalWatch] < 24 || counts[proto.CmdTerminalUnwatch] < 22 || counts[proto.CmdWorkerKeys] != 3 ||
		counts[proto.CmdWorkerPrompt] != 5 || counts[proto.CmdWorkerAnswer] != 3 {
		t.Fatalf("audit counts = %v", counts)
	}
}

func ptrTo[T any](v T) *T { return &v }
