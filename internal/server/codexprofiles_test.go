package server_test

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// profileRunner answers Claude as limitsRunner does, and each Codex probe
// with the plan named after its CODEX_HOME's folder; it records the
// CODEX_HOMEs.
type profileRunner struct {
	limitsRunner
	mu    sync.Mutex
	homes []string
}

func (r *profileRunner) Start(c limits.Cmd) (limits.Process, error) {
	if c.Path != "codex" {
		return r.limitsRunner.Start(c)
	}
	var home []string
	for _, kv := range c.Env {
		if v, ok := strings.CutPrefix(kv, "CODEX_HOME="); ok {
			home = append(home, v)
		}
	}
	r.mu.Lock()
	r.homes = append(r.homes, strings.Join(home, ","))
	r.mu.Unlock()
	plan := strings.TrimPrefix(filepath.Base(strings.Join(home, ",")), ".")
	p := &limitsProc{}
	var err error
	if p.in, p.inW, err = os.Pipe(); err != nil {
		return nil, err
	}
	if p.outR, p.out, err = os.Pipe(); err != nil {
		return nil, err
	}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer p.out.Close()
		defer p.in.Close()
		sc := bufio.NewScanner(p.in)
		for sc.Scan() {
			switch {
			case strings.Contains(sc.Text(), `"id":1`):
				io.WriteString(p.out, `{"id":1,"result":{}}`+"\n")
			case strings.Contains(sc.Text(), `"id":2`):
				io.WriteString(p.out, `{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":19,"windowDurationMins":10080,"resetsAt":1791053830},"planType":"`+plan+`"}}}`+"\n")
			}
		}
	}()
	return p, nil
}

func (r *profileRunner) probed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.homes...)
}

