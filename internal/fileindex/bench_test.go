package fileindex

import (
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// synthListing is n distinct file paths shaped like a large monorepo: a
// few top-level trees, 2–7 levels deep, mixed naming styles.
func synthListing(n int) []string {
	rng := rand.New(rand.NewPCG(11, 13))
	top := []string{"src", "internal", "packages", "services", "docs", "tools", "test", "vendor"}
	mid := []string{"api", "core", "ui", "server", "client", "store", "auth", "billing", "search", "worker", "utils", "models"}
	leaf := []string{"index", "main", "handler", "router", "config", "Button", "user_service", "fileIndex", "README", "types"}
	ext := []string{".go", ".ts", ".tsx", ".md", ".json", "_test.go", ".spec.ts", ".css"}
	seen := map[string]bool{}
	out := make([]string, 0, n)
	for len(out) < n {
		p := top[rng.IntN(len(top))]
		for range 1 + rng.IntN(6) {
			p += "/" + mid[rng.IntN(len(mid))]
			if rng.IntN(3) == 0 {
				p += fmt.Sprint(rng.IntN(40))
			}
		}
		p += "/" + leaf[rng.IntN(len(leaf))] + fmt.Sprint(rng.IntN(200)) + ext[rng.IntN(len(ext))]
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func benchQuery(b *testing.B, n int) {
	s := newSnapshot(synthListing(n), proto.FilesSourceGit, "", DefaultMaxEntries)
	b.Logf("%d files, %d entries with directories", n, len(s.cands))
	for _, q := range []string{"", "u", "button", "srvwrk", "internal/server/handler", "zzz"} {
		b.Run("q="+q, func(b *testing.B) {
			for b.Loop() {
				s.search(q, proto.FilesDefaultLimit)
			}
		})
	}
}

func BenchmarkQuery50k(b *testing.B)  { benchQuery(b, 50_000) }
func BenchmarkQuery200k(b *testing.B) { benchQuery(b, 200_000) }

func BenchmarkBuild200k(b *testing.B) {
	paths := synthListing(200_000)
	for b.Loop() {
		newSnapshot(paths, proto.FilesSourceGit, "", DefaultMaxEntries)
	}
}
