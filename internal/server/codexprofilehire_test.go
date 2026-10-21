package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/codexchild"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	shellpolicy "github.com/JeffreyVdb/herdr-3d/internal/shell"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #139: hiring and waking a Codex worker on a chosen Codex profile, against
// the fake floor, the fake CodexHost and real profile homes in a temp dir.

// profileBridge is a shared bridge whose Codex profiles are a user's
// ~/.codex (the default, with herdr's hook), ~/.codex-work and
// ~/.codex-team (bare homes). Each Prepare is recorded in the host's calls
// ("profile <key>"), and its releases counted.
type profileBridge struct {
	*sharedBridge
	user, def, work, team string
	log                   *syncBuffer

	mu                 sync.Mutex
	prepared, released int
	prepErr            error
}

// syncBuffer is the bridge's log, for what it must never hold.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startProfileBridge(t *testing.T, on bool, kind shellpolicy.Kind, more ...func(*server.Options)) *profileBridge {
	t.Helper()
	return startProfileBridgeAt(t, "", "", nil, on, kind, more...)
}

// startProfileBridgeAt is startProfileBridge on the database at db and the
// user folder user ("": new ones), whose floor has workers, for a test
// that restarts the bridge.
func startProfileBridgeAt(t *testing.T, db, user string, workers []world.WorkerObs, on bool, kind shellpolicy.Kind,
	more ...func(*server.Options)) *profileBridge {
	t.Helper()
	if user == "" {
		var err error
		if user, err = os.MkdirTemp("", "h3dp"); err != nil { // short and plain: the homes are typed into a shell
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(user) })
	}
	pb := &profileBridge{user: user, def: filepath.Join(user, ".codex"), work: filepath.Join(user, ".codex-work"),
		team: filepath.Join(user, ".codex-team"), log: &syncBuffer{}}
	for _, home := range []string{pb.def, pb.work, pb.team} {
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(pb.def, "hooks.json"), []byte(`{"hooks":{"SessionStart":[{"hooks":[{"command":"bash '`+
		pb.def+`/herdr-agent-state.sh' session"}]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	host := newFakeCodexHost()
	svc := codexaccount.New(user, pb.def)
	pb.sharedBridge = startSharedBridgeWith(t, db, host, on, kind, func(o *server.Options) {
		o.CodexProfiles = svc
		// The default home's sessions are --codex-sessions (usage and the sleep backfill).
		o.Usage.Roots.CodexSessions = filepath.Join(pb.def, "sessions")
		o.CodexSession = func(cwd string, skip func(string) bool) (string, error) {
			return codex.FindSession(filepath.Join(pb.def, "sessions"), cwd, skip)
		}
		o.Log = slog.New(slog.NewTextHandler(pb.log, &slog.HandlerOptions{Level: slog.LevelDebug}))
		o.CodexPrepare = func(ctx context.Context, key string) ([]string, func(), error) {
			host.record("profile %s", key)
			pb.mu.Lock()
			pb.prepared++
			err := pb.prepErr
			pb.mu.Unlock()
			counted := func() {
				pb.mu.Lock()
				pb.released++
				pb.mu.Unlock()
			}
			if err != nil {
				return nil, counted, err
			}
			env, release, err := svc.Prepare(ctx, key)
			return env, func() { release(); counted() }, err
		}
		for _, fn := range more {
			fn(o)
		}
	}, workers...)
	return pb
}

// balanced waits until every Prepare was released (runHire's and a wake's
// defers run after their reply) and returns how many there were.
func (pb *profileBridge) balanced(t *testing.T) int {
	t.Helper()
	for end := time.Now().Add(2 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		pb.mu.Lock()
		p, r := pb.prepared, pb.released
		pb.mu.Unlock()
		if p == r {
			return p
		}
		if time.Now().After(end) {
			t.Fatalf("prepared %d, released %d", p, r)
		}
	}
}

func profileHire(desk int, key string) proto.WorkerHireArgs {
	a := codexHire(desk)
	a.CodexProfile = key
	return a
}

// hire hires on key and returns the ack (or the error) and the herdr calls
// it made.
func (pb *profileBridge) hire(t *testing.T, desk int, key string) (msg, []string) {
	t.Helper()
	before := len(pb.fl.Calls())
	_, m := pb.c.command(proto.CmdWorkerHire, "h", profileHire(desk, key))
	return m, pb.fl.Calls()[before:]
}

func hireError(t *testing.T, m msg) proto.Error {
	t.Helper()
	var e proto.Error
	if err := json.Unmarshal(m.raw, &e); err != nil || m.env.T != proto.TError {
		t.Fatalf("hire acked: %s", m.raw)
	}
	return e
}

// AC2: a hire on a profile exports its home in the pane before its server
// starts, its launcher sets it (bash and fish), and it is checked once its
// server answers.
func TestProfileHireShared(t *testing.T) {
	t.Parallel()
	for _, kind := range []shellpolicy.Kind{shellpolicy.Bash, shellpolicy.Fish} {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, true, kind)
			m, calls := pb.hire(t, 2, "work")
			res := ackData[proto.HireResult](t, m)
			l := pb.launches(t)[res.ID]
			export := slices.Index(calls, "codex-home w1:p1 "+pb.work)
			server := slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-server w1:p1 ") })
			remote := slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-remote w1:p1 ") })
			if export < 0 || server < export || remote < server {
				t.Fatalf("herdr calls = %q", calls)
			}
			launches := pb.host.Launches()
			if len(launches) != 1 || !slices.Equal(launches[0].Env, []string{"CODEX_HOME=" + pb.work}) || launches[0].Shell != kind.Or() {
				t.Fatalf("launches = %+v", launches)
			}
			want := `export CODEX_HOME='\''` + pb.work + `'\''; codex app-server `
			if kind == shellpolicy.Fish {
				want = "\nset -gx CODEX_HOME '" + pb.work + "'\ncodex app-server "
			}
			if script := launches[0].Render(); !strings.Contains(script, want) {
				t.Fatalf("launcher =\n%s", script)
			}
			sock := codexRun + "/" + l.Name + ".sock"
			if checks := pb.host.Checks(); !slices.Equal(checks, []string{"server " + sock, "home CODEX_HOME=" + pb.work}) {
				t.Fatalf("checks = %q", checks)
			}
			if hc := pb.host.Calls(); hc[0] != "profile work" || !strings.HasPrefix(hc[1], "preflight ") {
				t.Fatalf("host calls = %q", hc)
			}
			if l.Profile != "work" || l.ProfileName != "work" || l.Account != store.AccountConfirmed || l.Plan != "team" ||
				!strings.HasPrefix(l.ProfileNote, "work does not share setup with codex: no herdr hooks. ") || // #167
				!strings.Contains(l.ProfileNote, "work has no hooks.json with herdr's hook: herdr is not told the worker's Codex session, "+
					"so the bridge takes its thread from the worker's own Codex server") {
				t.Fatalf("launch = %+v", l)
			}
			if c := res.Codex; c == nil || c.Profile != "work" || c.Account != proto.CodexAccountConfirmed || c.Plan != "team" || c.ProfileNote != l.ProfileNote {
				t.Fatalf("hire result %s", m.raw)
			}
			w := workersOf(pb.world(func(w proto.World) bool {
				x := workersOf(w, "s")["w1"]
				return x.Codex != nil && x.Codex.Server == proto.CodexServerRunning
			}), "s")["w1"]
			if w.Codex.Profile != "work" || w.Codex.Account != proto.CodexAccountConfirmed {
				t.Fatalf("worker codex = %+v", w.Codex)
			}
			row := auditRow(t, pb.bridge, proto.CmdWorkerHire)
			if !row.OK || !strings.Contains(row.Result, `"codex_profile":"work"`) || !strings.Contains(row.Result, "exported CODEX_HOME="+pb.work) ||
				!strings.Contains(row.Result, "account confirmed") {
				t.Fatalf("audit = %+v", row)
			}
			if n := pb.balanced(t); n != 1 {
				t.Fatalf("%d prepares", n)
			}
		})
	}
}

// #167 AC9: a hire on a profile that shares the default's setup says
// nothing of it while it is in step, and says how it drifted otherwise.
func TestProfileHireSharedSetup(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, shellpolicy.Bash)
	pb.c.mustAck(proto.CmdCodexProfilesShare, proto.CodexShareArgs{Key: "work", Share: ptr(true)})
	m, _ := pb.hire(t, 2, "work")
	if l := pb.launches(t)[ackData[proto.HireResult](t, m).ID]; l.ProfileNote != "" {
		t.Fatalf("in step: %q", l.ProfileNote)
	}
	if err := os.WriteFile(filepath.Join(pb.work, "hooks.json"), []byte(`{"hooks":{"Stop":[{"hooks":[{"command":"other"}]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	m, _ = pb.hire(t, 3, "work")
	res := ackData[proto.HireResult](t, m)
	want := "work's shared setup has drifted from codex's: hooks.json runs other commands than codex's. work has no hooks.json with herdr's hook"
	if l := pb.launches(t)[res.ID]; !strings.HasPrefix(l.ProfileNote, want) || res.Codex.ProfileNote != l.ProfileNote {
		t.Fatalf("drifted: %q", l.ProfileNote)
	}
}

// AC2/AC10: the default profile, asked for by its key or not at all, is
// today's hire: the same herdr calls, no export, no env, no check.
func TestProfileHireDefaultIsToday(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, "")
	_, plain := pb.hire(t, 1, "")
	m, named := pb.hire(t, 2, "codex")
	res := ackData[proto.HireResult](t, m)
	strip := func(calls []string) []string {
		out := []string{}
		for _, c := range calls {
			f := strings.Fields(c)
			out = append(out, f[0])
		}
		return out
	}
	if !slices.Equal(strip(plain), strip(named)) {
		t.Fatalf("herdr calls differ:\n%q\n%q", plain, named)
	}
	for _, c := range append(plain, named...) {
		if strings.HasPrefix(c, "codex-home") {
			t.Fatalf("an export was typed: %q", c)
		}
	}
	for _, l := range pb.host.Launches() {
		if l.Env != nil || strings.Contains(l.Render(), "CODEX_HOME") {
			t.Fatalf("launch env %q", l.Env)
		}
	}
	if checks := pb.host.Checks(); len(checks) != 0 {
		t.Fatalf("checks = %q", checks)
	}
	if l := pb.launches(t)[res.ID]; l.Profile != "codex" || l.ProfileName != "codex" || l.Account != "" || l.ProfileNote != "" {
		t.Fatalf("launch = %+v", l)
	}
	pb.balanced(t)
}

// AC3: what the worker's server signed in to, against the profile's own
// sign-in: another account and an unknown one are said plainly; a profile
// that is not signed in fails the hire with the way to sign in, its server
// stopped; no account id is kept anywhere.
func TestProfileHireConfirm(t *testing.T) {
	t.Parallel()
	const secretID = "acct-7c1e0d5b-identity"
	signed := func(id string) func(string) (codexapp.Account, codexapp.Requirements, error) {
		return func(string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{SignedIn: true, Plan: "team", ID: id}, codexapp.Requirements{}, nil
		}
	}
	for name, tc := range map[string]struct {
		server  func(string) (codexapp.Account, codexapp.Requirements, error)
		home    func([]string) (codexapp.Account, codexapp.Requirements, error)
		account string
		note    string
		fails   string
	}{
		"confirmed": {server: signed(secretID), account: store.AccountConfirmed},
		"another account": {server: signed(secretID), home: func([]string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{SignedIn: true, ID: secretID + "-other"}, codexapp.Requirements{}, nil
		}, account: store.AccountMismatch, note: "Asked for work, the server signed in to another account."},
		"no account id": {server: signed(""), account: store.AccountUnconfirmed,
			note: "Could not confirm the account: this Codex does not say which account it signed in to."},
		"server check fails": {server: func(string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{}, codexapp.Requirements{}, errors.New("account/read: no response")
		}, account: store.AccountUnconfirmed, note: "Could not confirm the account: account/read: no response."},
		"not signed in": {server: func(string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{}, codexapp.Requirements{}, nil
		}, fails: "work is not signed in. Run `CODEX_HOME=%s codex login` in a terminal."},
		// R3: account: null stands when the policy read after it fails.
		"not signed in, the policy read fails": {server: func(string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{Answered: true}, codexapp.Requirements{}, errors.New("configRequirements/read: app-server error -32601: unknown")
		}, fails: "work is not signed in. Run `CODEX_HOME=%s codex login` in a terminal."},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, true, "")
			pb.host.server, pb.host.home = tc.server, tc.home
			if pb.host.home == nil {
				pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) {
					return codexapp.Account{SignedIn: true, ID: secretID}, codexapp.Requirements{}, nil
				}
			}
			m, calls := pb.hire(t, 1, "work")
			if tc.fails != "" {
				e := hireError(t, m)
				if e.Code != proto.ErrHireFailed || !strings.Contains(e.Message, strings.ReplaceAll(tc.fails, "%s", pb.work)) {
					t.Fatalf("error %s", m.raw)
				}
				if len(pb.host.stopped) == 0 || len(pb.launches(t)) != 0 {
					t.Fatalf("stopped %+v, launches %+v", pb.host.stopped, pb.launches(t))
				}
				for _, c := range calls {
					if strings.HasPrefix(c, "codex-remote") || strings.HasPrefix(c, "start-agent") {
						t.Fatalf("it started anyway: %q", calls)
					}
				}
				pb.balanced(t)
				return
			}
			res := ackData[proto.HireResult](t, m)
			l := pb.launches(t)[res.ID]
			if l.Account != tc.account || !strings.HasPrefix(l.ProfileNote, tc.note) || res.Codex.Account != tc.account {
				t.Fatalf("launch = %+v, result %s", l, m.raw)
			}
			world, _ := json.Marshal(pb.world(func(proto.World) bool { return true }))
			row := auditRow(t, pb.bridge, proto.CmdWorkerHire)
			for where, text := range map[string]string{"ack": string(m.raw), "audit": row.Result, "world": string(world),
				"log": pb.log.String(), "launch": strings.Join([]string{l.Account, l.ProfileNote, l.Plan, l.Note}, " ")} {
				if strings.Contains(text, "acct-7c1e0d5b") {
					t.Fatalf("the account id is in the %s: %s", where, text)
				}
			}
			pb.balanced(t)
		})
	}
}

