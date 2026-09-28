package helper

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fakeSSHEnv makes the test binary act as ssh (see fakeSSH). Its value is a
// control file: "fail" makes it exit like a refused connection, "forward"
// makes it forward the -L unix socket like the real thing. It writes its
// arguments to <control>.args.
const fakeSSHEnv = "H3D_FAKE_SSH"

func TestMain(m *testing.M) {
	if ctl := os.Getenv(fakeSSHEnv); ctl != "" {
		os.Exit(fakeSSH(ctl, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fakeSSH(ctl string, args []string) int {
	_ = os.WriteFile(ctl+".args", []byte(strings.Join(args, "\n")), 0o600)
	mode, _ := os.ReadFile(ctl)
	var local, remote string
	for i, a := range args {
		if a == "-L" && i+1 < len(args) {
			local, remote, _ = strings.Cut(args[i+1], ":")
		}
	}
	if strings.TrimSpace(string(mode)) != "forward" || local == "" {
		fmt.Fprintln(os.Stderr, "ssh: connect to host fake port 22: Connection refused")
		return 255
	}
	_ = os.Remove(local) // StreamLocalBindUnlink=yes
	ln, err := net.Listen("unix", local)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bind:", err)
		return 255
	}
	go func() { // never outlive the test
		for os.Getppid() != 1 {
			time.Sleep(100 * time.Millisecond)
		}
		os.Exit(1)
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			return 255
		}
		go func() {
			defer c.Close()
			r, err := net.Dial("unix", remote)
			if err != nil {
				fmt.Fprintln(os.Stderr, "channel 2: open failed: connect failed:", err)
				return
			}
			defer r.Close()
			go io.Copy(r, c)
			io.Copy(c, r)
		}()
	}
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// shortDir is a temp dir short enough for unix socket paths.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// startBridge runs a real herdr-world hub and server (no herdr: one floor is
// published by hand) on a unix socket and returns the socket path.
func startBridge(t *testing.T, sock string) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	hub, err := server.NewHub(ctx, st, server.Options{Log: quietLog()})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := server.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { hub.Run(ctx) }()
	go func() {
		server.NewServer(hub, quietLog()).Serve(ctx, ln)
		close(done)
	}()
	hub.Updates() <- world.FloorObs{Session: "herdr-3d", Running: true, Gen: world.NextGen(),
		Workers: []world.WorkerObs{{WorkspaceID: "w1", Label: "ORCH|m2", Status: "working"}}}
	var once bool
	stop = func() {
		if once {
			return
		}
		once = true
		cancel()
		<-done
		st.Close()
	}
	t.Cleanup(stop)
	return stop
}

// waitFor polls cond for up to 10 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
