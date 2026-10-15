package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBridgeListRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "conf", "bridges.json")
	if l, ok, err := LoadBridgeList(file); err != nil || ok || len(l.Bridges) != 0 {
		t.Fatalf("missing file: %+v %v %v", l, ok, err)
	}
	a := BridgeEntry{ID: NewBridgeID(), Name: "devbox", Kind: KindSSH, Host: "dev@devbox", RemoteSocket: "/run/user/1000/herdr-world/bridge.sock"}
	b := BridgeEntry{ID: NewBridgeID(), Name: "Laptop", Kind: KindLocal, Socket: "/run/user/1000/herdr-world/bridge.sock"}
	want := BridgeList{Active: b.ID, Bridges: []BridgeEntry{a, b}}
	if err := SaveBridgeList(file, want); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(file)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode: %v %v", fi, err)
	}
	if di, _ := os.Stat(filepath.Dir(file)); di.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %v", di.Mode().Perm())
	}
	got, ok, err := LoadBridgeList(file)
	if err != nil || !ok || got.Active != want.Active || !slices.Equal(got.Bridges, want.Bridges) {
		t.Fatalf("round trip: %+v %v %v", got, ok, err)
	}
	// A file that breaks the rules is an error naming the file, never a guess.
	for name, body := range map[string]string{
		"not json":         "{",
		"unknown field":    `{"active":"","bridges":[],"extra":1}`,
		"active missing":   `{"active":"","bridges":[{"id":"0123456789","name":"a","kind":"local","socket":"/a.sock"}]}`,
		"active not there": `{"active":"aaaaaaaaaa","bridges":[{"id":"0123456789","name":"a","kind":"local","socket":"/a.sock"}]}`,
		"bad id":           `{"active":"x","bridges":[{"id":"x","name":"a","kind":"local","socket":"/a.sock"}]}`,
		"same name":        `{"active":"0123456789","bridges":[{"id":"0123456789","name":"a","kind":"local","socket":"/a.sock"},{"id":"0123456788","name":"A","kind":"local","socket":"/b.sock"}]}`,
		"bad host":         `{"active":"0123456789","bridges":[{"id":"0123456789","name":"a","kind":"ssh","host":"-oProxyCommand=x"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := LoadBridgeList(file); err == nil || !strings.Contains(err.Error(), file) {
				t.Errorf("want an error naming the file, got %v", err)
			}
		})
	}
}

func TestCheckBridgeEntry(t *testing.T) {
	long := "/" + strings.Repeat("s", MaxSocketPath)
	for name, tc := range map[string]struct {
		e    BridgeEntry
		want string // "" ok, else a piece of the message
	}{
		"ssh":                  {BridgeEntry{Name: "devbox", Kind: KindSSH, Host: "dev@devbox"}, ""},
		"ssh with socket":      {BridgeEntry{Name: "devbox", Kind: KindSSH, Host: "devbox", RemoteSocket: "/run/b.sock"}, ""},
		"name trimmed":         {BridgeEntry{Name: "  devbox ", Kind: KindSSH, Host: "devbox"}, ""},
		"no name":              {BridgeEntry{Name: "  ", Kind: KindSSH, Host: "devbox"}, "name is empty"},
		"long name":            {BridgeEntry{Name: strings.Repeat("n", 41), Kind: KindSSH, Host: "devbox"}, "longer than 40"},
		"control name":         {BridgeEntry{Name: "a\x07b", Kind: KindSSH, Host: "devbox"}, "control"},
		"no host":              {BridgeEntry{Name: "a", Kind: KindSSH}, "host is empty"},
		"option host":          {BridgeEntry{Name: "a", Kind: KindSSH, Host: "-oProxyCommand=x"}, "starts with '-'"},
		"space host":           {BridgeEntry{Name: "a", Kind: KindSSH, Host: "dev box"}, "whitespace"},
		"relative remote":      {BridgeEntry{Name: "a", Kind: KindSSH, Host: "devbox", RemoteSocket: "run/b.sock"}, "absolute"},
		"ssh with local sock":  {BridgeEntry{Name: "a", Kind: KindSSH, Host: "devbox", Socket: "/b.sock"}, "not a local socket"},
		"local":                {BridgeEntry{Name: "a", Kind: KindLocal, Socket: "/run/user/1000/herdr-world/bridge.sock"}, ""},
		"local no socket":      {BridgeEntry{Name: "a", Kind: KindLocal}, "socket is empty"},
		"local relative":       {BridgeEntry{Name: "a", Kind: KindLocal, Socket: "bridge.sock"}, "absolute"},
		"local unclean":        {BridgeEntry{Name: "a", Kind: KindLocal, Socket: "/run/../b.sock"}, "clean"},
		"local too long":       {BridgeEntry{Name: "a", Kind: KindLocal, Socket: long}, "unix sockets allow"},
		"local with host":      {BridgeEntry{Name: "a", Kind: KindLocal, Socket: "/b.sock", Host: "devbox"}, "no host"},
		"unknown kind":         {BridgeEntry{Name: "a", Kind: "tcp", Host: "devbox"}, `want "ssh" or "local"`},
		"local exactly at max": {BridgeEntry{Name: "a", Kind: KindLocal, Socket: long[:MaxSocketPath]}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := CheckBridgeEntry(tc.e)
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("got %v, want an error with %q", err, tc.want)
			case tc.want == "" && got.Name != strings.TrimSpace(tc.e.Name):
				t.Fatalf("name %q", got.Name)
			}
		})
	}
}

// TestSeedBridgeList: a helper from before #57 (only -host) comes up on that
// host, named after it, in use; a list file that exists wins over -host.
func TestSeedBridgeList(t *testing.T) {
	l, changed := SeedBridgeList(BridgeList{}, false, "dev@devbox", "/run/b.sock")
	if !changed || len(l.Bridges) != 1 || l.Active != l.Bridges[0].ID {
		t.Fatalf("seeded: %+v %v", l, changed)
	}
	if e := l.Bridges[0]; e.Name != "dev@devbox" || e.Kind != KindSSH || e.Host != "dev@devbox" || e.RemoteSocket != "/run/b.sock" || checkList(l) != nil {
		t.Fatalf("entry: %+v (%v)", e, checkList(l))
	}
	if l, changed := SeedBridgeList(BridgeList{}, false, "", ""); changed || len(l.Bridges) != 0 {
		t.Fatalf("no host, no list: %+v %v", l, changed)
	}
	if l2, changed := SeedBridgeList(l, true, "other@host", ""); changed || !slices.Equal(l2.Bridges, l.Bridges) {
		t.Fatalf("a list file is the truth: %+v %v", l2, changed)
	}
	if l3, changed := SeedBridgeList(BridgeList{Bridges: []BridgeEntry{}}, true, "dev@devbox", ""); !changed || len(l3.Bridges) != 1 {
		t.Fatalf("an empty list takes the host: %+v %v", l3, changed)
	}
}

// fakeEntry is an entry's connection with no ssh: Dial goes where dial says,
// Status is whatever the test set.
type fakeEntry struct {
	mu    sync.Mutex
	st    Status
	dial  func(ctx context.Context) (net.Conn, error)
	dials atomic.Int32
	runs  atomic.Int32
	run   func(ctx context.Context)
}

func (f *fakeEntry) Dial(ctx context.Context) (net.Conn, error) {
	f.dials.Add(1)
	if f.dial == nil {
		return nil, errors.New("fake: no dial")
	}
	return f.dial(ctx)
}

func (f *fakeEntry) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.st
}

func (f *fakeEntry) setState(s string) {
	f.mu.Lock()
	f.st.State = s
	f.mu.Unlock()
}

func (f *fakeEntry) Run(ctx context.Context) error {
	f.runs.Add(1)
	if f.run != nil {
		f.run(ctx)
	}
	<-ctx.Done()
	return nil
}

// fakeSet is a running BridgeSet whose entries are fakes, made as entries are
// added (by name).
type fakeSet struct {
	*BridgeSet
	mu    sync.Mutex
	fakes map[string]*fakeEntry // by name
	make  func(e BridgeEntry) *fakeEntry
}

func (f *fakeSet) fake(name string) *fakeEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fakes[name]
}

func newFakeSet(t *testing.T, file string, mk func(e BridgeEntry) *fakeEntry, entries ...BridgeEntry) *fakeSet {
	t.Helper()
	l := BridgeList{Bridges: []BridgeEntry{}}
	for _, e := range entries {
		e.ID = NewBridgeID()
		l.Bridges = append(l.Bridges, e)
	}
	if len(l.Bridges) > 0 {
		l.Active = l.Bridges[0].ID
	}
	set, err := NewBridgeSet(BridgeSetConfig{File: file, SocketDir: t.TempDir(), Log: quietLog()}, l)
	if err != nil {
		t.Fatal(err)
	}
	if mk == nil {
		mk = func(BridgeEntry) *fakeEntry { return &fakeEntry{st: Status{State: StateUp}} }
	}
	fs := &fakeSet{BridgeSet: set, fakes: map[string]*fakeEntry{}, make: mk}
	set.newBridge = func(e BridgeEntry) entryBridge {
		f := mk(e)
		fs.mu.Lock()
		fs.fakes[e.Name] = f
		fs.mu.Unlock()
		return f
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { set.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitFor(t, "runners started", func() bool {
		for _, e := range l.Bridges {
			if f := fs.fake(e.Name); f == nil || f.runs.Load() == 0 {
				return false
			}
		}
		return true
	})
	return fs
}

func idOf(t *testing.T, s *BridgeSet, name string) string {
	t.Helper()
	_, list := s.List()
	for _, b := range list {
		if b.Name == name {
			return b.ID
		}
	}
	t.Fatalf("no bridge %q", name)
	return ""
}

// pipeDial hands out one end of a pipe and keeps the other, to see it closed.
type pipeDial struct {
	mu   sync.Mutex
	ends []net.Conn
}

func (p *pipeDial) dial(context.Context) (net.Conn, error) {
	a, b := net.Pipe()
	p.mu.Lock()
	p.ends = append(p.ends, b)
	p.mu.Unlock()
	return a, nil
}

// closed reports whether the far end of dial i sees its peer gone.
func (p *pipeDial) closed(i int) bool {
	p.mu.Lock()
	c := p.ends[i]
	p.mu.Unlock()
	_ = c.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	_, err := c.Read(make([]byte, 1))
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe)
}

// TestBridgeSetDelegatesAndSwitches: Dial and Status are the entry in use's,
// and a switch closes every connection dialled to the entry before (the
// game's /ws and the proxies' idle ones) while the new entry's stay.
func TestBridgeSetDelegatesAndSwitches(t *testing.T) {
	dials := map[string]*pipeDial{}
	var mu sync.Mutex
	set := newFakeSet(t, filepath.Join(t.TempDir(), "bridges.json"), func(e BridgeEntry) *fakeEntry {
		p := &pipeDial{}
		mu.Lock()
		dials[e.Name] = p
		mu.Unlock()
		st := StateUp
		if e.Name == "B" {
			st = StateBackoff
		}
		return &fakeEntry{st: Status{State: st, Bridge: "v-" + e.Name, OpenHosts: []string{strings.ToLower(e.Name) + ".example.test"}}, dial: p.dial}
	}, BridgeEntry{Name: "A", Kind: KindLocal, Socket: "/a.sock"}, BridgeEntry{Name: "B", Kind: KindLocal, Socket: "/b.sock"})

	if st := set.Status(); st.State != StateUp || st.Bridge != "v-A" {
		t.Fatalf("status of A: %+v", st)
	}
	a1, err := set.Dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := set.Dial(context.Background())
	a2.Close() // a closed one is no longer A's
	if set.fake("A").dials.Load() != 2 || set.fake("B").dials.Load() != 0 {
		t.Fatalf("dials A %d, B %d", set.fake("A").dials.Load(), set.fake("B").dials.Load())
	}

	if err := set.Activate(idOf(t, set.BridgeSet, "B")); err != nil {
		t.Fatal(err)
	}
	if !dials["A"].closed(0) {
		t.Fatal("A's connection stayed open after the switch")
	}
	if st := set.Status(); st.State != StateBackoff || st.Bridge != "v-B" || !slices.Equal(st.OpenHosts, []string{"b.example.test"}) {
		t.Fatalf("status after the switch is not B's: %+v", st)
	}
	b1, err := set.Dial(context.Background())
	if err != nil || set.fake("B").dials.Load() != 1 {
		t.Fatalf("dial after the switch: %v, B dials %d", err, set.fake("B").dials.Load())
	}
	// Switching to the entry in use changes nothing and closes nothing.
	if err := set.Activate(idOf(t, set.BridgeSet, "B")); err != nil || dials["B"].closed(0) {
		t.Fatalf("re-activate: %v", err)
	}
	b1.Close()
	a1.Close()
	if err := set.Activate("ffffffffff"); err == nil {
		t.Fatal("activating an unknown id")
	}
}

// TestBridgeSetChanges: add, rename, edit and remove, each saved before it
// takes effect; the entry in use cannot be removed; an edit restarts only
// that entry's connection, a rename none.
func TestBridgeSetChanges(t *testing.T) {
	file := filepath.Join(t.TempDir(), "bridges.json")
	set := newFakeSet(t, file, nil)
	if st := set.Status(); st.State != StateNone {
		t.Fatalf("empty: %+v", st)
	}
	if _, err := set.Dial(context.Background()); !errors.Is(err, ErrNoBridge) {
		t.Fatalf("dial with none: %v", err)
	}
	a, err := set.Add(BridgeEntry{Name: " devbox ", Kind: KindSSH, Host: "dev@devbox"})
	if err != nil || a.Name != "devbox" || !validBridgeID(a.ID) {
		t.Fatalf("add: %+v %v", a, err)
	}
	b, err := set.Add(BridgeEntry{Name: "Laptop", Kind: KindLocal, Socket: "/run/b.sock"})
	if err != nil {
		t.Fatal(err)
	}
	active, list := set.List()
	if active != a.ID || len(list) != 2 || !list[0].Active || list[1].Active || list[0].Address != "dev@devbox" {
		t.Fatalf("the first added is in use: %s %+v", active, list)
	}
	waitFor(t, "B running", func() bool { f := set.fake("Laptop"); return f != nil && f.runs.Load() == 1 })
	if _, err := set.Add(BridgeEntry{Name: "LAPTOP", Kind: KindLocal, Socket: "/run/c.sock"}); err == nil || !strings.Contains(err.Error(), "exists already") {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err := set.Add(BridgeEntry{Name: "x", Kind: KindSSH, Host: "-x"}); err == nil {
		t.Fatal("bad host added")
	} else if be := (*BridgeError)(nil); !errors.As(err, &be) || be.Status != http.StatusBadRequest {
		t.Fatalf("refusal: %#v", err)
	}

	old := set.fake("Laptop")
	if _, err := set.Update(b.ID, BridgeEntry{Name: "Desk", Kind: KindLocal, Socket: "/run/b.sock"}); err != nil {
		t.Fatal(err)
	}
	if set.fake("Desk") != nil {
		t.Fatal("a rename restarted the connection")
	}
	if _, err := set.Update(b.ID, BridgeEntry{Name: "Desk", Kind: KindLocal, Socket: "/run/other.sock"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "edited entry restarted", func() bool { f := set.fake("Desk"); return f != nil && f != old && f.runs.Load() == 1 })
	if _, err := set.Update("ffffffffff", BridgeEntry{Name: "n", Kind: KindLocal, Socket: "/x.sock"}); err == nil {
		t.Fatal("update of an unknown id")
	}
	if _, err := set.Update(b.ID, BridgeEntry{Name: "devbox", Kind: KindLocal, Socket: "/x.sock"}); err == nil {
		t.Fatal("rename onto another's name")
	}

	err = set.Remove(a.ID)
	var be *BridgeError
	if !errors.As(err, &be) || be.Status != http.StatusConflict || !strings.Contains(be.Message, "in use") {
		t.Fatalf("removing the entry in use: %v", err)
	}
	if err := set.Remove(b.ID); err != nil {
		t.Fatal(err)
	}
	saved, _, err := LoadBridgeList(file)
	if err != nil || saved.Active != a.ID || len(saved.Bridges) != 1 || saved.Bridges[0].ID != a.ID {
		t.Fatalf("saved: %+v %v", saved, err)
	}
}

// TestBridgeSetAnyNumber: the list has no cap ("as many as I like"): every
// add is kept, saved, and loads again.
func TestBridgeSetAnyNumber(t *testing.T) {
	file := filepath.Join(t.TempDir(), "bridges.json")
	set := newFakeSet(t, file, nil)
	const n = 40
	for i := range n {
		if _, err := set.Add(BridgeEntry{Name: fmt.Sprintf("bridge %d", i), Kind: KindLocal, Socket: fmt.Sprintf("/run/b%d.sock", i)}); err != nil {
			t.Fatalf("add #%d: %v", i+1, err)
		}
	}
	if _, list := set.List(); len(list) != n {
		t.Fatalf("listed %d, want %d", len(list), n)
	}
	saved, ok, err := LoadBridgeList(file)
	if err != nil || !ok || len(saved.Bridges) != n {
		t.Fatalf("saved %d bridges (%v, %v), want %d", len(saved.Bridges), ok, err, n)
	}
}

// TestBridgeSetNeverStalls: an entry whose dial hangs (a host that never
// answers) holds up neither the list, nor switching, nor the other entries.
func TestBridgeSetNeverStalls(t *testing.T) {
	hang := make(chan struct{})
	t.Cleanup(func() { close(hang) })
	set := newFakeSet(t, "", func(e BridgeEntry) *fakeEntry {
		f := &fakeEntry{st: Status{State: StateUp}}
		if e.Name == "stuck" {
			f.st.State = StateConnecting
			f.dial = func(ctx context.Context) (net.Conn, error) {
				select {
				case <-hang:
				case <-ctx.Done():
				}
				return nil, errors.New("gave up")
			}
		} else {
			p := &pipeDial{}
			f.dial = p.dial
		}
		return f
	}, BridgeEntry{Name: "stuck", Kind: KindSSH, Host: "nobody@bogus.invalid"}, BridgeEntry{Name: "ok", Kind: KindLocal, Socket: "/ok.sock"})

	go func() { _, _ = set.Dial(context.Background()) }() // the game's /ws, waiting on the stuck host
	waitFor(t, "dial pending", func() bool { return set.fake("stuck").dials.Load() == 1 })
	done := make(chan error, 1)
	go func() {
		_, _ = set.List()
		_ = set.Status()
		if err := set.Activate(idOf(t, set.BridgeSet, "ok")); err != nil {
			done <- err
			return
		}
		c, err := set.Dial(context.Background())
		if err == nil {
			c.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a hanging dial held up the list, the switch or the other bridge")
	}
}

// TestBridgeSetTunnels: one ssh tunnel per ssh entry, each with its own
// local socket under the socket dir, all up at once; the one in use gets the
// traffic, a local entry is dialled directly, and an entry with no remote
// socket asks the host in its own supervisor (failing first, with backoff).
func TestBridgeSetTunnels(t *testing.T) {
	dir := shortDir(t)
	ctl := filepath.Join(dir, "ctl")
	if err := os.WriteFile(ctl, []byte("forward"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeSSHEnv, ctl)
	sockA, sockB, sockC := filepath.Join(dir, "ra", "b.sock"), filepath.Join(dir, "rb", "b.sock"), filepath.Join(dir, "rc", "b.sock")
	startBridge(t, sockA)
	startBridge(t, sockB)
	startBridge(t, sockC)
	var asked atomic.Int32
	discover := func(ctx context.Context, host string) (string, error) {
		if asked.Add(1) == 1 {
			return "", errors.New("ssh: connect to host b: Connection refused")
		}
		return sockB, nil
	}
	a := BridgeEntry{ID: NewBridgeID(), Name: "A", Kind: KindSSH, Host: "dev@a", RemoteSocket: sockA}
	b := BridgeEntry{ID: NewBridgeID(), Name: "B", Kind: KindSSH, Host: "dev@b"}
	c := BridgeEntry{ID: NewBridgeID(), Name: "C", Kind: KindLocal, Socket: sockC}
	socketDir := filepath.Join(dir, "bridges")
	set, err := NewBridgeSet(BridgeSetConfig{SSH: os.Args[0], SocketDir: socketDir, Log: quietLog(), Discover: discover}, BridgeList{Active: a.ID, Bridges: []BridgeEntry{a, b, c}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { set.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitFor(t, "every entry up", func() bool {
		_, list := set.List()
		for _, e := range list {
			if e.State != StateUp {
				return false
			}
		}
		return true
	})
	if asked.Load() != 2 {
		t.Errorf("discovery asked %d times, want a failure then the answer", asked.Load())
	}
	for _, e := range []BridgeEntry{a, b} {
		p := filepath.Join(socketDir, e.ID+".sock")
		if fi, err := os.Lstat(p); err != nil || fi.Mode().Type() != os.ModeSocket {
			t.Errorf("tunnel of %s: no socket at %s (%v)", e.Name, p, err)
		}
	}
	if entries, _ := os.ReadDir(socketDir); len(entries) != 2 {
		t.Errorf("socket dir holds %d entries, want one per ssh bridge", len(entries))
	}
	// Each tunnel's bridge answers through it: the one in use, then the others after a switch.
	for _, e := range []BridgeEntry{a, b, c} {
		if err := set.Activate(e.ID); err != nil {
			t.Fatal(err)
		}
		conn, err := set.Dial(context.Background())
		if err != nil {
			t.Fatalf("dial %s: %v", e.Name, err)
		}
		conn.Close()
	}
	cancel()
	<-done
	if entries, _ := os.ReadDir(socketDir); len(entries) != 0 {
		t.Errorf("sockets left after shutdown: %v", entries)
	}
}

// TestLocalBridgeState: up while the socket answers, down (with the error)
// while not.
func TestLocalBridgeState(t *testing.T) {
	dir := shortDir(t)
	sock := filepath.Join(dir, "b.sock")
	lb := &LocalBridge{Socket: sock, Log: quietLog(), HealthInterval: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { lb.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitFor(t, "down", func() bool { return lb.Status().State == StateDown && lb.Status().LastError != "" })
	stop := startBridge(t, sock)
	waitFor(t, "up", func() bool { return lb.Status().State == StateUp && lb.Status().Bridge != "" })
	stop()
	waitFor(t, "down again", func() bool { return lb.Status().State == StateDown })
}

// bridgesAPI is a helper server with a fake set behind /api/bridges.
func bridgesAPI(t *testing.T, set *BridgeSet) func(method, path, host, origin, token, body string) (int, map[string]any) {
	t.Helper()
	srv := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: set, Bridges: set, Bundle: writeBundle(t), Log: quietLog()})
	h := srv.Handler()
	return func(method, path, host, origin, token, body string) (int, map[string]any) {
		req, _ := http.NewRequest(method, "http://"+host+path, strings.NewReader(body))
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if token != "" {
			req.Header.Set(OpenTokenHeader, token)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
}

func TestBridgesAPIGuards(t *testing.T) {
	set := newFakeSet(t, "", nil, BridgeEntry{Name: "A", Kind: KindLocal, Socket: "/a.sock"}, BridgeEntry{Name: "B", Kind: KindLocal, Socket: "/b.sock"})
	call := bridgesAPI(t, set.BridgeSet)
	const host, origin = "127.0.0.1:7777", "http://127.0.0.1:7777"
	idB := idOf(t, set.BridgeSet, "B")
	add := `{"name":"C","kind":"local","socket":"/c.sock"}`
	routes := []struct{ method, path, body string }{
		{"GET", "/api/bridges", ""},
		{"POST", "/api/bridges", add},
		{"PUT", "/api/bridges/" + idB, `{"name":"B2","kind":"local","socket":"/b.sock"}`},
		{"POST", "/api/bridges/" + idB + "/activate", ""},
		{"DELETE", "/api/bridges/" + idB, ""},
	}
	for _, r := range routes {
		for name, tc := range map[string]struct{ host, origin, token string }{
			"wrong host":   {"evil.example:7777", origin, testToken},
			"wrong origin": {host, "http://evil.example", testToken},
			"other port":   {host, "http://127.0.0.1:8888", testToken},
			"no token":     {host, origin, ""},
			"wrong token":  {host, origin, strings.Repeat("0", len(testToken))},
		} {
			if code, _ := call(r.method, r.path, tc.host, tc.origin, tc.token, r.body); code != http.StatusForbidden {
				t.Errorf("%s %s, %s: %d, want 403", r.method, r.path, name, code)
			}
		}
		// A change needs the page's Origin; a read may come without one (a same-origin GET carries none).
		code, _ := call(r.method, r.path, host, "", testToken, r.body)
		if r.method == "GET" && code != http.StatusOK || r.method != "GET" && code != http.StatusForbidden {
			t.Errorf("%s %s without an Origin: %d", r.method, r.path, code)
		}
	}
	if _, list := set.List(); len(list) != 2 || list[1].Name != "B" || list[0].ID != set.list.Active {
		t.Fatalf("a refused request changed the list: %+v", list)
	}
	// The token never goes in a URL.
	if code, _ := call("GET", "/api/bridges?token="+testToken, host, origin, "", ""); code != http.StatusForbidden {
		t.Errorf("token in the query: %d", code)
	}
}

func TestBridgesAPICRUD(t *testing.T) {
	set := newFakeSet(t, filepath.Join(t.TempDir(), "bridges.json"), nil, BridgeEntry{Name: "A", Kind: KindLocal, Socket: "/a.sock"})
	call := bridgesAPI(t, set.BridgeSet)
	const host, origin = "127.0.0.1:7777", "http://127.0.0.1:7777"
	do := func(method, path, body string) (int, map[string]any) {
		return call(method, path, host, origin, testToken, body)
	}
	names := func(body map[string]any) (out []string) {
		for _, b := range body["bridges"].([]any) {
			m := b.(map[string]any)
			out = append(out, m["name"].(string)+":"+m["state"].(string)+":"+map[bool]string{true: "active", false: ""}[m["active"].(bool)])
		}
		return out
	}

	code, body := do("GET", "/api/bridges", "")
	if code != 200 || !slices.Equal(names(body), []string{"A:up:active"}) || body["active"] != idOf(t, set.BridgeSet, "A") {
		t.Fatalf("list: %d %v", code, body)
	}
	code, body = do("POST", "/api/bridges", `{"name":"devbox","kind":"ssh","host":"dev@devbox"}`)
	if code != 200 || !slices.Equal(names(body), []string{"A:up:active", "devbox:up:"}) {
		t.Fatalf("add: %d %v", code, body)
	}
	idD := idOf(t, set.BridgeSet, "devbox")
	for name, tc := range map[string]struct {
		method, path, body string
		code               int
		msg                string
	}{
		"bad host":      {"POST", "/api/bridges", `{"name":"x","kind":"ssh","host":"-oProxyCommand=x"}`, 400, "starts with '-'"},
		"long socket":   {"POST", "/api/bridges", `{"name":"x","kind":"local","socket":"/` + strings.Repeat("s", 200) + `"}`, 400, "unix sockets allow"},
		"unknown field": {"POST", "/api/bridges", `{"name":"x","kind":"local","socket":"/x.sock","id":"0123456789"}`, 400, "want {"},
		"unknown id":    {"PUT", "/api/bridges/ffffffffff", `{"name":"x","kind":"local","socket":"/x.sock"}`, 404, "no bridge"},
		"remove in use": {"DELETE", "/api/bridges/" + idOf(t, set.BridgeSet, "A"), "", 409, "switch to another bridge"},
		"activate none": {"POST", "/api/bridges/ffffffffff/activate", "", 404, "no bridge"},
	} {
		code, body := do(tc.method, tc.path, tc.body)
		if code != tc.code || body["t"] != "error" || !strings.Contains(body["message"].(string), tc.msg) {
			t.Errorf("%s: %d %v, want %d with %q", name, code, body, tc.code, tc.msg)
		}
	}
	if code, body = do("PUT", "/api/bridges/"+idD, `{"name":"Devbox 2","kind":"ssh","host":"dev@devbox"}`); code != 200 || !slices.Equal(names(body), []string{"A:up:active", "Devbox 2:up:"}) {
		t.Fatalf("rename: %d %v", code, body)
	}
	if code, body = do("POST", "/api/bridges/"+idD+"/activate", ""); code != 200 || !slices.Equal(names(body), []string{"A:up:", "Devbox 2:up:active"}) {
		t.Fatalf("activate: %d %v", code, body)
	}
	if code, body = do("DELETE", "/api/bridges/"+idOf(t, set.BridgeSet, "A"), ""); code != 200 || !slices.Equal(names(body), []string{"Devbox 2:up:active"}) {
		t.Fatalf("remove: %d %v", code, body)
	}
	if code, _ := do("PATCH", "/api/bridges/"+idD, `{}`); code != http.StatusMethodNotAllowed {
		t.Errorf("PATCH: %d", code)
	}
	if code, _ := do("GET", "/api/bridges/"+idD+"/activate", ""); code != http.StatusMethodNotAllowed {
		t.Errorf("GET activate: %d", code)
	}
}

// TestHealthFollowsTheSwitch: /healthz and /api/open's hosts are the entry
// in use's, and with none /healthz still names the helper's version.
func TestHealthFollowsTheSwitch(t *testing.T) {
	set := newFakeSet(t, "", func(e BridgeEntry) *fakeEntry {
		return &fakeEntry{st: Status{State: StateUp, Bridge: "v-" + e.Name, OpenHosts: []string{strings.ToLower(e.Name) + ".example.test"}}}
	}, BridgeEntry{Name: "A", Kind: KindLocal, Socket: "/a.sock"}, BridgeEntry{Name: "B", Kind: KindLocal, Socket: "/b.sock"})
	srv := NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: set, Bridges: set.BridgeSet, Bundle: writeBundle(t), Log: quietLog()})
	health := func() (int, string) {
		req, _ := http.NewRequest("GET", "http://127.0.0.1:7777/healthz", nil)
		req.Host = "127.0.0.1:7777"
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		var body struct{ Tunnel Status }
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Tunnel.Bridge
	}
	if code, v := health(); code != 200 || v != "v-A" || !srv.allowedOpenHosts()["a.example.test"] {
		t.Fatalf("A: %d %q", code, v)
	}
	if err := set.Activate(idOf(t, set.BridgeSet, "B")); err != nil {
		t.Fatal(err)
	}
	if code, v := health(); code != 200 || v != "v-B" || !srv.allowedOpenHosts()["b.example.test"] || srv.allowedOpenHosts()["a.example.test"] {
		t.Fatalf("B: %d %q", code, v)
	}
	set.fake("B").setState(StateBackoff)
	if code, _ := health(); code != http.StatusServiceUnavailable {
		t.Fatalf("B down: %d", code)
	}
	empty := newFakeSet(t, "", nil)
	srv = NewServer(ServerConfig{Port: testPort, ListenHost: "127.0.0.1", Token: testToken, Bridge: empty, Bridges: empty.BridgeSet, Bundle: writeBundle(t), Log: quietLog()})
	req, _ := http.NewRequest("GET", "http://127.0.0.1:7777/healthz", nil)
	req.Host = "127.0.0.1:7777"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	var body struct {
		Version string
		Tunnel  Status
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusServiceUnavailable || body.Version == "" || body.Tunnel.State != StateNone {
		t.Fatalf("no bridge: %d %+v", rec.Code, body)
	}
}

// TestSwitchClosesWS is the switch end to end: the game's /ws through the
// helper reaches bridge A; after the switch it is closed, and the next /ws
// reaches B.
func TestSwitchClosesWS(t *testing.T) {
	dir := shortDir(t)
	sockA, sockB := filepath.Join(dir, "a", "b.sock"), filepath.Join(dir, "b", "b.sock")
	startBridge(t, sockA)
	startBridge(t, sockB)
	a := BridgeEntry{ID: NewBridgeID(), Name: "A", Kind: KindLocal, Socket: sockA}
	b := BridgeEntry{ID: NewBridgeID(), Name: "B", Kind: KindLocal, Socket: sockB}
	set, err := NewBridgeSet(BridgeSetConfig{SocketDir: filepath.Join(dir, "tun"), Log: quietLog()}, BridgeList{Active: a.ID, Bridges: []BridgeEntry{a, b}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { set.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	ts := helperServer(t, set, nil)

	c, _, err := dialWS(ts, "127.0.0.1:7777", "http://127.0.0.1:7777", "?token="+testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	expectWorld(t, c)
	if err := set.Activate(b.ID); err != nil {
		t.Fatal(err)
	}
	rctx, rcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rcancel()
	for {
		if _, _, err := c.Read(rctx); err != nil {
			if rctx.Err() != nil {
				t.Fatal("the /ws to A stayed open after the switch")
			}
			break
		}
	}
	c2, _, err := dialWS(ts, "127.0.0.1:7777", "http://127.0.0.1:7777", "?token="+testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	expectWorld(t, c2)
	set.mu.Lock()
	onB := len(set.runs[b.ID].conns)
	set.mu.Unlock()
	if onB != 1 {
		t.Fatalf("connections through B: %d, want the new /ws", onB)
	}
}

// TestRoutesFollowTheSwitch: every route the helper proxies reaches the bridge
// in use, and right after a switch the next request reaches the new one, not
// the old one over a kept-alive connection.
func TestRoutesFollowTheSwitch(t *testing.T) {
	dir := shortDir(t)
	named := func(name string) string {
		sock := filepath.Join(dir, name+".sock")
		ln, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"bridge":"` + name + `","path":"` + r.URL.Path + `"}`))
		})}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close() })
		return sock
	}
	a := BridgeEntry{ID: NewBridgeID(), Name: "A", Kind: KindLocal, Socket: named("a")}
	b := BridgeEntry{ID: NewBridgeID(), Name: "B", Kind: KindLocal, Socket: named("b")}
	set, err := NewBridgeSet(BridgeSetConfig{SocketDir: filepath.Join(dir, "tun"), Log: quietLog()}, BridgeList{Active: a.ID, Bridges: []BridgeEntry{a, b}})
	if err != nil {
		t.Fatal(err)
	}
	ts := helperServer(t, set, nil)
	client := &http.Client{Transport: &http.Transport{}} // keeps its connections to the helper alive
	routes := []struct{ method, path string }{
		{"GET", "/logo/b1"},
		{"POST", "/upload"},
		{"POST", "/screen/frame/" + strings.Repeat("ab", 16)},
		{"GET", "/whiteboard/herdr-3d"},
		{"GET", "/drops/file"},
	}
	reach := func() []string {
		var got []string
		for _, rt := range routes {
			req, _ := http.NewRequest(rt.method, ts.URL+rt.path+"?token="+testToken, strings.NewReader("x"))
			req.Host = "127.0.0.1:7777"
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			var body struct{ Bridge string }
			_ = json.NewDecoder(resp.Body).Decode(&body)
			resp.Body.Close()
			got = append(got, body.Bridge)
		}
		return got
	}
	if got := reach(); !slices.Equal(got, []string{"a", "a", "a", "a", "a"}) {
		t.Fatalf("before the switch: %v", got)
	}
	if err := set.Activate(b.ID); err != nil {
		t.Fatal(err)
	}
	if got := reach(); !slices.Equal(got, []string{"b", "b", "b", "b", "b"}) {
		t.Fatalf("after the switch: %v", got)
	}
}