// AC6: a workspace policy that does not allow herdr-3d's hire (no approval
// "never", no "danger-full-access") fails it, its server stopped and no
// fallback; none (null) or one that allows it lets it through.
func TestProfileHirePolicy(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		req   codexapp.Requirements
		fails string
	}{
		"null":    {},
		"allowed": {req: codexapp.Requirements{Present: true, Approvals: []string{"on-request", "never"}, Sandboxes: []string{"danger-full-access"}}},
		"both limited": {req: codexapp.Requirements{Present: true, Approvals: []string{"on-request", "untrusted"}, Sandboxes: []string{"read-only", "workspace-write"}},
			fails: "work does not allow workers that run without asking. Its workspace policy limits approvals to on-request, untrusted and sandbox to read-only, workspace-write."},
		"sandbox only": {req: codexapp.Requirements{Present: true, Sandboxes: []string{"read-only"}},
			fails: "Its workspace policy limits sandbox to read-only."},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, true, "")
			pb.host.server = func(string) (codexapp.Account, codexapp.Requirements, error) {
				return codexapp.Account{SignedIn: true, ID: "a"}, tc.req, nil
			}
			pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) {
				return codexapp.Account{SignedIn: true, ID: "a"}, codexapp.Requirements{}, nil
			}
			m, calls := pb.hire(t, 1, "work")
			if tc.fails == "" {
				if l := pb.launches(t)[ackData[proto.HireResult](t, m).ID]; l.Mode != store.CodexShared || l.Account != store.AccountConfirmed {
					t.Fatalf("launch %+v", l)
				}
				return
			}
			if e := hireError(t, m); !strings.Contains(e.Message, tc.fails) {
				t.Fatalf("error %s", m.raw)
			}
			if len(pb.host.stopped) == 0 {
				t.Fatalf("stopped %+v", pb.host.stopped)
			}
			for _, c := range calls {
				if strings.HasPrefix(c, "start-agent") || strings.HasPrefix(c, "codex-remote") {
					t.Fatalf("it fell back: %q", calls)
				}
			}
			pb.balanced(t)
		})
	}
}

