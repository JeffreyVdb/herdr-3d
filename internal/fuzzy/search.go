package fuzzy

import (
	"container/heap"
	"runtime"
	"sync"
)

// Result is one match of Search: the candidate's index, its score and the
// rune offsets of the matched characters.
type Result struct {
	Index     int
	Score     int
	Positions []int
}

// Search returns the best limit matches of q among cands, best first: by
// score, then the shorter path (in runes), then byte order of the path.
// Every candidate is scored (cheap subsequence check first); positions are
// computed only for the ones returned. An empty query matches nothing here:
// the caller orders an empty query's list itself.
func Search(q *Query, cands []Candidate, limit int) []Result {
	if limit <= 0 || q.Empty() {
		return []Result{}
	}
	// A large list is scored in chunks in parallel, each with its own copy
	// of the query's scratch space, and the chunks' best merged.
	workers := min(runtime.GOMAXPROCS(0), maxWorkers, (len(cands)+parallelChunk-1)/parallelChunk)
	h := &topN{cands: cands}
	if workers <= 1 {
		q.scan(h, 0, len(cands), limit)
	} else {
		parts := make([]*topN, workers)
		var wg sync.WaitGroup
		size := (len(cands) + workers - 1) / workers
		for w := range workers {
			parts[w] = &topN{cands: cands}
			lo, hi := w*size, min((w+1)*size, len(cands))
			wq := q.clone()
			wg.Go(func() { wq.scan(parts[w], lo, hi, limit) })
		}
		wg.Wait()
		for _, p := range parts {
			for _, r := range p.rs {
				h.offer(r, limit)
			}
		}
	}
	out := make([]Result, h.Len())
	for i := len(out) - 1; i >= 0; i-- {
		out[i] = heap.Pop(h).(Result)
	}
	for i := range out {
		_, out[i].Positions, _ = q.Match(&cands[out[i].Index], true)
	}
	return out
}

const (
	// parallelChunk is the fewest candidates worth a goroutine.
	parallelChunk = 16 << 10
	maxWorkers    = 8
)

// scan offers the matches among cands[lo:hi] to h.
func (q *Query) scan(h *topN, lo, hi, limit int) {
	for i := lo; i < hi; i++ {
		if s, _, ok := q.Match(&h.cands[i], false); ok {
			h.offer(Result{Index: i, Score: s}, limit)
		}
	}
}

// clone is q with scratch space of its own.
func (q *Query) clone() *Query {
	return &Query{runes: q.runes, ascii: q.ascii, sensitive: q.sensitive}
}

// topN is a min-heap of results: the worst at the root.
type topN struct {
	cands []Candidate
	rs    []Result
}

// less reports whether a ranks below b.
func (h *topN) less(a, b Result) bool {
	if a.Score != b.Score {
		return a.Score < b.Score
	}
	ca, cb := &h.cands[a.Index], &h.cands[b.Index]
	if ca.n != cb.n {
		return ca.n > cb.n
	}
	return ca.Path > cb.Path
}

// offer keeps r if it is among the best limit.
func (h *topN) offer(r Result, limit int) {
	if h.Len() < limit {
		heap.Push(h, r)
	} else if h.less(h.rs[0], r) {
		h.rs[0] = r
		heap.Fix(h, 0)
	}
}

func (h *topN) Len() int           { return len(h.rs) }
func (h *topN) Less(i, j int) bool { return h.less(h.rs[i], h.rs[j]) }
func (h *topN) Swap(i, j int)      { h.rs[i], h.rs[j] = h.rs[j], h.rs[i] }
func (h *topN) Push(x any)         { h.rs = append(h.rs, x.(Result)) }
func (h *topN) Pop() any {
	r := h.rs[len(h.rs)-1]
	h.rs = h.rs[:len(h.rs)-1]
	return r
}
