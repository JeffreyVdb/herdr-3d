// Package fuzzy ranks paths against a query the way fzf's path scheme does
// (#137 worker.files): a subsequence match scored by fzf's V2 rules
// (adapted, not imported: algo.go at b1be3a8), with a bonus for characters
// matched in the basename. Pure Go, no I/O.
//
// A query is one pattern: spaces are literal characters, not fzf's
// extended-mode AND. Matching is smart case: case-insensitive unless the
// query has an uppercase letter. Positions are rune (code point) offsets
// into the path.
package fuzzy

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Scores (fzf's, path scheme: a space is an ordinary boundary, '/' the only
// delimiter, and a path starts as if after a delimiter).
const (
	scoreMatch        = 16
	scoreGapStart     = -3
	scoreGapExtension = -1
	bonusBoundary     = scoreMatch / 2
	bonusNonWord      = scoreMatch / 2
	bonusCamel123     = bonusBoundary + scoreGapExtension
	bonusConsecutive  = -(scoreGapStart + scoreGapExtension)
	bonusFirstCharMul = 2
	bonusWhite        = bonusBoundary     // fzf's bonusBoundaryWhite in the path scheme
	bonusDelimiter    = bonusBoundary + 1 // fzf's bonusBoundaryDelimiter
	// bonusBasename is ours: added to every character matched in the
	// basename, so a basename hit beats the same hit in a directory while a
	// boundary hit in a directory still beats a mid-word basename hit.
	bonusBasename = scoreMatch / 4
)

type charClass uint8

const (
	charWhite charClass = iota
	charNonWord
	charDelimiter
	charLower
	charUpper
	charLetter
	charNumber
	numClasses
)

// bonusMatrix is fzf's bonusFor(previous, current) with the path scheme's
// values.
var bonusMatrix = [numClasses][numClasses]int32{
	charWhite:     {bonusWhite, bonusWhite, bonusWhite, bonusWhite, bonusWhite, bonusWhite, bonusWhite},
	charNonWord:   {bonusWhite, bonusNonWord, bonusNonWord, bonusBoundary, bonusBoundary, bonusBoundary, bonusBoundary},
	charDelimiter: {bonusWhite, bonusDelimiter, bonusDelimiter, bonusDelimiter, bonusDelimiter, bonusDelimiter, bonusDelimiter},
	charLower:     {bonusWhite, bonusNonWord, bonusNonWord, 0, bonusCamel123, 0, bonusCamel123},
	charUpper:     {bonusWhite, bonusNonWord, bonusNonWord, 0, 0, 0, bonusCamel123},
	charLetter:    {bonusWhite, bonusNonWord, bonusNonWord, 0, 0, 0, bonusCamel123},
	charNumber:    {bonusWhite, bonusNonWord, bonusNonWord, 0, 0, 0, 0},
}

var asciiClass [utf8.RuneSelf]charClass

func init() {
	for c := range utf8.RuneSelf {
		switch {
		case c >= 'a' && c <= 'z':
			asciiClass[c] = charLower
		case c >= 'A' && c <= 'Z':
			asciiClass[c] = charUpper
		case c >= '0' && c <= '9':
			asciiClass[c] = charNumber
		case c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r':
			asciiClass[c] = charWhite
		case c == '/':
			asciiClass[c] = charDelimiter
		default:
			asciiClass[c] = charNonWord
		}
	}
}

func classOf(r rune) charClass {
	if r < utf8.RuneSelf {
		return asciiClass[r]
	}
	switch {
	case unicode.IsLower(r):
		return charLower
	case unicode.IsUpper(r):
		return charUpper
	case unicode.IsNumber(r):
		return charNumber
	case unicode.IsLetter(r):
		return charLetter
	case unicode.IsSpace(r):
		return charWhite
	}
	return charNonWord
}

// Candidate is a path prepared once (at index build time) for matching.
type Candidate struct {
	// Path is the path as given.
	Path string
	// lower is Path lowercased when Path is ASCII (Path itself when it has
	// no uppercase letter); wide holds a non-ASCII path's runes.
	lower string
	wide  *wideText
	// n is Path's length in runes, base the rune offset of its basename.
	n, base int32
}

type wideText struct{ runes, lower []rune }

// Prepare prepares path (valid UTF-8) for matching.
func Prepare(path string) Candidate {
	c := Candidate{Path: path}
	ascii := true
	for i := 0; i < len(path); i++ {
		if path[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		c.lower = asciiLower(path)
		c.n = int32(len(path))
		c.base = int32(strings.LastIndexByte(path, '/') + 1)
		return c
	}
	runes := []rune(path)
	lower := make([]rune, len(runes))
	for i, r := range runes {
		lower[i] = unicode.ToLower(r)
		if r == '/' {
			c.base = int32(i + 1)
		}
	}
	c.wide = &wideText{runes: runes, lower: lower}
	c.n = int32(len(runes))
	return c
}

func asciiLower(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 'a' - 'A'
				}
			}
			return string(b)
		}
	}
	return s
}

