package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #140: Auto, against the profile bridge (profileBridge: ~/.codex, the
// default, ~/.codex-work and ~/.codex-team).

// leftRunner answers Claude as limitsRunner does, and each Codex probe with
// the plan "team" and the 5-hour window used as set for its CODEX_HOME's
// folder (".codex-work": work); 0 for one not set.
type leftRunner struct {
	limitsRunner
	mu   sync.Mutex
	used map[string]int
}

func (r *leftRunner) set(used map[string]int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.used = used
}

func (r *leftRunner) Start(c limits.Cmd) (limits.Process, error) {
	if c.Path != "codex" {
		return r.limitsRunner.Start(c)
	}
	key := "codex"
	for _, kv := range c.Env {
		if v, ok := strings.CutPrefix(kv, "CODEX_HOME="); ok {
			key = strings.TrimPrefix(strings.TrimPrefix(filepath.Base(v), "."), "codex-")
		}
	}
	r.mu.Lock()
	used := r.used[key]
	r.mu.Unlock()
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
				fmt.Fprintf(p.out, `{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":%d,"windowDurationMins":300,"resetsAt":1791053830},`+
					`"secondary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":1791653830},"planType":"team"}}}`+"\n", used)
			}
		}
	}()
	return p, nil
}

// withOrigin makes repo the origin of the hires' folder (/home/u/repo,
// RepoOf), and of no other.
func withOrigin(repo string) func(*server.Options) {
	return func(o *server.Options) {
		o.RepoOf = func(_ context.Context, dir string) string {
			if dir == "/home/u/repo" {
				return repo
			}
			return ""
		}
	}
}

// withLeft reads the profiles' limits with r (a manual refresh at once).
func withLeft(r *leftRunner) func(*server.Options) {
	return func(o *server.Options) {
		o.Limits = &limits.Config{Runner: r, ClaudeBin: "claude", CodexBin: "codex", Tick: 10 * time.Millisecond, ManualMin: time.Millisecond,
			Accounts: o.CodexProfiles, Env: func() []string { return nil }, Log: quietLog()}
	}
}

// readings waits until the client has a reading of every key with its
// 5-hour window used as want.
func (pb *profileBridge) readings(t *testing.T, want map[string]float64) {
	t.Helper()
	got := map[string]float64{}
	for end := time.Now().Add(5 * time.Second); ; {
		ev := pb.c.until(proto.EvLimitsUpdate)
		if ev.Limits.Account != nil {
			for _, w := range ev.Limits.Windows {
				if w.Label == "5h" {
					got[ev.Limits.Account.Key] = w.Pct
				}
			}
		}
		done := true
		for k, v := range want {
			done = done && got[k] == v
		}
		if done {
			return
		}
		if time.Now().After(end) {
			t.Fatalf("readings %v, want %v", got, want)
		}
	}
}

// AC1/AC4: an Auto hire whose origin matches a rule lands on its profile,
// says why in the ack and the report, and its launch holds the key.
func TestAutoHireRule(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, "", withOrigin("acme/widgets"))
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &[]proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}}})
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "team", Anything: ptr(true)})
	m, calls := pb.hire(t, 2, proto.CodexProfileAuto)
	res := ackData[proto.HireResult](t, m)
	if res.CodexProfileReason != "Account: work (rule acme/*)" || res.Codex == nil || res.Codex.Profile != "work" {
		t.Fatalf("hire result %s", m.raw)
	}
	if !slices.Contains(calls, "codex-home w1:p1 "+pb.work) {
		t.Fatalf("herdr calls = %q", calls)
	}
	if l := pb.launches(t)[res.ID]; l.Profile != "work" || l.ProfileName != "work" {
		t.Fatalf("launch = %+v", l)
	}
	row := auditRow(t, pb.bridge, proto.CmdWorkerHire)
	if !row.OK || !strings.Contains(row.Result, `"codex_profile":"work"`) || !strings.Contains(row.Result, `"codex_profile_reason":"Account: work (rule acme/*)"`) {
		t.Fatalf("audit = %+v", row)
	}
	if n := pb.balanced(t); n != 1 {
		t.Fatalf("%d prepares", n)
	}
}

