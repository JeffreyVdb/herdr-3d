package limits

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #138: one Codex reading per visible profile, each with its own CODEX_HOME.

// fakeLister is a Codex profile list the test changes.
type fakeLister struct {
	mu    sync.Mutex
	list  []codexaccount.Account
	calls atomic.Int32
}

func (f *fakeLister) Accounts(context.Context) ([]codexaccount.Account, error) {
	f.calls.Add(1)
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.list), nil
}

func (f *fakeLister) set(list ...codexaccount.Account) {
	f.mu.Lock()
	f.list = list
	f.mu.Unlock()
}

func profile(key, home string, def bool) codexaccount.Account {
	return codexaccount.Account{Key: key, Name: key, Home: home, Default: def, Exists: true, SignedIn: true}
}

// codexHomeOf is the CODEX_HOME a probe got, and how many it got.
func codexHomeOf(env []string) (string, int) {
	var home string
	n := 0
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "CODEX_HOME="); ok {
			home, n = v, n+1
		}
	}
	return home, n
}

// byHome answers each Codex probe with the script of its CODEX_HOME (none:
// the CLI is not there); Claude is not there.
type byHome struct {
	mu      sync.Mutex
	scripts map[string]script
	homes   []string
	envs    [][]string
	running atomic.Int32
	overlap atomic.Bool
}

func (b *byHome) Start(c Cmd) (Process, error) {
	if c.Path != "codex" {
		return nil, os.ErrNotExist
	}
	home, _ := codexHomeOf(c.Env)
	b.mu.Lock()
	b.homes = append(b.homes, home)
	b.envs = append(b.envs, c.Env)
	sc, ok := b.scripts[home]
	b.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	if b.running.Add(1) > 1 {
		b.overlap.Store(true)
	}
	return newRunner(map[string]script{"codex": func(p *fakeProc) {
		defer b.running.Add(-1)
		sc(p)
	}}).Start(c)
}

func (b *byHome) probed() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.homes)
}

// failing plays an app-server whose read fails.
func failing(p *fakeProc) {
	sc := p.reader()
	for sc.Scan() {
		if strings.Contains(sc.Text(), `"id":1`) {
			p.say(`{"id":1,"result":{}}`)
		}
		if strings.Contains(sc.Text(), `"id":2`) {
			p.say(`{"id":2,"error":{"code":-32603,"message":"not logged in"}}`)
		}
	}
}

func profilesCfg(t *testing.T, b *byHome, f *fakeLister) Config {
	c, _ := newCfg(t, nil)
	c.Runner = b
	c.Accounts = f
	c.Env = func() []string { return []string{"PATH=/bin", "CODEX_HOME=/inherited", "HERDR_X=1"} }
	return c
}

func codexReadings(ls []proto.Limits) map[string]proto.Limits {
	out := map[string]proto.Limits{}
	for _, l := range ls {
		if l.Provider == proto.LimitsCodex && l.Account != nil {
			out[l.Account.Key] = l
		}
	}
	return out
}

func TestOnlyTheDefaultProfile(t *testing.T) {
	b := &byHome{scripts: map[string]script{"/h/.codex": codexAnswers(t, fixture(t, "codex_primary.json"))}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true))
	got := New(profilesCfg(t, b, f)).step(context.Background(), t0)
	if len(got) != 2 || got[0].Provider != proto.LimitsClaude || got[1].Provider != proto.LimitsCodex {
		t.Fatalf("got %+v", got)
	}
	want := proto.LimitsAccount{Key: "codex", Name: "codex", Plan: "prolite", Default: true}
	if a := got[1].Account; a == nil || *a != want || got[1].Error != "" || len(got[1].Windows) != 1 {
		t.Fatalf("codex %+v account %+v", got[1], a)
	}
	if !slices.Equal(b.probed(), []string{"/h/.codex"}) {
		t.Fatalf("probed %v", b.probed())
	}
}

