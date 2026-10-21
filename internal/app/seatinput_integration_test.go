//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// seatChild is a fixture program for the pane: raw mode, one mode on
// (`paste`: DECSET 2004, `mouse`: 1000 + 1006 SGR, `plain`: none), every
// byte it reads appended to its file; Ctrl+D ends it.
const seatChild = `import os, sys, termios, tty
out, mode = sys.argv[1], sys.argv[2]
on = {"paste": "\x1b[?2004h", "mouse": "\x1b[?1000h\x1b[?1006h", "plain": ""}[mode]
off = {"paste": "\x1b[?2004l", "mouse": "\x1b[?1006l\x1b[?1000l", "plain": ""}[mode]
old = termios.tcgetattr(0)
tty.setraw(0)
os.write(1, (on + "child " + mode + " ready\r\n").encode())
open(out + ".ready", "w").close()
try:
    with open(out, "ab", buffering=0) as f:
        while True:
            b = os.read(0, 4096)
            if not b:
                break
            f.write(b)
            if b"\x04" in b:
                break
finally:
    os.write(1, off.encode())
    termios.tcsetattr(0, termios.TCSADRAIN, old)
`

// seatRig is a bridge on a throwaway session with one plain workspace
// ("seat"), and a connection that owns its pane at 100 × 30.
type seatRig struct {
	t    *testing.T
	s    *throwaway
	b    *bridgeConn
	conn *proto.Conn
	w    *proto.Worker
	dir  string
	ctl  proto.TerminalControl
}

func startSeatRig(t *testing.T, s *throwaway) *seatRig {
	t.Helper()
	t.Logf("throwaway session %s (%s)", s.name, s.bin)
	var created struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", t.TempDir(), "--label", "seat", "--no-focus"), &created); err != nil {
		t.Fatal(err)
	}
	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: &herdr.Client{Bin: s.bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only},
		})
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
		if n := controllers(t, s.name); n != 0 {
			t.Errorf("%d controllers outlived the bridge", n)
		}
	})
	<-ready
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-seat-input"}); err != nil {
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
	r := &seatRig{t: t, s: s, b: &bridgeConn{t: t, conn: conn, st: st}, conn: conn, dir: t.TempDir()}
	r.w = r.b.workerOf("seat", 10*time.Second)
	if err := os.WriteFile(filepath.Join(r.dir, "child.py"), []byte(seatChild), 0o600); err != nil {
		t.Fatal(err)
	}
	r.b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: r.w.ID, Fps: 10, Cols: 100, Rows: 30, Control: true}, 10*time.Second, nil)
	r.b.st.next("terminal.control", 10*time.Second, func(env proto.Envelope, raw []byte) bool {
		return env.T == proto.TTerminalControl && json.Unmarshal(raw, &r.ctl) == nil && r.ctl.ID == r.w.ID
	})
	if r.ctl.Mode != proto.ControlOwned {
		t.Fatalf("control = %+v", r.ctl)
	}
	waitControllers(t, s.name, 1)
	return r
}

func (r *seatRig) keys(items ...proto.InputItem) {
	r.t.Helper()
	r.b.ack(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: r.w.ID, Input: items}, 10*time.Second, nil)
}

func (r *seatRig) text(s string) proto.InputItem { return proto.InputItem{Text: ptrTo(s)} }
func (r *seatRig) key(k string) proto.InputItem  { return proto.InputItem{Key: ptrTo(k)} }

