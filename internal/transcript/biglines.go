package transcript

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Big lines (#126). A transcript line of megabytes is nearly always base64:
// an inline image (a screenshot the agent viewed, an image Codex generated)
// or a copy of one (Claude's toolUseResult, Codex's item_completed). A list
// item never shows those bytes, only the image's ref, so a capped read of a
// big line skips them: the index records, for each such line, the ranges to
// skip and its inline images' refs (resolved once, while it is indexed).
// A full read (transcript.item, an image's bytes) still reads the whole line.
const (
	// bigLine is the shortest line that gets a record.
	bigLine = 256 << 10
	// minCut is the shortest base64 string a capped read cuts.
	minCut = 128 << 10
	// cutKeep is what a capped read keeps of a string it cuts: more than
	// any capped field shows of one string (MaxText, a diff line within
	// MaxDiffBytes), so whatever reads the string as text caps it the
	// same way and still sees it was longer. A base64 string has no
	// newline, quote or escape, so its prefix is all that a cap, a
	// first-line summary or a prefix check reads of it.
	cutKeep = max(MaxText, MaxDiffBytes) + 1
)

// bigRec is what a capped read of a big line needs besides the file. It is
// never changed once it is in the index.
type bigRec struct {
	cuts []cutRange // within the line, ascending
	cut  int        // their bytes
	imgs []knownImg // the line's inline images, by j
}

// cutRange is a run of a line a capped read skips: from, to are offsets in
// the line.
type cutRange struct{ from, to int32 }

// knownImg is an inline image of a big line: its j in the line's parse and
// what it is.
type knownImg struct {
	j int
	v memoVal
}

// b64Byte holds the bytes of a base64 string (standard and URL alphabets).
var b64Byte = func() (t [256]bool) {
	for _, c := range []byte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_") {
		t[c] = true
	}
	return t
}()

// b64Run is how many bytes b starts with that are base64, 8 at a time
// while it can.
func b64Run(b []byte) int {
	n := 0
	for ; n+8 <= len(b) && b64Word(binary.LittleEndian.Uint64(b[n:])); n += 8 {
	}
	for n < len(b) && b64Byte[b[n]] {
		n++
	}
	return n
}

// b64Word reports whether the 8 bytes of w are all base64 (b64Byte).
func b64Word(w uint64) bool {
	const ones, high = 0x0101010101010101, 0x8080808080808080
	if w&high != 0 {
		return false // a byte past ASCII
	}
	// in has the high bit of each byte in [lo, hi]: with the high bits set,
	// a byte minus lo (or hi minus a byte) borrows from no other byte.
	in := func(lo, hi uint64) uint64 {
		return ((w | high) - lo*ones) & ((hi*ones | high) - w) & high
	}
	return in('A', 'Z')|in('a', 'z')|in('/', '9')|in('+', '+')|in('-', '-')|in('=', '=')|in('_', '_') == high
}

// maxDataHeader bounds a data URL's header ("data:image/png;base64,").
const maxDataHeader = 128

// b64Cuts finds the string values of a JSON line that are base64 (after
// an optional data URL header) and at least minCut long: each one's run
// past its first cutKeep bytes. Nil when there are none (or the line ends
// inside a string).
func b64Cuts(line []byte) []cutRange {
	var cuts []cutRange
	for i := 0; i < len(line); {
		q := bytes.IndexByte(line[i:], '"')
		if q < 0 {
			break
		}
		start := i + q + 1 // the string's first byte
		j := start
		if bytes.HasPrefix(line[j:], []byte("data:")) {
			h := line[j:min(len(line), j+maxDataHeader)]
			if c := bytes.IndexByte(h, ','); c > 0 && !bytes.ContainsAny(h[:c], `"\`) {
				j += c + 1
			}
		}
		j += b64Run(line[j:])
		if j < len(line) && line[j] == '"' { // all base64
			if j-start >= minCut && !isKey(line, j+1) {
				cuts = append(cuts, cutRange{int32(start + cutKeep), int32(j)})
			}
			i = j + 1
			continue
		}
		end := stringEnd(line, j)
		if end < 0 {
			return nil
		}
		i = end + 1
	}
	return cuts
}

// isKey reports whether the string that ended before line[i] is an
// object's key (a ':' follows): a key is never cut.
func isKey(line []byte, i int) bool {
	for i < len(line) && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r' || line[i] == '\n') {
		i++
	}
	return i < len(line) && line[i] == ':'
}

// stringEnd is the closing quote of the string line[i] is in (-1: none).
func stringEnd(line []byte, i int) int {
	for i < len(line) {
		k := bytes.IndexAny(line[i:], `"\`)
		if k < 0 {
			return -1
		}
		if line[i+k] == '"' {
			return i + k
		}
		i += k + 2 // an escape: the next byte is part of it
	}
	return -1
}

// bigCuts is the record of a big line, without its images yet: nil if
// the line is short or has nothing to cut.
func bigCuts(line []byte, minLine int) *bigRec {
	if len(line) < minLine {
		return nil
	}
	cuts := b64Cuts(line)
	if len(cuts) == 0 {
		return nil
	}
	r := &bigRec{cuts: cuts}
	for _, c := range cuts {
		r.cut += int(c.to - c.from)
	}
	return r
}

// resolve finds what the inline images of the line's parse cs are: their
// base64 is decoded and hashed, the bytes are not kept. Before the record
// is in the index.
func (r *bigRec) resolve(cs []contrib) {
	for _, src := range inlineSrcs(cs) {
		v, _ := inspectInline(src.b64)
		r.imgs = append(r.imgs, knownImg{j: src.j, v: v})
	}
}

// inlineSrcs are the sources of a parse's inline images, in order.
func inlineSrcs(cs []contrib) []*imgSrc {
	var out []*imgSrc
	for i := range cs {
		for _, ir := range cs[i].imgs {
			if ir.src != nil && !ir.src.external && ir.ref.Source == proto.ImageInline {
				out = append(out, ir.src)
			}
		}
	}
	return out
}

// readCapped reads the line of sp without r's cuts into buf (grown as
// needed).
func (l *Log) readCapped(buf []byte, sp span, r *bigRec) ([]byte, error) {
	need := int(sp.n) - r.cut
	if cap(buf) < need {
		buf = make([]byte, 0, need)
	}
	buf = buf[:0]
	read := func(from, to int32) error {
		n := len(buf)
		buf = buf[:n+int(to-from)]
		_, err := l.r.ReadAt(buf[n:], sp.off+int64(from))
		return err
	}
	at := int32(0)
	for _, c := range r.cuts {
		if err := read(at, c.from); err != nil {
			return nil, err
		}
		at = c.to
	}
	if err := read(at, sp.n); err != nil {
		return nil, err
	}
	return buf, nil
}

// parseCapped parses the capped read of a big line and gives its inline
// images what the record knows of them (their base64 is cut). ok is false
// when the parse has other inline images than the record: the file
// changed, read the whole line.
func (l *Log) parseCapped(b []byte, sp span, r *bigRec) (cs []contrib, ok bool) {
	cs, _ = l.parse(sp.off, b)
	srcs := inlineSrcs(cs)
	if len(srcs) != len(r.imgs) {
		return nil, false
	}
	for i, src := range srcs {
		if src.j != r.imgs[i].j {
			return nil, false
		}
		src.n, src.known = int(sp.n), &r.imgs[i].v
	}
	return cs, true
}

// readErr is why reading a line of the log failed.
func (l *Log) readErr(err error) error {
	if l.Err() != nil {
		return l.Err()
	}
	return fmt.Errorf("%w: %v", ErrReplaced, err)
}
