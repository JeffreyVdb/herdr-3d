package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #58 session.create: a new herdr session, and with it a floor.

// sessionHost is herdr as session.create sees it: a sessions folder (a temp
// dir), `session list` with the default session and one asleep named
// session ("existing"), and the loaded transient units.
type sessionHost struct {
	fh    *fakeHerdr
	dir   string
	units map[string]bool
}

func newSessionHost(t *testing.T) *sessionHost {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(filepath.Join(dir, "existing"), 0o700); err != nil {
		t.Fatal(err)
	}
	fh := newFakeHerdr()
	fh.sessions = []herdr.Session{
		{Name: "default", Default: true, SessionDir: filepath.Dir(dir)},
		{Name: "existing", SessionDir: filepath.Join(dir, "existing")},
	}
	return &sessionHost{fh: fh, dir: dir, units: map[string]bool{}}
}

func (h *sessionHost) opts() server.Options {
	o := fastOps(h.fh)
	o.UnitLoaded = func(unit string) bool { return h.units[unit] }
	return o
}

// startsFloor makes CreateSession behave like herdr: the session's folder
// and list entry appear, and the watcher sees its floor running.
func (h *sessionHost) startsFloor(t *testing.T, b *bridge) {
	h.fh.onCreate = func(name string) {
		if err := os.Mkdir(filepath.Join(h.dir, name), 0o700); err != nil {
			t.Error(err)
		}
		h.fh.mu.Lock()
		h.fh.sessions = append(h.fh.sessions, herdr.Session{Name: name, Running: true, SessionDir: filepath.Join(h.dir, name)})
		h.fh.mu.Unlock()
		b.floorAt(name, true, nil)
	}
}

func TestSessionCreateHappyPath(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	b := startBridge(t, "", sh.opts())
	sh.startsFloor(t, b)
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()

	evs, m := c.command(proto.CmdSessionCreate, "create-1", proto.SessionCreateArgs{Name: "new_floor-2"})
	if got := ackData[proto.SessionCreated](t, m); got.Session != "new_floor-2" {
		t.Fatalf("ack = %+v", got)
	}
	// The floor is in the world before the ack: the client can assign it at once.
	var seen bool
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert && ev.Floor.Session == "new_floor-2" && ev.Floor.State == "running" && ev.Floor.Building == nil {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("no running floor.upsert for the new session before the ack: %+v", evs)
	}
	if calls := sh.fh.Calls(); !slices.Equal(calls, []string{"list", "create new_floor-2"}) {
		t.Errorf("herdr calls = %v", calls)
	}
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 1 || log[0].Cmd != proto.CmdSessionCreate || !log[0].OK || !log[0].Done {
		t.Fatalf("audit = %+v", log)
	}
	// The floor is like any discovered one: it can go into a building.
	id := createBuilding(c, "Work")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "new_floor-2", Building: &id})
}

func TestSessionCreateRefusesInvalidNames(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	b := startBridge(t, "", sh.opts())
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()

	// The length cap follows this host's sessions folder (sun_path), not a constant.
	max := herdr.MaxNewSessionName(sh.dir)
	for _, tc := range []struct{ name, why string }{
		{"", "Give the floor a name."},
		{"default", "herdr’s own session"},
		{"-x", "cannot start with “-”"},
		{"Upper", "lowercase letters"},
		{"a.b", "lowercase letters"},
		{"a/b", "lowercase letters"},
		{"a b", "lowercase letters"},
		{strings.Repeat("x", max+1), "at most"},
	} {
		_, m := c.command(proto.CmdSessionCreate, "bad", proto.SessionCreateArgs{Name: tc.name})
		if e := errorOf(m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, tc.why) {
			t.Errorf("%q: %s, want bad_request %q", tc.name, m.raw, tc.why)
		}
	}
	c.mustError(proto.CmdSessionCreate, map[string]any{"name": "x", "building": "b1"}, proto.ErrBadRequest)
	if calls := sh.fh.Calls(); slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "create") }) {
		t.Errorf("herdr calls = %v, want no create", calls)
	}
	// The longest name that fits is fine.
	sh.startsFloor(t, b)
	c.mustAck(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: strings.Repeat("x", max)})
}

func TestSessionCreateRefusesTakenNames(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	if err := os.Mkdir(filepath.Join(sh.dir, "stale"), 0o700); err != nil {
		t.Fatal(err)
	}
	sh.units["herdr-s-stopping.service"] = true
	b := startBridge(t, "", sh.opts())
	b.floorAt("known", false, nil) // a floor the bridge knows (herdr's list is older)
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()
	for name, why := range map[string]string{
		"existing": "already a herdr session (asleep)",
		"stale":    "already has a folder",
		"stopping": "herdr-s-stopping.service is still loaded",
		"known":    "already a floor",
	} {
		_, m := c.command(proto.CmdSessionCreate, "taken", proto.SessionCreateArgs{Name: name})
		if e := errorOf(m); e.Code != proto.ErrNameTaken || !strings.Contains(e.Message, why) {
			t.Errorf("%q: %s, want name_taken %q", name, m.raw, why)
		}
	}
	if calls := sh.fh.Calls(); slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "create") }) {
		t.Errorf("herdr calls = %v, want no create", calls)
	}
}

