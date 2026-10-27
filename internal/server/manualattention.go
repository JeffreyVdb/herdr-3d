package server

// #213: a manual run asking for the user, published as
// ManualProcess.Attention. A credential episode is the askpass broker's open
// request (credential, authenticated); an input episode comes only from
// sampling the run tty's foreground group (internal/manual/inputwatch):
// two consecutive positive samples open it, two negatives close it, and
// input the user sends to the run's terminal closes it at once (the next
// two positives open a new one). The credential wins while both exist. An
// episode is live state: it is never stored, and a bridge restart starts
// from no observation. Nothing here ever sees terminal text.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"path/filepath"
	"reflect"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/manual/inputwatch"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// DefaultManualInputPoll is how often each running manual run is sampled.
const DefaultManualInputPoll = 500 * time.Millisecond

// manualInput is the hub's part of the input detection (hub goroutine).
type manualInput struct {
	det      *inputwatch.Detector
	runs     map[string]*inputRun
	ticker   *time.Ticker
	sampling bool
}

// inputRun is one run's observation streaks and open input episode.
type inputRun struct {
	launcher  inputwatch.Run // from status.json, once known
	pos, neg  int
	episode   *proto.ManualAttention
	detection string
}

func (h *Hub) initManualInput() {
	proc := h.opts.ManualInputProc
	if proc == nil {
		proc = inputwatch.System()
	}
	h.mi = manualInput{det: &inputwatch.Detector{Proc: proc}, runs: map[string]*inputRun{}}
	if h.opts.ManualInputPoll <= 0 {
		h.opts.ManualInputPoll = DefaultManualInputPoll
	}
}

// inputSampled reports whether a run in state is sampled.
func inputSampled(state string) bool { return state == "running" || state == "waiting" }

// manualInputTick is the sampling ticker's channel (nil: no run to sample).
func (h *Hub) manualInputTick() <-chan time.Time {
	if h.mi.ticker == nil {
		return nil
	}
	return h.mi.ticker.C
}

// syncManualInputTicker runs the sampling ticker exactly while a run is
// sampled.
func (h *Hub) syncManualInputTicker() {
	want := false
	for _, p := range h.manualProcesses {
		if inputSampled(p.State) {
			want = true
			break
		}
	}
	switch {
	case want && h.mi.ticker == nil:
		h.mi.ticker = time.NewTicker(h.opts.ManualInputPoll)
	case !want && h.mi.ticker != nil:
		h.mi.ticker.Stop()
		h.mi.ticker = nil
	}
}

// sampleManualInput observes every running run off the hub goroutine, one
// sample at a time.
func (h *Hub) sampleManualInput(ctx context.Context) {
	if h.mi.sampling {
		return
	}
	known := map[string]inputwatch.Run{}
	var ids []string
	for id, p := range h.manualProcesses {
		if !inputSampled(p.State) {
			continue
		}
		ids = append(ids, id)
		if r := h.mi.runs[id]; r != nil && r.launcher.PID > 0 {
			known[id] = r.launcher
		}
	}
	if len(ids) == 0 {
		h.syncManualInputTicker()
		return
	}
	h.mi.sampling = true
	det, dir := h.mi.det, h.opts.ManualDir
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		runs := map[string]inputwatch.Run{}
		for _, id := range ids {
			if r, ok := known[id]; ok {
				runs[id] = r
				continue
			}
			if st, err := manual.ReadStatus(filepath.Join(dir, id)); err == nil && st.PID > 0 && st.ExitCode == nil {
				runs[id] = inputwatch.Run{PID: st.PID, StartTicks: st.StartTicks}
			}
		}
		obs := det.Observe(runs)
		_ = h.do(ctx, func(ctx context.Context) {
			h.mi.sampling = false
			h.applyManualInput(ctx, ids, runs, obs)
		})
	}()
}

