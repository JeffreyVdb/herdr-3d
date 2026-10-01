package whiteboard

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/append-vectors.json is [key, generateKeyBetween(key, null)] from
// fractional-indexing 3.2.0 itself (game/src/whiteboard/indexVectors.test.ts
// recomputes it with the package Excalidraw ships): 5000 appends from an
// empty scene, 1000 keys with fractions, the A/Z/a/z boundaries and the
// saturated integer parts.
func TestAppendIndexMatchesFractionalIndexing(t *testing.T) {
	b, err := os.ReadFile("testdata/append-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors [][2]string
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 6000 {
		t.Fatalf("%d vectors", len(vectors))
	}
	for _, v := range vectors {
		if !ValidIndex(v[0]) || !ValidIndex(v[1]) {
			t.Fatalf("%q -> %q: not valid", v[0], v[1])
		}
		got, err := AppendIndex(v[0])
		if err != nil || got != v[1] {
			t.Fatalf("AppendIndex(%q) = %q, %v; want %q", v[0], got, err, v[1])
		}
		if got <= v[0] {
			t.Fatalf("AppendIndex(%q) = %q does not sort after it", v[0], got)
		}
	}
}

func TestAppendIndexEmptyAndRefusals(t *testing.T) {
	if got, err := AppendIndex(""); err != nil || got != "a0" {
		t.Fatalf("empty scene: %q, %v", got, err)
	}
	for _, bad := range []string{"0", "a", "b0", "a0 ", "a00", "a0V0", "garbage!", "A" + strings.Repeat("0", 26), "~"} {
		if ValidIndex(bad) {
			t.Errorf("ValidIndex(%q) = true", bad)
		}
		if _, err := AppendIndex(bad); err == nil {
			t.Errorf("AppendIndex(%q) accepted", bad)
		}
	}
	for _, good := range []string{"a0", "a0V", "Zz", "b00", "A" + strings.Repeat("0", 26) + "V"} {
		if !ValidIndex(good) {
			t.Errorf("ValidIndex(%q) = false", good)
		}
	}
}
