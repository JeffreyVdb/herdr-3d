package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/shell"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

const (
	claudeID = "8cb4e8a5-1111-4111-8111-111111111111"
	codexID  = "01a0e795-2222-7222-8222-222222222222"
)

// fakeHost plays herdr and systemd-run for herdr.Control's Runner: it
// starts and stops a fake session server (herdrtest), writes session.json
// on the way down like herdr, and answers pane run / report-agent-session
// / process-info for the session's two panes.
type fakeHost struct {
	t        *testing.T
	name     string
	dir      string
	codexCwd string

	mu       sync.Mutex
	srv      *herdrtest.Server
	argv     [][]string
	fg       map[string]string // pane → foreground ("" = the shell)
	reported string            // Codex id reported for w2:p1
	// resumes is what herdr's own resume starts in each pane on start.
	resumes map[string]string
}

func (h *fakeHost) Argv() [][]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.argv)
}

func (h *fakeHost) snapshotLocked() json.RawMessage {
	codexSession := ""
	if h.reported != "" {
		codexSession = `,"agent_session":{"source":"herdr:codex","agent":"codex","kind":"id","value":"` + h.reported + `"}`
	}
	return json.RawMessage(`{"version":"0.9.0","protocol":22,
		"workspaces":[
			{"workspace_id":"w1","number":1,"label":"CODE|claude","active_tab_id":"w1:t1","agent_status":"idle"},
			{"workspace_id":"w2","number":2,"label":"CODE|codex","active_tab_id":"w2:t1","agent_status":"idle"}],
		"panes":[
			{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","cwd":"/home/u/claude","agent":"claude","agent_status":"idle",
			 "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"` + claudeID + `"}},
			{"pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","cwd":"` + h.codexCwd + `","agent":"codex","agent_status":"idle"` + codexSession + `}],
		"agents":[
			{"pane_id":"w1:p1","workspace_id":"w1","agent":"claude","agent_status":"idle",
			 "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"` + claudeID + `"}},
			{"pane_id":"w2:p1","workspace_id":"w2","agent":"codex","agent_status":"idle"` + codexSession + `}]}`)
}

func (h *fakeHost) startLocked() {
	h.srv = herdrtest.Start(h.t, h.dir)
	h.srv.SetSnapshot(h.snapshotLocked())
	h.fg = map[string]string{}
	for pane, fg := range h.resumes {
		h.fg[pane] = fg
	}
}

func (h *fakeHost) stopLocked() {
	codexSession := ""
	if h.reported != "" {
		codexSession = `,"agent_session":{"source":"herdr:codex","agent":"codex","kind":"id","value":"` + h.reported + `"}`
	}
	file := `{"version":3,"workspaces":[
		{"id":"w1","custom_name":"CODE|claude","identity_cwd":"/home/u/claude","public_pane_numbers":{"1":1},
		 "tabs":[{"root_pane":1,"panes":{"1":{"cwd":"/home/u/claude",
		   "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"` + claudeID + `"}}}}]},
		{"id":"w2","custom_name":"CODE|codex","identity_cwd":"` + h.codexCwd + `","public_pane_numbers":{"2":1},
		 "tabs":[{"root_pane":2,"panes":{"2":{"cwd":"` + h.codexCwd + `","managed_agent_kind":"codex"` + codexSession + `}}}]}]}`
	if err := os.WriteFile(filepath.Join(h.dir, "session.json"), []byte(file), 0o600); err != nil {
		h.t.Error(err)
	}
	h.srv.Close()
	h.srv = nil
}

func (h *fakeHost) run(_ context.Context, argv []string) ([]byte, []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.argv = append(h.argv, argv)
	switch {
	case argv[0] == "fake-systemd-run":
		if h.srv != nil {
			return nil, []byte("Unit herdr-s-" + h.name + ".service already exists."), fmt.Errorf("exit status 1")
		}
		h.startLocked()
		return []byte("Running as unit: herdr-s-" + h.name + ".service\n"), nil, nil
	case argv[1] == "session" && argv[2] == "stop":
		h.stopLocked()
		return []byte(`{"session":{"name":"` + h.name + `","running":false},"stopped":true}`), nil, nil
	case argv[3] == "pane" && argv[4] == "run":
		h.fg[argv[5]] = argv[6]
		return []byte(`{"result":{"type":"ok"}}`), nil, nil
	case argv[3] == "pane" && argv[4] == "report-agent-session":
		h.reported = argv[len(argv)-1]
		h.srv.SetSnapshot(h.snapshotLocked())
		return []byte(`{"result":{"type":"ok"}}`), nil, nil
	case argv[3] == "pane" && argv[4] == "process-info":
		pane := argv[len(argv)-1]
		fg := h.fg[pane]
		if fg == "" {
			return []byte(`{"result":{"process_info":{"pane_id":"` + pane + `","shell_pid":100,"foreground_process_group_id":100,
				"foreground_processes":[{"pid":100,"name":"fish","argv":["/bin/fish"],"cmdline":"/bin/fish"}]}}}`), nil, nil
		}
		name := strings.Fields(fg)[0]
		return []byte(`{"result":{"process_info":{"pane_id":"` + pane + `","shell_pid":100,"foreground_process_group_id":200,
			"foreground_processes":[{"pid":200,"name":"` + name + `","cmdline":"` + fg + `"}]}}}`), nil, nil
	}
	return nil, []byte("fake host: unexpected command"), fmt.Errorf("exit status 2")
}

