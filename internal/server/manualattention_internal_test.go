package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/manual/inputwatch"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// attentionHub is a hub that is not running: the test is its goroutine.
type attentionHub struct {
	t   *testing.T
	h   *Hub
	st  *store.Store
	db  string
	now time.Time
}

func newAttentionHub(t *testing.T, db string, ids ...string) *attentionHub {
	t.Helper()
	ctx := context.Background()
	if db == "" {
		db = filepath.Join(t.TempDir(), "world.db")
	}
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	a := &attentionHub{t: t, st: st, db: db, now: time.UnixMilli(1_800_000_000_000)}
	h, err := NewHub(ctx, st, Options{Now: func() time.Time { return a.now }, ManualInputProc: noProc{}})
	if err != nil {
		t.Fatal(err)
	}
	a.h = h
	for _, id := range ids {
		p := proto.ManualProcess{ID: id, Op: id, Worker: "w", State: "running", Command: "fixture"}
		if _, _, err := st.CreateManualProcess(ctx, manualToStore(p)); err != nil {
			t.Fatal(err)
		}
		if err := h.saveManual(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	return a
}

// noProc sees no process at all.
type noProc struct{ inputwatch.Proc }

func (noProc) Stat(int) (string, error) { return "", context.Canceled }

// sample applies one observation per run (absent: not observed).
func (a *attentionHub) sample(obs map[string]inputwatch.Observation) {
	a.t.Helper()
	var ids []string
	for id := range a.h.manualProcesses {
		ids = append(ids, id)
	}
	a.now = a.now.Add(500 * time.Millisecond)
	a.h.applyManualInput(context.Background(), ids, map[string]inputwatch.Run{}, obs)
}

func (a *attentionHub) p(id string) proto.ManualProcess { return a.h.manualProcesses[id] }

var (
	readObs   = inputwatch.Observation{Live: true, Detection: inputwatch.Full, Confidence: inputwatch.Confirmed, Reason: inputwatch.TTYRead}
	waitObs   = inputwatch.Observation{Live: true, Detection: inputwatch.Hints, Confidence: inputwatch.Uncertain, Reason: inputwatch.TTYWait}
	quietObs  = inputwatch.Observation{Live: true, Detection: inputwatch.Full}
	hiddenObs = inputwatch.Observation{Live: true, Detection: inputwatch.Hints, Suppressed: "tui"}
)

func TestManualInputEpisode(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a")
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if p := a.p("mp_a"); p.Attention != nil || p.State != "running" || p.InputDetection != "full" {
		t.Fatalf("one positive published: %+v", p)
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	p := a.p("mp_a")
	if p.Attention == nil || p.State != "waiting" {
		t.Fatalf("two positives: %+v", p)
	}
	ep := *p.Attention
	if !strings.HasPrefix(ep.ID, "ia_") || ep.Kind != "input" || ep.Confidence != "confirmed" || ep.Reason != "tty_read" || ep.Since != a.now.UnixMilli() || ep.ExpiresAt != 0 {
		t.Fatalf("episode: %+v", ep)
	}
	// Weaker evidence in the same episode: the id stays, the run is running.
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs})
	if p := a.p("mp_a"); p.Attention == nil || p.Attention.ID != ep.ID || p.Attention.Confidence != "uncertain" || p.Attention.Since != ep.Since || p.State != "running" || p.InputDetection != "hints" {
		t.Fatalf("uncertain: %+v", p)
	}
	// One negative keeps it, the second closes it.
	a.sample(map[string]inputwatch.Observation{"mp_a": quietObs})
	if a.p("mp_a").Attention == nil {
		t.Fatal("closed after one negative")
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": hiddenObs})
	if p := a.p("mp_a"); p.Attention != nil || p.State != "running" {
		t.Fatalf("two negatives: %+v", p)
	}
	// A positive interrupted by a negative does not count.
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": quietObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if a.p("mp_a").Attention != nil {
		t.Fatal("non-consecutive positives opened an episode")
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if p := a.p("mp_a"); p.Attention == nil || p.Attention.ID == ep.ID {
		t.Fatalf("a new episode needs a new id: %+v", p.Attention)
	}
	// No observation at all (no launcher status yet) is a negative.
	a.sample(nil)
	a.sample(nil)
	if a.p("mp_a").Attention != nil {
		t.Fatal("unobserved run kept its episode")
	}
}

// Input to the run's terminal closes the episode at once; it takes two new
// positives (a new id) to open another.
func TestManualInputClearedByTerminalInput(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a")
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	first := a.p("mp_a").Attention
	if first == nil {
		t.Fatal("no episode")
	}
	a.h.manualInputSent(context.Background(), "mp_a")
	if p := a.p("mp_a"); p.Attention != nil || p.State != "running" {
		t.Fatalf("after input: %+v", p)
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if a.p("mp_a").Attention != nil {
		t.Fatal("reopened after one positive")
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if p := a.p("mp_a"); p.Attention == nil || p.Attention.ID == first.ID {
		t.Fatalf("reopened: %+v", p.Attention)
	}
	a.h.manualInputSent(context.Background(), "mp_unknown") // no run: nothing happens
}

// The credential wins over input attention and gives it back afterwards;
// each run is independent.
func TestManualCredentialAttentionPrecedence(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a", "mp_b")
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs, "mp_b": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs, "mp_b": quietObs})
	input := a.p("mp_a").Attention
	if input == nil || input.Confidence != "uncertain" || a.p("mp_a").State != "running" || a.p("mp_b").Attention != nil {
		t.Fatalf("a %+v b %+v", a.p("mp_a"), a.p("mp_b"))
	}
	cred := &proto.ManualCredential{Request: "cr_0123", Prompt: "[sudo] password for x: ", User: "root", Attempt: 1, ExpiresAt: a.now.Add(2 * time.Minute).UnixMilli()}
	a.h.credentials = map[string]*credentialRequest{"mp_a": {request: "cr_0123", opened: a.now.Add(-time.Second)}}
	a.h.setManualCredential("mp_a", cred)
	p := a.p("mp_a")
	want := proto.ManualAttention{ID: "cr_0123", Kind: "credential", Confidence: "authenticated", Reason: "askpass", Since: a.now.Add(-time.Second).UnixMilli(), ExpiresAt: cred.ExpiresAt}
	if p.Attention == nil || *p.Attention != want || p.State != "waiting" {
		t.Fatalf("credential: %+v", p)
	}
	b, _ := json.Marshal(p.Attention)
	if strings.Contains(string(b), "password") || strings.Contains(string(b), "sudo") {
		t.Fatalf("attention carries prompt text: %s", b)
	}
	// Samples go on underneath; the credential stays what is shown.
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs})
	if p := a.p("mp_a"); p.Attention.Kind != "credential" || p.Attention.Since != want.Since {
		t.Fatalf("credential replaced: %+v", p.Attention)
	}
	a.h.setManualCredential("mp_a", nil)
	if p := a.p("mp_a"); p.Attention == nil || p.Attention.ID != input.ID || p.State != "running" {
		t.Fatalf("input attention not back: %+v", p)
	}
	// Run b opens its own episode meanwhile.
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs, "mp_b": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs, "mp_b": readObs})
	if pb := a.p("mp_b"); pb.Attention == nil || pb.Attention.ID == input.ID || pb.State != "waiting" || a.p("mp_a").Attention.ID != input.ID {
		t.Fatalf("b %+v", pb)
	}
}