func TestSessionCreateFollowsTheWatchedSessions(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	opts := sh.opts()
	opts.Sessions = regexp.MustCompile(`^h3d-`)
	b := startBridge(t, "", opts)
	sh.startsFloor(t, b)
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()
	_, m := c.command(proto.CmdSessionCreate, "outside", proto.SessionCreateArgs{Name: "other"})
	if e := errorOf(m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, "--sessions") {
		t.Fatalf("outside --sessions: %s", m.raw)
	}
	c.mustAck(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: "h3d-new"})
	if calls := sh.fh.Calls(); !slices.Equal(calls, []string{"list", "create h3d-new"}) {
		t.Errorf("herdr calls = %v", calls)
	}
}

func TestSessionCreateOneAtATimePerName(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	sh.fh.holdCreate, sh.fh.createGate = "twin", make(chan struct{})
	b := startBridge(t, "", sh.opts())
	sh.startsFloor(t, b)
	c := b.connect(proto.Hello{Client: "first"})
	c.snapshot()
	other := b.connect(proto.Hello{Client: "second"})
	other.snapshot()

	c.send(proto.Command{T: proto.CmdSessionCreate, ReqID: "slow", Args: json.RawMessage(`{"name":"twin"}`)})
	waitFor(t, "the first create", func() bool { return slices.Contains(sh.fh.Calls(), "create twin") })
	_, m := other.command(proto.CmdSessionCreate, "again", proto.SessionCreateArgs{Name: "twin"})
	if e := errorOf(m); e.Code != proto.ErrBusy {
		t.Fatalf("second create of the same name: %s", m.raw)
	}
	// Another name goes ahead meanwhile.
	other.mustAck(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: "solo"})
	close(sh.fh.createGate)
	for {
		if m := c.next(); m.env.ReqID == "slow" {
			if m.env.T != proto.TAck {
				t.Fatalf("first create: %s", m.raw)
			}
			break
		}
	}
	// Done: the name is taken now, not busy.
	other.mustError(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: "twin"}, proto.ErrNameTaken)
}

func TestSessionCreateRollsBackWhatItStarted(t *testing.T) {
	t.Parallel()
	sh := newSessionHost(t)
	b := startBridge(t, "", sh.opts())
	// herdr makes the folder, but the floor never comes up (the server died).
	sh.fh.onCreate = func(name string) {
		if err := os.Mkdir(filepath.Join(sh.dir, name), 0o700); err != nil {
			t.Error(err)
		}
	}
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()
	_, m := c.command(proto.CmdSessionCreate, "dead", proto.SessionCreateArgs{Name: "dead"})
	if e := errorOf(m); e.Code != proto.ErrSessionCreateFailed || !strings.Contains(e.Message, "not seen running") {
		t.Fatalf("create of a server that never comes up: %s", m.raw)
	}
	if calls := sh.fh.Calls(); !slices.Equal(calls, []string{"list", "create dead", "stop dead"}) {
		t.Errorf("herdr calls = %v", calls)
	}
	if _, err := os.Stat(filepath.Join(sh.dir, "dead")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the folder this call created is still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sh.dir, "existing")); err != nil {
		t.Errorf("another session's folder went: %v", err)
	}

	// herdr refuses to start it: its error, verbatim.
	sh.fh.onCreate = nil
	sh.fh.createErr = errors.New(`herdr control create-session: exit status 1: Failed to start transient service unit: Unit herdr-s-refused.service was already loaded`)
	_, m = c.command(proto.CmdSessionCreate, "refused", proto.SessionCreateArgs{Name: "refused"})
	if e := errorOf(m); e.Code != proto.ErrSessionCreateFailed || !strings.Contains(e.Message, "Unit herdr-s-refused.service was already loaded") {
		t.Fatalf("refused create: %s", m.raw)
	}

	// The list cannot be read: nothing is started.
	sh.fh.listErr = errors.New("herdr session list: exit status 1")
	_, m = c.command(proto.CmdSessionCreate, "blind", proto.SessionCreateArgs{Name: "blind"})
	if e := errorOf(m); e.Code != proto.ErrSessionCreateFailed || !strings.Contains(e.Message, "herdr session list") {
		t.Fatalf("create without a list: %s", m.raw)
	}
	if calls := sh.fh.Calls(); slices.Contains(calls, "create blind") {
		t.Errorf("herdr calls = %v", calls)
	}
}

func TestSessionCreateUnsupportedWithoutHerdr(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{Client: "add-floor"})
	c.snapshot()
	c.mustError(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: "x"}, proto.ErrUnsupported)
}
