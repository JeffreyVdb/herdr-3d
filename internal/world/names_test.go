package world

import (
	"strings"
	"testing"
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
	taken := map[string]bool{}
	first := PickName("6db1905e-9e85-42f4-911c-b05e31b84c68", taken)
	if again := PickName("6db1905e-9e85-42f4-911c-b05e31b84c68", taken); again != first {
		t.Fatalf("not stable: %q then %q", first, again)
	}
	// Fill a floor far past the list: every name stays unique.
	for i := 0; i < 2*len(Names)+5; i++ {
		n := PickName(strings.Repeat("x", i), taken)
		if taken[n] {
			t.Fatalf("%q handed out twice", n)
		}
		taken[n] = true
	}
	threes := 0
	for n := range taken {
		if strings.HasSuffix(n, " 3") {
			threes++
		}
	}
	if !taken[Names[0]+" 2"] || threes != 5 {
		t.Fatalf("exhausted list should suffix \" 2\", then \" 3\": %v", taken)
	}
}

func TestIsName(t *testing.T) {
	for name, want := range map[string]bool{"Pixel": true, "Pixel 2": true, "Pixel 12": true, "Pixel 1": false,
		"Pixel 02": false, "Pixel x": false, "pixel": false, "CODE|x": false, "": false, "Pixel  2": false} {
		if got := IsName(name); got != want {
			t.Errorf("IsName(%q) = %v", name, got)
		}
	}
}