// Query is a prepared query with its scratch space: not safe for
// concurrent use (one per search).
type Query struct {
	runes     []rune // lowercased unless sensitive
	ascii     []byte // runes as bytes when all are ASCII, else nil
	sensitive bool

	// scratch
	text   []rune
	bonus  []int32
	first  []int32
	last   []int32
	rows   [2][]int32 // M of the previous and current pattern row
	runs   [2][]int32 // consecutive run length per cell of those rows
	gap    []int32
	matM   []int32 // full matrices, for positions
	matRun []int32
	matDia []bool
}

// NewQuery prepares q: smart case (sensitive when q has an uppercase
// letter), every character literal.
func NewQuery(q string) *Query {
	qq := &Query{}
	for _, r := range q {
		if unicode.IsUpper(r) {
			qq.sensitive = true
			break
		}
	}
	ascii := true
	for _, r := range q {
		if !qq.sensitive {
			r = unicode.ToLower(r)
		}
		qq.runes = append(qq.runes, r)
		ascii = ascii && r < utf8.RuneSelf
	}
	if ascii {
		qq.ascii = make([]byte, len(qq.runes))
		for i, r := range qq.runes {
			qq.ascii[i] = byte(r)
		}
	}
	return qq
}

// Empty reports whether the query has no characters.
func (q *Query) Empty() bool { return len(q.runes) == 0 }

// Score matches path against query: its score, the ascending rune offsets
// of the matched characters, and whether it matched at all. An empty query
// matches everything with score 0 and no positions.
func Score(query, path string) (score int, positions []int, ok bool) {
	c := Prepare(path)
	return NewQuery(query).Match(&c, true)
}

// Match scores c against q; positions only when withPos.
func (q *Query) Match(c *Candidate, withPos bool) (score int, positions []int, ok bool) {
	m := len(q.runes)
	if m == 0 {
		return 0, []int{}, true
	}
	if int(c.n) < m {
		return 0, nil, false
	}
	// The text compared with the pattern: lowercased unless sensitive. The
	// classes always come from the path as written (camelCase).
	n := int(c.n)
	if cap(q.text) < n {
		q.text = make([]rune, n, n*2)
	}
	text := q.text[:n]
	if c.wide == nil {
		if q.ascii == nil { // a non-ASCII rune never matches an ASCII path
			return 0, nil, false
		}
		src := c.lower
		if q.sensitive {
			src = c.Path
		}
		if !subsequenceASCII(q.ascii, src) {
			return 0, nil, false
		}
		for i := 0; i < n; i++ {
			text[i] = rune(src[i])
		}
	} else {
		src := c.wide.lower
		if q.sensitive {
			src = c.wide.runes
		}
		copy(text, src)
	}
	if m == 1 {
		return q.matchOne(c, text, withPos)
	}
	if !q.bounds(text) {
		return 0, nil, false
	}
	q.bonuses(c)
	if !withPos {
		return int(q.scoreOnly(text, c.base)), nil, true
	}
	s, pos := q.scoreWithPositions(text, c.base)
	return int(s), pos, true
}

