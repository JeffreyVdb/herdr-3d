package server_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
	// Its key has a hash of its path (it is not a ~/.codex-* folder); its
	// name is the folder's.
	_, ack = a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Add: ptr("~/spare")})
	p := profilesOf(t, ack.Data)
	spare := p.Profiles[len(p.Profiles)-1].Key
	if keysOf(&p) != "codex,work,"+spare || !strings.HasPrefix(spare, "spare-") || p.Profiles[2].Name != "spare" || !p.Profiles[2].Added || p.Profiles[2].SignedIn || p.Profiles[2].Display != "~/spare" {
		t.Fatalf("add ack %+v", p)
	}
	b.stop()

	// Kept over a restart.
	b = startBridge(t, db, profilesOptions(home, &profileRunner{}))
	w := b.connect(proto.Hello{}).snapshot().World.CodexProfiles
	if keysOf(w) != "codex,work,"+spare || w.Profiles[1].Name != "Work seat" || !w.Profiles[1].Hidden || !w.Profiles[2].Added {
		t.Fatalf("after a restart %+v", w)
	}
	c := b.connect(proto.Hello{})
	c.snapshot()
	_, ack = c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: spare, Remove: true})
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

// R1 of the #138 review: two folders with the same name each keep their
// key, and their readings, when the other one goes (~/.codex-+a, listed
// first, was "a" and ~/.codex-a "a-2" until ~/.codex-+a went).
func TestCodexProfileKeysStayWithTheirFolder(t *testing.T) {
	t.Parallel()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-+a": true, ".codex-a": true})
	b := startBridge(t, filepath.Join(t.TempDir(), "world.db"), profilesOptions(home, &profileRunner{}))
	c := b.connect(proto.Hello{})
	snap := c.snapshot().World
	keyOf := map[string]string{}
	for _, p := range snap.CodexProfiles.Profiles {
		keyOf[p.Path] = p.Key
	}
	if keyOf[filepath.Join(home, ".codex-a")] != "a" || !strings.HasPrefix(keyOf[filepath.Join(home, ".codex-+a")], "a-") {
		t.Fatalf("keys %v", keyOf)
	}
	for range 4 {
		c.until(proto.EvLimitsUpdate)
	}
	if err := os.Remove(filepath.Join(home, ".codex-+a", "auth.json")); err != nil {
		t.Fatal(err)
	}
	_, ack := c.mustAck(proto.CmdCodexProfilesGet, map[string]any{})
	p := profilesOf(t, ack.Data)
	if keysOf(&p) != "codex,a" {
		t.Fatalf("profiles %+v", p)
	}
	if a := p.Profiles[1]; a.Path != filepath.Join(home, ".codex-a") || a.Plan != "codex-a" {
		t.Fatalf("~/.codex-a: %+v", a)
	}
	for _, l := range b.connect(proto.Hello{}).snapshot().World.Limits {
		if l.Account != nil && l.Account.Key == "a" && l.Plan != "codex-a" {
			t.Fatalf("a's reading %+v", l)
		}
	}
}