// Stop or exit clears the attention and drops the run's
// observations; later samples are ignored.
func TestManualInputClearedWhenTheRunEnds(t *testing.T) {
	for _, state := range []string{"stopping", "exited", "stopped"} {
		t.Run(state, func(t *testing.T) {
			a := newAttentionHub(t, "", "mp_a")
			a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
			a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
			p := a.p("mp_a")
			if p.State != "waiting" {
				t.Fatalf("%+v", p)
			}
			p.State = state
			if err := a.h.saveManual(context.Background(), p); err != nil {
				t.Fatal(err)
			}
			if p := a.p("mp_a"); p.Attention != nil || p.InputDetection != "" || a.h.mi.runs["mp_a"] != nil {
				t.Fatalf("after %s: %+v", state, p)
			}
			a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
			a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
			if a.p("mp_a").Attention != nil {
				t.Fatal("sampled after the end")
			}
		})
	}
}

// A run whose launcher can no longer be verified (unknown) loses its input
// episode: it is no longer sampled, so the episode could only go stale.
func TestManualInputClearedWhenUnknown(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a")
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	p := a.p("mp_a")
	p.State = "unknown"
	if err := a.h.saveManual(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if p := a.p("mp_a"); p.Attention != nil || p.State != "unknown" {
		t.Fatalf("%+v", p)
	}
	p = a.p("mp_a")
	p.State = "running"
	if err := a.h.saveManual(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if a.p("mp_a").Attention != nil {
		t.Fatal("stale episode came back")
	}
}

// Attention is never stored: a waiting-on-input run is stored as running,
// and a new hub on the same database starts with no observation.
func TestManualInputNotRestoredAfterRestart(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a")
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": readObs})
	if a.p("mp_a").State != "waiting" {
		t.Fatal("not waiting")
	}
	records, err := a.st.AllManualProcesses(context.Background())
	if err != nil || len(records) != 1 {
		t.Fatal(records, err)
	}
	b, _ := json.Marshal(records[0])
	if records[0].State != "running" || strings.Contains(string(b), "attention") || strings.Contains(string(b), "input_detection") || strings.Contains(string(b), "ia_") {
		t.Fatalf("stored: %s", b)
	}
	_ = a.st.Close()
	b2 := newAttentionHub(t, a.db)
	if p := b2.p("mp_a"); p.State != "running" || p.Attention != nil || p.InputDetection != "" || p.Error != "" {
		t.Fatalf("restored: %+v", p)
	}
}

// The sampling ticker exists exactly while a run is sampled.
func TestManualInputTickerOnlyWhileRunsExist(t *testing.T) {
	a := newAttentionHub(t, "")
	if a.h.manualInputTick() != nil {
		t.Fatal("ticker without runs")
	}
	if err := a.h.saveManual(context.Background(), proto.ManualProcess{ID: "mp_a", Op: "a", State: "running"}); err != nil {
		t.Fatal(err)
	}
	if a.h.manualInputTick() == nil {
		t.Fatal("no ticker for a running run")
	}
	p := a.p("mp_a")
	p.State = "exited"
	if err := a.h.saveManual(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if a.h.manualInputTick() != nil {
		t.Fatal("ticker after the last run ended")
	}
}

// Detection follows the live samples only; a sample of a launcher that is
// gone keeps the last level.
func TestManualInputDetectionLevel(t *testing.T) {
	a := newAttentionHub(t, "", "mp_a")
	if a.p("mp_a").InputDetection != "" {
		t.Fatal("detection before any sample")
	}
	a.sample(map[string]inputwatch.Observation{"mp_a": waitObs})
	a.sample(map[string]inputwatch.Observation{"mp_a": {Detection: inputwatch.None}})
	if got := a.p("mp_a").InputDetection; got != "hints" {
		t.Fatalf("detection %q", got)
	}
}