// AC2: with the shared server switch off, a Codex hire on a profile starts
// the usual way with the home exported first, checked through the home
// itself, and recorded so its seat shows the profile.
func TestProfileHireLegacy(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "")
	m, calls := pb.hire(t, 1, "team")
	res := ackData[proto.HireResult](t, m)
	if i := slices.Index(calls, "codex-home w1:p1 "+pb.team); i < 0 || !strings.HasPrefix(calls[i+1], "start-agent w1:p1 ") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if checks := pb.host.Checks(); !slices.Equal(checks, []string{"home CODEX_HOME=" + pb.team}) {
		t.Fatalf("checks = %q", checks)
	}
	l := pb.launches(t)[res.ID]
	if l.Mode != store.CodexLegacy || l.Profile != "team" || l.Account != store.AccountUnconfirmed ||
		!strings.Contains(l.ProfileNote, "it has no Codex server of its own") || res.Codex == nil || res.Codex.Profile != "team" ||
		!strings.Contains(l.ProfileNote, "the bridge finds it by the worker's folder in team's sessions") {
		t.Fatalf("launch = %+v, result %s", l, m.raw)
	}

	// Not signed in: the hire fails before Codex starts, also when the
	// policy read after account/read fails (R3).
	for desk, fail := range []error{nil, errors.New("configRequirements/read: context deadline exceeded")} {
		pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{Answered: true}, codexapp.Requirements{}, fail
		}
		m, calls = pb.hire(t, 2+desk, "work")
		if e := hireError(t, m); !strings.Contains(e.Message, "work is not signed in") || slices.ContainsFunc(calls, func(c string) bool {
			return strings.HasPrefix(c, "start-agent")
		}) {
			t.Fatalf("error %s, calls %q", m.raw, calls)
		}
	}
	pb.balanced(t)
}

// Two hires at once on different profiles each get their own CODEX_HOME,
// in their own launcher and pane: neither leaks into the other.
func TestProfileHiresAtOnce(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, "")
	keys := map[int]string{1: "work", 2: "team"}
	homes := map[string]string{"work": pb.work, "team": pb.team}
	c2 := pb.connect(proto.Hello{Client: "second"})
	c2.snapshot()
	var wg sync.WaitGroup
	ids := map[string]string{}
	var mu sync.Mutex
	for desk, cl := range map[int]*client{1: pb.c, 2: c2} {
		wg.Go(func() {
			_, m := cl.command(proto.CmdWorkerHire, "h", profileHire(desk, keys[desk]))
			mu.Lock()
			ids[ackData[proto.HireResult](t, m).ID] = keys[desk]
			mu.Unlock()
		})
	}
	wg.Wait()
	all := pb.launches(t)
	byName := map[string]string{}
	for id, key := range ids {
		if all[id].Profile != key {
			t.Fatalf("launch %s = %+v, want %s", id, all[id], key)
		}
		byName[all[id].Name] = key
	}
	for _, l := range pb.host.Launches() {
		if !slices.Equal(l.Env, []string{"CODEX_HOME=" + homes[byName[l.Name]]}) {
			t.Fatalf("launch %s env %q, want %s", l.Name, l.Env, byName[l.Name])
		}
	}
	panes := map[string]string{} // pane → the home exported there
	for _, c := range pb.fl.Calls() {
		if f := strings.Fields(c); f[0] == "codex-home" {
			if panes[f[1]] != "" {
				t.Fatalf("two exports in %s", f[1])
			}
			panes[f[1]] = f[2]
		}
	}
	for _, c := range pb.fl.Calls() {
		if f := strings.Fields(c); f[0] == "codex-server" {
			name := strings.TrimSuffix(filepath.Base(f[2]), ".sh")
			if panes[f[1]] != homes[byName[name]] {
				t.Fatalf("pane %s exported %s, its server %s is on %s", f[1], panes[f[1]], name, byName[name])
			}
		}
	}
	if n := pb.balanced(t); n != 2 {
		t.Fatalf("%d prepares", n)
	}
}

