package fuzzy

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

func TestScoreMatches(t *testing.T) {
	for _, tc := range []struct {
		query, path string
		ok          bool
		pos         []int
	}{
		{"", "a/b.go", true, []int{}},
		{"abc", "abc", true, []int{0, 1, 2}},
		{"abc", "ab", false, nil},
		{"abc", "acb", false, nil},
		{"abc", "a/b/c", true, []int{0, 2, 4}},
		// Smart case: lowercase matches either case; an uppercase letter
		// makes the whole query case-sensitive.
		{"readme", "README.md", true, []int{0, 1, 2, 3, 4, 5}},
		{"README", "readme.md", false, nil},
		{"ReadMe", "docs/ReadMe.md", true, []int{5, 6, 7, 8, 9, 10}},
		// Spaces are literal characters, matched and highlighted.
		{"my file", "docs/my file.md", true, []int{5, 6, 7, 8, 9, 10, 11}},
		{"my file", "docs/myfile.md", false, nil},
		// Odd characters are plain characters.
		{"#1?", "notes/#1 what?.md", true, []int{6, 7, 13}},
		// Rune offsets, not bytes: é is two bytes.
		{"éé", "café/thé.txt", true, []int{3, 7}},
		{"ée", "café/thé.txt", false, nil},
		{"ÉCOLE", "docs/école.md", false, nil},
		{"école", "docs/ÉCOLE.md", true, []int{5, 6, 7, 8, 9}},
		{"日本", "文書/日本語.txt", true, []int{3, 4}},
		// The basename's hit, not the directory's.
		{"main", "domain/main.go", true, []int{7, 8, 9, 10}},
		{"foo", "foo/foo", true, []int{4, 5, 6}},
	} {
		t.Run(tc.query+"|"+tc.path, func(t *testing.T) {
			_, pos, ok := Score(tc.query, tc.path)
			if ok != tc.ok || !slices.Equal(pos, tc.pos) {
				t.Fatalf("Score(%q, %q) = %v %v, want %v %v", tc.query, tc.path, pos, ok, tc.pos, tc.ok)
			}
			if ok && !slices.IsSorted(pos) {
				t.Fatalf("positions not ascending: %v", pos)
			}
		})
	}
}

// better asserts that query ranks a above b.
func better(t *testing.T, query, a, b string) {
	t.Helper()
	sa, pa, oka := Score(query, a)
	sb, pb, okb := Score(query, b)
	if !oka || !okb {
		t.Fatalf("%q: no match (%q %v, %q %v)", query, a, oka, b, okb)
	}
	if sa <= sb {
		t.Errorf("%q: %q (%d %v) should beat %q (%d %v)", query, a, sa, pa, b, sb, pb)
	}
}

func TestScoreOrder(t *testing.T) {
	// A basename hit beats the same hit in a directory.
	better(t, "foo", "src/foo.go", "foo/bar.go")
	better(t, "button", "ui/button.ts", "button/index.ts")
	// A boundary beats mid-word: after / - _ . space, camelCase, a digit.
	better(t, "bar", "foo_bar.go", "foobar.go")
	better(t, "bar", "foo-bar.go", "foobar.go")
	better(t, "bar", "foo.bar", "foobar.c")
	better(t, "bar", "foo bar.go", "foobar.go")
	better(t, "bar", "fooBar.go", "foobar.go")
	better(t, "b", "x/b", "xb")
	better(t, "2", "a2", "12")
	// Consecutive beats scattered.
	better(t, "abc", "xabcx", "xaxbxcx")
	better(t, "conf", "config.go", "c_o_n_f.go")
	// A boundary in a directory still beats a mid-word basename hit, and
	// the directory itself beats the files in it.
	better(t, "ui", "src/ui/index.ts", "src/build.ts")
	better(t, "src/ui", "src/ui", "src/ui/index.ts")
	// An exact-case hit scores like a folded one (smart case only gates).
	if a, _, _ := Score("main", "Main.go"); a == 0 {
		t.Error("zero score")
	}
}

