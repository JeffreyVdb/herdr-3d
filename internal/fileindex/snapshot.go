package fileindex

import (
	"cmp"
	"fmt"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/fuzzy"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// snapshot is one built index of a checkout: immutable once built, so
// queries read it without a lock.
type snapshot struct {
	cands  []fuzzy.Candidate
	dir    []bool // dir[i]: cands[i] is a directory
	source string
	reason string
}

// validPath reports whether p (as a lister printed it) names something
// inside the checkout: valid UTF-8 (the protocol is JSON), relative, clean,
// no ".." or ".git" component. Anything else is dropped, never repaired.
func validPath(p string) bool {
	if p == "" || p == "." || !utf8.ValidString(p) || strings.ContainsRune(p, 0) || path.IsAbs(p) || path.Clean(p) != p {
		return false
	}
	for c := range strings.SplitSeq(p, "/") {
		if c == ".." || c == ".git" {
			return false
		}
	}
	return true
}

// noFiles is the reason of an index with no entries: nothing was listed,
// or nothing listed was valid.
const noFiles = "the checkout has no files to search"

// newSnapshot builds the index of the files listed: the valid ones, plus
// every directory above them, at most max paths in all (reason says when
// some were left out, or when there are none). Order (an empty query's answer): shallow first, a
// depth's directories before its files, then byte order.
func newSnapshot(paths []string, source, reason string, max int) *snapshot {
	type ent struct {
		path  string
		dir   bool
		depth int
	}
	files := make(map[string]struct{}, len(paths))
	dirs := map[string]struct{}{}
	var ents []ent
	full := false
	for _, p := range paths {
		p = strings.TrimPrefix(p, "./")
		if !validPath(p) {
			continue
		}
		if _, dup := files[p]; dup {
			continue
		}
		// The file and the directories above it not seen yet.
		var add []ent
		add = append(add, ent{p, false, strings.Count(p, "/")})
		for d := path.Dir(p); d != "."; d = path.Dir(d) {
			if _, seen := dirs[d]; seen {
				break
			}
			add = append(add, ent{d, true, strings.Count(d, "/")})
		}
		if len(ents)+len(add) > max {
			full = true
			break
		}
		files[p] = struct{}{}
		for _, e := range add[1:] {
			dirs[e.path] = struct{}{}
		}
		ents = append(ents, add...)
	}
	if full {
		reason = joinReason(reason, fmt.Sprintf("the checkout has more than %d files and directories; only %d are searched",
			max, len(ents)))
	}
	if len(ents) == 0 {
		reason = joinReason(reason, noFiles)
	}
	// A path listed as a file and needed as a directory (a tracked file
	// replaced by a directory) is kept once, as the file.
	ents = slices.DeleteFunc(ents, func(e ent) bool {
		_, isFile := files[e.path]
		return e.dir && isFile
	})
	slices.SortFunc(ents, func(a, b ent) int {
		if c := cmp.Compare(a.depth, b.depth); c != 0 {
			return c
		}
		if a.dir != b.dir {
			if a.dir {
				return -1
			}
			return 1
		}
		return strings.Compare(a.path, b.path)
	})
	s := &snapshot{cands: make([]fuzzy.Candidate, len(ents)), dir: make([]bool, len(ents)), source: source, reason: reason}
	for i, e := range ents {
		s.cands[i] = fuzzy.Prepare(e.path)
		s.dir[i] = e.dir
	}
	return s
}

// search is the best limit matches of query: for an empty query the first
// limit paths in the snapshot's order.
func (s *snapshot) search(query string, limit int) []proto.FileMatch {
	out := []proto.FileMatch{}
	if query == "" {
		for i := range min(limit, len(s.cands)) {
			out = append(out, proto.FileMatch{Path: s.cands[i].Path, Kind: s.kind(i), Indices: []int{}})
		}
		return out
	}
	for _, r := range fuzzy.Search(fuzzy.NewQuery(query), s.cands, limit) {
		out = append(out, proto.FileMatch{Path: s.cands[r.Index].Path, Kind: s.kind(r.Index), Indices: r.Positions})
	}
	return out
}

func (s *snapshot) kind(i int) string {
	if s.dir[i] {
		return proto.FileKindDir
	}
	return proto.FileKindFile
}

func joinReason(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	}
	return a + "; " + b
}
