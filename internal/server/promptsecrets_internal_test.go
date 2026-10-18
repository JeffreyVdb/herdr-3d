package server

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
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

// A scan past its timeout fails with no review, and what it still writes in
// its slot is never read (run with -race).
func TestScanSecretsTimeout(t *testing.T) {
	h := &Hub{opts: Options{SecretScanTimeout: time.Millisecond}}
	h.ps.slots = make(chan struct{}, maxSecretScans)
	rev := promptsecret.NewReviewer([]byte(strings.Repeat("k", 32)))
	r, err := h.scanSecrets(context.Background(), rev, strings.Repeat("a ", 8000)+"PASSWORD=Value77!")
	h.wg.Wait()
	if !errors.Is(err, errSecretsUnavailable) || r.Revision != "" || r.Found != nil {
		t.Fatalf("%+v %v", r, err)
	}
}