// matchOne is Match for a one-rune query: the best single occurrence (the
// earliest on a tie), no matrix.
func (q *Query) matchOne(c *Candidate, text []rune, withPos bool) (int, []int, bool) {
	r := q.runes[0]
	best, at := negInf, -1
	prev := charDelimiter
	for j, t := range text {
		var cur charClass
		if c.wide == nil {
			cur = asciiClass[c.Path[j]]
		} else {
			cur = classOf(c.wide.runes[j])
		}
		if t == r {
			if s := scoreMatch + bonusMatrix[prev][cur]*bonusFirstCharMul + q.basenameBonus(j, c.base); s > best {
				best, at = s, j
			}
		}
		prev = cur
	}
	if at < 0 {
		return 0, nil, false
	}
	if !withPos {
		return int(best), nil, true
	}
	return int(best), []int{at}, true
}

// subsequenceASCII reports whether p is a subsequence of s.
func subsequenceASCII(p []byte, s string) bool {
	at := 0
	for _, b := range p {
		i := strings.IndexByte(s[at:], b)
		if i < 0 {
			return false
		}
		at += i + 1
	}
	return true
}

// bounds sets first[i] and last[i], the earliest and latest offsets the
// i-th pattern rune can match at; false when the pattern is no subsequence.
func (q *Query) bounds(text []rune) bool {
	m, n := len(q.runes), len(text)
	q.first = grow(q.first, m)
	q.last = grow(q.last, m)
	j := 0
	for i, r := range q.runes {
		for j < n && text[j] != r {
			j++
		}
		if j == n {
			return false
		}
		q.first[i] = int32(j)
		j++
	}
	j = n - 1
	for i := m - 1; i >= 0; i-- {
		for text[j] != q.runes[i] {
			j--
		}
		q.last[i] = int32(j)
		j--
	}
	return true
}

// bonuses sets bonus[j] for every offset of c's path.
func (q *Query) bonuses(c *Candidate) {
	n := int(c.n)
	q.bonus = grow(q.bonus, n)
	prev := charDelimiter
	for j := 0; j < n; j++ {
		var r rune
		if c.wide == nil {
			r = rune(c.Path[j])
		} else {
			r = c.wide.runes[j]
		}
		cur := classOf(r)
		q.bonus[j] = bonusMatrix[prev][cur]
		prev = cur
	}
}

const negInf = int32(-1 << 28)

// cell computes M[i][j] (pattern rune i matched at offset j) from the
// previous row's diagonal M[i-1][j-1] (with its run length) and the best
// gapped predecessor: the score and the run length it ends.
func (q *Query) cell(i, j int, diag, diagRun, gapped int32, base int32) (score, run int32, fromDiag bool) {
	b := q.bonus[j]
	if i == 0 {
		return scoreMatch + b*bonusFirstCharMul + q.basenameBonus(j, base), 1, false
	}
	score, run = negInf, 0
	if gapped > negInf {
		score, run = gapped+scoreMatch+b, 1
	}
	if diag > negInf {
		cb, crun := b, diagRun+1
		fb := q.bonus[j-int(diagRun)] // the run's first offset
		if b >= bonusBoundary && b > fb {
			crun = 1 // a stronger boundary starts a new run
		} else {
			cb = max(b, bonusConsecutive, fb)
		}
		if s := diag + scoreMatch + cb; s >= score {
			score, run, fromDiag = s, crun, true
		}
	}
	if score > negInf {
		score += q.basenameBonus(j, base)
	}
	return score, run, fromDiag
}

func (q *Query) basenameBonus(j int, base int32) int32 {
	if int32(j) >= base {
		return bonusBasename
	}
	return 0
}