// R1 of the #138 review, round 3: a folder named like another folder's
// hashed key (~/.codex-a-<hash of ~/.codex-+a>) has a key of its own, kept
// when ~/.codex-+a goes; the gone folder's key then names no profile.
func TestCodexProfileKeysHashedAndPlainNeverMeet(t *testing.T) {
	t.Parallel()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-+a": true})
	plusA := filepath.Join(home, ".codex-+a")
	sum := sha256.Sum256([]byte(plusA))
	gone := fmt.Sprintf("a-%x", sum[:3])
	survivor := filepath.Join(home, ".codex-"+gone)
	if err := os.Mkdir(survivor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(survivor, "auth.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	b := startBridge(t, filepath.Join(t.TempDir(), "world.db"), profilesOptions(home, &profileRunner{}))
	c := b.connect(proto.Hello{})
	keyOf := map[string]string{}
	for _, p := range c.snapshot().World.CodexProfiles.Profiles {
		keyOf[p.Path] = p.Key
	}
	sum = sha256.Sum256([]byte(survivor))
	kept := fmt.Sprintf("%s-%x", gone, sum[:3])
	if keyOf[plusA] != gone || keyOf[survivor] != kept {
		t.Fatalf("keys %v, want %s: %s, %s: %s", keyOf, plusA, gone, survivor, kept)
	}
	for range 4 {
		c.until(proto.EvLimitsUpdate)
	}
	if err := os.Remove(filepath.Join(plusA, "auth.json")); err != nil {
		t.Fatal(err)
	}
	_, ack := c.mustAck(proto.CmdCodexProfilesGet, map[string]any{})
	if p := profilesOf(t, ack.Data); keysOf(&p) != "codex,"+kept || p.Profiles[1].Name != gone {
		t.Fatalf("profiles %+v", p)
	}
	c.mustError(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: gone, Hidden: ptr(true)}, "not_found")
	_, ack = c.mustAck(proto.CmdCodexProfilesGet, map[string]any{})
	if p := profilesOf(t, ack.Data); p.Profiles[1].Hidden {
		t.Fatalf("the survivor was hidden: %+v", p)
	}
}

// gateLister holds the poller's first list after it is armed, once it has
// listed (from the settings as they were then).
type gateLister struct {
	codexaccount.Lister
	armed            atomic.Bool
	started, release chan struct{}
}

func (g *gateLister) Accounts(ctx context.Context) ([]codexaccount.Account, error) {
	list, err := g.Lister.Accounts(ctx)
	if g.armed.CompareAndSwap(true, false) {
		close(g.started)
		<-g.release
	}
	return list, err
}

// R3 of the #138 review: a list the poller took before a codex_profiles.set
// does not undo the change the hub published (it lists again itself).
func TestCodexProfilesOlderPollerListIsNotApplied(t *testing.T) {
	t.Parallel()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-work": true})
	opts := profilesOptions(home, &profileRunner{})
	gate := &gateLister{Lister: opts.Limits.Accounts, started: make(chan struct{}), release: make(chan struct{})}
	opts.Limits.Accounts = gate
	b := startBridge(t, filepath.Join(t.TempDir(), "world.db"), opts)
	c := b.connect(proto.Hello{})
	c.snapshot()
	for range 3 {
		c.until(proto.EvLimitsUpdate)
	}
	// A folder found makes the poller's next list a change.
	if err := os.MkdirAll(filepath.Join(home, ".codex-new"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex-new", "auth.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	gate.armed.Store(true)
	c.mustAck(proto.CmdLimitsRefresh, map[string]any{})
	<-gate.started
	_, ack := c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "work", Hidden: ptr(true)})
	if p := profilesOf(t, ack.Data); keysOf(&p) != "codex,new,work" || !p.Profiles[2].Hidden {
		t.Fatalf("hide ack %+v", p)
	}
	close(gate.release)
	// The poller hands its list over before it reads ~/.codex-new.
	for {
		m := c.next()
		switch m.env.T {
		case proto.EvCodexProfilesUpdate:
			var u proto.CodexProfilesUpdate
			if err := json.Unmarshal(m.raw, &u); err != nil {
				t.Fatal(err)
			}
			if keysOf(&u.CodexProfiles) != "codex,new,work" || !u.Profiles[2].Hidden {
				t.Fatalf("work shown again by an older list: %s", m.raw)
			}
		case proto.EvLimitsUpdate:
			var ev proto.Event
			if err := json.Unmarshal(m.raw, &ev); err != nil {
				t.Fatal(err)
			}
			if ev.Account != nil && ev.Account.Key == "work" {
				t.Fatalf("a hidden profile's reading: %s", m.raw)
			}
			if ev.Account != nil && ev.Account.Key == "new" {
				return
			}
		}
	}
}