// hireOnAndSleep is hireAndSleep on profile key.
func (pb *profileBridge) hireOnAndSleep(t *testing.T, key, thread string) proto.HireResult {
	t.Helper()
	return pb.hireArgsAndSleep(t, profileHire(1, key), thread)
}

// AC5: a wake prepares the stored profile again and exports its home
// before its server starts, then checks it before the terminal attaches.
func TestProfileWake(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	pb := startProfileBridge(t, true, "")
	a := pb.hireOnAndSleep(t, "work", th)
	l := pb.launches(t)[a.ID]
	hostBefore, checksBefore := len(pb.host.Calls()), len(pb.host.Checks())
	calls, resumes := pb.wakeResumes(t)
	if resumes[a.ID] != proto.ResumeFallback {
		t.Fatalf("resumes = %+v", resumes)
	}
	export := slices.Index(calls, "codex-home w1:p1 "+pb.work)
	server := slices.Index(calls, "codex-server w1:p1 "+codexRun+"/"+l.Name+".sh")
	resume := slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-resume w1:p1 ") && strings.Contains(c, th) })
	if export < 0 || server < export || resume < server {
		t.Fatalf("wake calls = %q", calls)
	}
	hc := pb.host.Calls()[hostBefore:]
	if len(hc) < 3 || hc[0] != "profile work" || !strings.HasPrefix(hc[1], "prepare ") || !strings.HasPrefix(hc[2], "ready ") {
		t.Fatalf("wake host calls = %q", hc)
	}
	if checks := pb.host.Checks()[checksBefore:]; len(checks) != 2 || !strings.HasPrefix(checks[0], "server ") {
		t.Fatalf("wake checks = %q", checks)
	}
	if launches := pb.host.Launches(); !slices.Equal(launches[len(launches)-1].Env, []string{"CODEX_HOME=" + pb.work}) {
		t.Fatalf("wake launch env %q", launches[len(launches)-1].Env)
	}
	if l2 := pb.launches(t)[a.ID]; l2.Profile != "work" || l2.Thread != th || l2.Account != store.AccountConfirmed || l2.ServerPID == 0 {
		t.Fatalf("launch after wake = %+v", l2)
	}
	if n := pb.balanced(t); n != 2 {
		t.Fatalf("%d prepares", n)
	}
}

// AC5: a profile gone while the floor slept (its folder removed) wakes on
// the default profile with a new Codex session, and its seat says so.
func TestProfileWakeGone(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	pb := startProfileBridge(t, true, "")
	a := pb.hireOnAndSleep(t, "work", th)
	if err := os.RemoveAll(pb.work); err != nil {
		t.Fatal(err)
	}
	calls, resumes := pb.wakeResumes(t)
	if resumes[a.ID] != proto.ResumeFallback {
		t.Fatalf("resumes = %+v", resumes)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "codex-home") || strings.HasPrefix(c, "codex-resume") {
			t.Fatalf("wake calls = %q", calls)
		}
	}
	if !slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-remote w1:p1 ") }) {
		t.Fatalf("no new session: %q", calls)
	}
	if launches := pb.host.Launches(); launches[len(launches)-1].Env != nil {
		t.Fatalf("woke with env %q", launches[len(launches)-1].Env)
	}
	const note = "work is gone: woke on codex. Its Codex session stays in that folder, so a new one was started."
	l := pb.launches(t)[a.ID]
	if l.Profile != "codex" || l.Thread != "" || l.ProfileNote != note || l.Account != "" || l.ServerPID == 0 {
		t.Fatalf("launch after wake = %+v", l)
	}
	w := workersOf(pb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.ProfileNote == note
	}), "s")["w1"]
	if w.Codex.Profile != "codex" || w.Codex.Server != proto.CodexServerRunning {
		t.Fatalf("worker codex = %+v", w.Codex)
	}
	if row := auditRow(t, pb.bridge, proto.CmdFloorWake); !strings.Contains(row.Result, note) {
		t.Fatalf("wake audit = %+v", row)
	}
	pb.balanced(t)
}

// waitUntil polls ok for up to 2 s.
func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(2 * time.Second); !ok(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("timed out: %s", what)
		}
	}
}

// S1e: a shared worker on a bare profile home (herdr's hook does not run
// there, so herdr reports no thread) gets its thread from its own server:
// the bridge joins it, and a wake resumes it rather than starting a new
// Codex session.
func TestProfileThreadFromServer(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ad01"
	pb := startProfileBridge(t, true, "")
	pb.host.mu.Lock()
	pb.host.root = func(string) (string, error) { return th, nil }
	pb.host.mu.Unlock()
	_, m := pb.c.command(proto.CmdWorkerHire, "a", profileHire(1, "work"))
	a := ackData[proto.HireResult](t, m)
	waitUntil(t, "the thread from its server", func() bool { return pb.launches(t)[a.ID].Thread == th })
	waitUntil(t, "the join", func() bool {
		pb.host.mu.Lock()
		defer pb.host.mu.Unlock()
		return slices.ContainsFunc(pb.host.watches, func(w *fakeCodexWatch) bool { return w.o.Thread == th })
	})
	pb.sleepShared(t, a.ID)
	if l := pb.launches(t)[a.ID]; l.Thread != th {
		t.Fatalf("launch after sleep = %+v", l)
	}
	calls, resumes := pb.wakeResumes(t)
	if resumes[a.ID] != proto.ResumeFallback || !slices.ContainsFunc(calls, func(c string) bool {
		return strings.HasPrefix(c, "codex-resume w1:p1 ") && strings.Contains(c, th)
	}) || slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-remote ") }) {
		t.Fatalf("wake calls = %q, resumes %+v", calls, resumes)
	}
	pb.balanced(t)
}

