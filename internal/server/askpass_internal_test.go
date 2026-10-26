//go:build linux

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/manual/askpass"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

const testManualID = "mp_01234567"

type lockedLog struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(b)
}
func (l *lockedLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type hygieneRoles struct {
	cls *ai.FakeClassifier
	llm *ai.FakeLLM
}

func (r *hygieneRoles) State(ai.Role) ai.State     { return ai.StateReady }
func (r *hygieneRoles) Fingerprint(ai.Role) string { return "fixture" }
func (r *hygieneRoles) Classifier() ai.Classifier  { return r.cls }
func (r *hygieneRoles) LLM() ai.LLM                { return r.llm }

type manualRig struct {
	t             *testing.T
	ctx           context.Context
	cancel        context.CancelFunc
	hub           *Hub
	st            *store.Store
	ws            *proto.Conn
	root, dir, db string
	wire          bytes.Buffer
	log           *lockedLog
	models        *hygieneRoles
	transcript    string
	seq           int
}

func newManualRig(t *testing.T) *manualRig { return newManualRigWithTerm(t, nil) }

func newManualRigWithTerm(t *testing.T, term TermHerdr) *manualRig {
	t.Helper()
	root, err := os.MkdirTemp(os.Getenv("TMPDIR"), "mb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "r"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "s"))
	dir := filepath.Join(manualStateDir(), testManualID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := askpass.Env(dir, testManualID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	db := filepath.Join(root, "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	log := &lockedLog{}
	models := &hygieneRoles{cls: &ai.FakeClassifier{}, llm: &ai.FakeLLM{}}
	_, _ = models.cls.Classify(ctx, map[string]any{"fixture": "benign"}, "fixture request")
	_, _ = models.llm.Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "user", Content: "benign fixture request"}}})
	on := true
	transcript := filepath.Join(root, "agent-transcript.jsonl")
	if err := os.WriteFile(transcript, []byte("{\"type\":\"assistant\",\"text\":\"fixture\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	h, err := NewHub(ctx, st, Options{Log: slog.New(slog.NewTextHandler(log, nil)), Term: term, FollowupRoles: models, FollowupsEnabled: &on})
	if err != nil {
		t.Fatal(err)
	}
	h.manualProcesses = map[string]proto.ManualProcess{testManualID: {ID: testManualID, State: "running", Session: "s", PaneID: "w:p2", Launched: "sudo -A -u root true"}}
	sock := filepath.Join(root, "bridge.sock")
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.ListenAskpass(ctx, askpass.SocketPath()); err != nil {
		t.Fatal(err)
	}
	hubDone := make(chan struct{})
	go func() { _ = h.Run(ctx); close(hubDone) }()
	srv := NewServer(h, slog.New(slog.NewTextHandler(log, nil)))
	srv.SetCloseGrace(10 * time.Millisecond)
	srvDone := make(chan struct{})
	go func() { _ = srv.Serve(ctx, ln); close(srvDone) }()
	ws, err := proto.Dial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.Hello(ctx, proto.Hello{Client: "credential-test"}); err != nil {
		t.Fatal(err)
	}
	r := &manualRig{t: t, ctx: ctx, cancel: cancel, hub: h, st: st, ws: ws, root: root, dir: dir, db: db, log: log, models: models, transcript: transcript}
	r.read() // snapshot
	t.Cleanup(func() { ws.CloseNow(); cancel(); <-srvDone; <-hubDone; _ = st.Close() })
	return r
}
func (r *manualRig) action(f func()) {
	r.t.Helper()
	done := make(chan struct{})
	if err := r.hub.do(r.ctx, func(context.Context) { f(); close(done) }); err != nil {
		r.t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		r.t.Fatal("hub action timed out")
	}
}
func (r *manualRig) read() (proto.Envelope, []byte) {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
	defer cancel()
	e, b, err := r.ws.Read(ctx)
	if err != nil {
		r.t.Fatal(err)
	}
	r.wire.Write(b)
	r.wire.WriteByte('\n')
	return e, b
}
func (r *manualRig) credential() proto.ManualCredential {
	r.t.Helper()
	for {
		e, b := r.read()
		if e.T != proto.EvManualProcessUpsert {
			continue
		}
		var ev proto.Event
		if json.Unmarshal(b, &ev) == nil && ev.Process != nil && ev.Process.Credential != nil {
			return *ev.Process.Credential
		}
	}
}
func (r *manualRig) command(typ string, args any) proto.Error {
	r.t.Helper()
	r.seq++
	id := fmt.Sprint(r.seq)
	raw, _ := json.Marshal(args)
	if err := r.ws.Send(r.ctx, proto.Command{T: typ, ReqID: id, Args: raw}); err != nil {
		r.t.Fatal(err)
	}
	for {
		e, b := r.read()
		if e.ReqID != id {
			continue
		}
		if e.T == proto.TAck {
			return proto.Error{}
		}
		var failure proto.Error
		_ = json.Unmarshal(b, &failure)
		return failure
	}
}
func (r *manualRig) answer(c proto.ManualCredential, s *string, cancel *bool) proto.Error {
	return r.command(proto.CmdManualProcessCredential, proto.ManualProcessCredentialArgs{ID: testManualID, Request: c.Request, Secret: s, Cancel: cancel})
}
func (r *manualRig) process(state string) {
	r.action(func() {
		p := r.hub.manualProcesses[testManualID]
		p.State = state
		r.hub.manualProcesses[testManualID] = p
	})
}

// TestManualAskpassHelperProcess lets the fixture exec this test binary as a
// helper without putting the answer in argv or environment.
func TestManualAskpassHelperProcess(t *testing.T) {
	if os.Getenv("H3D_TEST_ASKPASS") != "1" {
		return
	}
	args := os.Args
	i := 0
	for i < len(args) && args[i] != "--" {
		i++
	}
	if i+2 >= len(args) || askpass.Helper(args[i+1], args[i+2], os.Stdout) != nil {
		os.Exit(1)
	}
	os.Exit(0)
}
func (r *manualRig) sudo(marker string) (*exec.Cmd, *bytes.Buffer) {
	r.t.Helper()
	expected := filepath.Join(r.root, "expected")
	if err := os.WriteFile(expected, []byte(marker), 0600); err != nil {
		r.t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		r.t.Fatal(err)
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
	script := "#!/bin/sh\necho $$ > " + quote(filepath.Join(r.root, "helper.pid")) + "\nexec " + quote(exe) + " -test.run '^TestManualAskpassHelperProcess$' -- " + quote(r.dir) + " \"$@\"\n"
	helper := filepath.Join(r.dir, "askpass")
	if err := os.WriteFile(helper, []byte(script), 0700); err != nil {
		r.t.Fatal(err)
	}
	cmd := exec.Command("sh", "testdata/fake-sudo.sh", "-A", "sh", "-c", "printf completed")
	cmd.Env = append(os.Environ(), "H3D_TEST_ASKPASS=1", "SUDO_ASKPASS="+helper, "FAKE_EXPECT="+expected)
	output := &bytes.Buffer{}
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	})
	return cmd, output
}
func assertNoMarker(t *testing.T, label, marker string, data []byte) {
	t.Helper()
	if bytes.Contains(data, []byte(marker)) {
		t.Fatalf("marker leaked into %s", label)
	}
}
func (r *manualRig) inspectProc(pid int, markers ...string) {
	r.t.Helper()
	for _, name := range []string{"cmdline", "environ"} {
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/%s", pid, name))
		if err != nil {
			r.t.Fatalf("read process %d %s: %v", pid, name, err)
		}
		for _, marker := range markers {
			assertNoMarker(r.t, fmt.Sprintf("process %d %s", pid, name), marker, b)
		}
	}
}
func (r *manualRig) inspectDescendants(root int, markers ...string) {
	r.t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		r.t.Fatal(err)
	}
	parents := map[int]int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PPid:") {
				n, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
				parents[pid] = n
				break
			}
		}
	}
	owned := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, parent := range parents {
			if !owned[pid] && owned[parent] {
				owned[pid] = true
				changed = true
			}
		}
	}
	for pid := range owned {
		for _, name := range []string{"cmdline", "environ"} {
			data, err := os.ReadFile(fmt.Sprintf("/proc/%d/%s", pid, name))
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				r.t.Fatal(err)
			}
			for _, marker := range markers {
				assertNoMarker(r.t, fmt.Sprintf("process %d %s", pid, name), marker, data)
			}
		}
	}
}

