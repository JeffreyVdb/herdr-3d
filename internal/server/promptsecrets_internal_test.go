package server

import (
	"errors"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// The scan takes a text whole or refuses it: never cut, never not UTF-8
// (JSON cannot carry that, so it is checked here).
func TestScannable(t *testing.T) {
	var bad *badArgsError
	for _, text := range []string{"\xff\xfe", string(make([]byte, herdr.MaxPrompt+1))} {
		if err := scannable(text, "text"); !errors.As(err, &bad) {
			t.Errorf("%d bytes: %v", len(text), err)
		}
	}
	if err := scannable("é🙂", "text"); err != nil {
		t.Fatal(err)
	}
}