// S1e: the server's answer follows noteCodexThread's rules: a thread
// another worker has is never taken, no answer changes nothing, and a
// worker on the default profile (herdr's hook reports its thread) is
// never asked.
func TestProfileThreadFromServerRules(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ad02"
	pb := startProfileBridge(t, true, "")
	hire := func(desk int, key string) proto.HireResult {
		_, m := pb.c.command(proto.CmdWorkerHire, "h", profileHire(desk, key))
		return ackData[proto.HireResult](t, m)
	}
	sockOf := func(id string) string { return launchSocket(pb.launches(t)[id]) }
	def := hire(3, "codex")
	quiet := hire(4, "team") // its server has no root thread yet
	waitUntil(t, "a second ask", func() bool { return countOf(pb.host.Asked(), sockOf(quiet.ID)) >= 2 })
	if l := pb.launches(t)[quiet.ID]; l.Thread != "" {
		t.Fatalf("no answer, launch = %+v", l)
	}
	a := hire(1, "work")
	pb.fl.update(a.WorkspaceID, func(w *world.WorkerObs) { w.AgentSession = th }) // herdr's report: a's
	waitUntil(t, "a's thread", func() bool { return pb.launches(t)[a.ID].Thread == th })
	pb.host.mu.Lock()
	pb.host.root = func(string) (string, error) { return th, nil } // every server now names a's
	pb.host.mu.Unlock()
	b := hire(2, "work")
	waitUntil(t, "b asked twice", func() bool { return countOf(pb.host.Asked(), sockOf(b.ID)) >= 2 })
	if l := pb.launches(t)[b.ID]; l.Thread != "" {
		t.Fatalf("another worker's thread taken: %+v", l)
	}
	if slices.Contains(pb.host.Asked(), sockOf(def.ID)) {
		t.Fatalf("a worker on the default was asked: %q", pb.host.Asked())
	}
}

func countOf(list []string, s string) int {
	n := 0
	for _, x := range list {
		if x == s {
			n++
		}
	}
	return n
}

// launchSocket is a launch's server socket (codexapp.Launch.Socket).
func launchSocket(l store.CodexLaunch) string { return codexRun + "/" + l.Name + ".sock" }

// AC5: release runs on every error path of a hire and a wake.
func TestProfileReleaseOnErrors(t *testing.T) {
	t.Parallel()
	notSigned := func(string) (codexapp.Account, codexapp.Requirements, error) {
		return codexapp.Account{}, codexapp.Requirements{}, nil
	}
	refusing := func(string) (codexapp.Account, codexapp.Requirements, error) {
		return codexapp.Account{SignedIn: true}, codexapp.Requirements{Present: true, Approvals: []string{"on-request"}}, nil
	}
	for name, setup := range map[string]func(*profileBridge){
		"prepare fails":  func(pb *profileBridge) { pb.prepErr = errors.New("no profile") },
		"export fails":   func(pb *profileBridge) { pb.fl.fakeHerdr.exportErr = errors.New("pane gone") },
		"not signed in":  func(pb *profileBridge) { pb.host.server = notSigned },
		"policy refuses": func(pb *profileBridge) { pb.host.server = refusing },
		"server is down": func(pb *profileBridge) {
			pb.host.readyErr = errors.New("no answer")
			pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) { return notSigned("") }
		},
		"terminal fails": func(pb *profileBridge) { pb.fl.startErr = errors.New("agent start failed") },
		"fallback refused": func(pb *profileBridge) {
			pb.host.preErr = errors.New("unsupported Codex version")
			pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) { return notSigned("") }
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, true, "")
			setup(pb)
			if m, _ := pb.hire(t, 1, "work"); m.env.T != proto.TError {
				t.Fatalf("hire acked: %s", m.raw)
			}
			if n := pb.balanced(t); n != 1 {
				t.Fatalf("%d prepares", n)
			}
		})
	}
	for name, setup := range map[string]func(*profileBridge){
		"prepare fails":  func(pb *profileBridge) { pb.prepErr = errors.New("no profile") },
		"export fails":   func(pb *profileBridge) { pb.fl.fakeHerdr.exportErr = errors.New("pane gone") },
		"not signed in":  func(pb *profileBridge) { pb.host.server = notSigned },
		"policy refuses": func(pb *profileBridge) { pb.host.server = refusing },
		"embedded refused": func(pb *profileBridge) {
			pb.host.readyErr = errors.New("no answer")
			pb.host.home = func([]string) (codexapp.Account, codexapp.Requirements, error) {
				return codexapp.Account{}, codexapp.Requirements{}, nil
			}
		},
	} {
		t.Run("wake "+name, func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, true, "")
			a := pb.hireOnAndSleep(t, "work", "01a11172-ac09-7aa0-ab6b-84485199ada3")
			setup(pb)
			_, resumes := pb.wakeResumes(t)
			if resumes[a.ID] == proto.ResumeFallback {
				t.Fatalf("resumes = %+v", resumes)
			}
			l := pb.launches(t)[a.ID]
			if !strings.Contains(l.Note, "resume failed") || l.ServerPID != 0 {
				t.Fatalf("launch after wake = %+v", l)
			}
			if n := pb.balanced(t); n != 2 {
				t.Fatalf("%d prepares", n)
			}
		})
	}
}

// AC8 (protocol): a preset keeps its profile's key; only a Codex preset
// takes one, and only a listed one, but a gone one it had stays.
func TestProfileHirePreset(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, true, "")
	spec := proto.HirePresetSpec{Name: "On work", Prompt: "Review it.", Harness: "codex", Model: "gpt-6-sol", Effort: "low", CodexProfile: "work"}
	_, ack := pb.c.mustAck(proto.CmdHirePresetCreate, spec)
	b, _ := json.Marshal(ack.Data)
	var p proto.HirePreset
	if err := json.Unmarshal(b, &p); err != nil || p.CodexProfile != "work" {
		t.Fatalf("preset %s", b)
	}
	bad := spec
	bad.Name, bad.CodexProfile = "Nope", "nope"
	pb.c.mustError(proto.CmdHirePresetCreate, bad, proto.ErrNotFound)
	bad.Name, bad.Harness, bad.Model, bad.Effort, bad.CodexProfile = "Claude", "claude", "claude-opus-5-5", "high", "work"
	pb.c.mustError(proto.CmdHirePresetCreate, bad, proto.ErrBadRequest)
	if err := os.RemoveAll(pb.work); err != nil {
		t.Fatal(err)
	}
	pb.c.mustAck(proto.CmdCodexProfilesGet, nil) // lists them again
	edit := proto.HirePresetUpdateArgs{ID: p.ID, HirePresetSpec: spec}
	edit.Prompt = "Review it again."
	pb.c.mustAck(proto.CmdHirePresetUpdate, edit)
	pb.c.mustError(proto.CmdWorkerHire, profileHire(1, "work"), proto.ErrNotFound)
	if snap := pb.connect(proto.Hello{Client: "x"}).snapshot(); snap.World.CodexProfiles == nil || !snap.World.CodexProfiles.Hire {
		t.Fatalf("codex_profiles = %+v", snap.World.CodexProfiles)
	}
}

