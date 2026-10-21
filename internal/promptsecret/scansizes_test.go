package promptsecret_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)

// sizedPrompts are prompts of n bytes: plain prose (the existing 16 KiB
// text), prose with several long tokens (the entropy rule's candidates:
// letters, base64, a repeat), and a prompt full of near-misses it reads and
// drops (hex ids, paths, long identifiers, base64 lines in a PEM block, a
// long word over the limit).
func sizedPrompts(n int) []struct{ name, text string } {
	fit := func(unit string) string { return strings.Repeat(unit, n/len(unit)+1)[:n] }
	prose := "Review the module and keep its behavior. "
	tokens := "Actually, token is this one: " + gen(1, alphaLetters, 64) + ". Also " + gen(2, alphaAlnum, 128) +
		", then " + gen(3, alphaB64, 64) + "==, and " + gen(1, alphaLetters, 64) + "! "
	misses := "Revert " + gen(4, alphaHex, 40) + " in internal/promptsecret/structural_test.go (TestScanMatrixWithAReallyLongNameForTheTestingFunction), " +
		"image@sha256:" + gen(5, alphaHex, 64) + " " + gen(6, alphaAlnum, 40) + ".png see https://example.test/" + gen(7, alphaAlnum, 64) + "/x. "
	pem := "-----BEGIN CERTIFICATE-----\n" + strings.Repeat(gen(8, alphaB64, 64)+"\n", 6) + "-----END CERTIFICATE-----\n"
	long := gen(9, alphaLetters, 600) + " "
	texts := map[string]string{
		"prose":  fit(prose),
		"tokens": fit(strings.Repeat(prose, 8) + tokens),
		"misses": fit(strings.Repeat(prose, 3) + misses + pem + long),
	}
	var out []struct{ name, text string }
	for _, name := range []string{"prose", "tokens", "misses"} {
		out = append(out, struct{ name, text string }{name, texts[name]})
	}
	return out
}

// BenchmarkScanSizes: a warm scan of 8, 16 and 32 KiB prompts (#163, AC4:
// the same benchmark runs on the base to compare).
func BenchmarkScanSizes(b *testing.B) {
	for _, n := range []int{8 << 10, 16 << 10, 32 << 10} {
		for _, p := range sizedPrompts(n) {
			promptsecret.Scan(p.text, own)
			b.Run(fmt.Sprintf("%s/%dKiB", p.name, n>>10), func(b *testing.B) {
				b.SetBytes(int64(len(p.text)))
				for b.Loop() {
					promptsecret.Scan(p.text, own)
				}
			})
		}
	}
}

// A warm scan of every size and shape stays well inside the budget.
func TestScanTimeSizes(t *testing.T) {
	for _, n := range []int{8 << 10, 16 << 10, 32 << 10} {
		for _, p := range sizedPrompts(n) {
			promptsecret.Scan(p.text, own)
			best := time.Hour
			for range 5 {
				start := time.Now()
				promptsecret.Scan(p.text, own)
				best = min(best, time.Since(start))
			}
			t.Logf("%s %d KiB: best of 5 %v", p.name, n>>10, best)
			if best > 2*time.Second {
				t.Errorf("%s %d KiB: %v", p.name, n>>10, best)
			}
		}
	}
}
