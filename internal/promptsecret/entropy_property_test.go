package promptsecret_test

import (
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)

// Property tests for the entropy rule's two seams with the rest of the scan
// (review r1: R1, R2): what a generic finding keeps, and which words before a
// run may call it public. Each is a product of layouts, so a neighbouring
// layout cannot stay broken while one example passes.

// sentenceEnd is what a generic finding may have past an entropy run: the
// sentence's punctuation its value ran on through.
const sentenceEnd = ".!?:"

// checkCandidates asserts Scan's candidates are sorted, non-overlapping, in
// the text and on character boundaries.
func checkCandidates(t *testing.T, text string, cs []promptsecret.Candidate) {
	t.Helper()
	at := 0
	for _, c := range cs {
		if c.Start < at || c.End <= c.Start || c.End > len(text) || !utf8.ValidString(text[c.Start:c.End]) {
			t.Fatalf("candidates %+v on %q: not sorted, disjoint and byte-exact", cs, text)
		}
		at = c.End
	}
}

// Every Gitleaks generic finding keeps all its bytes in the candidates,
// whatever surrounds or is inside its value, except the sentence's
// punctuation after a candidate that starts where the finding starts: the
// entropy run (the one replacement the rule makes: "<tok>." is proposed as
// "<tok>") and, as on base, an assignment's value, which wins its bytes.
func TestEntropyKeepsAGenericFinding(t *testing.T) {
	t.Parallel()
	tok, tok2 := gen(201, alphaLetters, 64), gen(202, alphaAlnum, 48)
	type phrasing struct{ pre, post string }
	phrasings := []phrasing{
		{"token is this one: ", ""}, {"Actually, token is this one: ", ""}, {"secret_value=", ""},
		{"api_key: ", ""}, {"API_KEY=", ""}, {"password = ", ""}, {"the secret_value=", ""},
		{"token: ", ""}, {"- token: ", ""}, {`{"token": "`, `"}`}, {`"api_key": "`, `"`},
		{"password: '", "'"}, {"export SECRET=", ""}, {"Authorization: Bearer ", ""},
	}
	values := map[string]string{
		"plain":         tok,
		"prefix =":      "foo=" + tok,
		"prefix =long":  "foo_bar=" + tok,
		"pad =":         tok + "=",
		"pad ==":        tok + "==",
		"dotted prefix": "a.b." + tok,
		"suffix":        tok + "-suffix",
		"prefix -":      "prefix-" + tok,
		"two":           tok + "." + tok2,
		"inner =":       tok[:20] + "=" + tok[20:],
		"suffix =":      tok + "=x",
		"prefix =.":     "foo=" + tok + ".bar",
		"short prefix":  "k=" + tok2,
	}
	trailers := []string{"", ".", "...", "!", "?", ",", ")", "\n", ". Thanks", ":", ".\n"}
	var generics, replaced, kept int
	for _, ph := range phrasings {
		for vn, v := range values {
			for _, tr := range trailers {
				for _, lead := range []string{"", "Hi. "} {
					text := lead + ph.pre + v + ph.post + tr
					cs := promptsecret.Scan(text, own)
					checkCandidates(t, text, cs)
					for _, m := range promptsecret.Gitleaks(text) {
						if !strings.Contains(strings.ToLower(m.Rule), "generic") {
							continue
						}
						generics++
						covered := make([]bool, len(text))
						limit := m.End // the bytes before it must be covered
						for _, c := range cs {
							for j := c.Start; j < c.End; j++ {
								covered[j] = true
							}
							// A candidate that starts with the finding and ends before
							// its sentence's punctuation: the entropy run, or (as on
							// base) an assignment's value, which wins its bytes.
							if c.Start == m.Start && c.End < m.End && strings.Trim(text[c.End:m.End], sentenceEnd) == "" {
								limit = c.End
								if slices.Contains(c.Kinds, "entropy") {
									replaced++
								}
							}
						}
						if limit == m.End {
							kept++
						}
						for j := m.Start; j < limit; j++ {
							if !covered[j] {
								t.Errorf("%q / %s / %q: generic finding [%d,%d) %q loses byte %d; candidates %+v",
									ph.pre, vn, tr, m.Start, m.End, text[m.Start:m.End], j, cs)
								break
							}
						}
					}
				}
			}
		}
	}
	// The product must reach the cases it is about, or it asserts nothing.
	if generics < 300 || replaced < 10 || kept < 200 {
		t.Errorf("generic findings %d (replaced at the run %d, kept whole %d): the layouts no longer reach the seam", generics, replaced, kept)
	}
}