// legacyAsleep hires a Codex worker on key without its own server (the
// switch off), gives it the session th and puts its floor to sleep; the
// wake brings the floor back with its pane at its shell (herdr's own
// resume looked in the default home).
func (pb *profileBridge) legacyAsleep(t *testing.T, key, th string) proto.HireResult {
	t.Helper()
	m, _ := pb.hire(t, 1, key)
	res := ackData[proto.HireResult](t, m)
	pb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th })
	fh := pb.fl.fakeHerdr
	var awake []world.WorkerObs
	fh.onStop = func() {
		pb.fl.mu.Lock()
		awake = slices.Clone(pb.fl.workers)
		pb.fl.mu.Unlock()
		pb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	pb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", atShell())
		pb.floorAt("s", true, withStatus(awake, "idle"))
	}
	return res
}

// A Codex worker on a profile without its own server (the switch off)
// that herdr's own resume did not bring back on wake: the floor's fallback
// checks its profile's home again (R2), exports it in its pane and types
// `codex resume` there.
func TestProfileLegacyWakeFallback(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	pb := startProfileBridge(t, false, "")
	pb.legacyAsleep(t, "team", th)
	before := len(pb.host.Checks())
	calls, _ := pb.wakeResumes(t)
	i := slices.Index(calls, "codex-home w1:p1 "+pb.team)
	if i < 0 || i+1 >= len(calls) || calls[i+1] != "resume s w1:p1 codex "+th {
		t.Fatalf("wake calls = %q", calls)
	}
	if checks := pb.host.Checks()[before:]; !slices.Equal(checks, []string{"home CODEX_HOME=" + pb.team}) {
		t.Fatalf("wake checks = %q", checks)
	}
	pb.balanced(t)
}

// R2: a Codex worker without its own server whose profile no longer lets
// it run (signed out, or a workspace policy that refuses) is not resumed
// on wake: the check's reason is on its seat.
func TestProfileLegacyWakeRefused(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	for name, tc := range map[string]struct {
		home func([]string) (codexapp.Account, codexapp.Requirements, error)
		want string
	}{
		"not signed in": {func([]string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{Answered: true}, codexapp.Requirements{}, nil
		}, "team is not signed in. Run `CODEX_HOME=%s codex login` in a terminal."},
		"policy refuses": {func([]string) (codexapp.Account, codexapp.Requirements, error) {
			return codexapp.Account{Answered: true, SignedIn: true}, codexapp.Requirements{Present: true, Approvals: []string{"on-request"}}, nil
		}, "team does not allow workers that run without asking. Its workspace policy limits approvals to on-request."},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pb := startProfileBridge(t, false, "")
			a := pb.legacyAsleep(t, "team", th)
			pb.host.mu.Lock()
			pb.host.home = tc.home
			pb.host.mu.Unlock()
			before := len(pb.host.Checks())
			calls, resumes := pb.wakeResumes(t)
			if checks := pb.host.Checks()[before:]; !slices.Equal(checks, []string{"home CODEX_HOME=" + pb.team}) {
				t.Fatalf("wake checks = %q", checks)
			}
			for _, c := range calls {
				if strings.HasPrefix(c, "resume s w1:p1") || strings.HasPrefix(c, "start-agent") || strings.HasPrefix(c, "codex-home") {
					t.Fatalf("wake calls = %q", calls)
				}
			}
			if resumes[a.ID] == proto.ResumeFallback || resumes[a.ID] == proto.ResumeConfirmed {
				t.Fatalf("resumes = %+v", resumes)
			}
			want := strings.ReplaceAll(tc.want, "%s", pb.team)
			l := pb.launches(t)[a.ID]
			if l.Profile != "team" || !strings.Contains(l.ProfileNote, want) {
				t.Fatalf("launch after wake = %+v", l)
			}
			w := workersOf(pb.world(func(w proto.World) bool {
				x := workersOf(w, "s")["w1"]
				return x.Codex != nil && strings.Contains(x.Codex.ProfileNote, want)
			}), "s")["w1"]
			if w.Codex.Profile != "team" {
				t.Fatalf("worker codex = %+v", w.Codex)
			}
			if row := auditRow(t, pb.bridge, proto.CmdFloorWake); !strings.Contains(row.Result, want) {
				t.Fatalf("wake audit = %+v", row)
			}
			pb.balanced(t)
		})
	}
}

// R1: a Codex worker without its own server whose profile is gone (its
// folder removed while the floor slept) wakes on the default profile with
// a new Codex session, as a shared worker does, and its seat says so.
func TestProfileLegacyWakeGone(t *testing.T) {
	t.Parallel()
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	pb := startProfileBridge(t, false, "")
	a := pb.legacyAsleep(t, "team", th)
	if err := os.RemoveAll(pb.team); err != nil {
		t.Fatal(err)
	}
	calls, resumes := pb.wakeResumes(t)
	if resumes[a.ID] != proto.ResumeFallback {
		t.Fatalf("resumes = %+v", resumes)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "codex-home") || strings.HasPrefix(c, "resume s w1:p1") {
			t.Fatalf("wake calls = %q", calls)
		}
	}
	if !slices.ContainsFunc(calls, func(c string) bool {
		return strings.HasPrefix(c, "start-agent w1:p1 ") && strings.Contains(c, " codex gpt-6-sol low ")
	}) {
		t.Fatalf("no new session: %q", calls)
	}
	const note = "team is gone: woke on codex. Its Codex session stays in that folder, so a new one was started."
	l := pb.launches(t)[a.ID]
	if l.Mode != store.CodexLegacy || l.Profile != "codex" || l.ProfileNote != note || l.Account != "" {
		t.Fatalf("launch after wake = %+v", l)
	}
	w := workersOf(pb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.ProfileNote == note
	}), "s")["w1"]
	if w.Codex.Profile != "codex" {
		t.Fatalf("worker codex = %+v", w.Codex)
	}
	if row := auditRow(t, pb.bridge, proto.CmdFloorWake); !strings.Contains(row.Result, note) {
		t.Fatalf("wake audit = %+v", row)
	}
	pb.balanced(t)
}