func TestScoreOnlyAgreesWithPositions(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	paths := synthPaths(rng, 3000)
	for _, query := range []string{"a", "s", "src", "ui", "cfg", "tst", "go", "intidx", "a/b", "Ab", "é", "x y"} {
		q := NewQuery(query)
		for _, p := range paths {
			c := Prepare(p)
			s1, _, ok1 := q.Match(&c, false)
			s2, pos, ok2 := q.Match(&c, true)
			if ok1 != ok2 || s1 != s2 {
				t.Fatalf("%q in %q: score-only %d %v, with positions %d %v", query, p, s1, ok1, s2, ok2)
			}
			if !ok2 {
				continue
			}
			// The positions spell the query and rescore to the score.
			runes := []rune(p)
			if len(pos) != len([]rune(query)) || !slices.IsSorted(pos) {
				t.Fatalf("%q in %q: positions %v", query, p, pos)
			}
			for i, r := range []rune(query) {
				if got := runes[pos[i]]; got != r && !strings.EqualFold(string(got), string(r)) {
					t.Fatalf("%q in %q: position %d is %q", query, p, pos[i], got)
				}
			}
			if got := rescore(&c, q, pos); got != s2 {
				t.Fatalf("%q in %q: positions %v rescore to %d, score %d", query, p, pos, got, s2)
			}
		}
	}
}

// rescore is fzf's calculateScore for given positions, with the basename
// bonus: an independent check of the DP's alignment.
func rescore(c *Candidate, q *Query, pos []int) int {
	runes := []rune(c.Path)
	class := func(j int) charClass {
		if j < 0 {
			return charDelimiter
		}
		return classOf(runes[j])
	}
	score, run := 0, 0
	var firstBonus int32
	for i, j := range pos {
		b := bonusMatrix[class(j-1)][class(j)]
		s := scoreMatch
		if i > 0 && pos[i-1] == j-1 {
			if b >= bonusBoundary && b > firstBonus {
				run, firstBonus = 1, b
			} else {
				run++
				b = max(b, bonusConsecutive, firstBonus)
			}
		} else {
			if i > 0 {
				gap := j - pos[i-1] - 1
				s += scoreGapStart + (gap-1)*scoreGapExtension
			}
			run, firstBonus = 1, b
		}
		if i == 0 {
			b *= bonusFirstCharMul
		}
		s += int(b)
		if int32(j) >= c.base {
			s += bonusBasename
		}
		score += s
	}
	_ = run
	return score
}

func TestSearch(t *testing.T) {
	paths := []string{"b.go", "a.go", "src/a.go", "src/ui", "src/ui/button.ts", "docs/my file.md", "zz/a"}
	cands := make([]Candidate, len(paths))
	for i, p := range paths {
		cands[i] = Prepare(p)
	}
	got := func(query string, limit int) []string {
		var out []string
		for _, r := range Search(NewQuery(query), cands, limit) {
			out = append(out, fmt.Sprintf("%s%v", paths[r.Index], r.Positions))
		}
		return out
	}
	// Ties: the shorter path, then byte order.
	if g := got("a", 3); !slices.Equal(g, []string{"a.go[0]", "zz/a[3]", "src/a.go[4]"}) {
		t.Fatalf("a = %v", g)
	}
	if g := got("ui", 10); len(g) != 2 || g[0] != "src/ui[4 5]" {
		t.Fatalf("ui = %v", g)
	}
	if g := got("nomatch", 10); len(g) != 0 {
		t.Fatalf("nomatch = %v", g)
	}
	if g := got("a", 0); len(g) != 0 {
		t.Fatalf("limit 0 = %v", g)
	}
}

var dirs = []string{"src", "internal", "cmd", "pkg", "lib", "test", "docs", "game", "tools", "assets", "ui", "net",
	"server", "client", "proto", "store", "world", "harness", "fixtures", "vendor", "node_modules", "components"}