// Two homes are each read with their own CODEX_HOME (the inherited one
// replaced, not added to), one after the other, into readings of their own.
func TestTwoProfilesAreReadApart(t *testing.T) {
	b := &byHome{scripts: map[string]script{
		"/h/.codex":      codexAnswers(t, fixture(t, "codex_primary.json")),
		"/h/.codex-work": codexAnswers(t, fixture(t, "codex_two.json")),
	}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	got := New(profilesCfg(t, b, f)).step(context.Background(), t0)
	if len(got) != 3 {
		t.Fatalf("%d readings: %+v", len(got), got)
	}
	r := codexReadings(got)
	if r["codex"].Plan != "prolite" || r["work"].Plan != "pro" || r["work"].Account.Plan != "pro" || r["work"].Account.Default || !r["codex"].Account.Default {
		t.Fatalf("readings %+v", r)
	}
	if got[1].Account.Key != "codex" || got[2].Account.Key != "work" {
		t.Errorf("order: %s, %s", got[1].Account.Key, got[2].Account.Key)
	}
	if !slices.Equal(b.probed(), []string{"/h/.codex", "/h/.codex-work"}) {
		t.Fatalf("probed %v", b.probed())
	}
	for _, env := range b.envs {
		if _, n := codexHomeOf(env); n != 1 || slices.Contains(env, "CODEX_HOME=/inherited") || slices.Contains(env, "HERDR_X=1") {
			t.Errorf("env %v", env)
		}
	}
	if b.overlap.Load() {
		t.Error("two Codex probes ran at the same time")
	}
}

// A probe that fails for one profile leaves the other's reading alone; a
// home without an auth.json that does not answer is not signed in.
func TestOneProfileFailing(t *testing.T) {
	b := &byHome{scripts: map[string]script{
		"/h/.codex":       codexAnswers(t, fixture(t, "codex_primary.json")),
		"/h/.codex-work":  failing,
		"/h/signed-out":   failing,
		"/h/not-answered": func(p *fakeProc) { p.hang() },
	}}
	f := &fakeLister{}
	out := profile("out", "/h/signed-out", false)
	out.SignedIn, out.Added = false, true
	slow := profile("slow", "/h/not-answered", false)
	slow.SignedIn = false
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false), out, slow)
	r := codexReadings(New(profilesCfg(t, b, f)).step(context.Background(), t0))
	if c := r["codex"]; c.Error != "" || c.Stale || len(c.Windows) != 1 {
		t.Errorf("codex %+v", c)
	}
	if w := r["work"]; w.Error != proto.LimitsFailed || !w.Stale || w.Account.Name != "work" {
		t.Errorf("work %+v", w)
	}
	if o := r["out"]; o.Error != proto.LimitsNoPlan || o.Stale || o.At == 0 {
		t.Errorf("signed out %+v", o)
	}
	if s := r["slow"]; s.Error != proto.LimitsTimeout {
		t.Errorf("timed out %+v", s)
	}
}

// Hidden profiles and added folders that are gone are not read; the
// default's home that is not there is read in the environment as it is.
func TestHiddenAndMissingProfilesAreNotRead(t *testing.T) {
	b := &byHome{scripts: map[string]script{"/inherited": codexAnswers(t, fixture(t, "codex_primary.json"))}}
	f := &fakeLister{}
	def := profile("codex", "/h/.codex", true)
	def.Exists, def.SignedIn = false, false
	hidden := profile("work", "/h/.codex-work", false)
	hidden.Hidden = true
	gone := profile("gone", "/h/gone", false)
	gone.Exists, gone.Added = false, true
	f.set(def, hidden, gone)
	got := New(profilesCfg(t, b, f)).step(context.Background(), t0)
	if len(got) != 2 || got[1].Account == nil || got[1].Account.Key != "codex" || got[1].Error != "" {
		t.Fatalf("got %+v", got)
	}
	if !slices.Equal(b.probed(), []string{"/inherited"}) {
		t.Fatalf("probed %v", b.probed())
	}
}

// The transcript fallback of a profile reads its own sessions; the
// default's reads the configured directory.
func TestTranscriptFallbackPerProfile(t *testing.T) {
	home := t.TempDir()
	copyTree(t, "testdata/codex-sessions", filepath.Join(home, ".codex-work", "sessions"))
	b := &byHome{scripts: map[string]script{}} // the CLI is not there for anyone
	f := &fakeLister{}
	f.set(profile("codex", filepath.Join(home, ".codex"), true), profile("work", filepath.Join(home, ".codex-work"), false))
	c := profilesCfg(t, b, f)
	c.CodexSessions = filepath.Join(home, "configured")
	r := codexReadings(New(c).step(context.Background(), t0))
	if w := r["work"]; w.Source != proto.LimitsTranscript || w.Error != proto.LimitsNotInstalled || len(w.Windows) == 0 || w.Account.Key != "work" {
		t.Errorf("work %+v", w)
	}
	if d := r["codex"]; d.Source == proto.LimitsTranscript || len(d.Windows) != 0 {
		t.Errorf("the default read another profile's rollouts: %+v", d)
	}
	c.CodexSessions = filepath.Join(home, ".codex-work", "sessions")
	r = codexReadings(New(c).step(context.Background(), t0))
	if d := r["codex"]; d.Source != proto.LimitsTranscript {
		t.Errorf("the default did not read the configured directory: %+v", d)
	}
}

