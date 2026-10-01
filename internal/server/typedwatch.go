package server

// #95: the bridge types its prompts into Claude Code, which takes an input
// burst of more than 800 characters (v2.1.287) as a paste. Should that
// change, a typed prompt would reach the model wrapped in <pasted_content>
// again. The usage tracker reads every Claude transcript line; a prompt
// there that holds pasted text and is one the bridge typed into that
// worker lately is logged as a warning. Only a fingerprint of each typed
// prompt is kept, never its text.

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// How many typed prompts are remembered per worker, and for how long.
const (
	maxTypedNotes = 8
	typedNoteTTL  = 10 * time.Minute
)

// typedSum is a prompt's fingerprint: a hash of its words, so line ends
// and the paste wrapper's blank lines do not count.
type typedSum [sha256.Size]byte

func sumTyped(text string) typedSum {
	return sha256.Sum256([]byte(strings.Join(strings.Fields(text), " ")))
}

type typedNote struct {
	sum typedSum
	at  time.Time
}

// noteTyped remembers that the bridge types text into worker id now (hub
// goroutine).
func (h *Hub) noteTyped(id, text string) {
	norm, _ := herdr.NormalizeTyped(text)
	now := h.opts.Now()
	notes := slices.DeleteFunc(h.typed[id], func(n typedNote) bool { return now.Sub(n.at) > typedNoteTTL })
	notes = append(notes, typedNote{sum: sumTyped(norm), at: now})
	if len(notes) > maxTypedNotes {
		notes = notes[len(notes)-maxTypedNotes:]
	}
	h.typed[id] = notes
}

// typedSums are the fingerprints of the prompts the bridge typed into
// worker id lately (hub goroutine).
func (h *Hub) typedSums(id string) []typedSum {
	var out []typedSum
	now := h.opts.Now()
	for _, n := range h.typed[id] {
		if now.Sub(n.at) <= typedNoteTTL {
			out = append(out, n.sum)
		}
	}
	return out
}

// pasteWatch looks for the worker's typed prompts arriving as a paste in
// its Claude transcript's lines (usage tracker goroutine).
type pasteWatch struct {
	sums   []typedSum // this round's: the worker's typed prompts
	warned map[typedSum]bool
	hits   int // since the tracker last looked
}

func newPasteWatch() *pasteWatch { return &pasteWatch{warned: map[typedSum]bool{}} }

func (p *pasteWatch) line(b []byte) {
	if len(p.sums) == 0 {
		return
	}
	text, ok := transcript.ClaudePasted(b)
	if !ok {
		return
	}
	if s := sumTyped(text); slices.Contains(p.sums, s) && !p.warned[s] {
		p.warned[s] = true
		p.hits++
	}
}

// takeHits returns the hits since the last call.
func (p *pasteWatch) takeHits() int {
	n := p.hits
	p.hits = 0
	return n
}

// eraseTimeout bounds the erase of a partly typed prompt (#95 R1); it has
// a context of its own, so a prompt cut short by its context is erased
// too.
const eraseTimeout = 15 * time.Second

// erasePartlyTyped erases what a failed TypePrompt (err) left in worker
// id's input box, on its input lane before anything else is typed there
// (#95 R1): a retry, or any later prompt, would be appended to it and
// sent with it. An error that typed nothing erases nothing. When the
// erase fails too, the worker's input is marked dirty (eraseDirty).
func (h *Hub) erasePartlyTyped(ctx context.Context, id, session, pane string, err error,
	erase func(ctx context.Context, session, pane string, n int) error) {
	var part *herdr.PartlyTypedError
	if !errors.As(err, &part) {
		return
	}
	ectx, cancel := context.WithTimeout(context.WithoutCancel(ctx), eraseTimeout)
	defer cancel()
	if eerr := erase(ectx, session, pane, part.Erase); eerr != nil {
		h.log.Warn("a partly typed prompt could not be erased", "worker", id, "err", eerr)
		if derr := h.doWait(ectx, func() { h.dirty[id] = max(h.dirty[id], part.Erase) }); derr != nil {
			h.log.Warn("a partly typed prompt not erased, not remembered", "worker", id, "err", derr)
		}
	}
}

// eraseDirty erases what an earlier prompt that could not be erased left
// in worker id's input box (erasePartlyTyped), before a prompt is typed
// there. While that fails the prompt is refused: it would be sent with
// the leftover.
func (h *Hub) eraseDirty(ctx context.Context, id, session, pane string,
	erase func(ctx context.Context, session, pane string, n int) error) error {
	n, err := query(ctx, h, func() int { return h.dirty[id] })
	if err != nil || n == 0 {
		return err
	}
	if err := erase(ctx, session, pane, n); err != nil {
		return fmt.Errorf("%w: the worker's input box may still hold part of an earlier prompt, which could not be erased: %v",
			errPromptFailed, err)
	}
	return h.doWait(ctx, func() {
		if h.dirty[id] == n {
			delete(h.dirty, id)
		}
	})
}
