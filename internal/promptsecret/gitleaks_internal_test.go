package promptsecret

import (
	"math"
	"regexp"
	"regexp/syntax"
	"strings"
	"testing"
)

// The entropy threshold must be exceeded, as upstream (detect.go: entropy
// <= threshold is dropped): a secret exactly at it is no finding. Runes are
// counted over the length in bytes.
func TestEntropyThresholdIsStrict(t *testing.T) {
	if e := shannonEntropy("aabbccdd"); e != 2 {
		t.Fatalf("entropy %v", e)
	}
	if e := shannonEntropy("éé"); math.Abs(e-0.5) > 1e-9 { // one rune twice over four bytes: -2·(2/4)·log2(2/4)
		t.Fatalf("entropy %v", e)
	}
	r := compiledRule{glRule: glRule{ID: "t", Entropy: 2}, re: regexp.MustCompile(`s=(\w+)`)}
	if fs := r.detect("s=aabbccdd", nil, nil); len(fs) != 0 {
		t.Fatalf("at the threshold: %+v", fs)
	}
	if fs := r.detect("s=aabbccde", nil, nil); len(fs) != 1 || fs[0].Start != 2 || fs[0].End != 10 {
		t.Fatalf("above it: %+v", fs)
	}
}

// The generated tables compile, and the rule set is the pinned one.
func TestGeneratedRules(t *testing.T) {
	loadRules()
	if len(compiledRules) != 217 || len(compiledGlobal) != 1 || gitleaksVersion != "v8.30.1" {
		t.Fatalf("%d rules, %d global allowlists, %s", len(compiledRules), len(compiledGlobal), gitleaksVersion)
	}
	if RulesVersion != "gitleaks-v8.30.1+structural-1+entropy-1" {
		t.Fatalf("rules version %q", RulesVersion)
	}
}

// punctuated keeps a name's colon only for namedRules (E2): every other
// rule it runs matches no colon at all, so blanking one never hides what
// they read. A Gitleaks upgrade that breaks this fails here.
func TestPunctColonRules(t *testing.T) {
	punctuated("Use sk_live_k3Jd9fLq0ZrMv8.", nil)
	if len(punctRules) != 149 || len(namedRules) != 99 {
		t.Fatalf("%d rules, %d named", len(punctRules), len(namedRules))
	}
	var colon func(re *syntax.Regexp) bool
	colon = func(re *syntax.Regexp) bool {
		switch re.Op {
		case syntax.OpLiteral:
			return strings.ContainsRune(string(re.Rune), ':')
		case syntax.OpCharClass:
			for i := 0; i < len(re.Rune); i += 2 {
				if re.Rune[i] <= ':' && ':' <= re.Rune[i+1] {
					return true
				}
			}
		case syntax.OpAnyChar, syntax.OpAnyCharNotNL:
			return true
		}
		for _, s := range re.Sub {
			if colon(s) {
				return true
			}
		}
		return false
	}
	for _, r := range punctRules {
		re, err := syntax.Parse(strings.TrimSuffix(r.Regex, gitleaksBoundary), syntax.Perl)
		if err != nil {
			t.Fatal(err)
		}
		if named := strings.Contains(r.Regex, gitleaksSeparator); named != colon(re) {
			t.Errorf("%s: a name's separator %v, reads a colon %v", r.ID, named, colon(re))
		}
	}
}