func (r *manualRig) hygiene(markers ...string) {
	r.t.Helper()
	entries, err := r.st.AuditLog(r.ctx)
	if err != nil {
		r.t.Fatal(err)
	}
	audit, _ := json.Marshal(entries)
	var ring [][]byte
	var snapshot []byte
	r.action(func() {
		for _, e := range r.hub.ring.buf {
			ring = append(ring, append([]byte(nil), e.msg...))
		}
		snapshot, _ = json.Marshal(r.hub.snapshot())
	})
	db, err := os.ReadFile(r.db)
	if err != nil {
		r.t.Fatal(err)
	}
	// SQLite WAL may hold newer rows until checkpoint; inspect it as well.
	wal, _ := os.ReadFile(r.db + "-wal")
	transcript, err := os.ReadFile(r.transcript)
	if err != nil {
		r.t.Fatal(err)
	}
	modelRequests, _ := json.Marshal(r.models.cls.Calls())
	for _, req := range r.models.llm.Calls() {
		b, _ := json.Marshal(req.Messages)
		modelRequests = append(modelRequests, b...)
	}
	if !bytes.Contains(modelRequests, []byte("benign")) {
		r.t.Fatal("fake AI request recorder was not exercised")
	}
	for _, marker := range markers {
		for label, b := range map[string][]byte{"database": db, "WAL": wal, "audit": audit, "logs": []byte(r.log.String()), "wire": r.wire.Bytes(), "snapshot": snapshot, "replay ring": bytes.Join(ring, nil), "agent transcript": transcript, "AI request recorder": modelRequests} {
			assertNoMarker(r.t, label, marker, b)
		}
	}
}

