package server

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// The scan takes a text whole or refuses it: never cut, never not UTF-8
// (JSON cannot carry that, so it is checked here).
func TestScannable(t *testing.T) {
	var bad *badArgsError
	for _, text := range []string{"\xff\xfe", string(make([]byte, herdr.MaxPrompt+1))} {
		if err := scannable(text, "text"); !errors.As(err, &bad) {
			t.Errorf("%d bytes: %v", len(text), err)
		}
	}
	if err := scannable("é🙂", "text"); err != nil {
		t.Fatal(err)
	}
}

// A scan past its timeout fails with no review, and what it still writes in
// its slot is never read (run with -race).
func TestScanSecretsTimeout(t *testing.T) {
	h := &Hub{opts: Options{SecretScanTimeout: time.Millisecond}}
	h.ps.slots = make(chan struct{}, maxSecretScans)
	rev := promptsecret.NewReviewer([]byte(strings.Repeat("k", 32)), nil)
	r, err := h.scanSecrets(context.Background(), rev, strings.Repeat("a ", 8000)+"PASSWORD=Value77!")
	h.wg.Wait()
	if !errors.Is(err, errSecretsUnavailable) || r.Revision != "" || r.Found != nil {
		t.Fatalf("%+v %v", r, err)
	}
}

// pausedRead holds the janitor's read of the open workers once its query
// holds the store's one connection, until resume: review S2's window.
type pausedRead struct {
	context.Context
	once            sync.Once
	entered, resume chan struct{}
}

func (c *pausedRead) Done() <-chan struct{} {
	if b := stacks(false); strings.Contains(b, "store.(*Store).OpenWorkers") && strings.Contains(b, "database/sql.(*Rows).initContextClose") {
		c.once.Do(func() { close(c.entered); <-c.resume })
	}
	return c.Context.Done()
}

func stacks(all bool) string {
	b := make([]byte, 1<<20)
	return string(b[:runtime.Stack(b, all)])
}

// A worker that starts while the janitor reads which workers are live, and
// whose prompt's file is written then, keeps it (review S2: the sweep
// judged the new owner by the read before it, and removed a live worker's
// file).
func TestSweepSecretsKeepsANewWorkersFile(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	h, err := NewHub(ctx, st, Options{Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	go func() { h.Run(ctx); close(stopped) }()
	defer func() { cancel(); <-stopped }()
	f, err := secretfiles.Open(secretfiles.Options{Dir: filepath.Join(t.TempDir(), "secrets"), Store: st})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.doWait(ctx, func() { h.ps.files = f }); err != nil {
		t.Fatal(err)
	}
	read := &pausedRead{Context: ctx, entered: make(chan struct{}), resume: make(chan struct{})}
	swept := make(chan struct{})
	go func() { h.sweepSecrets(read); close(swept) }()
	select {
	case <-read.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the janitor never read the open workers")
	}
	const id = "new-worker"
	if err := h.doWait(ctx, func() { h.workers[id] = &proto.Worker{ID: id} }); err != nil {
		t.Fatal(err)
	}
	saved := make(chan error, 1)
	go func() { saved <- st.SaveWorker(ctx, store.Worker{ID: id, Session: "s", WorkspaceID: "w"}) }()
	written := make(chan []secretfiles.File, 1)
	go func() {
		files, err := f.Write(ctx, secretfiles.Worker(id), time.Time{}, [][]byte{[]byte("live")})
		if err != nil {
			t.Error(err)
		}
		written <- files
	}()
	// The write waits: for the store's connection while it holds the files'
	// lock (the sweep then goes after it), or for that lock (the sweep holds
	// it while it reads).
	waits := func() bool {
		for _, g := range strings.Split(stacks(true), "\n\n") {
			if strings.Contains(g, "secretfiles.(*Files).Write") &&
				(strings.Contains(g, "database/sql.(*DB).conn") || strings.Contains(g, "Mutex).Lock")) {
				return true
			}
		}
		return false
	}
	for deadline := time.Now().Add(10 * time.Second); !waits(); time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			close(read.resume)
			t.Fatal("the write never waited")
		}
	}
	close(read.resume)
	files := <-written
	if err := <-saved; err != nil {
		t.Fatal(err)
	}
	<-swept
	if len(files) != 1 || !f.Exists(files) {
		t.Fatalf("the janitor removed a live worker's file: %+v", files)
	}
}