// applyManualInput takes one sample of the runs (hub goroutine). A run with
// no launcher identity yet counts as not waiting.
func (h *Hub) applyManualInput(ctx context.Context, ids []string, runs map[string]inputwatch.Run, obs map[string]inputwatch.Observation) {
	now := h.opts.Now()
	for _, id := range ids {
		p, ok := h.manualProcesses[id]
		if !ok || !inputSampled(p.State) {
			continue
		}
		r := h.mi.runs[id]
		if r == nil {
			r = &inputRun{}
			h.mi.runs[id] = r
		}
		o, observed := obs[id]
		if observed && o.Live {
			r.launcher, r.detection = runs[id], o.Detection
		}
		if o.Positive() {
			r.pos, r.neg = r.pos+1, 0
			switch {
			case r.episode == nil && r.pos >= 2:
				r.episode = &proto.ManualAttention{ID: newAttentionID(), Kind: proto.AttentionInput, Confidence: o.Confidence, Reason: o.Reason, Since: now.UnixMilli()}
				h.log.Info("manual process input attention opened", "process", id, "confidence", o.Confidence, "reason", o.Reason, "detection", r.detection)
			case r.episode != nil && (r.episode.Confidence != o.Confidence || r.episode.Reason != o.Reason):
				next := *r.episode
				next.Confidence, next.Reason = o.Confidence, o.Reason
				r.episode = &next
			}
		} else {
			r.pos, r.neg = 0, r.neg+1
			if r.episode != nil && r.neg >= 2 {
				r.episode = nil
				h.log.Info("manual process input attention closed", "process", id, "why", "not observed", "suppressed", o.Suppressed)
			}
		}
		h.publishManualAttention(ctx, id)
	}
}

// manualInputSent closes a run's input episode when the user types into its
// terminal: the answer may have resolved it, and only new observations may
// open another.
func (h *Hub) manualInputSent(ctx context.Context, id string) {
	r := h.mi.runs[id]
	if r == nil {
		return
	}
	r.pos, r.neg = 0, 0
	if r.episode != nil {
		r.episode = nil
		h.log.Info("manual process input attention closed", "process", id, "why", "terminal input")
		h.publishManualAttention(ctx, id)
	}
}

// publishManualAttention publishes a run whose derived attention changed.
func (h *Hub) publishManualAttention(ctx context.Context, id string) {
	p, ok := h.manualProcesses[id]
	if !ok {
		return
	}
	next := p
	h.deriveManualAttention(&next)
	if reflect.DeepEqual(p, next) {
		return
	}
	if err := h.saveManual(ctx, next); err != nil {
		h.log.Error("publishing manual process attention", "process", id, "err", err)
	}
}

// deriveManualAttention sets p's attention, input detection and the
// running/waiting state from the credential and the input episode: waiting
// while a credential or a confirmed input episode is open. A run that is
// stopping or ended has neither (its observations are dropped).
func (h *Hub) deriveManualAttention(p *proto.ManualProcess) {
	if manual.Terminal(p.State) || p.State == "stopping" {
		p.Attention, p.InputDetection = nil, ""
		delete(h.mi.runs, p.ID)
		return
	}
	prev := p.Attention
	r := h.mi.runs[p.ID]
	if r != nil && !inputSampled(p.State) { // unknown: never a stale episode
		r.episode, r.pos, r.neg = nil, 0, 0
	}
	p.InputDetection = ""
	if r != nil {
		p.InputDetection = r.detection
	}
	switch {
	case p.Credential != nil:
		since := h.opts.Now().UnixMilli()
		if cr := h.credentials[p.ID]; cr != nil && cr.request == p.Credential.Request && !cr.opened.IsZero() {
			since = cr.opened.UnixMilli()
		}
		if prev != nil && prev.ID == p.Credential.Request {
			since = prev.Since
		}
		p.Attention = &proto.ManualAttention{ID: p.Credential.Request, Kind: proto.AttentionCredential, Confidence: proto.AttentionAuthenticated,
			Reason: proto.AttentionAskpass, Since: since, ExpiresAt: p.Credential.ExpiresAt}
	case r != nil && r.episode != nil:
		a := *r.episode
		p.Attention = &a
	default:
		p.Attention = nil
	}
	switch {
	case p.Credential != nil && p.State != "unknown":
		p.State = "waiting"
	case p.Credential == nil && p.Attention != nil && p.Attention.Confidence == proto.AttentionConfirmed && p.State == "running":
		p.State = "waiting"
	case p.State == "waiting" && (p.Attention == nil || (p.Credential == nil && p.Attention.Confidence != proto.AttentionConfirmed)):
		p.State = "running"
	}
}

func newAttentionID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "ia_" + hex.EncodeToString(b[:])
}