// The profiles are listed again every Interval and on a refresh: a new one
// is read at once, one hidden since is dropped (and not read again).
func TestProfilesAreListedAgain(t *testing.T) {
	b := &byHome{scripts: map[string]script{
		"/h/.codex":      codexAnswers(t, fixture(t, "codex_primary.json")),
		"/h/.codex-work": codexAnswers(t, fixture(t, "codex_two.json")),
	}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true))
	c := profilesCfg(t, b, f)
	now := t0
	c.Now = func() time.Time { return now }
	p := New(c)
	var lists [][]codexaccount.Account
	step := func(d time.Duration) []proto.Limits {
		now = now.Add(d)
		var mu sync.Mutex
		var got []proto.Limits
		p.poll(context.Background(), now, func() bool { return true }, func(_ int, l proto.Limits) { mu.Lock(); got = append(got, l); mu.Unlock() },
			func(l []codexaccount.Account) { lists = append(lists, l) })
		return got
	}
	step(0)
	if len(lists) != 1 || f.calls.Load() != 1 {
		t.Fatalf("lists %v, %d calls", lists, f.calls.Load())
	}
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	if got := step(time.Second); len(got) != 0 || f.calls.Load() != 1 {
		t.Fatalf("listed or read again a second later: %+v (%d lists)", got, f.calls.Load())
	}
	if !p.Refresh() {
		t.Fatal("refresh refused")
	}
	got := codexReadings(step(0))
	if len(got) != 2 || got["work"].Plan != "pro" || len(lists) != 2 || len(lists[1]) != 2 {
		t.Fatalf("after the refresh: %+v, lists %d", got, len(lists))
	}
	hidden := profile("work", "/h/.codex-work", false)
	hidden.Hidden = true
	f.set(profile("codex", "/h/.codex", true), hidden)
	got = codexReadings(step(2*time.Minute + time.Second)) // the Interval: both listed and read again
	if _, ok := got["work"]; ok || len(got) != 1 || len(lists) != 3 {
		t.Fatalf("after hiding: %+v, lists %d", got, len(lists))
	}
	if _, ok := p.state["codex/work"]; ok {
		t.Error("a hidden profile kept its state")
	}
	// Shown again through Relist (its setting changed): read at the next poll.
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	p.Relist()
	if got := codexReadings(step(time.Second)); len(got) != 1 || got["work"].Plan != "pro" {
		t.Fatalf("after Relist: %+v", got)
	}
}