// codexHomes makes a user home with Codex homes: name → whether it has an
// auth.json.
func codexHomes(t *testing.T, homes map[string]bool) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, auth := range homes {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o700); err != nil {
			t.Fatal(err)
		}
		if auth {
			if err := os.WriteFile(filepath.Join(dir, name, "auth.json"), []byte(`{"tokens":{}}`), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}

func profilesOptions(home string, r limits.Runner) server.Options {
	svc := codexaccount.New(home, filepath.Join(home, ".codex"))
	return server.Options{CodexProfiles: svc, Limits: &limits.Config{Runner: r, ClaudeBin: "claude", CodexBin: "codex", Tick: 10 * time.Millisecond,
		Accounts: svc, Env: func() []string { return []string{"CODEX_HOME=/inherited"} }, Log: quietLog()}}
}

func profilesOf(t *testing.T, v any) proto.CodexProfiles {
	t.Helper()
	var p proto.CodexProfiles
	if err := json.Unmarshal(mustMarshal(t, v), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func keysOf(p *proto.CodexProfiles) string {
	var out []string
	for _, x := range p.Profiles {
		out = append(out, x.Key)
	}
	return strings.Join(out, ",")
}

// limitsKeyOf is a reading's provider and Codex profile.
func limitsKeyOf(l proto.Limits) string {
	if l.Account == nil {
		return l.Provider
	}
	return l.Provider + "/" + l.Account.Key
}

// #138: two Codex homes are read apart (each with its own CODEX_HOME), each
// its own limits.update and snapshot entry; the profiles are in the
// snapshot and the settings are checked, published and kept.
func TestCodexProfilesLimits(t *testing.T) {
	t.Parallel()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-work": true, ".codex-loggedout": false, "spare": false})
	r := &profileRunner{}
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, profilesOptions(home, r))
	a := b.connect(proto.Hello{Client: "a"})
	snap := a.snapshot().World
	if snap.CodexProfiles == nil || keysOf(snap.CodexProfiles) != "codex,work" {
		t.Fatalf("profiles %+v", snap.CodexProfiles)
	}
	if d := snap.CodexProfiles.Profiles[0]; !d.Default || !d.SignedIn || d.Display != "~/.codex" || d.Path != filepath.Join(home, ".codex") || d.Hidden || d.Added {
		t.Errorf("default %+v", d)
	}
	got := map[string]proto.Event{}
	for len(got) < 3 {
		ev := a.until(proto.EvLimitsUpdate)
		got[limitsKeyOf(*ev.Limits)] = ev
	}
	if got["codex/codex"].Plan != "codex" || got["codex/work"].Plan != "codex-work" || got["codex/work"].Account.Name != "work" || got["codex/work"].Account.Default {
		t.Fatalf("readings %+v / %+v", got["codex/codex"].Limits, got["codex/work"].Limits)
	}
	if p := r.probed(); len(p) < 2 || p[0] != filepath.Join(home, ".codex") || p[1] != filepath.Join(home, ".codex-work") {
		t.Fatalf("probed with CODEX_HOME %v", p)
	}

	c2 := b.connect(proto.Hello{Client: "c2"})
	w2 := c2.snapshot().World
	var order []string
	for _, l := range w2.Limits {
		order = append(order, limitsKeyOf(l))
	}
	if strings.Join(order, " ") != "claude codex/codex codex/work" {
		t.Fatalf("snapshot limits %v", order)
	}
	if p := w2.CodexProfiles.Profiles[1]; p.Plan != "codex-work" {
		t.Errorf("work's plan in the profiles: %+v", p)
	}

	// Refusals; nothing stored.
	for _, c := range []struct {
		args any
		code string
		want string
	}{
		{map[string]any{}, proto.ErrBadRequest, "exactly one"},
		{map[string]any{"key": "work", "name": "x", "hidden": true}, proto.ErrBadRequest, "exactly one"},
		{map[string]any{"name": "x"}, proto.ErrBadRequest, "key is required"},
		{map[string]any{"key": "nope", "name": "x"}, proto.ErrNotFound, "nope"},
		{map[string]any{"key": "codex", "hidden": true}, proto.ErrBadRequest, "cannot be hidden"},
		{map[string]any{"key": "work", "remove": true}, proto.ErrBadRequest, "only hidden"},
		{map[string]any{"key": "work", "name": "  "}, proto.ErrBadRequest, "Type a name"},
		{map[string]any{"key": "work", "name": "Codex"}, proto.ErrBadRequest, "Another profile"},
		{map[string]any{"add": "~/nothing"}, proto.ErrBadRequest, "no folder there"},
		{map[string]any{"add": "~/.codex-work"}, proto.ErrBadRequest, "already the profile"},
		{map[string]any{"add": "rel"}, proto.ErrBadRequest, "absolute path"},
	} {
		_, m := a.command(proto.CmdCodexProfilesSet, "bad", c.args)
		if m.env.T != proto.TError || !strings.Contains(string(m.raw), `"`+c.code+`"`) || !strings.Contains(string(m.raw), c.want) {
			t.Errorf("set %v: %s", c.args, m.raw)
		}
	}

	// A rename goes out on the reading at once, the key stays.
	evs, ack := a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "work", Name: ptr(" Work seat ")})
	if p := profilesOf(t, ack.Data); p.Profiles[1].Name != "Work seat" || p.Profiles[1].Key != "work" {
		t.Fatalf("rename ack %+v", p)
	}
	renamed := false
	for _, e := range evs {
		renamed = renamed || (e.T == proto.EvLimitsUpdate && e.Account != nil && e.Account.Key == "work" && e.Account.Name == "Work seat")
	}
	if !renamed {
		t.Fatalf("rename events %+v", evs)
	}

	// Hidden: its reading is gone from the snapshot.
	_, ack = a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "work", Hidden: ptr(true)})
	if p := profilesOf(t, ack.Data); !p.Profiles[1].Hidden {
		t.Fatalf("hide ack %+v", p)
	}
	for _, l := range b.connect(proto.Hello{}).snapshot().World.Limits {
		if l.Account != nil && l.Account.Key == "work" {
			t.Fatalf("a hidden profile's reading in the snapshot: %+v", l)
		}
	}

	// Added: listed after the found ones, signed out, removable.
	_, ack = a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Add: ptr("~/spare")})
	p := profilesOf(t, ack.Data)
	if keysOf(&p) != "codex,work,spare" || !p.Profiles[2].Added || p.Profiles[2].SignedIn || p.Profiles[2].Display != "~/spare" {
		t.Fatalf("add ack %+v", p)
	}
	b.stop()

	// Kept over a restart.
	b = startBridge(t, db, profilesOptions(home, &profileRunner{}))
	w := b.connect(proto.Hello{}).snapshot().World.CodexProfiles
	if keysOf(w) != "codex,work,spare" || w.Profiles[1].Name != "Work seat" || !w.Profiles[1].Hidden || !w.Profiles[2].Added {
		t.Fatalf("after a restart %+v", w)
	}
	c := b.connect(proto.Hello{})
	c.snapshot()
	_, ack = c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "spare", Remove: true})
	if p := profilesOf(t, ack.Data); keysOf(&p) != "codex,work" {
		t.Fatalf("remove ack %+v", p)
	}
}

// A bridge without the service refuses the commands and has no profiles in
// its snapshot; a Codex reading without an account still shows.
func TestCodexProfilesUnsupported(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", limitsOptions(&limitsRunner{}))
	c := b.connect(proto.Hello{})
	if w := c.snapshot().World; w.CodexProfiles != nil {
		t.Fatalf("profiles %+v", w.CodexProfiles)
	}
	c.mustError(proto.CmdCodexProfilesGet, nil, proto.ErrUnsupported)
	if ev := c.until(proto.EvLimitsUpdate); ev.Account != nil {
		t.Fatalf("an account without profiles: %+v", ev.Limits)
	}
}