// fillRow computes pattern row i over its window from the previous row
// (pM, pR; unused for i == 0) into M and R, and D (which predecessor won)
// when D is not nil. It returns the row's best score.
func (q *Query) fillRow(i int, text []rune, base int32, pM, pR, M, R []int32, D []bool) int32 {
	r := q.runes[i]
	lo, hi := int(q.first[i]), int(q.last[i])
	best := negInf
	start := lo
	var plo, phi int
	if i > 0 {
		plo, phi = int(q.first[i-1]), int(q.last[i-1])
		start = min(lo, plo+2) // fold every k >= plo into the gap first
	}
	// gapped: the best M[i-1][k] + gap penalty for the gap k+1 … j-1.
	gapped := negInf
	for j := start; j <= hi; j++ {
		if i > 0 {
			if gapped > negInf {
				gapped += scoreGapExtension
			}
			if k := j - 2; k >= plo && k <= phi && pM[k] > negInf {
				gapped = max(gapped, pM[k]+scoreGapStart)
			}
		}
		if j < lo {
			continue
		}
		if text[j] != r {
			M[j], R[j] = negInf, 0
			continue
		}
		diag, diagRun := negInf, int32(0)
		if i > 0 && j-1 >= plo && j-1 <= phi {
			diag, diagRun = pM[j-1], pR[j-1]
		}
		var fromDiag bool
		M[j], R[j], fromDiag = q.cell(i, j, diag, diagRun, gapped, base)
		if D != nil {
			D[j] = fromDiag
		}
		best = max(best, M[j])
	}
	return best
}

// scoreOnly is the best score, two rows at a time.
func (q *Query) scoreOnly(text []rune, base int32) int32 {
	m, n := len(q.runes), len(text)
	for k := range 2 {
		q.rows[k] = grow(q.rows[k], n)
		q.runs[k] = grow(q.runs[k], n)
	}
	prev, cur := 0, 1
	var best int32
	for i := range m {
		best = q.fillRow(i, text, base, q.rows[prev], q.runs[prev], q.rows[cur], q.runs[cur], nil)
		prev, cur = cur, prev
	}
	return best
}

// scoreWithPositions is the best score and its alignment: the full
// matrices, then a walk back from the best end (the earliest on a tie).
func (q *Query) scoreWithPositions(text []rune, base int32) (int32, []int) {
	m, n := len(q.runes), len(text)
	q.matM = grow(q.matM, m*n)
	q.matRun = grow(q.matRun, m*n)
	if cap(q.matDia) < m*n {
		q.matDia = make([]bool, m*n, m*n*2)
	}
	q.matDia = q.matDia[:m*n]
	row := func(s []int32, i int) []int32 { return s[i*n : (i+1)*n] }
	var best int32
	for i := range m {
		var pM, pR []int32
		if i > 0 {
			pM, pR = row(q.matM, i-1), row(q.matRun, i-1)
		}
		best = q.fillRow(i, text, base, pM, pR, row(q.matM, i), row(q.matRun, i), q.matDia[i*n:(i+1)*n])
	}
	pos := make([]int, m)
	j := -1
	last := row(q.matM, m-1)
	for k := int(q.first[m-1]); k <= int(q.last[m-1]); k++ {
		if text[k] == q.runes[m-1] && last[k] == best {
			j = k
			break
		}
	}
	for i := m - 1; ; i-- {
		pos[i] = j
		if i == 0 {
			break
		}
		if q.matDia[i*n+j] {
			j--
			continue
		}
		// The gapped predecessor: the k <= j-2 that gave M[i][j].
		pM := row(q.matM, i-1)
		want := row(q.matM, i)[j] - scoreMatch - q.bonus[j] - q.basenameBonus(j, base)
		lo := int(q.first[i-1])
		found := -1
		for k := min(j-2, int(q.last[i-1])); k >= lo; k-- {
			if text[k] == q.runes[i-1] && pM[k] > negInf && pM[k]+scoreGapStart+int32(j-2-k)*scoreGapExtension == want {
				found = k
				break
			}
		}
		j = found
	}
	return best, pos
}

func grow(s []int32, n int) []int32 {
	if cap(s) < n {
		return make([]int32, n, n*2)
	}
	return s[:n]
}
