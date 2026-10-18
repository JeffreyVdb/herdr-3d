package promptsecret

// The review contract (docs/protocol.md "Prompt secrets"). A scan's
// revision is an HMAC, keyed per bridge process, over the text, the rule set
// and the candidates: never a plain hash of the text, which would let a
// short secret be guessed offline. A submission's decisions are checked
// against a fresh scan of the text it carries, never against the client's
// list.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"slices"
	"strconv"
)

// MaxDecisions bounds one submission's decisions.
const MaxDecisions = 4096

// Reviewer signs and checks revisions with its key, and scans with the
// bridge's own file references (Scan's own).
type Reviewer struct {
	key []byte
	own func(path string) bool
}

// NewReviewer is a Reviewer with key (random, at least 32 bytes, kept in
// memory only: a restart makes every review stale) whose scans leave the
// references to the paths own says are the bridge's alone (nil: none).
func NewReviewer(key []byte, own func(path string) bool) *Reviewer {
	if len(key) < 32 {
		panic("promptsecret: a revision key needs 32 bytes")
	}
	return &Reviewer{key: slices.Clone(key), own: own}
}

// Found is a candidate as a review shows it: its id (c1, c2, … in text
// order, stable for a revision) and its range in UTF-16 code units too.
type Found struct {
	ID string
	Candidate
	Start16, End16 int
}

// Review is a scan's answer: the revision and the candidates.
type Review struct {
	Revision string
	Found    []Found
}

// Scan scans text (valid UTF-8) for review.
func (r *Reviewer) Scan(text string) Review {
	cands := Scan(text, r.own)
	o := NewOffsets(text)
	rev := Review{Revision: r.revision(text, cands), Found: make([]Found, len(cands))}
	for i, c := range cands {
		rev.Found[i] = Found{ID: "c" + strconv.Itoa(i+1), Candidate: c, Start16: o.UTF16(c.Start), End16: o.UTF16(c.End)}
	}
	return rev
}

