package transcript

// The approximate heap of an index's parts (#149: the bridge keeps a few
// logs nobody watches for return visits, within a budget of their
// footprints). They count the structs and the map slots on amd64, not the
// allocator's rounding: an estimate that grows with the index, not a
// measurement.
const (
	fpLog      = 512 // the Log, its maps' headers and its file
	fpEntry    = 72  // an entry (its id and spans apart)
	fpSpan     = 16  // a span
	fpSlot     = 16  // a map slot's own overhead (control bytes, the load factor's spare slots)
	fpByID     = 24  // a byID slot: string header and index (the string is the entry's)
	fpMsg      = 104 // a msgs slot, its msgState and its blocks map's header, and its msgOrder string header
	fpBlock    = 16  // a block of a message
	fpBig      = 72  // a big slot and its bigRec (its cuts and images apart)
	fpCut      = 8   // a cut range
	fpImg      = 96  // a known image of a big line (its strings apart)
	fpMemo     = 112 // a memo or paths slot: key and memoVal (strings apart)
	fpHashLoc  = 88  // a hashLoc slot: key header and hashPlace (strings apart)
	fpTermSess = 48  // a terminal session: its slot and its termOrder place
	fpStarting = 96  // a call that may start sessions: its slot and its Terminals
	fpPolled   = 40  // a poll's command slot
)

// Footprint estimates the memory the index holds, in bytes: its entries
// and their spans, the maps that find them, the big lines' records, the
// images it resolved and its terminal sessions. It grows with the index;
// it is not exact.
func (l *Log) Footprint() int64 {
	l.mu.Lock()
	n := int64(fpLog)
	for i := range l.entries {
		e := &l.entries[i]
		n += fpEntry + int64(len(e.id)) + int64(cap(e.spans))*fpSpan
	}
	n += int64(cap(l.entries)-len(l.entries)) * fpEntry
	n += int64(len(l.byID)) * (fpByID + fpSlot)
	for id, m := range l.msgs {
		n += fpMsg + fpSlot + int64(len(id)) + int64(len(m.blocks))*(fpBlock+fpSlot)
	}
	n += int64(cap(l.open)) * 4
	for _, r := range l.big {
		n += fpBig + fpSlot + int64(cap(r.cuts))*fpCut
		for _, k := range r.imgs {
			n += fpImg + k.v.size()
		}
	}
	for _, cmd := range l.sessions {
		n += fpTermSess + fpSlot + int64(len(cmd))
	}
	n += int64(len(l.starting)) * (fpStarting + fpSlot)
	for _, cmd := range l.polled {
		n += fpPolled + fpSlot + int64(len(cmd))
	}
	env := l.env
	l.mu.Unlock()
	return n + env.footprint()
}

// footprint estimates the images' memory (Log.Footprint).
func (e *imageEnv) footprint() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	var n int64
	for _, v := range e.memo {
		n += fpMemo + fpSlot + v.size()
	}
	for k, v := range e.paths {
		n += fpMemo + fpSlot + int64(len(k.real)) + v.size()
	}
	for h, p := range e.hashLoc {
		n += fpHashLoc + fpSlot + int64(len(h)+len(p.path))
		for _, r := range p.roots {
			n += 16 + int64(len(r))
		}
	}
	return n
}

// size is the bytes of v's strings.
func (v memoVal) size() int64 { return int64(len(v.hash) + len(v.mime) + len(v.reason)) }
