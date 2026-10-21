//go:build ignore

// open times what a transcript.watch waits for on the bridge: the index
// build of the whole file (transcript.Follow → Ready) and the first page
// (Subscribe(200)), plus the page's JSON size, and (#149) the index's
// estimated Footprint beside the heap it holds after a GC. Usage:
//
//	go run docs/research/transcript-open-bench/open.go claude|codex FILE...
//
// With OUT set (a private directory), the first page of each file is
// written there as OUT/<harness>-<n>.json ({"items": [...]}) for
// browser.mjs: it holds transcript text, keep it out of the repository.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

func main() {
	harness := os.Args[1]
	for n, path := range os.Args[2:] {
		fi, err := os.Stat(path)
		if err != nil {
			panic(err)
		}
		for pass := 0; pass < 3; pass++ {
			before := heap()
			t0 := time.Now()
			l, err := transcript.Follow(harness, path, fi, fi.Size())
			if err != nil {
				panic(err)
			}
			<-l.Ready()
			if l.Err() != nil {
				panic(l.Err())
			}
			built := time.Since(t0)
			held := heap() - before
			t1 := time.Now()
			s, page, err := l.Subscribe(200)
			if err != nil {
				panic(err)
			}
			first := time.Since(t1)
			t2 := time.Now()
			b, _ := json.Marshal(page.Items)
			enc := time.Since(t2)
			fmt.Printf("%7.1f MB entries=%6d build=%6.0f ms page=%5.0f ms items=%3d json=%5.0f KB enc=%4.0f ms footprint=%6.1f MB heap=%6.1f MB pass=%d\n",
				float64(fi.Size())/1e6, l.Len(), ms(built), ms(first), len(page.Items), float64(len(b))/1e3, ms(enc),
				float64(l.Footprint())/1e6, float64(held)/1e6, pass)
			if out := os.Getenv("OUT"); out != "" && pass == 0 {
				ack, _ := json.Marshal(map[string]any{"items": page.Items, "file_mb": float64(fi.Size()) / 1e6, "build_ms": ms(built), "page_ms": ms(first)})
				if err := os.WriteFile(filepath.Join(out, fmt.Sprintf("%s-%02d.json", harness, n)), ack, 0o600); err != nil {
					panic(err)
				}
			}
			s.Close()
			l.Close()
		}
	}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1e3 }

// heap is the live heap after a GC.
func heap() int64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.HeapAlloc)
}