var words = []string{"index", "main", "config", "button", "handler", "router", "util", "helper", "types", "store",
	"model", "view", "worker", "files", "changes", "commands", "session", "client", "server", "protocol", "Readme"}
var exts = []string{".go", ".ts", ".tsx", ".md", ".json", ".css", ".png", "_test.go", ".test.ts", ".yaml"}

// synthPaths makes n distinct realistic paths: 1–6 directories deep,
// mixed separators and case, a few non-ASCII and spaced names.
func synthPaths(rng *rand.Rand, n int) []string {
	seen := map[string]bool{}
	out := make([]string, 0, n)
	for len(out) < n {
		var b strings.Builder
		for range 1 + rng.IntN(6) {
			b.WriteString(dirs[rng.IntN(len(dirs))])
			if rng.IntN(4) == 0 {
				fmt.Fprintf(&b, "-%d", rng.IntN(50))
			}
			b.WriteByte('/')
		}
		w := words[rng.IntN(len(words))]
		switch rng.IntN(20) {
		case 0:
			w += " copy"
		case 1:
			w = "café-" + w
		case 2:
			w += "_" + strings.ToUpper(words[rng.IntN(len(words))][:1]) + words[rng.IntN(len(words))]
		}
		b.WriteString(w)
		fmt.Fprintf(&b, "%d", rng.IntN(100))
		b.WriteString(exts[rng.IntN(len(exts))])
		if p := b.String(); !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func benchSearch(b *testing.B, n int, query string) {
	rng := rand.New(rand.NewPCG(7, 9))
	paths := synthPaths(rng, n)
	cands := make([]Candidate, len(paths))
	for i, p := range paths {
		cands[i] = Prepare(p)
	}
	b.ResetTimer()
	for b.Loop() {
		Search(NewQuery(query), cands, 30)
	}
}

func BenchmarkSearch50k(b *testing.B) {
	for _, q := range []string{"s", "main", "srvhnd", "internal/server/worker", "zzzz"} {
		b.Run(q, func(b *testing.B) { benchSearch(b, 50_000, q) })
	}
}

func BenchmarkSearch200k(b *testing.B) {
	for _, q := range []string{"s", "main", "srvhnd", "internal/server/worker", "zzzz"} {
		b.Run(q, func(b *testing.B) { benchSearch(b, 200_000, q) })
	}
}

// Search over a list large enough to run in parallel returns exactly the
// best of a full sort.
func TestSearchParallelMatchesFullSort(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	paths := synthPaths(rng, 3*parallelChunk)
	cands := make([]Candidate, len(paths))
	for i, p := range paths {
		cands[i] = Prepare(p)
	}
	for _, query := range []string{"s", "main", "srvhnd", "Readme", "café"} {
		q := NewQuery(query)
		type scored struct {
			i, s int
		}
		var all []scored
		for i := range cands {
			if s, _, ok := q.Match(&cands[i], false); ok {
				all = append(all, scored{i, s})
			}
		}
		h := &topN{cands: cands}
		slices.SortFunc(all, func(a, b scored) int {
			switch {
			case h.less(Result{Index: a.i, Score: a.s}, Result{Index: b.i, Score: b.s}):
				return 1
			case h.less(Result{Index: b.i, Score: b.s}, Result{Index: a.i, Score: a.s}):
				return -1
			}
			return 0
		})
		got := Search(q, cands, 50)
		if len(got) != min(50, len(all)) {
			t.Fatalf("%q: %d results, want %d", query, len(got), min(50, len(all)))
		}
		for k, r := range got {
			if r.Index != all[k].i || r.Score != all[k].s {
				t.Fatalf("%q: result %d = %s (%d), want %s (%d)", query, k, paths[r.Index], r.Score, paths[all[k].i], all[k].s)
			}
		}
	}
}
