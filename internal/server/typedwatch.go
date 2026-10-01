package server

// #95: the bridge types its prompts into Claude Code, which takes an input
// burst of more than 800 characters (v2.1.287) as a paste. Should that
// change, a typed prompt would reach the model wrapped in <pasted_content>
// again. The usage tracker reads every Claude transcript line; a prompt
// there that holds pasted text and is one the bridge typed into that
// worker lately is logged as a warning. Only a fingerprint of each typed
// prompt is kept, never its text.

import (
	"crypto/sha256"
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