// AC2/AC3: no rule matches: work (no flag) is never picked, however much
// it has left; team (flagged) is. With nothing flagged, the default.
func TestAutoHireNoRule(t *testing.T) {
	t.Parallel()
	r := &leftRunner{}
	r.set(map[string]int{"work": 0, "team": 95, "codex": 50})
	pb := startProfileBridge(t, true, "", withOrigin("me/dotfiles"), withLeft(r))
	pb.readings(t, map[string]float64{"work": 0, "team": 95, "codex": 50})
	m, _ := pb.hire(t, 1, proto.CodexProfileAuto)
	if res := ackData[proto.HireResult](t, m); res.CodexProfileReason != "Account: codex (no rule matched, no profile may be used for anything: the default)" ||
		pb.launches(t)[res.ID].Profile != "codex" {
		t.Fatalf("nothing flagged: %s", m.raw)
	}
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &[]proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}}})
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "team", Anything: ptr(true)})
	m, _ = pb.hire(t, 2, proto.CodexProfileAuto)
	if res := ackData[proto.HireResult](t, m); res.CodexProfileReason != "Account: team (the only profile that may be used for anything)" ||
		pb.launches(t)[res.ID].Profile != "team" {
		t.Fatalf("team flagged: %s", m.raw)
	}
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "codex", Anything: ptr(true)})
	m, _ = pb.hire(t, 3, proto.CodexProfileAuto)
	if res := ackData[proto.HireResult](t, m); res.CodexProfileReason != "Account: codex (most left: 50% of 5 h)" ||
		pb.launches(t)[res.ID].Profile != "codex" {
		t.Fatalf("codex and team flagged: %s", m.raw)
	}
	pb.balanced(t)
}

// AC6: Auto is picked once, at hire: the launch holds the concrete key, and
// a wake after the readings changed (so a pick now would land elsewhere)
// wakes it on that key, as #139's wake does.
func TestAutoHireWakeKeepsProfile(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	r := &leftRunner{}
	r.set(map[string]int{"work": 10, "team": 70})
	pb := startProfileBridge(t, true, "", withOrigin(""), withLeft(r))
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "work", Anything: ptr(true)})
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "team", Anything: ptr(true)})
	pb.readings(t, map[string]float64{"work": 10, "team": 70})
	a := pb.hireArgsAndSleep(t, profileHire(1, proto.CodexProfileAuto), th)
	if a.CodexProfileReason != "Account: work (most left: 90% of 5 h)" {
		t.Fatalf("hire reason %q", a.CodexProfileReason)
	}
	if l := pb.launches(t)[a.ID]; l.Profile != "work" {
		t.Fatalf("launch = %+v", l)
	}
	r.set(map[string]int{"work": 99, "team": 0})
	pb.c.mustAck(proto.CmdLimitsRefresh, map[string]any{})
	pb.readings(t, map[string]float64{"work": 99, "team": 0})
	hostBefore := len(pb.host.Calls())
	calls, resumes := pb.wakeResumes(t)
	if resumes[a.ID] != proto.ResumeFallback || !slices.Contains(calls, "codex-home w1:p1 "+pb.work) {
		t.Fatalf("wake: %v, calls %q", resumes, calls)
	}
	if hc := pb.host.Calls()[hostBefore:]; len(hc) == 0 || hc[0] != "profile work" {
		t.Fatalf("wake host calls = %q", hc)
	}
	if l := pb.launches(t)[a.ID]; l.Profile != "work" || l.Thread != th {
		t.Fatalf("launch after wake = %+v", l)
	}
	pb.balanced(t)
}

// AC7: Auto is for a Codex hire on a bridge with profiles, in the words of
// any other key; a preset keeps it as it is; a key chosen by hand (or
// none) is not picked: no reason, its own key.
func TestAutoHireRefusedAndManual(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, "", withOrigin("acme/widgets"))
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &[]proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}}})
	claude := proto.WorkerHireArgs{Session: "s", DeskIndex: ptr(1), Harness: "claude", Model: "claude-opus-5-5", Effort: "high", Cwd: "/home/u/repo",
		CodexProfile: proto.CodexProfileAuto}
	_, m := pb.c.command(proto.CmdWorkerHire, "c", claude)
	if e := hireError(t, m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, `codex_profile is for a Codex hire, not "claude"`) {
		t.Fatalf("claude auto: %+v", e)
	}
	m, _ = pb.hire(t, 2, "team")
	if res := ackData[proto.HireResult](t, m); res.CodexProfileReason != "" || pb.launches(t)[res.ID].Profile != "team" {
		t.Fatalf("manual: %s", m.raw)
	}
	m, _ = pb.hire(t, 3, "")
	if res := ackData[proto.HireResult](t, m); res.CodexProfileReason != "" || pb.launches(t)[res.ID].Profile != "" {
		t.Fatalf("none: %s", m.raw)
	}

	spec := proto.HirePresetSpec{Name: "Auto", Prompt: "Review it.", Harness: "codex", Model: "gpt-6-sol", Effort: "low", CodexProfile: proto.CodexProfileAuto}
	_, ack := pb.c.mustAck(proto.CmdHirePresetCreate, spec)
	var p proto.HirePreset
	if err := json.Unmarshal(mustMarshal(t, ack.Data), &p); err != nil || p.CodexProfile != proto.CodexProfileAuto {
		t.Fatalf("preset %+v %v", ack.Data, err)
	}
	spec.Name, spec.Harness, spec.Model, spec.Effort = "Claude auto", "claude", "claude-opus-5-5", "high"
	pb.c.mustError(proto.CmdHirePresetCreate, spec, proto.ErrBadRequest)
	pb.balanced(t)

	plain := startHireBridge(t, nil)
	_, m = plain.c.command(proto.CmdWorkerHire, "a", profileHire(1, proto.CodexProfileAuto))
	if e := hireError(t, m); e.Code != proto.ErrUnsupported {
		t.Fatalf("no profiles: %+v", e)
	}
}

