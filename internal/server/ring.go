package server

// ring keeps the last n encoded events for since_seq replay.
type ring struct {
	buf  []ringEntry
	next int // slot for the next add
	full bool
}

type ringEntry struct {
	seq uint64
	msg []byte
}

func newRing(n int) *ring { return &ring{buf: make([]ringEntry, n)} }

func (r *ring) add(seq uint64, msg []byte) {
	r.buf[r.next] = ringEntry{seq, msg}
	r.next = (r.next + 1) % len(r.buf)
	if r.next == 0 {
		r.full = true
	}
}

// since returns every event after seq up to cur, or false when some of
// them have already been evicted (or seq is from the future).
func (r *ring) since(seq, cur uint64) ([][]byte, bool) {
	if seq > cur {
		return nil, false
	}
	if seq == cur {
		return nil, true
	}
	n := r.next
	start := 0
	if r.full {
		n = len(r.buf)
		start = r.next
	}
	if n == 0 {
		return nil, false
	}
	oldest := r.buf[start].seq
	if seq+1 < oldest {
		return nil, false
	}
	out := make([][]byte, 0, cur-seq)
	for i := 0; i < n; i++ {
		e := r.buf[(start+i)%len(r.buf)]
		if e.seq > seq {
			out = append(out, e.msg)
		}
	}
	return out, true
}
