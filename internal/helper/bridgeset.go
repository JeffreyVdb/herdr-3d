package helper

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// BridgeSet (#57) is the helper's Bridge when it knows several: it keeps one
// connection supervised per entry of the list (a Tunnel for an ssh entry, a
// LocalBridge for a local one), so the state of each is always at hand, and
// hands Dial and Status to the entry in use. Every route that reaches the
// bridge (/ws, /logo, /upload, /screen/frame, /whiteboard, /drops, /healthz and
// /api/open's open hosts) goes through it, so all of them follow a switch.
//
// A switch closes every connection dialled to the entry that was in use: the
// game's /ws (it reloads and comes back through the new entry) and the proxies'
// idle keep-alive connections, which would otherwise carry the next request to
// the old bridge.
//
// Its lock only guards the list, the runners and the connection sets: no ssh,
// dial or health check ever runs under it, so one unreachable bridge never
// holds up the others or the helper.
type BridgeSet struct {
	file      string
	ssh       string
	socketDir string
	log       *slog.Logger
	discover  func(ctx context.Context, host string) (string, error)
	// newBridge makes the supervised connection of an entry, an ssh one's
	// tunnel ending at socket (tests use fakes).
	newBridge func(e BridgeEntry, socket string) entryBridge

	mu   sync.Mutex
	list BridgeList
	runs map[string]*entryRun
	gen  uint64          // runners made so far: each ssh runner's socket is <id>-<gen>.sock
	ctx  context.Context // Run's: nil until it starts
	wg   sync.WaitGroup
}

// BridgeSetConfig configures a BridgeSet.
type BridgeSetConfig struct {
	// File is the list file: every change is saved there before it takes effect.
	File string
	SSH  string // ssh executable
	// SocketDir holds the tunnels' local ends, one per ssh entry's runner:
	// <SocketDir>/<id>-<gen>.sock.
	SocketDir string
	Log       *slog.Logger
	// Discover finds the bridge socket of an ssh entry that names none (it asks
	// the host over ssh). It runs in the entry's own supervisor, never on a request.
	Discover func(ctx context.Context, host string) (string, error)
}

// entryBridge is an entry's supervised connection: Run keeps it (and its
// Status) going until ctx is done.
type entryBridge interface {
	Bridge
	Run(ctx context.Context) error
}

// entryRun is one entry's connection and the connections dialled through it.
type entryRun struct {
	entry  BridgeEntry
	bridge entryBridge
	cancel context.CancelFunc
	conns  map[*trackedConn]struct{}
}

// BridgeError is a refused change: Code and Message for the game, Status for HTTP.
type BridgeError struct {
	Status  int
	Code    string
	Message string
}

func (e *BridgeError) Error() string { return e.Message }