// #140 settings: the flag and the rules are checked, stored, published and
// kept over a restart; one change a command.
func TestCodexProfilesRulesSettings(t *testing.T) {
	t.Parallel()
	home := codexHomes(t, map[string]bool{".codex": true, ".codex-work": true})
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{CodexProfiles: profilesOptions(home, &profileRunner{}).CodexProfiles})
	a := b.connect(proto.Hello{Client: "a"})
	snap := a.snapshot().World.CodexProfiles
	if snap == nil || !snap.Auto || snap.Rules == nil || len(snap.Rules) != 0 || snap.Profiles[0].Anything {
		t.Fatalf("snapshot %+v", snap)
	}
	for _, c := range []struct {
		args any
		code string
		want string
	}{
		{map[string]any{"key": "work", "anything": true, "hidden": true}, proto.ErrBadRequest, "exactly one of add, name, hidden, anything, rules and remove"},
		{map[string]any{"anything": true}, proto.ErrBadRequest, "key is required"},
		{map[string]any{"key": "nope", "anything": true}, proto.ErrNotFound, "nope"},
		{map[string]any{"key": "work", "rules": []any{}}, proto.ErrBadRequest, "rules takes no key"},
		{map[string]any{"rules": []any{map[string]any{"match": "acme/*", "profile": "work"}}}, proto.ErrBadRequest, "Rule 1: use github.com"},
		{map[string]any{"rules": []any{map[string]any{"match": "/a", "profile": "nope"}}}, proto.ErrBadRequest, `Rule 1: there is no Codex profile \"nope\"`},
		{map[string]any{"rules": []any{map[string]any{"match": "/a", "profile": "work", "extra": 1}}}, proto.ErrBadRequest, "extra"},
	} {
		_, m := a.command(proto.CmdCodexProfilesSet, "bad", c.args)
		if m.env.T != proto.TError || !strings.Contains(string(m.raw), `"`+c.code+`"`) || !strings.Contains(string(m.raw), c.want) {
			t.Errorf("set %v: %s", c.args, m.raw)
		}
	}
	evs, ack := a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Key: "codex", Anything: ptr(true)})
	if p := profilesOf(t, ack.Data); !p.Profiles[0].Anything || p.Profiles[1].Anything {
		t.Fatalf("flag ack %+v", p)
	}
	if !slices.ContainsFunc(evs, func(e proto.Event) bool { return e.T == proto.EvCodexProfilesUpdate }) {
		t.Fatalf("no update: %+v", evs)
	}
	rules := []proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}, {Match: "~/src/mine/", Profile: "codex"}}
	_, ack = a.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &rules})
	want := []proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}, {Match: "~/src/mine", Profile: "codex"}}
	if p := profilesOf(t, ack.Data); !slices.Equal(p.Rules, want) {
		t.Fatalf("rules ack %+v", p.Rules)
	}
	b.stop()
	b = startBridge(t, db, server.Options{CodexProfiles: profilesOptions(home, &profileRunner{}).CodexProfiles})
	snap = b.connect(proto.Hello{Client: "a2"}).snapshot().World.CodexProfiles
	if !snap.Profiles[0].Anything || !slices.Equal(snap.Rules, want) {
		t.Fatalf("after restart %+v", snap)
	}
	stored, err := b.st.LoadCodexProfiles(context.Background())
	if err != nil || len(stored.Rules) != 2 || stored.Rules[1] != (store.CodexRule{Match: "~/src/mine", Profile: "codex"}) {
		t.Fatalf("stored %+v %v", stored, err)
	}
	a2 := b.connect(proto.Hello{Client: "a3"})
	a2.snapshot()
	_, ack = a2.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &[]proto.CodexRule{}})
	if p := profilesOf(t, ack.Data); p.Rules == nil || len(p.Rules) != 0 {
		t.Fatalf("cleared %+v", p.Rules)
	}
}
