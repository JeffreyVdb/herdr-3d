package server

// #118 floor overview: each worker's digest, the task and now lines the
// overview (the lounge's wall screen and its page) shows. The usage tracker
// feeds every Claude and Codex worker's transcript lines to its
// transcript.DigestTracker (on the same tap as the ask, wrap-up, follow-up
// and activity trackers) and hands the hub its view when it changed; the hub
// keeps it per worker (the input phase 2's summarizer reads) and publishes
// Worker.Digest in a worker.upsert, only when the composed lines changed:
// they move on a prompt, an ai-title, a recap or the first step, rarely.
//
// Phase 1 is the fallbacks only: the task is Claude's ai-title, else the
// first prompt's first sentence; now is Claude's recent away_summary recap,
// else the worker's terminal title (NowSource "title", no text: the game
// reads Title, which goes out on the hot worker.status path and is never
// copied here).

import (
	"reflect"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// digestUpdate is a worker's tracker's digest now (nil: none: no
// transcript, another harness).
type digestUpdate struct {
	id     string
	digest *transcript.Digest
}

// digestOffered is what the usage tracker last offered of a worker: which
// tracker, at which of its changes.
type digestOffered struct {
	t   *transcript.DigestTracker
	seq int
}

// offerDigest queues worker w's digest when its tracker changed (usage
// tracker goroutine, after its session's Poll).
func (tr *usageTracker) offerDigest(w usageWorker) {
	var t *transcript.DigestTracker
	if l := tr.lines[w.id]; l != nil {
		t = l.digest
	}
	o := digestOffered{t: t}
	if t != nil {
		o.seq = t.Seq()
	}
	prev, ok := tr.dgOffered[w.id]
	if ok && prev == o {
		return
	}
	tr.dgOffered[w.id] = o
	if !ok && t == nil {
		return
	}
	u := digestUpdate{id: w.id}
	if t != nil {
		d := t.View()
		u.digest = &d
	}
	tr.dgUps = append(tr.dgUps, u)
}

// digestSeen takes a worker's tracker digest (hub goroutine).
func (h *Hub) digestSeen(u digestUpdate) {
	w := h.workers[u.id]
	if w == nil {
		delete(h.dg, u.id)
		return
	}
	if u.digest == nil {
		delete(h.dg, u.id)
	} else {
		h.dg[u.id] = u.digest
	}
	next := composeDigest(h.dg[u.id])
	if reflect.DeepEqual(next, w.Digest) {
		return
	}
	nw := *w
	nw.Digest = next
	h.workers[u.id] = &nw
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &nw})
}

// composeDigest is the lines the overview shows of a tracker's digest: none
// before the first assistant step.
//
// Phase 2 (internal/digest) plugs in here: a model's lines for this input
// (the first prompt's hash for the task, the recent steps for now), when
// it has them, take the place of the fallbacks below with source
// proto.DigestLLM; the fallbacks stay for a model that is off, not ready or
// failing.
func composeDigest(d *transcript.Digest) *proto.WorkerDigest {
	if d == nil || d.Steps == 0 {
		return nil
	}
	out := &proto.WorkerDigest{NowSource: proto.DigestTitle}
	out.Task, out.TaskSource = d.Task()
	if d.Recap != "" {
		out.Now, out.NowSource, out.NowAt = d.Recap, proto.DigestRecap, d.RecapAt
	}
	return out
}