// steerWatch is a shared Codex worker's join that keeps what is steered
// into its turn.
type steerWatch struct {
	CodexWatch
	texts []string
}

func (w *steerWatch) Steer(_ context.Context, turn, text, _ string) (string, error) {
	w.texts = append(w.texts, text)
	return turn, nil
}

// A reviewed prompt to a shared Codex worker blocked only by an async
// question goes through its app-server after one more hub step: a switch
// change while it waits for that step sends nothing of it, unsent (review
// R2P3-1: its review was checked only before it). The hub's steps are run
// by hand.
func TestPromptSecretsPromptViaServerSwitchWhileItWaits(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rev := promptsecret.NewReviewer(make([]byte, 32), nil)
	h := &Hub{ops: make(chan func(context.Context)), done: make(chan struct{}),
		workers: map[string]*proto.Worker{"w": {ID: "w", AgentKind: "codex", Status: statusBlocked}}}
	h.ps.rev = rev
	h.ps.cur.Store(rev)
	q := codexapp.NewQuestions("thread")
	q.Observe("turn", codexapp.Item{Type: codexapp.ItemAgentMessage, ID: "call_3", Delivery: codexapp.DeliveryAsync,
		Questions: []codexapp.AsyncQuestion{{Title: "Any context?"}}}, codexapp.OriginLive)
	watch := &steerWatch{}
	h.cx.launches = map[string]store.CodexLaunch{"w": {Mode: store.CodexShared, Thread: "thread"}}
	h.cx.watches = map[string]*codexWatch{"w": {w: watch, attached: true, thread: "thread", turn: "turn"}}
	h.cx.questions = map[string]*codexapp.Questions{"w": q}
	// prompt sends text, running its two hub steps (its state, then the
	// async block), and between them runs between.
	prompt := func(text string, between func()) (any, error) {
		type sent struct {
			res any
			err error
		}
		done := make(chan sent, 1)
		go func() {
			res, err := h.prompt(ctx, proto.WorkerPromptArgs{ID: "w", Text: text}, "s", "pane", rev)
			done <- sent{res, err}
		}()
		for _, before := range []func(){func() {}, between} {
			select {
			case op := <-h.ops:
				before()
				op(ctx)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		select {
		case s := <-done:
			return s.res, s.err
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return nil, nil
		}
	}
	res, err := prompt("first task", func() {})
	if pr, _ := res.(proto.PromptResult); err != nil || !pr.Queued || pr.Via != viaAppServer || !slices.Equal(watch.texts, []string{"first task"}) {
		t.Fatalf("the switch unchanged: %+v %v %q", res, err, watch.texts)
	}
	_, err = prompt("reviewed task [secret in file /private/owner/secret]", h.setReviewer)
	if !errors.Is(err, errSecretsReviewStale) || !notSent(err) || len(watch.texts) != 1 {
		t.Fatalf("the switch changed while it waited: %v (unsent %v) %q", err, notSent(err), watch.texts)
	}
}

// askTerm is a terminal that keeps what a dialog's driver sends it.
type askTerm struct {
	TermHerdr
	sent []string
}

func (a *askTerm) SendText(_ context.Context, _, _, text string) error {
	a.sent = append(a.sent, "text "+text)
	return nil
}

func (a *askTerm) SendKeys(_ context.Context, _, _ string, keys ...string) error {
	a.sent = append(a.sent, "keys "+strings.Join(keys, " "))
	return nil
}

// askHub is a running hub with worker w asking toolu_ask in pane p, its
// files in f, and a reviewer made current.
func askHub(t *testing.T) (*Hub, *secretfiles.Files, *askTerm, *promptsecret.Reviewer) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	base := t.TempDir()
	st, err := store.Open(ctx, filepath.Join(base, "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f, err := secretfiles.Open(secretfiles.Options{Dir: filepath.Join(base, "secrets"), Store: st})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	term := &askTerm{}
	h := &Hub{opts: Options{Term: term}, ops: make(chan func(context.Context)), done: make(chan struct{}),
		workers: map[string]*proto.Worker{"w": {ID: "w", PaneID: "p", Ask: &proto.Ask{ToolUseID: "toolu_ask"}}}}
	h.ps.files = f
	rev := promptsecret.NewReviewer(make([]byte, 32), f.IsFilePath)
	h.ps.cur.Store(rev)
	go func() {
		for {
			select {
			case op := <-h.ops:
				op(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
	return h, f, term, rev
}

// revokedRef is a reference to a file of worker id, revoked.
func revokedRef(t *testing.T, f *secretfiles.Files, id string) string {
	t.Helper()
	ctx := context.Background()
	files, err := f.Write(ctx, secretfiles.Worker(id), time.Time{}, [][]byte{[]byte("credential")})
	if err != nil {
		t.Fatal(err)
	}
	all := func(context.Context) (func(string) bool, error) { return func(string) bool { return true }, nil }
	if _, err := f.Revoke(ctx, id, all); err != nil {
		t.Fatal(err)
	}
	return promptsecret.Reference(files[0].Path)
}

// #108 round 5 (review L3): each text a worker.answer_ask types is checked
// for revoked files right before its first byte, the answers' review or
// not (the switch's check is the first text's only: round 2).
func TestAskDriverChecksEveryTextForRevokedFiles(t *testing.T) {
	ctx := context.Background()
	h, f, term, rev := askHub(t)
	ref := revokedRef(t, f, "v")
	if err := h.reviewHolds(rev, ref); !errors.Is(err, errSecretsReviewStale) {
		t.Fatalf("a first text naming a revoked file: %v", err)
	}
	d := &askDriver{h: h, ctx: ctx, id: "w", toolUseID: "toolu_ask", pane: "p", rev: rev}
	if err := d.typeText("a clean first answer"); err != nil {
		t.Fatal(err)
	}
	if err := d.typeText("then " + ref); !errors.Is(err, errSecretsReviewStale) {
		t.Fatalf("the second text: %v; sent %q", err, term.sent)
	}
	// Unreviewed (the switch off): checked all the same.
	d = &askDriver{h: h, ctx: ctx, id: "w", toolUseID: "toolu_ask", pane: "p"}
	if err := d.typeText(ref); !errors.Is(err, errSecretsReviewStale) {
		t.Fatalf("unreviewed: %v; sent %q", err, term.sent)
	}
	if !slices.Equal(term.sent, []string{"text a clean first answer"}) {
		t.Fatalf("sent %q", term.sent)
	}
}

// Every text of a worker.answer_ask is checked for revoked files before
// the dialog's first key (review L3): a revoke that came before the
// command touches nothing of the dialog, though the text naming the file
// is the last to be typed.
func TestAskDriverChecksEveryTextBeforeItsFirstKey(t *testing.T) {
	ctx := context.Background()
	h, f, term, rev := askHub(t)
	ref := revokedRef(t, f, "v")
	d := &askDriver{h: h, ctx: ctx, id: "w", toolUseID: "toolu_ask", pane: "p", rev: rev, texts: []string{"first", "then " + ref}}
	if err := d.press("2"); !errors.Is(err, errSecretsReviewStale) {
		t.Fatalf("the first key: %v", err)
	}
	if err := d.typeText("first"); !errors.Is(err, errSecretsReviewStale) {
		t.Fatalf("the first text: %v", err)
	}
	if len(term.sent) != 0 {
		t.Fatalf("sent %q", term.sent)
	}
	d = &askDriver{h: h, ctx: ctx, id: "w", toolUseID: "toolu_ask", pane: "p", rev: rev, texts: []string{"first", "second"}}
	if err := d.press("2"); err != nil {
		t.Fatal(err)
	}
	if err := d.typeText("first"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(term.sent, []string{"keys 2", "text first"}) {
		t.Fatalf("sent %q", term.sent)
	}
}