// child starts the fixture in the pane (typed by the bridge) and waits until
// it is ready; it returns the file of what it reads.
func (r *seatRig) child(name, mode string) string {
	r.t.Helper()
	out := filepath.Join(r.dir, name)
	r.keys(r.text("python3 "+filepath.Join(r.dir, "child.py")+" "+out+" "+mode), r.key("enter"))
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := os.Stat(out + ".ready"); err == nil {
			return out
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("the %s child did not start:\n%s", mode, r.s.run("--session", r.s.name, "pane", "read", r.w.PaneID, "--source", "visible"))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// read waits until the child's file ends with end, and returns it.
func (r *seatRig) read(out, end string) string {
	r.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, _ := os.ReadFile(out)
		if bytes.HasSuffix(b, []byte(end)) {
			return string(b)
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("the child read %q, want it to end with %q", b, end)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

// done ends the child (Ctrl+D) and waits for its shell prompt.
func (r *seatRig) done(out string) {
	r.t.Helper()
	r.keys(r.key("ctrl+d"))
	r.read(out, "\x04")
	time.Sleep(300 * time.Millisecond) // the shell takes the terminal back
}

// TestIntegrationSeatPaste (#176 part 2): a paste on a seat that owns its pane
// reaches the program as one bracketed paste when it asked for that (DECSET
// 2004), as plain text otherwise (herdr strips the markers), in order with the
// keys typed around it, with nothing submitted; markers and NUL in the text
// never reach it. herdr 0.9.1 takes no clicks: the bridge says so and refuses
// them.
func TestIntegrationSeatPaste(t *testing.T) {
	r := startSeatRig(t, startThrowaway(t))
	v, _ := (&herdr.Control{Herdr: r.s.bin}).Version(context.Background())
	if !r.ctl.Paste || r.ctl.Mouse != v.AtLeast(herdr.MouseVersion) {
		t.Fatalf("control = %+v with herdr %s", r.ctl, v)
	}

	paste := func(text string) {
		t.Helper()
		r.b.ack(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: r.w.ID, Text: text}, 10*time.Second, nil)
	}
	out := r.child("bracketed", "paste")
	r.keys(r.text("a"))
	paste("line one\nline twö ✓\t<&>\x00\x1b[201~; echo injected\r\nlast")
	r.keys(r.text("b"))
	if got, want := r.read(out, "b"), "a\x1b[200~line one\rline twö ✓\t<&>; echo injected\rlast\x1b[201~b"; got != want {
		t.Fatalf("bracketed: the child read %q, want %q", got, want)
	}
	r.done(out)

	out = r.child("plain", "plain")
	paste("x\ny ✓")
	r.keys(r.text("z"))
	if got, want := r.read(out, "z"), "x\ry ✓z"; got != want {
		t.Fatalf("plain: the child read %q, want %q", got, want)
	}
	r.done(out)

	if !r.ctl.Mouse {
		out = r.child("mouse", "mouse")
		r.b.refuse(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: r.w.ID, Column: 5, Row: 2}, proto.ErrInvalidState)
		r.keys(r.text("q"))
		if got := r.read(out, "q"); got != "q" {
			t.Fatalf("a refused click reached the child: %q", got)
		}
		r.done(out)
	}
}

// herdr095 is the official herdr 0.9.5 release binary the #176 probe
// downloaded ("": not there).
func herdr095() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	bin := filepath.Join(home, ".cache", "h3d-176", "herdr-0.9.5", "herdr")
	if st, err := os.Stat(bin); err != nil || st.Mode()&0o111 == 0 {
		return ""
	}
	return bin
}

// isolateHerdr gives this test's herdr processes (the server, the bridge's
// CLI calls) directories of their own, so another release never touches the
// user's herdr state.
func isolateHerdr(t *testing.T) {
	t.Helper()
	root, err := os.MkdirTemp("", "h3dx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	for _, k := range []string{"XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"} {
		d := filepath.Join(root, strings.ToLower(strings.TrimPrefix(k, "XDG_")))
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(k, d)
	}
	cfg := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "herdr", "config.toml")
	if err := os.Mkdir(filepath.Dir(cfg), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, []byte("onboarding = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_CONFIG_PATH", cfg)
}

// TestIntegrationSeatMouse (#176 part 2) runs herdr 0.9.5 (isolated: its own
// XDG directories and a throwaway session): the bridge reads its version and
// says the seat takes clicks; a click reaches a program with mouse reporting
// on as SGR press and release at the cell (1-based), and a plain program gets
// no byte of it. A paste still works there too.
func TestIntegrationSeatMouse(t *testing.T) {
	bin := herdr095()
	if bin == "" {
		t.Skip("no herdr 0.9.5 at ~/.cache/h3d-176/herdr-0.9.5/herdr")
	}
	isolateHerdr(t)
	r := startSeatRig(t, startThrowawayBin(t, bin))
	if !r.ctl.Mouse || !r.ctl.Paste {
		t.Fatalf("control = %+v: herdr 0.9.5 takes clicks", r.ctl)
	}
	click := func(button string, col, row, mods int) {
		t.Helper()
		r.b.ack(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: r.w.ID, Button: button, Column: col, Row: row, Modifiers: mods}, 10*time.Second, nil)
	}

	out := r.child("mouse", "mouse")
	click("left", 5, 2, 0)
	r.keys(r.text("k"))
	click("right", 99, 29, 0)
	r.keys(r.text("q"))
	want := "\x1b[<0;6;3M\x1b[<0;6;3mk\x1b[<2;100;30M\x1b[<2;100;30mq"
	if got := r.read(out, "q"); got != want {
		t.Fatalf("mouse on: the child read %q, want %q", got, want)
	}
	r.b.refuse(proto.CmdTerminalMouse, proto.TerminalMouseArgs{ID: r.w.ID, Column: 100, Row: 0}, proto.ErrBadRequest)
	r.done(out)

	out = r.child("plain", "plain")
	click("left", 5, 2, 0)
	r.b.ack(proto.CmdWorkerPaste, proto.WorkerPasteArgs{ID: r.w.ID, Text: "p"}, 10*time.Second, nil)
	r.keys(r.text("z"))
	if got := r.read(out, "z"); got != "pz" {
		t.Fatalf("mouse off: the child read %q (a click must send nothing)", got)
	}
	r.done(out)
	t.Logf("herdr %s: %s", bin, strconv.Quote(want))
}
