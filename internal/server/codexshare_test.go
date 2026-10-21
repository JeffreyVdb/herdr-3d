package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #167: sharing a profile's setup with the default home, through the
// bridge's commands, on throwaway homes.

const shareSecret = "sk-test-SECRET-167"

// trustingHost is a CodexHost that can trust a profile's hooks; it records
// each seed.
type trustingHost struct {
	*fakeCodexHost
	mu    sync.Mutex
	seeds []string
	res   codexapp.HookTrust
	err   error
}

func (h *trustingHost) SeedHookTrust(_ context.Context, defHome, home string) (codexapp.HookTrust, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seeds = append(h.seeds, defHome+" "+home)
	return h.res, h.err
}

// shareHome is a user home with a default ~/.codex (a config.toml with two
// MCP servers and a fake key, a hooks.json with herdr's hook) and a
// signed-in ~/.codex-work holding its own config.toml.
func shareHome(t *testing.T) string {
	t.Helper()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-work": true})
	for name, body := range map[string]string{
		".codex/config.toml":                "[mcp_servers.alterlab]\ncommand = \"x\"\n[mcp_servers.alterlab.env]\nALTERLAB_API_KEY = \"" + shareSecret + "\"\n[mcp_servers.kaneo]\nurl = \"u\"\n",
		".codex/hooks.json":                 `{"hooks":{"SessionStart":[{"hooks":[{"command":"bash '/u/.codex/herdr-agent-state.sh' session","type":"command"}]}]}}`,
		".codex-work/config.toml":           "model = \"mine\"\n",
		".codex-work/sessions/2026/a.jsonl": "{}\n",
	} {
		p := filepath.Join(home, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func shareAck(t *testing.T, a *client, args proto.CodexShareArgs) proto.CodexShareAck {
	t.Helper()
	_, ack := a.mustAck(proto.CmdCodexProfilesShare, args)
	var out proto.CodexShareAck
	if err := json.Unmarshal(mustMarshal(t, ack.Data), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func profileByKey(p *proto.CodexProfiles, key string) proto.CodexProfile {
	for _, x := range p.Profiles {
		if x.Key == key {
			return x
		}
	}
	return proto.CodexProfile{}
}

// AC1, AC3, AC5, AC6, AC8: plan, a refused unconfirmed replace, apply with
// its report and the trust seed, drift within one poll after a sed -i, Fix,
// unshare; the setting kept over a restart; no config value on the wire.
func TestCodexShareSetup(t *testing.T) {
	t.Parallel()
	home := shareHome(t)
	work := filepath.Join(home, ".codex-work")
	host := &trustingHost{fakeCodexHost: newFakeCodexHost(), res: codexapp.HookTrust{Seeded: 1}}
	opts := profilesOptions(home, &profileRunner{})
	opts.Limits.Interval = 50 * time.Millisecond
	opts.CodexHost = host
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, opts)
	a := b.connect(proto.Hello{Client: "a"})
	snap := a.snapshot().World.CodexProfiles
	if !snap.Share || snap.Profiles[1].Share || snap.Profiles[1].Drift != nil {
		t.Fatalf("snapshot %+v", snap)
	}

	// Refusals: nothing written.
	for _, c := range []struct {
		args any
		code string
		want string
	}{
		{map[string]any{"key": "work"}, proto.ErrBadRequest, "share is required"},
		{map[string]any{"share": true}, proto.ErrBadRequest, "key is required"},
		{map[string]any{"key": "codex", "share": true}, proto.ErrBadRequest, "share from"},
		{map[string]any{"key": "nope", "share": true}, proto.ErrNotFound, "nope"},
		{map[string]any{"key": "work", "share": false, "dry_run": true}, proto.ErrBadRequest, "for share: true"},
		{map[string]any{"key": "work", "share": true, "path": "/tmp"}, proto.ErrBadRequest, "unknown field"},
		{map[string]any{"key": "work", "share": true}, proto.ErrBadRequest, "~/.codex-work changed since you looked; look again."},
	} {
		_, m := a.command(proto.CmdCodexProfilesShare, "bad", c.args)
		if m.env.T != proto.TError || !strings.Contains(string(m.raw), `"`+c.code+`"`) || !strings.Contains(string(m.raw), c.want) {
			t.Errorf("share %v: %s", c.args, m.raw)
		}
	}
	if fi, _ := os.Lstat(filepath.Join(work, "config.toml")); !fi.Mode().IsRegular() {
		t.Fatal("a refusal wrote")
	}

	plan := shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true), DryRun: true})
	if len(plan.Steps) != 5 || plan.Steps[0].Action != proto.CodexStepReplace || plan.Steps[0].Was != "file" ||
		!strings.HasPrefix(plan.Steps[0].Backup, "config.toml.before-share-") || plan.Steps[4] != (proto.CodexShareStep{Name: "hooks.json", Action: proto.CodexStepWrite}) || plan.Report != "" {
		t.Fatalf("plan %+v", plan)
	}
	if profileByKey(&plan.CodexProfiles, "work").Share {
		t.Fatal("a dry run turned sharing on")
	}

	done := shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true), Replace: []string{"config.toml"}})
	if !strings.HasPrefix(done.Report, "Linked config.toml, wrote hooks.json, backed up the old config.toml to config.toml.before-share-") ||
		!strings.HasSuffix(done.Report, " work's hooks are trusted as on codex, so Codex will not ask to review them.") || done.Failed {
		t.Fatalf("report %q", done.Report)
	}
	if p := profileByKey(&done.CodexProfiles, "work"); !p.Share || p.Drift != nil {
		t.Fatalf("after share %+v", p)
	}
	if len(host.seeds) != 1 || host.seeds[0] != filepath.Join(home, ".codex")+" "+work {
		t.Fatalf("seeds %v", host.seeds)
	}
	if l, err := os.Readlink(filepath.Join(work, "config.toml")); err != nil || l != filepath.Join(home, ".codex", "config.toml") {
		t.Fatalf("config.toml -> %s %v", l, err)
	}

	// sed -i: drift shows within one poll.
	tmp := filepath.Join(work, "sed123")
	os.WriteFile(tmp, []byte("model = \"edited\"\n"), 0o600)
	if err := os.Rename(tmp, filepath.Join(work, "config.toml")); err != nil {
		t.Fatal(err)
	}
	var drift []proto.CodexDrift
	for deadline := time.Now().Add(5 * time.Second); drift == nil && time.Now().Before(deadline); {
		m := a.next()
		if m.env.T != proto.EvCodexProfilesUpdate {
			continue
		}
		var u proto.CodexProfilesUpdate
		if err := json.Unmarshal(m.raw, &u); err != nil {
			t.Fatal(err)
		}
		drift = profileByKey(&u.CodexProfiles, "work").Drift
	}
	if len(drift) != 1 || drift[0] != (proto.CodexDrift{Kind: proto.CodexDriftLinkReplaced, Name: "config.toml",
		Text: "config.toml is no longer a link: a file replaced it (MCP servers only on codex: alterlab, kaneo)"}) {
		t.Fatalf("drift %+v", drift)
	}

	// Fix: the same plan, confirm, apply; the backup stays.
	plan = shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true), DryRun: true})
	fix := shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true), Replace: []string{plan.Steps[0].Name}})
	if p := profileByKey(&fix.CodexProfiles, "work"); p.Drift != nil {
		t.Fatalf("after Fix %+v", p)
	}
	if b, err := os.ReadFile(filepath.Join(work, plan.Steps[0].Backup)); err != nil || string(b) != "model = \"edited\"\n" {
		t.Fatalf("Fix's backup %q %v", b, err)
	}
	b.stop()

	// Kept over a restart.
	b = startBridge(t, db, opts)
	c := b.connect(proto.Hello{})
	if p := profileByKey(c.snapshot().World.CodexProfiles, "work"); !p.Share {
		t.Fatalf("after a restart %+v", p)
	}
	off := shareAck(t, c, proto.CodexShareArgs{Key: "work", Share: ptr(false)})
	if off.Report != "Copied config.toml from codex: work keeps them as its own and no longer follows codex. Its hooks.json stays." {
		t.Fatalf("off %q", off.Report)
	}
	if p := profileByKey(&off.CodexProfiles, "work"); p.Share || p.Drift != nil {
		t.Fatalf("after off %+v", p)
	}
	if fi, _ := os.Lstat(filepath.Join(work, "config.toml")); !fi.Mode().IsRegular() {
		t.Fatal("config.toml is not a copy")
	}
	if b, _ := os.ReadFile(filepath.Join(work, "sessions/2026/a.jsonl")); string(b) != "{}\n" {
		t.Fatal("sessions/ touched")
	}
	for _, cl := range []*client{a, c} {
		if strings.Contains(cl.heard.String(), shareSecret) || strings.Contains(cl.heard.String(), "ALTERLAB_API_KEY") {
			t.Fatal("a config value went out")
		}
	}
}