// foo=<tok> and foo=<tok>.: the finding is the whole value, so it is the
// candidate (the period of the second stays in it, as before the entropy
// rule); only "<tok>." with nothing before the run is trimmed to the run.
func TestEntropyGenericWithAPrefix(t *testing.T) {
	t.Parallel()
	tok := gen(203, alphaLetters, 64)
	for _, tc := range []struct{ text, want string }{
		{"Actually, token is this one: foo=" + tok, "foo=" + tok},
		{"Actually, token is this one: foo=" + tok + ".", "foo=" + tok + "."},
		{"Actually, token is this one: foo=" + tok + "...", "foo=" + tok + "..."},
		{"Actually, token is this one: " + tok + ".", tok},
		{"Actually, token is this one: " + tok + "...", tok},
		{"Actually, token is this one: " + tok, tok},
	} {
		cs := promptsecret.Scan(tc.text, own)
		if len(cs) != 1 || tc.text[cs[0].Start:cs[0].End] != tc.want {
			t.Errorf("%q: %+v, want %q", tc.text, cs, tc.want)
		}
	}
}

var (
	// introductions say the run is a credential.
	introductions = []string{"API key", "API token", "token", "secret", "password", "access key", "auth token",
		"credential", "client secret", "sleutel", "clé", "wachtwoord", "mot de passe", "API-sleutel", "private key"}
	// contextWords are every word entropy.go reads before a run to call it
	// a hash or a public value, plus the SSH type word it reads.
	contextWords = []string{"public", "sha", "sha256", "sha512", "hash", "digest", "checksum", "integrity", "fingerprint",
		"etag", "uuid", "guid", "md5", "commit", "h1", "build", "trace", "span", "request", "correlation", "image",
		"container", "revision", "release", "run", "job", "pipeline", "deployment", "instance"}
	separators = []string{" %s ok", ": %s", " is %s", " = %s", "\n%s", " is: %s."}
)

// A run introduced by a word that says it is a credential is proposed
// whatever context word stands before it ("my public API key <tok>", "the
// build token <tok>", "commit token <tok>").
func TestEntropyContextWordsDoNotHideACredential(t *testing.T) {
	t.Parallel()
	toks := []string{gen(204, alphaLetters, 64), gen(205, alphaAlnum, 56)}
	for _, tok := range toks {
		if bits(tok) < 4.6 {
			t.Fatalf("seed gives %.2f bits", bits(tok))
		}
	}
	var rows int
	for _, intro := range introductions {
		for _, w := range contextWords {
			phrases := []string{
				"my " + w + " " + intro, "the " + w + " " + intro, w + " " + intro, "Use the " + w + " " + intro,
				"the " + w + "'s " + intro, "my " + w + " repo's " + intro,
			}
			if w == "public" {
				phrases = append(phrases, intro+" "+w, "my "+intro+", "+w, "my public ssh "+intro, "the public (ssh) "+intro)
			}
			for _, ph := range phrases {
				for _, sep := range separators {
					for _, tok := range toks {
						text := ph + strings.Replace(sep, "%s", tok, 1)
						rows++
						found := false
						for _, c := range promptsecret.Scan(text, own) {
							found = found || text[c.Start:c.End] == tok
						}
						if !found {
							t.Errorf("not proposed: %q", abbreviate(text))
						}
					}
				}
			}
		}
	}
	if rows < 3000 {
		t.Errorf("only %d rows", rows)
	}
}

// The public values stay out: a context word that describes the run itself
// excludes it, in every separator, in front of both token families.
func TestEntropyPublicContextStillExcludes(t *testing.T) {
	t.Parallel()
	toks := []string{gen(206, alphaAlnum, 64), gen(207, alphaB64, 64)}
	for _, tok := range toks {
		if bits(tok) < 4.6 {
			t.Fatalf("seed gives %.2f bits", bits(tok))
		}
	}
	for _, ph := range []string{
		"public key", "my public key", "Here is my public ssh key", "my public gpg key", "the public key", "public", "public value",
		"public id", "sha256", "the sha512", "hash", "the hash", "digest", "checksum", "integrity", "fingerprint", "etag", "ETag",
		"uuid", "guid", "md5", "commit", "git commit", "h1", "the build id", "Build-Id", "trace id", "span id", "request id",
		"correlation id", "container image id", "run id", "job id", "pipeline id", "deployment id", "instance id",
		"release id", "revision id",
	} {
		for _, sep := range separators {
			for _, tok := range toks {
				if strings.Contains(sep, "\n") {
					continue // a new line is a new context
				}
				text := ph + strings.Replace(sep, "%s", tok, 1)
				if got := entropyHits(text); len(got) != 0 {
					t.Errorf("proposed %q in %q", abbreviate2(got), abbreviate(text))
				}
			}
		}
	}
}

// The review's two sentences (r1, R2): "public" describing the API does not
// hide its credential, and the same token without it is found as before.
func TestEntropyPublicAPIWording(t *testing.T) {
	t.Parallel()
	tok := gen(1, alphaLetters, 64)
	for _, text := range []string{"my key " + tok + " ok", "my public API key " + tok + " ok", "Use the public API token " + tok,
		"my public repo's token " + tok} {
		cs := promptsecret.Scan(text, own)
		if len(cs) != 1 || text[cs[0].Start:cs[0].End] != tok {
			t.Errorf("%q: want the exact token, got %+v", text, cs)
		}
	}
}