// profileRollout writes a Codex rollout started at stamp in cwd, under a
// sessions folder, whose last token count has input tokens in.
func profileRollout(t *testing.T, sessions, stamp, id, cwd string, in int, more ...string) {
	t.Helper()
	dir := filepath.Join(sessions, stamp[0:4], stamp[5:7], stamp[8:10])
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q}}`+"\n"+
		`{"type":"turn_context","payload":{"model":"gpt-6-sol","cwd":%q}}`+"\n"+
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":0,`+
		`"output_tokens":1,"total_tokens":%d},"last_token_usage":{"total_tokens":%d},"model_context_window":258400}}}`+"\n",
		id, cwd, cwd, in, in+1, in+1)
	for _, line := range more {
		body += line + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "rollout-"+stamp+"-"+id+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// S1b: the sleep backfills a Codex worker on another profile whose session
// herdr never learned (a bare home runs no herdr hook) from its own
// profile's folder, never from --codex-sessions (the default's), where a
// newer session of the same folder is another one's; a worker on the
// default still is, from there. A profile that is gone is not looked in.
func TestProfileSleepBackfillsOwnHome(t *testing.T) {
	t.Parallel()
	const (
		defID  = "0c0d0e0f-1390-4000-8000-00000000000d"
		teamID = "0c0d0e0f-1390-4000-8000-00000000000e"
	)
	pb := startProfileBridge(t, false, "")
	profileRollout(t, filepath.Join(pb.def, "sessions"), "2026-10-21T11-00-00", defID, "/home/u/repo", 900)
	profileRollout(t, filepath.Join(pb.team, "sessions"), "2026-10-21T10-00-00", teamID, "/home/u/repo", 300)
	ackData[proto.HireResult](t, func() msg { m, _ := pb.hire(t, 1, "team"); return m }())
	ackData[proto.HireResult](t, func() msg { m, _ := pb.hire(t, 2, "codex"); return m }())
	ackData[proto.HireResult](t, func() msg { m, _ := pb.hire(t, 3, "work"); return m }())
	if err := os.RemoveAll(pb.work); err != nil {
		t.Fatal(err)
	}
	pb.c.mustAck(proto.CmdCodexProfilesGet, nil) // lists them again
	fh := pb.fl.fakeHerdr
	fh.onStop = func() {
		pb.fl.mu.Lock()
		awake := slices.Clone(pb.fl.workers)
		pb.fl.mu.Unlock()
		pb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	before := len(pb.fl.Calls())
	pb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	calls := pb.fl.Calls()[before:]
	if !slices.Contains(calls, "report s w1:p1 "+teamID) || !slices.Contains(calls, "report s w2:p1 "+defID) {
		t.Fatalf("sleep calls = %q", calls)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "report s w3:p1") || c == "report s w1:p1 "+defID {
			t.Fatalf("sleep calls = %q", calls)
		}
	}
	if row := auditRow(t, pb.bridge, proto.CmdFloorSleep); !strings.Contains(row.Result, `"pane":"w3:p1","skipped":"its Codex profile is gone: its sessions are not read"`) {
		t.Fatalf("sleep audit = %+v", row)
	}
}

// S1a, S1b: a Codex worker on another profile whose session herdr does not
// know gets the usage of the rollout of its folder in its own profile's
// sessions folder, not the newer one of the same folder in --codex-sessions
// (the default's), which is another worker's.
func TestProfileUsageOwnHome(t *testing.T) {
	t.Parallel()
	const (
		defID  = "0c0d0e0f-1390-4000-8000-0000000000a1"
		teamID = "0c0d0e0f-1390-4000-8000-0000000000a2"
	)
	pb := startProfileBridge(t, false, "")
	profileRollout(t, filepath.Join(pb.def, "sessions"), "2026-10-21T11-00-00", defID, "/home/u/repo", 900)
	profileRollout(t, filepath.Join(pb.team, "sessions"), "2026-10-21T10-00-00", teamID, "/home/u/repo", 300,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review the team's pull requests"}]}}`)
	res := ackData[proto.HireResult](t, func() msg { m, _ := pb.hire(t, 1, "team"); return m }())
	w := workersOf(pb.world(func(w proto.World) bool {
		x := workersOf(w, "s")[res.WorkspaceID]
		return x.Usage != nil
	}), "s")[res.WorkspaceID]
	if w.Usage.Input != 300 || w.AgentSession != "" {
		t.Fatalf("usage = %+v, agent session %q", w.Usage, w.AgentSession)
	}
	// Its transcript lines come from the same rollout (the watch's first page).
	c := pb.connect(proto.Hello{Client: "tx"})
	c.snapshot()
	_, wack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: res.ID})
	b, _ := json.Marshal(wack.Data)
	var page proto.TranscriptWatchResult
	if err := json.Unmarshal(b, &page); err != nil || page.Session != teamID || !slices.ContainsFunc(page.Items, func(it proto.TranscriptItem) bool {
		return it.Kind == proto.ItemUser && len(it.Parts) > 0 && it.Parts[0].Text == "review the team's pull requests"
	}) {
		t.Fatalf("transcript.watch = %s", b)
	}
}

// childOf is the world's child of native id, if any.
func childOf(w proto.World, native string) (proto.Child, bool) {
	i := slices.IndexFunc(w.Children, func(c proto.Child) bool { return c.NativeID == native })
	if i < 0 {
		return proto.Child{}, false
	}
	return w.Children[i], true
}

// S1e, N2: the children of a worker on a bare home (herdr reports no
// session) are bound to the thread its own server named, at once, and
// stay so: a later refresh while herdr is still silent keeps them and the
// generation, and so does herdr's report of the same thread.
func TestProfileBareHomeChildren(t *testing.T) {
	t.Parallel()
	const (
		th  = "01a11172-ac09-7aa0-ab6b-84485199ad01"
		kid = "01a11172-ac09-7aa0-ab6b-84485199ad02"
	)
	src := childagentstest.NewFixtureSource()
	pb := startProfileBridge(t, true, "", func(o *server.Options) { o.ChildSources = []childagents.Source{src} })
	pb.host.mu.Lock()
	pb.host.root = func(string) (string, error) { return th, nil }
	pb.host.mu.Unlock()
	_, m := pb.c.command(proto.CmdWorkerHire, "a", profileHire(1, "work"))
	a := ackData[proto.HireResult](t, m)
	waitUntil(t, "the thread from its server", func() bool { return pb.launches(t)[a.ID].Thread == th })
	src.Emit(childagents.Evidence{Session: th, Provider: proto.ChildCodex, NativeID: kid, State: proto.ChildRunning,
		Source: proto.ChildFromFixture, Parent: &childagents.ParentRef{Kind: proto.ParentRoot}})
	w := pb.world(func(w proto.World) bool { _, ok := childOf(w, kid); return ok })
	c, _ := childOf(w, kid)
	gen := workersOf(w, "s")[a.WorkspaceID].ChildGeneration
	if c.WorkerID != a.ID || c.AgentSession != th || c.Generation != gen {
		t.Fatalf("child = %+v, worker's generation %d", c, gen)
	}
	pb.fl.update(a.WorkspaceID, func(w *world.WorkerObs) { w.Title = "still no session" })
	w = pb.world(func(w proto.World) bool { return workersOf(w, "s")[a.WorkspaceID].Title == "still no session" })
	if _, ok := childOf(w, kid); !ok || workersOf(w, "s")[a.WorkspaceID].ChildGeneration != gen {
		t.Fatalf("a refresh without herdr's session: %+v", w)
	}
	pb.fl.update(a.WorkspaceID, func(w *world.WorkerObs) { w.AgentSession = th })
	w = pb.world(func(w proto.World) bool { return workersOf(w, "s")[a.WorkspaceID].AgentSession == th })
	if _, ok := childOf(w, kid); !ok || workersOf(w, "s")[a.WorkspaceID].ChildGeneration != gen {
		t.Fatalf("herdr's report of the same thread: %+v", w)
	}
}

