package promptsecret

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"math"
	"math/rand/v2"
	"strings"
	"testing"
)

// byteEntropy is the Gitleaks formula (shannonEntropy) over bytes: the same
// value on ASCII, which every run is.
func TestByteEntropyIsGitleaksFormula(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 163))
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/_-"
	for range 200 {
		b := make([]byte, 32+r.IntN(200))
		for i := range b {
			b[i] = alphabet[r.IntN(1+r.IntN(len(alphabet)))]
		}
		if a, g := byteEntropy(string(b)), shannonEntropy(string(b)); math.Abs(a-g) > 1e-9 {
			t.Fatalf("%q: %v and %v", b, a, g)
		}
	}
}

// A review made under the previous rule set (before #163) is stale: its
// revision is refused by Check and CheckScan, however the decisions fit,
// so nothing is sent after a confirmation the new detector never saw. The
// candidates are the same under both (a token the old rules found), so
// only the version differs.
func TestRevisionOfTheOldRulesIsStale(t *testing.T) {
	const oldRules = "gitleaks-v8.30.1+structural-1"
	if RulesVersion == oldRules {
		t.Fatal("the rules version did not change")
	}
	key := []byte("0123456789abcdef0123456789abcdef")
	r := NewReviewer(key, nil)
	text := "PASSWORD=Hunter2! and the token is ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	rev := r.Scan(text)
	cands := make([]Candidate, len(rev.Found))
	for i, f := range rev.Found {
		cands[i] = f.Candidate
	}
	m := hmac.New(sha256.New, key)
	m.Write(scanBytesUnder(oldRules, "h3d-prompt-secrets/1", text, cands))
	old := base64.RawURLEncoding.EncodeToString(m.Sum(nil))
	if old == rev.Revision {
		t.Fatal("the revision does not depend on the rules version")
	}
	ds := []Decision{{Candidate: "c1", Protect: true}, {Candidate: "c2", Protect: true}}
	for name, call := range map[string]func() error{
		"Check":     func() error { _, err := r.Check(text, old, ds); return err },
		"CheckScan": func() error { _, err := r.CheckScan(text, rev, old, ds); return err },
	} {
		var re *ReviewError
		if err := call(); !errors.As(err, &re) || !re.Stale {
			t.Errorf("%s: the old revision is not refused as stale: %v", name, err)
		}
	}
	if _, err := r.Check(text, rev.Revision, ds); err != nil {
		t.Fatalf("the current revision: %v", err)
	}
	// The stored digest of a prompt is also under the rules.
	digest := func(version string) string {
		s := sha256.Sum256(scanBytesUnder(version, "h3d-prompt-secrets-stored/1", text, cands))
		return base64.RawURLEncoding.EncodeToString(s[:])
	}
	if digest(oldRules) == StoredDigest(text, rev) || digest(RulesVersion) != StoredDigest(text, rev) {
		t.Error("the stored digest does not follow the rules version")
	}
}

// BenchmarkEntropySpans is the entropy pass alone over 32 KiB of prose, of
// prose with long tokens, and of near-misses it reads and drops (#163 AC4:
// next to a whole scan's tens of ms).
func BenchmarkEntropySpans(b *testing.B) {
	r := rand.New(rand.NewPCG(2, 163))
	word := func(alphabet string, n int) string {
		w := make([]byte, n)
		for i := range w {
			w[i] = alphabet[r.IntN(len(alphabet))]
		}
		return string(w)
	}
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	fit := func(unit string) string { return strings.Repeat(unit, 32<<10/len(unit)+1)[:32<<10] }
	prose := strings.Repeat("Review the module and keep its behavior. ", 8)
	for name, text := range map[string]string{
		"prose":  fit(prose),
		"tokens": fit(prose + "Actually, token is this one: " + word(letters, 64) + ". Also " + word(letters+"0123456789", 128) + ", then " + word(letters+"+/", 64) + "==. "),
		"misses": fit(prose + "Revert " + word("0123456789abcdef", 40) + " in internal/promptsecret/structural_test.go image@sha256:" + word("0123456789abcdef", 64) +
			" " + word(letters, 40) + ".png see https://example.test/" + word(letters, 64) + "/x " + word(letters, 600) + " "),
	} {
		b.Run(name, func(b *testing.B) {
			b.SetBytes(int64(len(text)))
			for b.Loop() {
				entropySpans(text, nil)
			}
		})
	}
}