func bridgeErr(status int, code, format string, args ...any) error {
	return &BridgeError{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNoBridge is what Dial says while the list is empty.
var ErrNoBridge = errors.New("no bridge configured: add one in Settings")

// ErrBridgeChanged is what Dial says when the bridge in use is not the one the
// dial was for: a page's keys and in-memory state belong to one bridge, and a
// switch made elsewhere (another tab) must not hand it another's world.
var ErrBridgeChanged = errors.New("the bridge in use changed: reload the game")

type expectKey struct{}

// expectBridge makes a dial a page's of bridge id ("none": a helper that had
// no bridge when the page started): Dial refuses it unless that is the bridge
// in use.
func expectBridge(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, expectKey{}, id)
}

// NewBridgeSet supervises list (checked, as LoadBridgeList does) once Run starts.
func NewBridgeSet(cfg BridgeSetConfig, list BridgeList) (*BridgeSet, error) {
	if err := checkList(list); err != nil {
		return nil, err
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	s := &BridgeSet{file: cfg.File, ssh: cfg.SSH, socketDir: cfg.SocketDir, log: cfg.Log, discover: cfg.Discover, list: list, runs: map[string]*entryRun{}}
	s.newBridge = s.defaultBridge
	for _, e := range list.Bridges {
		if err := s.checkSocketDir(e); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// A runner's tunnel ends at a socket of its own, <id>-<gen>.sock, never at one
// an earlier runner of the same entry used: after an address edit the old
// tunnel may still be shutting down (ssh gets KillGrace), and a shared path
// would let the new runner's dials reach the old host, or the old runner's
// cleanup unlink the new one's socket. So nothing waits for the old runner.
func (s *BridgeSet) socketPath(id, gen string) string {
	return filepath.Join(s.socketDir, id+"-"+gen+".sock")
}

// genReserve is the widest generation the length check allows for (base 36:
// two billion runners in one helper run).
const genReserve = "zzzzzz"

// socketName matches the tunnels' sockets, <id>-<gen>.sock (and <id>.sock
// from helpers before generations).
var socketName = regexp.MustCompile(`^[0-9a-f]{10}(-[0-9a-z]+)?\.sock$`)

// removeStaleSockets removes the tunnels' sockets an earlier helper run left
// (it was killed before its tunnels removed them). Run calls it before any
// runner starts.
func (s *BridgeSet) removeStaleSockets() {
	if s.socketDir == "" {
		return
	}
	entries, err := os.ReadDir(s.socketDir)
	if err != nil {
		return
	}
	for _, d := range entries {
		if d.Type() == fs.ModeSocket && socketName.MatchString(d.Name()) {
			_ = os.Remove(filepath.Join(s.socketDir, d.Name()))
		}
	}
}

// checkSocketDir: an ssh entry's local end must fit a unix socket address.
func (s *BridgeSet) checkSocketDir(e BridgeEntry) error {
	if e.Kind != KindSSH {
		return nil
	}
	if p := s.socketPath(e.ID, genReserve); len(p) > MaxSocketPath {
		return fmt.Errorf("the helper's tunnel socket %s is %d bytes, unix sockets allow %d: start the helper with a shorter -local-socket", p, len(p), MaxSocketPath)
	}
	return nil
}

func (s *BridgeSet) defaultBridge(e BridgeEntry, socket string) entryBridge {
	log := s.log.With("bridge", e.Name, "bridge_id", e.ID)
	if e.Kind == KindLocal {
		return &LocalBridge{Socket: e.Socket, Log: log}
	}
	b := &sshBridge{discover: s.discover, log: log, tun: &Tunnel{SSH: s.ssh, Host: e.Host, Remote: e.RemoteSocket, Local: socket, Log: log}}
	if e.RemoteSocket != "" {
		b.ready.Store(true)
	}
	return b
}

// run returns the entry's runner, making one (not started) if it has none. Callers hold mu.
func (s *BridgeSet) run(e BridgeEntry) *entryRun {
	r := s.runs[e.ID]
	if r == nil {
		s.gen++
		socket := s.socketPath(e.ID, strconv.FormatUint(s.gen, 36))
		r = &entryRun{entry: e, bridge: s.newBridge(e, socket), conns: map[*trackedConn]struct{}{}}
		s.runs[e.ID] = r
	}
	return r
}

// start runs r's connection. Callers hold mu and have checked s.ctx.
func (s *BridgeSet) start(r *entryRun) {
	ctx, cancel := context.WithCancel(s.ctx)
	r.cancel = cancel
	name := r.entry.Name // r.entry changes on a rename, under mu
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := r.bridge.Run(ctx); err != nil {
			s.log.Error("bridge connection stopped", "bridge", name, "err", err)
		}
	}()
}

// stop ends r's connection (in its own time) and hands back what was dialled
// through it. Callers hold mu; the connections are closed by the caller after
// unlocking.
func (r *entryRun) stop() []*trackedConn {
	if r.cancel != nil {
		r.cancel()
	}
	return r.takeConns()
}

func (r *entryRun) takeConns() []*trackedConn {
	out := make([]*trackedConn, 0, len(r.conns))
	for c := range r.conns {
		out = append(out, c)
	}
	clear(r.conns)
	return out
}

func closeAll(conns []*trackedConn) {
	for _, c := range conns {
		_ = c.Conn.Close()
	}
}

// Run supervises every entry's connection until ctx is done.
func (s *BridgeSet) Run(ctx context.Context) error {
	s.mu.Lock()
	s.ctx = ctx
	s.removeStaleSockets()
	for _, e := range s.list.Bridges {
		s.start(s.run(e))
	}
	s.mu.Unlock()
	<-ctx.Done()
	s.wg.Wait()
	return nil
}

// active is the runner in use (nil: none). Callers hold mu.
func (s *BridgeSet) active() *entryRun {
	if s.list.Active == "" {
		return nil
	}
	return s.run(s.list.Bridges[s.list.find(s.list.Active)])
}

// Dial connects to the bridge in use (for a ctx from expectBridge, only if it
// is that one). The connection is the entry's: a switch closes it.
func (s *BridgeSet) Dial(ctx context.Context) (net.Conn, error) {
	s.mu.Lock()
	if want, ok := ctx.Value(expectKey{}).(string); ok && want != cmp.Or(s.list.Active, "none") {
		s.mu.Unlock()
		return nil, ErrBridgeChanged
	}
	r := s.active()
	s.mu.Unlock()
	if r == nil {
		return nil, ErrNoBridge
	}
	c, err := r.bridge.Dial(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active() != r { // switched while dialling: it belongs to no one
		c.Close()
		return nil, ErrBridgeChanged
	}
	tc := &trackedConn{Conn: c, set: s, run: r}
	r.conns[tc] = struct{}{}
	return tc, nil
}

// Status is the state of the bridge in use; StateNone without one.
func (s *BridgeSet) Status() Status {
	s.mu.Lock()
	r := s.active()
	s.mu.Unlock()
	if r == nil {
		return Status{State: StateNone, LastError: ErrNoBridge.Error()}
	}
	return normalStatus(r.bridge.Status())
}

// normalStatus: a connection that has not started yet is connecting.
func normalStatus(st Status) Status {
	if st.State == "" {
		st.State = StateConnecting
	}
	return st
}

// BridgeInfo is an entry as GET /api/bridges lists it: what the file holds,
// whether it is in use, and its connection's state now.
type BridgeInfo struct {
	BridgeEntry
	Address   string    `json:"address"`
	Active    bool      `json:"active"`
	State     string    `json:"state"`
	Since     time.Time `json:"since,omitzero"`
	LastError string    `json:"last_error,omitempty"`
	// Version is the bridge's build version from its /healthz ("" until it answered once).
	Version string `json:"version,omitempty"`
}

// List is every entry in the order added, with its state as last seen. It
// never waits on a connection.
func (s *BridgeSet) List() (active string, out []BridgeInfo) {
	s.mu.Lock()
	active = s.list.Active
	entries := append([]BridgeEntry(nil), s.list.Bridges...)
	bridges := make([]entryBridge, len(entries))
	for i, e := range entries {
		bridges[i] = s.run(e).bridge
	}
	s.mu.Unlock()
	out = make([]BridgeInfo, 0, len(entries))
	for i, e := range entries {
		st := normalStatus(bridges[i].Status())
		out = append(out, BridgeInfo{BridgeEntry: e, Address: e.Address(), Active: e.ID == active, State: st.State, Since: st.Since, LastError: st.LastError, Version: st.Bridge})
	}
	return active, out
}

// save writes next to the file and makes it the list. Callers hold mu.
func (s *BridgeSet) save(next BridgeList) error {
	if s.file != "" {
		if err := SaveBridgeList(s.file, next); err != nil {
			s.log.Error("saving the bridge list failed", "file", s.file, "err", err)
			return bridgeErr(http.StatusInternalServerError, "save_failed", "the helper could not save its bridge list: %v", err)
		}
	}
	s.list = next
	return nil
}

func (s *BridgeSet) cloneList() BridgeList {
	return BridgeList{Active: s.list.Active, Bridges: append([]BridgeEntry(nil), s.list.Bridges...)}
}

// nameTaken: another entry than id has this name (case-insensitively). Callers hold mu.
func (s *BridgeSet) nameTaken(name, id string) bool {
	for _, e := range s.list.Bridges {
		if e.ID != id && strings.EqualFold(e.Name, name) {
			return true
		}
	}
	return false
}

func (s *BridgeSet) checkNew(e BridgeEntry, id string) (BridgeEntry, error) {
	e, err := CheckBridgeEntry(e)
	if err != nil {
		return e, bridgeErr(http.StatusBadRequest, "invalid", "%s", err)
	}
	if s.nameTaken(e.Name, id) {
		return e, bridgeErr(http.StatusBadRequest, "invalid", "a bridge named %q exists already: pick another name", e.Name)
	}
	e.ID = id
	if err := s.checkSocketDir(e); err != nil {
		return e, bridgeErr(http.StatusBadRequest, "invalid", "%s", err)
	}
	return e, nil
}

// Add appends an entry (a new id; the first one added is put in use) and
// starts its connection.
func (s *BridgeSet) Add(e BridgeEntry) (BridgeEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.checkNew(e, NewBridgeID())
	if err != nil {
		return e, err
	}
	next := s.cloneList()
	next.Bridges = append(next.Bridges, e)
	if next.Active == "" {
		next.Active = e.ID
	}
	if err := s.save(next); err != nil {
		return e, err
	}
	r := s.run(e)
	if s.ctx != nil {
		s.start(r)
	}
	s.log.Info("bridge added", "bridge", e.Name, "bridge_id", e.ID, "kind", e.Kind, "address", e.Address())
	return e, nil
}

// Update changes an entry's name, kind or address; its id stays. A new
// address replaces its connection at once (the old one stops in its own time,
// on its own socket) and drops what was dialled through the old one.
func (s *BridgeSet) Update(id string, e BridgeEntry) (BridgeEntry, error) {
	s.mu.Lock()
	i := s.list.find(id)
	if i < 0 {
		s.mu.Unlock()
		return e, bridgeErr(http.StatusNotFound, "not_found", "no bridge %s", id)
	}
	e, err := s.checkNew(e, id)
	if err != nil {
		s.mu.Unlock()
		return e, err
	}
	old := s.list.Bridges[i]
	next := s.cloneList()
	next.Bridges[i] = e
	if err := s.save(next); err != nil {
		s.mu.Unlock()
		return e, err
	}
	var drop []*trackedConn
	if r := s.runs[id]; r != nil {
		if old.sameTarget(e) {
			r.entry = e // a rename: the connection stays
		} else {
			drop = r.stop()
			delete(s.runs, id)
			nr := s.run(e)
			if s.ctx != nil {
				s.start(nr)
			}
		}
	}
	s.mu.Unlock()
	closeAll(drop)
	s.log.Info("bridge changed", "bridge", e.Name, "bridge_id", id, "kind", e.Kind, "address", e.Address())
	return e, nil
}

// Remove takes an entry out and stops its connection. The entry in use cannot
// be removed: switch to another first.
func (s *BridgeSet) Remove(id string) error {
	s.mu.Lock()
	i := s.list.find(id)
	if i < 0 {
		s.mu.Unlock()
		return bridgeErr(http.StatusNotFound, "not_found", "no bridge %s", id)
	}
	e := s.list.Bridges[i]
	if id == s.list.Active {
		s.mu.Unlock()
		return bridgeErr(http.StatusConflict, "in_use", "%s is the bridge in use: switch to another bridge before removing it", e.Name)
	}
	next := s.cloneList()
	next.Bridges = append(next.Bridges[:i], next.Bridges[i+1:]...)
	if err := s.save(next); err != nil {
		s.mu.Unlock()
		return err
	}
	var drop []*trackedConn
	if r := s.runs[id]; r != nil {
		drop = r.stop()
		delete(s.runs, id)
	}
	s.mu.Unlock()
	closeAll(drop)
	s.log.Info("bridge removed", "bridge", e.Name, "bridge_id", id)
	return nil
}

// Activate puts entry id in use and closes every connection dialled to the
// one in use before. It never waits on a connection: an entry that is not up
// is switched to all the same (the game asks first).
func (s *BridgeSet) Activate(id string) error {
	s.mu.Lock()
	i := s.list.find(id)
	if i < 0 {
		s.mu.Unlock()
		return bridgeErr(http.StatusNotFound, "not_found", "no bridge %s", id)
	}
	if id == s.list.Active {
		s.mu.Unlock()
		return nil
	}
	prev := s.active()
	to := s.list.Bridges[i].Name
	next := s.cloneList()
	next.Active = id
	if err := s.save(next); err != nil {
		s.mu.Unlock()
		return err
	}
	var drop []*trackedConn
	from := ""
	if prev != nil {
		drop = prev.takeConns()
		from = prev.entry.Name
	}
	s.mu.Unlock()
	closeAll(drop)
	s.log.Info("bridge switched", "from", from, "to", to, "closed", len(drop))
	return nil
}

// trackedConn is a connection dialled through an entry: closing it takes it
// out of the entry's set.
type trackedConn struct {
	net.Conn
	set    *BridgeSet
	run    *entryRun
	closed atomic.Bool
}

func (c *trackedConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		c.set.mu.Lock()
		delete(c.run.conns, c)
		c.set.mu.Unlock()
	}
	return c.Conn.Close()
}

// sshBridge is an ssh entry: its Tunnel, after asking the host for its bridge
// socket when the entry names none (with the tunnel's backoff while it can't).
type sshBridge struct {
	tun      *Tunnel
	discover func(ctx context.Context, host string) (string, error)
	log      *slog.Logger
	ready    atomic.Bool // tun.Remote is known: the tunnel's Status is the state
	pre      health      // the state while asking
}

func (b *sshBridge) Dial(ctx context.Context) (net.Conn, error) { return b.tun.Dial(ctx) }

func (b *sshBridge) Status() Status {
	if b.ready.Load() {
		return b.tun.Status()
	}
	return b.pre.Status()
}

func (b *sshBridge) Run(ctx context.Context) error {
	if !b.ready.Load() {
		if b.discover == nil {
			b.pre.set(StateStopped, errors.New("no remote socket: set one for this bridge"), 0)
			return nil
		}
		backoff := DefaultBackoff
		for attempt := 0; ; attempt++ {
			b.pre.set(StateConnecting, nil, 0)
			remote, err := b.discover(ctx, b.tun.Host)
			if ctx.Err() != nil {
				return nil
			}
			if err == nil {
				b.log.Info("bridge socket discovered on the host", "host", b.tun.Host, "socket", remote)
				b.tun.Remote = remote
				break
			}
			b.pre.restarted()
			b.pre.set(StateBackoff, err, 0)
			d := backoff.Delay(attempt, 0.5)
			b.log.Warn("asking the host for its bridge socket failed", "err", err, "retry_in", d)
			if sleep(ctx, d) != nil {
				return nil
			}
		}
		b.ready.Store(true)
	}
	return b.tun.Run(ctx)
}
