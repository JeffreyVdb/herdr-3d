package world

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode"
)

func TestNamesList(t *testing.T) {
	if len(Names) < 80 {
		t.Fatalf("only %d names, want at least 80", len(Names))
	}
	// Not exhaustive: the names most associated with Illumination's films.
	banned := map[string]bool{
		"kevin": true, "stuart": true, "bob": true, "dave": true, "jerry": true, "carl": true, "phil": true,
		"tim": true, "mark": true, "jorge": true, "otto": true, "norbert": true, "mel": true, "gru": true,
		"minion": true, "banana": true, "bello": true, "papoy": true, "nefario": true, "agnes": true,
		"edith": true, "margo": true, "vector": true, "lucy": true,
	}
	seen := map[string]bool{}
	for _, n := range Names {
		if len(n) == 0 || len(n) > 10 {
			t.Errorf("%q: names are 1-10 bytes", n)
		}
		if !unicode.IsUpper(rune(n[0])) || strings.ContainsAny(n, " 0123456789") {
			t.Errorf("%q: want one capitalised word without digits", n)
		}
		if banned[strings.ToLower(n)] {
			t.Errorf("%q is not ours to use", n)
		}
		if seen[n] {
			t.Errorf("%q is listed twice", n)
		}
		seen[n] = true
	}
}

func TestPickName(t *testing.T) {
	held, released := map[string]bool{}, map[string]time.Time{}
	first := PickName("6db1905e-9e85-42f4-911c-b05e31b84c68", held, released)
	if again := PickName("6db1905e-9e85-42f4-911c-b05e31b84c68", held, released); again != first {
		t.Fatalf("not stable: %q then %q", first, again)
	}
	// Fill a floor: every name of the list is handed out once, plain.
	for i := range len(Names) {
		n := PickName(strings.Repeat("x", i), held, released)
		if held[n] || !slices.Contains(Names, n) {
			t.Fatalf("%q handed out twice or not a plain name", n)
		}
		held[n] = true
	}
}

func TestPickNameRecyclesTheOldestRelease(t *testing.T) {
	base := time.Unix(1_790_000_000, 0)
	held, released := map[string]bool{}, map[string]time.Time{}
	for i, n := range Names {
		held[n] = true
		released[n] = base.Add(time.Duration(len(Names)-i) * time.Hour) // the last entry left first
	}
	for _, id := range []string{"a", "b", "c", "d"} {
		if got := PickName(id, held, released); got != Names[len(Names)-1] {
			t.Fatalf("PickName(%q) = %q, want the longest released %q", id, got, Names[len(Names)-1])
		}
	}
	// A name of a live worker (no release time) is never recycled, however
	// old the others are not.
	released[Names[len(Names)-1]] = time.Time{}
	delete(released, Names[len(Names)-2])
	if got := PickName("a", held, released); got != Names[len(Names)-3] {
		t.Fatalf("PickName = %q, want %q (the oldest release among names not owned)", got, Names[len(Names)-3])
	}
}

func TestPickNameAllOwned(t *testing.T) {
	held := map[string]bool{}
	for _, n := range Names {
		held[n] = true
	}
	seen := map[string]bool{}
	for i := range 300 {
		n := PickName(fmt.Sprint("w", i), held, nil)
		if strings.ContainsAny(n, "0123456789") || held[n] || !IsName(n) || len(strings.Fields(n)) != 2 {
			t.Fatalf("PickName = %q: want a new two-word name without digits", n)
		}
		held[n], seen[n] = true, true
	}
}

func TestPickable(t *testing.T) {
	held := map[string]bool{Names[0]: true}
	released := map[string]time.Time{Names[0]: time.Unix(1, 0)}
	if Pickable("nope", held, released) || Pickable(Names[0], held, released) || !Pickable(Names[1], held, released) {
		t.Fatal("while a name is free: only free names of the list")
	}
	for _, n := range Names {
		held[n] = true
		released[n] = time.Unix(1, 0)
	}
	released[Names[2]] = time.Time{}
	if !Pickable(Names[0], held, released) || Pickable(Names[2], held, released) {
		t.Fatal("list full: a released name may be recycled, a live worker's never")
	}
}

func TestIsName(t *testing.T) {
	for name, want := range map[string]bool{"Pixel": true, "Pixel 2": true, "Pixel 12": true, "Pixel Mochi": true, "Pixel Pixel 2": false, "Pixel Zzz": false, "Pixel 1": false,
		"Pixel 02": false, "Pixel x": false, "pixel": false, "CODE|x": false, "": false, "Pixel  2": false} {
		if got := IsName(name); got != want {
			t.Errorf("IsName(%q) = %v", name, got)
		}
	}
}
