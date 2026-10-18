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