// The trust seed that fails, or leaves a hook untrusted, says Codex will
// ask once; a skill moves to ~/.agents/skills and its drift goes.
func TestCodexShareTrustFallbackAndSkill(t *testing.T) {
	t.Parallel()
	home := shareHome(t)
	os.Remove(filepath.Join(home, ".codex-work", "config.toml"))
	os.MkdirAll(filepath.Join(home, ".codex", "skills", "infra"), 0o755)
	host := &trustingHost{fakeCodexHost: newFakeCodexHost(), res: codexapp.HookTrust{Untrusted: 1}}
	opts := profilesOptions(home, &profileRunner{})
	opts.CodexHost = host
	b := startBridge(t, "", opts)
	a := b.connect(proto.Hello{})
	a.snapshot()
	done := shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true)})
	if done.Report != "Linked config.toml, wrote hooks.json. Codex will ask once to review the hooks of work." {
		t.Fatalf("report %q", done.Report)
	}
	p := profileByKey(&done.CodexProfiles, "work")
	if len(p.Drift) != 1 || p.Drift[0].Kind != proto.CodexDriftSkillOnlyDefault || p.Drift[0].Text != "skill infra is only on codex" {
		t.Fatalf("drift %+v", p.Drift)
	}
	a.mustError(proto.CmdCodexProfilesMoveSkill, proto.CodexMoveSkillArgs{Key: "codex", Skill: ".system"}, proto.ErrBadRequest)
	_, ack := a.mustAck(proto.CmdCodexProfilesMoveSkill, proto.CodexMoveSkillArgs{Key: "codex", Skill: "infra"})
	var moved proto.CodexShareAck
	if err := json.Unmarshal(mustMarshal(t, ack.Data), &moved); err != nil {
		t.Fatal(err)
	}
	if moved.Report != "Moved the skill infra to ~/.agents/skills/infra and left a link in codex's skills/: every Codex home sees it now." || profileByKey(&moved.CodexProfiles, "work").Drift != nil {
		t.Fatalf("moved %+v", moved)
	}
}

// A trust seed that fails says Codex will ask once, and its app-server's
// error text (which could quote the config) is not logged.
func TestCodexShareTrustErrorNotLogged(t *testing.T) {
	t.Parallel()
	home := shareHome(t)
	os.Remove(filepath.Join(home, ".codex-work", "config.toml"))
	host := &trustingHost{fakeCodexHost: newFakeCodexHost(),
		err: fmt.Errorf("config/batchWrite: %w", &codexapp.RPCError{Code: -32600, Message: "bad value " + shareSecret})}
	log := &syncBuffer{}
	opts := profilesOptions(home, &profileRunner{})
	opts.CodexHost = host
	opts.Log = slog.New(slog.NewTextHandler(log, nil))
	b := startBridge(t, "", opts)
	a := b.connect(proto.Hello{})
	a.snapshot()
	done := shareAck(t, a, proto.CodexShareArgs{Key: "work", Share: ptr(true)})
	if !strings.HasSuffix(done.Report, " Codex will ask once to review the hooks of work.") {
		t.Fatalf("report %q", done.Report)
	}
	if got := log.String(); strings.Contains(got, shareSecret) || !strings.Contains(got, "app-server error -32600") {
		t.Fatalf("log %s", got)
	}
}