func TestManualAskpassSuccessRetryCancelExpiry(t *testing.T) {
	r := newManualRig(t)
	marker := "H3D-MARKER-credential-0123456789"
	wrong := "H3D-MARKER-wrong-0123456789"
	cmd, out := r.sudo(marker)
	first := r.credential()
	if first.Attempt != 1 || first.User != "root" || first.Prompt != "[sudo] password for x: " {
		t.Fatalf("first request: %+v", first)
	}
	r.inspectProc(cmd.Process.Pid, marker, wrong)
	pidBytes, err := os.ReadFile(filepath.Join(r.root, "helper.pid"))
	if err != nil {
		t.Fatal(err)
	}
	var helperPID int
	if _, err = fmt.Sscan(string(pidBytes), &helperPID); err != nil {
		t.Fatal(err)
	}
	r.inspectProc(helperPID, marker, wrong)
	r.inspectDescendants(cmd.Process.Pid, marker, wrong)
	r.hygiene(marker, wrong)
	if e := r.answer(first, &wrong, nil); e.T != "" {
		t.Fatalf("wrong answer: %+v", e)
	}
	second := r.credential()
	if second.Attempt != 2 || second.Request == first.Request {
		t.Fatalf("retry: %+v", second)
	}
	if e := r.answer(first, &marker, nil); e.Code != proto.ErrStale {
		t.Fatalf("replayed request: %+v", e)
	}
	if e := r.answer(second, &marker, nil); e.T != "" {
		t.Fatalf("answer: %+v", e)
	}
	if err := cmd.Wait(); err != nil || !strings.Contains(out.String(), "completed") || !strings.Contains(out.String(), "Sorry, try again.") {
		t.Fatalf("fake sudo result %v %q", err, out.String())
	}
	if e := r.answer(second, &marker, nil); e.Code != proto.ErrStale {
		t.Fatalf("replayed answer: %+v", e)
	}
	cmd, out = r.sudo(marker)
	cancelReq := r.credential()
	yes := true
	if e := r.answer(cancelReq, nil, &yes); e.T != "" {
		t.Fatalf("cancel: %+v", e)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("cancel succeeded")
	}
	assertNoMarker(t, "cancel output", marker, out.Bytes())
	cmd, _ = r.sudo(marker)
	expired := r.credential()
	r.action(func() { r.hub.credentials[testManualID].expires = time.Now().Add(-time.Second) })
	if e := r.answer(expired, &marker, nil); e.Code != proto.ErrStale {
		t.Fatalf("expired: %+v", e)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("expiry succeeded")
	}
	cmd, _ = r.sudo(marker)
	late := r.credential()
	r.process("exited")
	if e := r.answer(late, &marker, nil); e.Code != proto.ErrStale {
		t.Fatalf("after process exit: %+v", e)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("exit did not cancel helper")
	}
	r.hygiene(marker, wrong)
}

