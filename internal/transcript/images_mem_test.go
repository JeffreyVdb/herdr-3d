package transcript

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// A page of image-heavy lines does not keep every line's base64 alive while
// it is built: what is held is bounded by bytes, not by the page.
func TestPageDoesNotRetainEveryImageLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const lines = 64
	for i := 0; i < lines; i++ {
		data := append(pngBytes(t, 1, 1, i), make([]byte, 1<<20)...)
		data[len(data)-1] = byte(i)
		if _, err := f.WriteString(claudeUserLine(t, fmt.Sprintf("u%d", i), claudeImg("image/png", data))); err != nil {
			t.Fatal(err)
		}
	}
	f.Close()
	// A cache too small to hold the images: what the page keeps is not
	// hiding in it.
	im := newImages(t, 2<<20)
	l, err := Read(context.Background(), Claude, path, WithImages(im))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	original := l.parse
	var peak uint64
	l.parse = func(off int64, b []byte) ([]contrib, string) {
		cs, v := original(off, b)
		runtime.GC()
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		peak = max(peak, m.HeapAlloc)
		return cs, v
	}
	p, err := l.Before(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != lines {
		t.Fatalf("%d items, want %d", len(p.Items), lines)
	}
	for i, it := range p.Items {
		if r := refsOf(it); len(r) != 1 || r[0].Hash == "" {
			t.Fatalf("item %d: %+v", i, r)
		}
	}
	// 64 lines of ~1.4 MiB were 90 MiB live before; a few lines are held now.
	if grew := int64(peak) - int64(base.HeapAlloc); grew > 40<<20 {
		t.Errorf("the page held %d MiB live while it was built", grew>>20)
	}
}
