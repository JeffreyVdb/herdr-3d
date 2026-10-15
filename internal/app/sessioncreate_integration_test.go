//go:build integration

package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestIntegrationSessionCreate creates a throwaway session (h3d-it-new-*)
// through the bridge's session.create, the Add floor dialog's "New herdr
// session" (#58): herdr starts its server in the transient unit
// herdr-s-<name>, the ack comes once its floor is in the world, and a second
// create of the name is name_taken. Cleanup stops the session herdr's way,
// waits for the unit to go and deletes the session, also on failure. The
// bridge only watches (and may only control) that one name.
func TestIntegrationSessionCreate(t *testing.T) {
	bin, err := exec.LookPath("herdr")
	if err != nil {
		t.Skip("herdr is not installed")
	}
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run is not installed")
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	name := "h3d-it-new-" + hex.EncodeToString(rnd[:])
	env := herdr.CleanEnv(os.Environ())
	client := &herdr.Client{Bin: bin}
	before := listSessions(t, client)
	for _, s := range before {
		if s.Name == name {
			t.Fatalf("session %s already exists", name)
		}
	}
	sessionsDir, err := herdr.SessionsDir(before)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(sessionsDir, name)
	unit := herdr.SessionUnit(name)
	herdrOn := func(args ...string) {
		if !strings.HasPrefix(name, "h3d-it-") || args[len(args)-2] != name {
			panic("integration test tried to run herdr outside its throwaway session: " + strings.Join(args, " "))
		}
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Logf("herdr %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	t.Cleanup(func() {
		herdrOn("session", "stop", name, "--json")
		for deadline := time.Now().Add(10 * time.Second); unitActive(unit) && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
		}
		if unitActive(unit) {
			t.Errorf("%s still active after herdr session stop; stopping the unit", unit)
			_ = exec.Command("systemctl", "--user", "stop", unit).Run()
		}
		_ = exec.Command("systemctl", "--user", "reset-failed", unit).Run()
		for deadline := time.Now().Add(10 * time.Second); unitLoaded(unit) && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
		}
		if unitLoaded(unit) {
			t.Errorf("transient unit %s is still loaded", unit)
		}
		herdrOn("session", "delete", name, "--json")
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("throwaway session dir %s still exists", dir)
		}
	})

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(name) + "$")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: client, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: bin, Only: only},
		})
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	<-ready

	create := func() (string, error) {
		var out strings.Builder
		cctx, ccancel := context.WithTimeout(ctx, time.Minute)
		defer ccancel()
		err := cmdMain(cctx, "herdr-world", []string{"-socket", sock, proto.CmdSessionCreate, `{"name":"` + name + `"}`}, &out, io.Discard)
		return out.String(), err
	}
	start := time.Now()
	out, err := create()
	if err != nil {
		t.Fatalf("session.create: %v: %s", err, out)
	}
	t.Logf("session.create acked after %s: %s", time.Since(start).Round(time.Millisecond), strings.TrimSpace(out))
	var ack struct {
		Data proto.SessionCreated `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &ack); err != nil || ack.Data.Session != name {
		t.Fatalf("ack = %s (%v)", out, err)
	}

	// The ack comes after the floor is in the world: running, in no building.
	var dump strings.Builder
	dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
	defer dcancel()
	if err := dumpMain(dctx, "herdr-world", []string{"-socket", sock, "-once"}, &dump, io.Discard); err != nil {
		t.Fatal(err)
	}
	var snap proto.Snapshot
	if err := json.Unmarshal([]byte(dump.String()), &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.World.Floors) != 1 || snap.World.Floors[0].Session != name || snap.World.Floors[0].State != "running" || snap.World.Floors[0].Building != nil {
		t.Fatalf("floors right after the ack = %+v", snap.World.Floors)
	}
	// herdr knows it, it runs in its unit, and the bridge's unit check sees
	// that unit (its transient file under the runtime dir).
	var listed bool
	for _, s := range listSessions(t, client) {
		listed = listed || s.Name == name
	}
	if !listed {
		t.Errorf("herdr session list has no %s", name)
	}
	if !unitActive(unit) {
		t.Errorf("no active transient unit %s", unit)
	}
	if !herdr.TransientUnitLoaded(herdr.RuntimeDir())(unit) {
		t.Errorf("TransientUnitLoaded does not see %s", unit)
	}

	// The name is taken now.
	out, err = create()
	var e proto.Error
	if err == nil || json.Unmarshal([]byte(out), &e) != nil || e.Code != proto.ErrNameTaken {
		t.Fatalf("second session.create = %v: %s, want name_taken", err, out)
	}
}