var _ io.Writer = (*lockedLog)(nil)

func (r *manualRig) helperConn(nonce string) *net.UnixConn {
	r.t.Helper()
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: askpass.SocketPath(), Net: "unix"})
	if err != nil {
		r.t.Fatal(err)
	}
	if err := json.NewEncoder(conn).Encode(askpass.Request{Process: testManualID, Nonce: nonce, Prompt: "password:"}); err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = conn.Close() })
	return conn
}
func (r *manualRig) nonce() string {
	b, err := os.ReadFile(filepath.Join(r.dir, "nonce"))
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}
func TestManualAskpassReplacementDisconnectTimeout(t *testing.T) {
	r := newManualRig(t)
	// A wrong nonce is rejected without creating a request.
	badConn := r.helperConn(strings.Repeat("0", 64))
	_ = badConn.SetReadDeadline(time.Now().Add(time.Second))
	var badResponse askpass.Response
	if err := json.NewDecoder(badConn).Decode(&badResponse); err == nil {
		t.Fatal("invalid nonce accepted")
	}
	one := r.helperConn(r.nonce())
	first := r.credential()
	two := r.helperConn(r.nonce())
	second := r.credential()
	if second.Attempt != first.Attempt+1 || second.Request == first.Request {
		t.Fatalf("replacement: %+v %+v", first, second)
	}
	_ = one.SetReadDeadline(time.Now().Add(time.Second))
	var canceled askpass.Response
	if err := json.NewDecoder(one).Decode(&canceled); err != nil || canceled.OK {
		t.Fatalf("replaced helper: %+v %v", canceled, err)
	}
	secret := "H3D-MARKER-replaced-answer"
	if e := r.answer(first, &secret, nil); e.Code != proto.ErrStale {
		t.Fatalf("replaced answer: %+v", e)
	}
	_ = two.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		open := false
		r.action(func() { open = r.hub.credentials[testManualID] != nil })
		if !open {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("disconnect did not expire request")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if e := r.answer(second, &secret, nil); e.Code != proto.ErrStale {
		t.Fatalf("disconnected answer: %+v", e)
	}
	r.action(func() { r.hub.credentialTimeout = 80 * time.Millisecond })
	three := r.helperConn(r.nonce())
	third := r.credential()
	_ = three.SetReadDeadline(time.Now().Add(2 * time.Second))
	var expired askpass.Response
	if err := json.NewDecoder(three).Decode(&expired); (err != nil && err != io.EOF) || expired.OK {
		t.Fatalf("timeout: %+v %v", expired, err)
	}
	if e := r.answer(third, &secret, nil); e.Code != proto.ErrStale {
		t.Fatalf("timed-out answer: %+v", e)
	}
	r.hygiene(secret)
}