// TestWakeSleepThroughControl runs floor.sleep and floor.wake end to end:
// the real watcher and herdr.Control, with herdr and systemd-run faked
// at the Runner.
func TestWakeSleepThroughControl(t *testing.T) {
	root, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	bash := filepath.Join(root, "bash") // (the wake revalidates the shell it is given)
	if err := os.WriteFile(bash, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	name := "h3d-m3go-t1"
	host := &fakeHost{t: t, name: name, dir: filepath.Join(root, name), codexCwd: filepath.Join(root, "codex-work"),
		resumes: map[string]string{"w1:p1": "claude --resume " + claudeID, "w2:p1": "codex resume x"}}
	realDir := filepath.Join(root, "herdr-3d")
	for _, d := range []string{host.dir, realDir, host.codexCwd} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(realDir, "session.json"), herdrtest.Fixture(t, "session_v3.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Codex never told herdr its session; its rollout knows the cwd.
	rollouts := filepath.Join(root, "codex-sessions")
	day := filepath.Join(rollouts, "2026", "09", "28")
	if err := os.MkdirAll(day, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := `{"type":"session_meta","payload":{"id":"` + codexID + `","cwd":"` + host.codexCwd + `"}}` + "\n"
	if err := os.WriteFile(filepath.Join(day, "rollout-2026-09-28T10-00-00-"+codexID+".jsonl"), []byte(meta), 0o600); err != nil {
		t.Fatal(err)
	}
	host.mu.Lock()
	host.startLocked()
	host.mu.Unlock()

	lister := herdrtest.NewLister()
	lister.Set(herdr.Session{Name: name, SessionDir: host.dir, SocketPath: filepath.Join(host.dir, "herdr.sock")},
		herdr.Session{Name: "herdr-3d", SessionDir: realDir, SocketPath: filepath.Join(realDir, "herdr.sock")})
	only := regexp.MustCompile(`^h3d-m3go-`)
	db := filepath.Join(t.TempDir(), "world.db")
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
			Socket: sock, DB: db, Herdr: lister, Only: only, Poll: 50 * time.Millisecond, Resnapshot: time.Hour,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Name: "herdr-world", Ready: func() { close(ready) },
			Control:       &herdr.Control{Herdr: "fake-herdr", SystemdRun: "fake-systemd-run", Home: "/home/u", Only: only, Run: host.run, Shell: shell.Bash, ShellBin: bash},
			CodexSessions: rollouts, WakeTimeout: 2 * time.Second, ResumeTimeout: 500 * time.Millisecond,
			ResumePoll: 10 * time.Millisecond, ResumeSettle: 30 * time.Millisecond,
		})
	}()
	stopped := false
	stop := func() {
		if !stopped {
			stopped = true
			cancel()
			if err := <-served; err != nil {
				t.Errorf("Serve: %v", err)
			}
		}
	}
	t.Cleanup(stop)
	<-ready

	w := dumpOnce(t, sock)
	for len(w.Workers) < 2 || w.Floors[0].State != "running" {
		w = dumpOnce(t, sock)
	}
	if len(w.Floors) != 1 {
		t.Fatalf("floors = %+v (herdr-3d is outside --sessions)", w.Floors)
	}
	before := slices.Clone(w.Workers)

	cmd := func(typ string, args string) (proto.Ack, string) {
		t.Helper()
		out, err := runCLI(t, cmdMain, "-socket", sock, typ, args)
		var ack proto.Ack
		_ = json.Unmarshal([]byte(out), &ack)
		if err != nil {
			return ack, out
		}
		return ack, ""
	}
	if _, e := cmd(proto.CmdFloorSleep, `{"session":"`+name+`"}`); e != "" {
		t.Fatalf("sleep: %s", e)
	}
	argv := host.Argv()
	want := [][]string{
		{"fake-herdr", "--session", name, "pane", "report-agent-session", "w2:p1", "--source", "herdr:codex", "--agent", "codex", "--agent-session-id", codexID},
		{"fake-herdr", "session", "stop", name, "--json"},
	}
	if !slices.EqualFunc(filterOps(argv), want, slices.Equal) {
		t.Fatalf("sleep argv =\n%q\nwant\n%q", filterOps(argv), want)
	}
	asleep := dumpOnce(t, sock)
	if asleep.Floors[0].State != "asleep" || asleep.Floors[0].Transition != "" {
		t.Fatalf("after sleep: %+v", asleep.Floors)
	}
	sameDesks(t, "asleep", before, asleep.Workers)
	if asleep.Workers[1].AgentSession != codexID {
		t.Fatalf("codex worker asleep = %+v", asleep.Workers[1])
	}

	// herdr resumes claude itself; codex lands back at the shell and gets
	// the fallback.
	host.mu.Lock()
	host.resumes = map[string]string{"w1:p1": "claude --resume " + claudeID}
	host.mu.Unlock()
	ack, e := cmd(proto.CmdFloorWake, `{"session":"`+name+`"}`)
	if e != "" {
		t.Fatalf("wake: %s", e)
	}
	raw, _ := json.Marshal(ack.Data)
	wantAck := fmt.Sprintf(`{"workers":[{"id":%q,"resume":"confirmed"},{"id":%q,"resume":"fallback"}]}`, before[0].ID, before[1].ID)
	if string(raw) != wantAck {
		t.Fatalf("wake ack = %s, want %s", raw, wantAck)
	}
	argv = filterOps(host.Argv())
	want = [][]string{
		{"fake-systemd-run", "--user", "--unit=herdr-s-" + name, "--collect", "-p", "KillMode=process", "--working-directory=/home/u",
			bash, "-l", "-c", "exec herdr --session '" + name + "' server"},
		{"fake-herdr", "--session", name, "pane", "run", "w2:p1", "codex resume " + codexID},
	}
	if !slices.EqualFunc(argv[2:], want, slices.Equal) {
		t.Fatalf("wake argv =\n%q\nwant\n%q", argv[2:], want)
	}
	awake := dumpOnce(t, sock)
	if awake.Floors[0].State != "running" || awake.Floors[0].Transition != "" {
		t.Fatalf("after wake: %+v", awake.Floors)
	}
	sameDesks(t, "awake", before, awake.Workers)
	if awake.Workers[0].Resume != "confirmed" || awake.Workers[1].Resume != "fallback" {
		t.Fatalf("resume = %q %q", awake.Workers[0].Resume, awake.Workers[1].Resume)
	}

	// A session outside --sessions cannot be touched, not even named.
	if _, e := cmd(proto.CmdFloorWake, `{"session":"herdr-3d"}`); !strings.Contains(e, proto.ErrUnknownSession) {
		t.Fatalf("wake herdr-3d: %q", e)
	}
	if _, e := cmd(proto.CmdFloorWake, `{"session":"`+name+`"}`); !strings.Contains(e, proto.ErrInvalidState) {
		t.Fatalf("wake running: %q", e)
	}
	for _, a := range host.Argv() {
		if slices.Contains(a, "herdr-3d") {
			t.Fatalf("ran %q", a)
		}
	}

	stop()
	st, err := store.Open(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	log, err := st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		rows = append(rows, fmt.Sprintf("%s ok=%v done=%v", e.Cmd, e.OK, e.Done))
	}
	if !slices.Equal(rows, []string{"floor.sleep ok=true done=true", "floor.wake ok=true done=true",
		"floor.wake ok=false done=true", "floor.wake ok=false done=true"}) {
		t.Fatalf("audit = %v", rows)
	}
	if !strings.Contains(log[0].Result, codexID) || !strings.Contains(log[0].Result, `"stopped":true`) ||
		!strings.Contains(log[1].Result, "fallback: ran the resume command") {
		t.Fatalf("audit results = %q / %q", log[0].Result, log[1].Result)
	}
}

// filterOps drops the read-only process-info polls.
func filterOps(argv [][]string) [][]string {
	var out [][]string
	for _, a := range argv {
		if !slices.Contains(a, "process-info") {
			out = append(out, a)
		}
	}
	return out
}

func sameDesks(t *testing.T, when string, before, after []proto.Worker) {
	t.Helper()
	if len(after) != len(before) {
		t.Fatalf("%s: %d workers, want %d", when, len(after), len(before))
	}
	for i, b := range before {
		if a := after[i]; a.ID != b.ID || a.DeskIndex != b.DeskIndex || a.Name != b.Name {
			t.Errorf("%s: worker %d = %s desk %d %q, was %s desk %d %q", when, i, a.ID, a.DeskIndex, a.Name, b.ID, b.DeskIndex, b.Name)
		}
	}
}