// S1a, S1e, N1, N2 end to end: a worker on a bare home gets its thread
// from its own server; its subagent's rollout in that home's sessions
// folder makes its child row, bound to that thread, and the child's
// transcript opens from there.
func TestProfileBareHomeChildTranscript(t *testing.T) {
	t.Parallel()
	const (
		th  = "01a11172-ac09-7aa0-ab6b-84485199ad11"
		kid = "01a11172-ac09-7aa0-ab6b-84485199ad12"
	)
	src := codexchild.New(codexchild.Options{})
	pb := startProfileBridge(t, true, "", func(o *server.Options) {
		o.Usage.Interval = 20 * time.Millisecond
		o.Usage.CodexChildren = func(s string) server.ChildReader { return src.Listener(s) }
		o.ChildSources = []childagents.Source{src}
	})
	sessions := filepath.Join(pb.work, "sessions")
	profileRollout(t, sessions, "2026-10-21T09-00-00", th, "/home/u/repo", 100)
	// A newer root of the same folder: the lookup by folder would take it, never the thread's own.
	profileRollout(t, sessions, "2026-10-21T09-30-00", "01a11172-ac09-7aa0-ab6b-84485199ad13", "/home/u/repo", 50)
	profileRollout(t, sessions, "2026-10-21T09-01-00", kid, "/home/u/repo", 10,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"the subagent's own task"}]}}`)
	// Its first line says whose subagent it is.
	path := filepath.Join(sessions, "2026", "10", "21", "rollout-2026-10-21T09-01-00-"+kid+".jsonl")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"session_id":%q,"cwd":"/home/u/repo","thread_source":"subagent",`+
		`"agent_nickname":"Volta","source":{"subagent":{"thread_spawn":{"parent_thread_id":%q,"depth":1}}}}}`, kid, th, th)
	b = append([]byte(meta), b[bytes.IndexByte(b, '\n'):]...)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	pb.host.mu.Lock()
	pb.host.root = func(string) (string, error) { return th, nil }
	pb.host.mu.Unlock()
	_, m := pb.c.command(proto.CmdWorkerHire, "a", profileHire(1, "work"))
	a := ackData[proto.HireResult](t, m)
	waitUntil(t, "the thread from its server", func() bool { return pb.launches(t)[a.ID].Thread == th })
	w := pb.world(func(w proto.World) bool { _, ok := childOf(w, kid); return ok })
	ch, _ := childOf(w, kid)
	if ch.WorkerID != a.ID || ch.AgentSession != th || ch.Source != proto.ChildFromRollout || workersOf(w, "s")[a.WorkspaceID].AgentSession != "" {
		t.Fatalf("child = %+v", ch)
	}
	c := pb.connect(proto.Hello{Client: "tx"})
	c.snapshot()
	target := &proto.TranscriptChild{ID: ch.ID, Generation: ch.Generation, Provider: ch.Provider}
	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: a.ID, Child: target})
	res := decode[proto.TranscriptWatchResult](t, ack)
	head, items := res.TranscriptHead, res.Items
	for head.Pending { // its log opens on the tracker's next poll: live on the same watch
		p, cl := c.pushOf(a.ID, target)
		if cl.Reason != "" {
			t.Fatalf("the child's watch closed: %+v", cl)
		}
		if p.TranscriptHead != nil {
			head = *p.TranscriptHead
		}
		items = append(items, p.Items...)
	}
	if head.Session != kid || !slices.ContainsFunc(items, func(it proto.TranscriptItem) bool {
		return it.Kind == proto.ItemUser && len(it.Parts) > 0 && it.Parts[0].Text == "the subagent's own task"
	}) {
		t.Fatalf("the child's transcript = %+v, items %+v", head, items)
	}
}

// N2 after a bridge start: the stored thread binds a bare home's worker at
// its first refresh (it is never asked again), and the source's replay of
// that thread brings its children back.
func TestProfileBareHomeChildrenAfterRestart(t *testing.T) {
	t.Parallel()
	const (
		th  = "01a11172-ac09-7aa0-ab6b-84485199ad21"
		kid = "01a11172-ac09-7aa0-ab6b-84485199ad22"
	)
	db := filepath.Join(t.TempDir(), "world.db")
	src := childagentstest.NewFixtureSource()
	first := startProfileBridgeAt(t, db, "", nil, true, "", func(o *server.Options) { o.ChildSources = []childagents.Source{src} })
	first.host.mu.Lock()
	first.host.root = func(string) (string, error) { return th, nil }
	first.host.mu.Unlock()
	_, m := first.c.command(proto.CmdWorkerHire, "a", profileHire(1, "work"))
	a := ackData[proto.HireResult](t, m)
	waitUntil(t, "the thread from its server", func() bool { return first.launches(t)[a.ID].Thread == th })
	src.Emit(childagents.Evidence{Session: th, Provider: proto.ChildCodex, NativeID: kid, State: proto.ChildRunning,
		Source: proto.ChildFromFixture, Parent: &childagents.ParentRef{Kind: proto.ParentRoot}})
	first.world(func(w proto.World) bool { _, ok := childOf(w, kid); return ok })
	first.fl.mu.Lock()
	workers := slices.Clone(first.fl.workers)
	first.fl.mu.Unlock()
	first.stop()

	again := startProfileBridgeAt(t, db, first.user, workers, true, "", func(o *server.Options) {
		o.ChildSources = []childagents.Source{childagentstest.NewFixtureSource(src.Seen()...)}
	})
	w := again.world(func(w proto.World) bool { _, ok := childOf(w, kid); return ok })
	if c, _ := childOf(w, kid); c.WorkerID != a.ID || c.AgentSession != th || workersOf(w, "s")[a.WorkspaceID].AgentSession != "" {
		t.Fatalf("child after the restart = %+v", c)
	}
	if asked := again.host.Asked(); len(asked) != 0 {
		t.Fatalf("asked again: %q", asked)
	}
}