func (r *Reviewer) revision(text string, cands []Candidate) string {
	m := hmac.New(sha256.New, r.key)
	m.Write(scanBytes("h3d-prompt-secrets/1", text, cands))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// StoredDigest is the record of a stored prompt reviewed with every
// candidate ignored (#108 round 2: a schedule's or a hire preset's): a
// plain SHA-256 of the rule set, the text and its candidates, the same for
// every bridge process. Only for a text stored in plain beside it: it tells
// nothing the text does not (never a review's revision, which is keyed).
// A rescan under other rules or of another text gives another digest.
func StoredDigest(text string, rev Review) string {
	cands := make([]Candidate, len(rev.Found))
	for i, f := range rev.Found {
		cands[i] = f.Candidate
	}
	s := sha256.Sum256(scanBytes("h3d-prompt-secrets-stored/1", text, cands))
	return base64.RawURLEncoding.EncodeToString(s[:])
}

// scanBytes encodes a scan (the rule set, the text, its candidates) under
// a purpose's prefix.
func scanBytes(purpose, text string, cands []Candidate) []byte {
	b := []byte(purpose + "\x00" + RulesVersion + "\x00")
	b = binary.AppendUvarint(b, uint64(len(text)))
	b = append(b, text...)
	b = binary.AppendUvarint(b, uint64(len(cands)))
	for _, c := range cands {
		b = binary.AppendUvarint(b, uint64(c.Start))
		b = binary.AppendUvarint(b, uint64(c.End))
		b = binary.AppendUvarint(b, uint64(len(c.Kinds)))
		for _, k := range c.Kinds {
			b = binary.AppendUvarint(b, uint64(len(k)))
			b = append(b, k...)
		}
		if c.Encoded {
			b = append(b, 1)
		} else {
			b = append(b, 0)
		}
	}
	return b
}

// Range is [Start, End): UTF-16 code units in a Decision, bytes in a Plan.
type Range struct{ Start, End int }

// Decision is one choice of a review: a candidate's (Candidate, its id)
// protected or ignored, a protected candidate with a corrected Range, or a
// manual mark (no Candidate, Protect, a Range). Ranges are UTF-16.
type Decision struct {
	Candidate string
	Protect   bool
	Range     *Range
}

// Plan is what a checked review protects: byte ranges, sorted, never
// overlapping; Ignored candidates stay as typed. Key is the same for the
// same text, revision and choices in any order (a retry's identity).
type Plan struct {
	Protect []Range
	Ignored int
	Key     string
}

// ReviewError refuses a submission's review: Stale when the revision is
// not the text's under the current rules and key (rescan), else the
// decisions do not fit it. Its message names decisions by index and
// candidates by id, never their text.
type ReviewError struct {
	Stale  bool
	Reason string
}

func (e *ReviewError) Error() string { return e.Reason }

// Check checks a submission's decisions against a fresh scan of text: the
// revision must be that scan's, each candidate must have exactly one
// decision, and every protected range (and ignored candidate) must be
// non-empty, in the text, on code point boundaries and apart from the
// others.
func (r *Reviewer) Check(text, revision string, decisions []Decision) (Plan, error) {
	return r.CheckScan(text, r.Scan(text), revision, decisions)
}

// CheckScan is Check with the fresh scan already made: rev must be this
// Reviewer's Scan of text.
func (r *Reviewer) CheckScan(text string, rev Review, revision string, decisions []Decision) (Plan, error) {
	if !hmac.Equal([]byte(revision), []byte(rev.Revision)) {
		return Plan{}, &ReviewError{Stale: true, Reason: "the review's revision is not this text's: scan it again"}
	}
	if len(decisions) > MaxDecisions {
		return Plan{}, &ReviewError{Reason: fmt.Sprintf("at most %d decisions, got %d", MaxDecisions, len(decisions))}
	}
	o := NewOffsets(text)
	byID := make(map[string]Found, len(rev.Found))
	for _, f := range rev.Found {
		byID[f.ID] = f
	}
	type placed struct {
		Range
		decision int
		protect  bool
		id       string
	}
	var all []placed
	decided := map[string]bool{}
	var ignored []string
	for i, d := range decisions {
		if d.Candidate != "" {
			if _, ok := byID[d.Candidate]; !ok {
				return Plan{}, &ReviewError{Reason: fmt.Sprintf("decision %d names no candidate of this revision", i)}
			}
			if decided[d.Candidate] {
				return Plan{}, &ReviewError{Reason: fmt.Sprintf("candidate %s has more than one decision", d.Candidate)}
			}
			decided[d.Candidate] = true
		}
		switch {
		case d.Candidate == "" && (!d.Protect || d.Range == nil):
			return Plan{}, &ReviewError{Reason: fmt.Sprintf("decision %d: a manual mark protects a range (start and end)", i)}
		case d.Range != nil && !d.Protect:
			return Plan{}, &ReviewError{Reason: fmt.Sprintf("decision %d: only a protected candidate takes a corrected range", i)}
		case d.Range != nil:
			s, e, err := o.byteRange(*d.Range)
			if err != nil {
				return Plan{}, &ReviewError{Reason: fmt.Sprintf("decision %d: %v", i, err)}
			}
			all = append(all, placed{Range{s, e}, i, true, d.Candidate})
		default:
			f := byID[d.Candidate]
			all = append(all, placed{Range{f.Start, f.End}, i, d.Protect, d.Candidate})
			if !d.Protect {
				ignored = append(ignored, d.Candidate)
			}
		}
	}
	if len(decided) != len(rev.Found) {
		return Plan{}, &ReviewError{Reason: fmt.Sprintf("%d of %d candidates have no decision", len(rev.Found)-len(decided), len(rev.Found))}
	}
	slices.SortFunc(all, func(a, b placed) int { return a.Start - b.Start })
	for i := 1; i < len(all); i++ {
		if all[i].Start < all[i-1].End {
			return Plan{}, &ReviewError{Reason: fmt.Sprintf("decisions %d and %d overlap", all[i-1].decision, all[i].decision)}
		}
	}
	p := Plan{Ignored: len(ignored)}
	h := sha256.New()
	h.Write([]byte(revision + "\x00"))
	for _, a := range all {
		if a.protect {
			p.Protect = append(p.Protect, a.Range)
			fmt.Fprintf(h, "p%d-%d,", a.Start, a.End)
		}
	}
	slices.Sort(ignored)
	for _, id := range ignored {
		fmt.Fprintf(h, "i%s,", id)
	}
	p.Key = hex.EncodeToString(h.Sum(nil))
	return p, nil
}

// byteRange is a UTF-16 range as bytes, checked.
func (o *Offsets) byteRange(r Range) (int, int, error) {
	if r.Start < 0 || r.End > o.Len() || r.Start >= r.End {
		return 0, 0, fmt.Errorf("range [%d,%d) is empty or outside the text's %d code units", r.Start, r.End, o.Len())
	}
	s, ok1 := o.Byte(r.Start)
	e, ok2 := o.Byte(r.End)
	if !ok1 || !ok2 {
		return 0, 0, fmt.Errorf("range [%d,%d) splits a surrogate pair", r.Start, r.End)
	}
	return s, e, nil
}

// Replace is text with each byte range (sorted, apart) replaced by its
// reference.
func Replace(text string, ranges []Range, refs []string) string {
	if len(ranges) != len(refs) {
		panic("promptsecret: a reference per range")
	}
	out := make([]byte, 0, len(text)+len(ranges)*96)
	at := 0
	for i, r := range ranges {
		out = append(out, text[at:r.Start]...)
		out = append(out, refs[i]...)
		at = r.End
	}
	return string(append(out, text[at:]...))
}