// A rename is in the next reading's account, the key stays.
func TestRenamedProfileKeepsItsKey(t *testing.T) {
	b := &byHome{scripts: map[string]script{"/h/.codex-work": failing, "/h/.codex": codexAnswers(t, fixture(t, "codex_primary.json"))}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	p := New(profilesCfg(t, b, f))
	p.step(context.Background(), t0)
	renamed := profile("work", "/h/.codex-work", false)
	renamed.Name = "Work seat"
	f.set(profile("codex", "/h/.codex", true), renamed)
	p.Relist()
	p.Refresh()
	if w := codexReadings(p.step(context.Background(), t0)); w["work"].Account == nil || w["work"].Account.Name != "Work seat" {
		t.Fatalf("got %+v", w)
	}
}

// With no client nothing is probed and the profiles are not listed.
func TestRunListsNothingWithoutAClient(t *testing.T) {
	b := &byHome{scripts: map[string]script{"/h/.codex": codexAnswers(t, fixture(t, "codex_primary.json"))}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true))
	c := profilesCfg(t, b, f)
	c.Tick = 5 * time.Millisecond
	p := New(c)
	var on atomic.Bool
	got := make(chan proto.Limits, 8)
	lists := make(chan []codexaccount.Account, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Run(ctx, on.Load, func(l proto.Limits) { got <- l }, func(l []codexaccount.Account) { lists <- l })
	p.Relist()
	time.Sleep(60 * time.Millisecond)
	if f.calls.Load() != 0 || len(b.probed()) != 0 {
		t.Fatalf("with no client: %d lists, probed %v", f.calls.Load(), b.probed())
	}
	on.Store(true)
	select {
	case l := <-lists:
		if len(l) != 1 {
			t.Fatalf("list %+v", l)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no list after a client came")
	}
	for {
		select {
		case l := <-got:
			if l.Provider == proto.LimitsCodex {
				if l.Account == nil || l.Account.Key != "codex" {
					t.Fatalf("got %+v", l)
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no Codex reading after a client came")
		}
	}
}

// R2 of the #138 review: the profiles read one after the other stop when
// the last client goes, and the ones not read stay due for the next.
func TestProfilesQueuedWhenTheClientGoesWait(t *testing.T) {
	var on atomic.Bool
	on.Store(true)
	started, release := make(chan struct{}), make(chan struct{})
	b := &byHome{scripts: map[string]script{
		"/h/.codex":      func(p *fakeProc) { close(started); <-release; failing(p) },
		"/h/.codex-work": failing,
	}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	c := profilesCfg(t, b, f)
	c.Now = time.Now
	c.Tick = 10 * time.Millisecond
	c.Timeout, c.Grace = 30*time.Second, 10*time.Second // a read in a poll holds the others off that long
	p := New(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan proto.Limits, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Run(ctx, on.Load, func(l proto.Limits) { got <- l }, nil)
	}()
	defer func() { cancel(); <-done }()
	<-started
	on.Store(false)
	close(release)
	deadline := time.After(300 * time.Millisecond)
wait:
	for {
		select {
		case l := <-got:
			if l.Account != nil && l.Account.Key == "work" {
				t.Fatalf("work read with no client: probed %v", b.probed())
			}
		case <-deadline:
			break wait
		}
	}
	if h := b.probed(); !slices.Equal(h, []string{"/h/.codex"}) {
		t.Fatalf("probed %v with no client", h)
	}
	on.Store(true)
	for {
		select {
		case l := <-got:
			if l.Account != nil && l.Account.Key == "work" {
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("work not read when a client came back: probed %v", b.probed())
		}
	}
}

// blockingLister holds its first list after taking the settings it lists
// from, as codexaccount.Service does before it looks at the folders.
type blockingLister struct {
	fakeLister
	started, release chan struct{}
	once             sync.Once
}

func (f *blockingLister) Accounts(ctx context.Context) ([]codexaccount.Account, error) {
	list, err := f.fakeLister.Accounts(ctx)
	f.once.Do(func() { close(f.started); <-f.release })
	return list, err
}

// R3 of the #138 review: a Relist asked for while the profiles are being
// listed (the settings changed after that list read them) lists them again
// at the next poll.
func TestRelistDuringListingIsKept(t *testing.T) {
	f := &blockingLister{started: make(chan struct{}), release: make(chan struct{})}
	f.set(profile("codex", "/h/.codex", true), profile("work", "/h/.codex-work", false))
	c, _ := newCfg(t, nil)
	c.Accounts = f
	p := New(c)
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.listAccounts(context.Background(), t0)
	}()
	<-f.started
	hidden := profile("work", "/h/.codex-work", false)
	hidden.Hidden = true
	f.set(profile("codex", "/h/.codex", true), hidden)
	p.Relist()
	close(f.release)
	<-done
	list, changed := p.listAccounts(context.Background(), t0.Add(time.Second))
	if n := f.calls.Load(); n != 2 || !changed || !list[1].Hidden {
		t.Fatalf("the Relist was lost: %d lists, changed %v, %+v", n, changed, list)
	}
	if _, changed := p.listAccounts(context.Background(), t0.Add(2*time.Second)); changed || f.calls.Load() != 2 {
		t.Fatalf("listed again with nothing asked: %d lists", f.calls.Load())
	}
}

// A key that names another folder in a later list does not carry the
// state (last reading, failures) of the folder it named before.
func TestKeyOnAnotherHomeStartsAfresh(t *testing.T) {
	b := &byHome{scripts: map[string]script{
		"/h/.codex":   codexAnswers(t, fixture(t, "codex_primary.json")),
		"/h/.codex-a": codexAnswers(t, fixture(t, "codex_two.json")),
		"/h/.codex-b": failing,
	}}
	f := &fakeLister{}
	f.set(profile("codex", "/h/.codex", true), profile("a", "/h/.codex-a", false))
	p := New(profilesCfg(t, b, f))
	if got := codexReadings(p.step(context.Background(), t0)); got["a"].Plan != "pro" {
		t.Fatalf("got %+v", got)
	}
	f.set(profile("codex", "/h/.codex", true), profile("a", "/h/.codex-b", false))
	p.Relist()
	got := codexReadings(p.step(context.Background(), t0.Add(time.Second)))
	if a, ok := got["a"]; !ok || a.Plan == "pro" || a.Error == "" {
		t.Fatalf("the other folder's reading carried over: %+v", got)
	}
}
