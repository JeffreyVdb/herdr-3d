package promptsecret_test

import (
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)

// The entropy rule (#163, entropy.go): synthetic tokens only, generated from
// a seed (never a real token, never a vendor prefix).

const (
	alphaLetters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	alphaAlnum   = alphaLetters + "0123456789"
	alphaB64     = alphaAlnum + "+/"
	alphaURLSafe = alphaAlnum + "-_"
	alphaHex     = "0123456789abcdef"
)

// gen is n random bytes of alphabet from the seed.
func gen(seed uint64, alphabet string, n int) string {
	r := rand.New(rand.NewPCG(seed, 163))
	b := make([]byte, n)
	for i := range b {
		b[i] = alphabet[r.IntN(len(alphabet))]
	}
	return string(b)
}

// bits is a string's Shannon entropy per byte (the test's own copy).
func bits(s string) float64 {
	counts := map[rune]int{}
	for _, c := range s {
		counts[c]++
	}
	var h float64
	for _, n := range counts {
		f := float64(n) / float64(len(s))
		h -= f * math.Log2(f)
	}
	return h
}

// entropyHits are the candidates the entropy rule found, as typed.
func entropyHits(text string) []string {
	var out []string
	for _, c := range promptsecret.Scan(text, own) {
		if slices.Contains(c.Kinds, "entropy") {
			out = append(out, text[c.Start:c.End])
		}
	}
	return out
}

type token struct{ name, value string }

// matrixTokens are the families the matrix runs over; each one's entropy is
// checked, so a seed never decides a case.
func matrixTokens(t *testing.T) []token {
	t.Helper()
	toks := []token{
		{"letters64", gen(1, alphaLetters, 64)},
		{"letters128", gen(2, alphaLetters, 128)},
		{"alnum64", gen(3, alphaAlnum, 64)},
		{"base64+/", gen(4, alphaAlnum, 20) + "+" + gen(5, alphaAlnum, 20) + "/" + gen(6, alphaAlnum, 22)},
		{"base64 padded ==", gen(7, alphaAlnum, 40) + "+" + gen(8, alphaAlnum, 21) + "=="},
		{"base64 padded =", gen(9, alphaAlnum, 30) + "/" + gen(10, alphaAlnum, 32) + "="},
		{"urlsafe", gen(11, alphaAlnum, 20) + "-" + gen(12, alphaAlnum, 20) + "_" + gen(13, alphaAlnum, 22)},
		{"edge symbols", "-" + gen(14, alphaAlnum, 62) + "_"},
		{"slash and plus ends", "/" + gen(15, alphaAlnum, 62) + "+"},
	}
	for _, tk := range toks {
		if h := bits(strings.TrimRight(tk.value, "=")); h < 4.7 {
			t.Fatalf("%s: entropy %.2f: pick another seed", tk.name, h)
		}
	}
	return toks
}

// layouts put a token (%s) in a prompt: no introduction, wording in several
// languages, quotes, assignments, JSON and YAML, Markdown, Unicode and
// escaped newlines right next to it.
var layouts = []string{
	"%s",
	"Actually, token is this one: %s",
	"my key %s ok",
	"de sleutel is %s",
	"la clé est : %s",
	"der Schlüssel ist: %s",
	"Hier ist der Schlüssel %s zum Testen",
	`"%s"`, "'%s'", "`%s`", "(%s)", "[%s]",
	"API_KEY=%s", `API_KEY="%s"`, "export X=%s", "token: %s", "- token: %s", "secret_value=%s",
	`{"key": "%s"}`, `{"key":"%s","other":1}`, "key: %s\nother: 1",
	"Use the value `%s` for the job",
	"```\n%s\n```",
	"é%s🙂", "日本語%s日本語", "«%s»", "“%s”", "%s…", "🙂 %s 🙂",
	`line one\n%s\nline two`,
}

// assignedNamed are the layouts a credential-named assignment finds as well:
// that rule (first, as it was) keeps a trailing '!' or '?' in an unquoted
// value, as a password may end in one. The entropy rule does not shorten it.
var assignedNamed = map[string]bool{"API_KEY=%s": true, "token: %s": true, "- token: %s": true}

// trailers follow a layout: sentence punctuation, a closing bracket or quote,
// a line end, more text, and the end of the text.
var trailers = []string{"", ".", ",", "!", "?", ")", ";", `"`, ":", "...", "\n", "\r\n", " and more text.\n"}

// The matrix: every layout × trailer × token's exact [Start, End) is the
// token as typed, padding included and an assignment's '=' left out, and it
// is the only candidate.
func TestEntropyMatrix(t *testing.T) {
	t.Parallel()
	n := 0
	for _, tk := range matrixTokens(t) {
		for _, lay := range layouts {
			for _, tr := range trailers {
				text := strings.Replace(lay, "%s", tk.value, 1) + tr
				want := strings.Index(text, tk.value)
				end := want + len(tk.value)
				if assignedNamed[lay] && (tr == "!" || tr == "?") {
					end += len(tr) // the assignment rule's value: a password may end in "!"
				}
				n++
				cs := promptsecret.Scan(text, own)
				if len(cs) != 1 || cs[0].Start != want || cs[0].End != end || text[cs[0].Start:cs[0].End] != text[want:end] {
					t.Errorf("%s %q + %q: %+v, want [%d, %d)", tk.name, lay, tr, cs, want, end)
				}
			}
		}
	}
	t.Logf("%d layouts", n)
}

// Padding: an unpadded token with '=' or '==' typed after it takes the
// padding; an assignment's '=' before the next word does not.
func TestEntropyPadding(t *testing.T) {
	t.Parallel()
	core := gen(21, alphaAlnum, 64)
	for _, tc := range []struct{ name, text, want string }{
		{"one pad", "here is one: " + core + "= ok", core + "="},
		{"two pads", "here is one: " + core + "==", core + "=="},
		{"three are not padding", "here is one: " + core + "===", ""},
		{"assignment after", "here is one: " + core + "=value", ""},
		{"assignment of a name", core + "=x", ""},
		{"assignment before", "A=" + core + " ok", core},
		{"pad then word", "here is one: " + core + "==x", ""},
	} {
		got := entropyHits(tc.text)
		switch {
		case tc.want == "" && len(got) != 0, tc.want != "" && !slices.Equal(got, []string{tc.want}):
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

// Adjacent and repeated values: each occurrence is its own candidate, at its
// own bytes, whatever stands between them.
func TestEntropyAdjacency(t *testing.T) {
	t.Parallel()
	a, b := gen(31, alphaLetters, 64), gen(32, alphaAlnum, 64)
	for _, sep := range []string{" ", ", ", ",", "\n", "; ", " and ", `" "`, `","`, "\r\n", " / ", "\t"} {
		for _, tc := range []struct {
			name, text string
			want       []string
		}{
			{"two different", a + sep + b, []string{a, b}},
			{"repeated", a + sep + a, []string{a, a}},
			{"three", a + sep + b + sep + a, []string{a, b, a}},
			{"introduced", "keys are " + a + sep + b + ".", []string{a, b}},
			{"quoted", `"` + a + `"` + sep + `'` + b + `'`, []string{a, b}},
		} {
			cs := promptsecret.Scan(tc.text, own)
			var got []string
			for _, c := range cs {
				got = append(got, tc.text[c.Start:c.End])
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("%s sep %q: %q, want %q", tc.name, sep, got, tc.want)
			}
		}
	}
	// A value found by another rule is repeated as before, and a repeat
	// glued into a word is not.
	text := "API_KEY=" + a + " then the same " + a + " and again, " + a + "."
	if got := values(text); !slices.Equal(got, []string{a, a, a}) {
		t.Errorf("repeated assigned: %q", got)
	}
}

// Start and end of the text, and the UTF-16 offsets of a token after astral
// characters (the review's protocol ranges).
func TestEntropyOffsets(t *testing.T) {
	t.Parallel()
	tok := gen(41, alphaLetters, 64)
	text := "🙂é " + tok + " 日本"
	r := promptsecret.NewReviewer(key, own)
	f := r.Scan(text).Found
	if len(f) != 1 || text[f[0].Start:f[0].End] != tok || f[0].End16-f[0].Start16 != len(tok) || f[0].Start16 != 4 {
		t.Fatalf("found %+v", f)
	}
	if f[0].Kinds[0] != "entropy" || len(f[0].Kinds) != 1 || f[0].Encoded {
		t.Fatalf("kinds %+v", f[0])
	}
	for _, text := range []string{tok, tok + "\n", "\n" + tok, " " + tok + " "} {
		if got := entropyHits(text); !slices.Equal(got, []string{tok}) {
			t.Errorf("%q: %q", text, got)
		}
	}
}

// The word: what stands around a run that makes it a part of a longer word.
func TestEntropyWords(t *testing.T) {
	t.Parallel()
	tok := gen(51, alphaLetters, 64)
	long := gen(52, alphaLetters, 600)
	edge := gen(53, alphaLetters, 512)
	over := gen(54, alphaLetters, 513)
	for _, tc := range []struct {
		name, text string
		want       []string
	}{
		{"filename after", "see " + tok + ".png now", nil},
		{"domain after", "host " + tok + ".example.org now", nil},
		{"domain before", "host www." + tok + " now", nil},
		{"query after", "open " + tok + "?page=2 now", nil},
		{"port after", "open " + tok + ":8080 now", nil},
		{"call after", "call " + tok + "(x)", nil},
		{"index after", "read " + tok + "[0]", nil},
		{"at after", tok + "@example.org", nil},
		{"at before", "@" + tok, nil},
		{"percent before", "%2F" + tok, nil},
		{"dollar before", "$" + tok, nil},
		{"hash before", "#" + tok, nil},
		{"ampersand before", "&" + tok, nil},
		{"dot version after", "v" + tok + ".1.2", nil},
		{"two sentences", "Here it is " + tok + ". Next.", []string{tok}},
		{"question", "Is " + tok + "?", []string{tok}},
		{"dots", "Is " + tok + "...", []string{tok}},
		{"exclamation then quote", `He said "it is ` + tok + `!"`, []string{tok}},
		{"url path", "fetch https://example.test/a/" + tok + "/b now", nil},
		{"url last segment", "fetch https://example.test/" + tok, nil},
		{"url query", "fetch https://example.test/x?v=" + tok + "&w=1", nil},
		{"url in quotes", `{"url": "https://example.test/` + tok + `"}`, nil},
		{"url host port", "fetch http://example.test:8443/" + tok, nil},
		{"scheme only", "fetch ftp://" + tok, nil},
		{"json after a url", `{"url":"https://example.test/x","key":"` + tok + `"}`, []string{tok}},
		{"data uri", "src=data:image/png;base64," + tok + " ok", nil},
		{"data uri quoted", `<img src="data:image/png;base64,` + tok + `">`, nil},
		{"data uri css", "background: url(data:image/png;base64," + tok + ");", nil},
		{"over the limit", "see " + long + " now", nil},
		{"exactly the limit", "see " + edge + " now", []string{edge}},
		{"one over the limit", "see " + over + " now", nil},
		{"over the limit assigned", "API_KEY=" + long, nil},
		{"over the limit quoted", `"` + long + `"`, nil},
		{"substring of a long word is never proposed", long[:300] + "." + long[300:], nil},
		{"long word with a quote inside is two words", long[:550] + `"` + long[:60], []string{long[:60]}},
		{"escaped newline glued before", `intro\n` + tok + `\n`, []string{tok}},
		{"escaped tab", `a\t` + tok + `\t` + tok, []string{tok, tok}},
		{"windows path", `C:\Users\x\` + tok, nil},
		{"markdown bold", "**" + tok + "**", []string{tok}},
		{"markdown table", "|" + tok + "|", []string{tok}},
		{"html tag", "<code>" + tok + "</code>", []string{tok}},
		{"colon list", "user:" + tok + ":end", nil},
		{"assigned in a url fragment", "https://example.test/#key=" + tok, nil},
	} {
		got := entropyHits(tc.text)
		if !slices.Equal(got, tc.want) && !(len(got) == 0 && len(tc.want) == 0) {
			t.Errorf("%s: %q: got %q, want %q", tc.name, abbreviate(tc.text), abbreviate2(got), abbreviate2(tc.want))
		}
	}
}

func abbreviate(s string) string {
	if len(s) > 100 {
		return s[:48] + "…" + s[len(s)-48:]
	}
	return s
}

func abbreviate2(ss []string) []string {
	var out []string
	for _, s := range ss {
		out = append(out, abbreviate(s))
	}
	return out
}

// No Unicode is normalized or decoded: the candidate is the typed ASCII run,
// and a Unicode letter, mark, punctuation or emoji beside it is a boundary.
func TestEntropyUnicodeBoundaries(t *testing.T) {
	t.Parallel()
	tok := gen(61, alphaLetters, 64)
	for _, nb := range []string{"é", "日本語", "🙂", "👨‍👩‍👧", "«", "»", "…", "—", "ß", "ñ", "\u200b", "\u00a0", "ａ", "𝐀"} {
		for _, tc := range []struct{ name, text string }{
			{"before", nb + tok},
			{"after", tok + nb},
			{"both", nb + tok + nb},
			{"inside a sentence", "ключ" + nb + tok + nb + "ключ"},
		} {
			if got := entropyHits(tc.text); !slices.Equal(got, []string{tok}) {
				t.Errorf("%s %q: %q", tc.name, nb, got)
			}
		}
	}
	// A combining mark glued after an ASCII letter leaves that typed letter in
	// the run; before the token it is a boundary.
	if got := entropyHits(tok + "e\u0301"); !slices.Equal(got, []string{tok + "e"}) {
		t.Errorf("decomposed accent after: %q", got)
	}
	if got := entropyHits("e\u0301" + tok); !slices.Equal(got, []string{tok}) {
		t.Errorf("decomposed accent before: %q", got)
	}
	// A look-alike inside the run is not in the alphabet: the run is cut.
	if got := entropyHits(tok[:30] + "é" + tok[30:]); len(got) != 0 {
		t.Errorf("a letter with an accent in the middle: %q", got)
	}
}

// Negatives: values that are public, structured or not random are not
// proposed by the entropy rule. Hex cannot reach the threshold at all (16
// symbols: 4 bits); base64 can, so those classes are left out by context.
func TestEntropyNegatives(t *testing.T) {
	t.Parallel()
	hex := func(n int, seed uint64) string { return gen(seed, alphaHex, n) }
	b64 := func(n int, seed uint64) string { return gen(seed, alphaAlnum, n) }
	uuid := func(seed uint64) string {
		h := hex(32, seed)
		return h[:8] + "-" + h[8:12] + "-4" + h[13:16] + "-a" + h[17:20] + "-" + h[20:]
	}
	pubBody := strings.Join([]string{b64(64, 71), b64(64, 72), b64(64, 73), b64(20, 74)}, "\n")
	repeated := b64(16, 75)
	cases := map[string]string{
		"sha1":               "Revert " + hex(40, 1) + " now",
		"sha256":             "sha256: " + hex(64, 2),
		"sha256 docker":      "image@sha256:" + hex(64, 3) + " pulled",
		"sha512":             "digest " + hex(128, 4),
		"git commit":         "cherry-pick " + hex(40, 5) + " and " + hex(40, 6) + ".",
		"uuid":               "Request " + uuid(7) + " failed; retry " + uuid(8) + ".",
		"uuid no dashes":     "id " + hex(32, 9) + " ok",
		"long hex":           hex(256, 10),
		"ssh ed25519":        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + b64(43, 11) + " user@host",
		"ssh rsa":            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB" + b64(360, 12) + " user@host",
		"ssh rsa 512 cap":    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB" + b64(60, 13) + " user@host",
		"ssh ecdsa":          "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABB" + b64(60, 14) + " u@h",
		"ssh sk":             "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t" + b64(40, 15),
		"ssh other blob":     "ssh-ed25519 " + b64(68, 16) + " u@h",
		"authorized_keys":    `command="x",no-pty ssh-rsa ` + b64(120, 17) + " u@h",
		"public key word":    "my public key is " + b64(64, 18),
		"public ssh key":     "Here is my public ssh key: " + b64(64, 19),
		"sri sha512":         `"integrity": "sha512-` + b64(86, 20) + `=="`,
		"sri sha256":         `<script integrity="sha256-` + b64(43, 21) + `=" src="x.js">`,
		"sri sha384":         "sha384-" + b64(64, 22),
		"nix sha256":         "hash = sha256-" + b64(43, 23) + "=;",
		"go sum":             "golang.org/x/text v0.14.0 h1:" + b64(43, 24) + "=",
		"pem public key":     "-----BEGIN PUBLIC KEY-----\n" + pubBody + "\n-----END PUBLIC KEY-----",
		"pem certificate":    "-----BEGIN CERTIFICATE-----\n" + pubBody + "\n-----END CERTIFICATE-----\n",
		"pem unclosed":       "-----BEGIN CERTIFICATE-----\n" + pubBody + "\n\nthen text",
		"pem request":        "-----BEGIN CERTIFICATE REQUEST-----\n" + pubBody + "\n-----END CERTIFICATE REQUEST-----",
		"data uri":           "data:image/png;base64," + b64(96, 25),
		"data uri in css":    "a { background: url(data:image/png;base64," + b64(96, 26) + ") }",
		"build id":           "the build id is " + b64(36, 27) + " from CI",
		"build id colon":     "Build-Id: " + b64(40, 28),
		"run id":             "run id " + b64(40, 29),
		"image digest":       "container image id " + b64(40, 30),
		"etag":               `ETag: "` + b64(40, 31) + `"`,
		"checksum":           "checksum " + b64(44, 32) + "=",
		"fingerprint":        "fingerprint: " + b64(43, 33),
		"nix store path":     "/nix/store/" + gen(34, "0123456789abcdfghijklmnpqrsvwxyz", 32) + "-hello-2.12.1/bin/hello",
		"nix store no dots":  "/nix/store/" + gen(35, "0123456789abcdfghijklmnpqrsvwxyz", 32) + "-hello",
		"ci run id":          "GitHub run 8842192037 job 24198776112 attempt 2",
		"x mask":             "token: " + strings.Repeat("x", 64),
		"mask sections":      "key " + strings.Repeat("xxxxxxxx-", 7) + "xxxxxxxx",
		"redacted":           "api key " + strings.Repeat("REDACTED_", 8),
		"placeholder":        "set it to YOUR_SUPER_SECRET_API_KEY_GOES_HERE_PLEASE_REPLACE_ME_NOW",
		"placeholder angle":  "token <" + strings.Repeat("your-token-goes-here-", 3) + ">",
		"your token":         "token: your-" + b64(60, 36),
		"here suffix":        "token: " + b64(60, 37) + "-here",
		"repeated char":      strings.Repeat("a", 64),
		"repeated block":     strings.Repeat(repeated, 4),
		"repeated block cut": strings.Repeat(repeated, 4)[:55],
		"alphabet":           alphaAlnum,
		"alphabet twice":     alphaLetters + alphaLetters,
		"digits":             strings.Repeat("0123456789", 7),
		"reverse alphabet":   "zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9876543210",
		"separator":          strings.Repeat("-", 80) + "\n" + strings.Repeat("=", 80),
		"camel identifier":   "call TestScanMatrixWithAReallyLongNameForTheTestingFunctionHere now",
		"snake identifier":   "set the_quick_brown_fox_jumps_over_the_lazy_dog_and_keeps_running_away",
		"kebab slug":         "branch feature/add-prompt-secret-entropy-detection-for-long-random-tokens",
		"english word run":   "Pneumonoultramicroscopicsilicovolcanoconiosissupercalifragilisticexpialidocious",
		"repo path":          "edit internal/promptsecret/structural_test.go and game/src/net/protocol.ts please",
		"absolute path":      "open /home/user/projects/herdr-3d/internal/promptsecret/entropy_test.go now",
		"long url":           "https://example.test/" + strings.Repeat("segment/", 12) + "end",
		"url path random":    "GET https://cdn.example.test/assets/" + b64(64, 38) + "/app.js",
		"jwt like parts":     b64(40, 39) + "." + b64(60, 40) + "." + b64(43, 41),
		"dotted":             b64(40, 42) + "." + b64(40, 43),
		"over limit":         b64(600, 44),
		"over limit hyphens": strings.Repeat(b64(40, 45)+"-", 15),
		"email":              b64(40, 46) + "@example.org",
		"mailto words":       "mail " + b64(36, 47) + "@example.org now",
		"query value":        "see /search?q=" + b64(40, 48) + "&page=2",
		"short token":        "key " + b64(31, 49),
		"short words":        "the quick brown fox jumps over the lazy dog again and again",
	}
	names := make([]string, 0, len(cases))
	for name := range cases {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		text := cases[name]
		if got := entropyHits(text); len(got) != 0 {
			t.Errorf("%s: proposed %q in %q", name, abbreviate2(got), abbreviate(text))
		}
	}
	// A hex string cannot reach the threshold, whatever its length: 16
	// symbols hold at most 4 bits per byte.
	for n := 32; n <= 512; n += 7 {
		for seed := uint64(0); seed < 4; seed++ {
			if h := bits(gen(1000+seed, alphaHex, n)); h >= 4.0 {
				t.Fatalf("hex of %d bytes has %.3f bits", n, h)
			}
			if got := entropyHits(gen(1000+seed, alphaHex, n)); len(got) != 0 {
				t.Errorf("hex of %d bytes proposed", n)
			}
		}
	}
	if got := entropyHits(strings.Repeat("0123456789abcdef", 8)); len(got) != 0 {
		t.Errorf("all 16 hex digits evenly: %q", got)
	}
}

// Noise that is accepted: a random-looking word with nothing around it that
// says what it is. It is a candidate (the review decides), asserted here so
// a change of that is a decision. Each class is counted in docs/decisions.md.
func TestEntropyAcceptedNoise(t *testing.T) {
	t.Parallel()
	for name, text := range map[string]string{
		"bare build id":      "artifact " + gen(81, alphaAlnum, 40) + " uploaded",
		"base64 payload":     "Here is the payload: " + gen(82, alphaB64, 64) + "==",
		"base64 without cue": "msg " + gen(83, alphaAlnum, 44) + "=",
		"opaque id":          "order " + gen(84, alphaURLSafe, 43),
	} {
		if got := entropyHits(text); len(got) != 1 {
			t.Errorf("%s: %q", name, got)
		}
	}
}

// What the entropy rule does beside the others: it adds where nothing else
// found a byte, and every other finding keeps its bytes and its kinds.
func TestEntropyComposition(t *testing.T) {
	t.Parallel()
	alnum := gen(91, alphaAlnum, 64)
	kinds := func(text string) [][]string {
		var out [][]string
		for _, c := range promptsecret.Scan(text, own) {
			out = append(out, c.Kinds)
		}
		return out
	}
	for _, tc := range []struct {
		name, text string
		want       [][]string
	}{
		// The same range found by another rule: no kind is added.
		{"assignment", "API_KEY=" + alnum, [][]string{{"assignment", "gitleaks:generic-api-key", "prose"}}},
		{"provider", "token=ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167,extra", [][]string{{"gitleaks:github-pat"}}},
		{"provider alone", "use ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167 for it", [][]string{{"gitleaks:github-pat"}}},
		{"pem", "key:\n" + pemKey, [][]string{{"gitleaks:private-key", "pem"}}},
		{"nothing else", "here it is " + gen(92, alphaLetters, 64) + " ok", [][]string{{"entropy"}}},
		// Another occurrence of a value another rule found is a repeat, as
		// before; one of a value only the entropy rule found is its own.
		{"repeat of an assigned value", "API_KEY=" + alnum + " then the same " + alnum + ".",
			[][]string{{"assignment", "gitleaks:generic-api-key", "prose"}, {"repeat"}}},
		{"repeats of an entropy value", "here it is " + gen(93, alphaLetters, 64) + " and " + gen(93, alphaLetters, 64),
			[][]string{{"entropy"}, {"entropy"}}},
		// A value another rule bounds shorter or longer keeps its bytes.
		{"structural value around", `password: "` + alnum[:20] + " " + alnum[20:] + `"`, [][]string{{"assignment", "prose"}}},
	} {
		got := kinds(tc.text)
		if len(got) != len(tc.want) {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
			continue
		}
		for i := range got {
			if !slices.Equal(got[i], tc.want[i]) {
				t.Errorf("%s: kinds %q, want %q", tc.name, got, tc.want)
			}
		}
	}
}

// A generic rule's finding is no known format, only a value after a name,
// and its value runs on through a sentence's '.': where a run stands as a
// whole word the run replaces it at its exact bytes (base proposed
// "<tok>." with the period). A known format and a structural value are not
// replaced.
func TestEntropyReplacesAGenericValue(t *testing.T) {
	t.Parallel()
	tok := gen(101, alphaAlnum, 64)
	for _, tc := range []struct{ name, text, glued string }{
		{"prose then period", "Actually, token is this one: " + tok + ".", tok + "."},
		{"prose then dots", "Actually, token is this one: " + tok + "...", tok + "..."},
		{"name then period", "the secret_value=" + tok + ". Thanks", tok + "."},
	} {
		found := false
		for _, m := range promptsecret.Gitleaks(tc.text) {
			found = found || tc.text[m.Start:m.End] == tc.glued
		}
		if !found {
			t.Fatalf("%s: the generic rule no longer finds %q: pick another case", tc.name, tc.glued)
		}
		cs := promptsecret.Scan(tc.text, own)
		if len(cs) != 1 || tc.text[cs[0].Start:cs[0].End] != tok || !slices.Equal(cs[0].Kinds, []string{"entropy"}) {
			t.Errorf("%s: got %+v, want the token alone", tc.name, cs)
		}
	}
}

// Own references (a sent prompt edited and sent again): a reference is never
// part of a candidate nor read as a word; a token beside one is proposed at
// its typed bytes whichever side the reference is on.
func TestEntropyOwnReferences(t *testing.T) {
	t.Parallel()
	ref := ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57")
	ref2 := ownRef("LEI5ZMIW4XSUXWUGR2R2IAUNOA")
	a, b := gen(111, alphaLetters, 64), gen(112, alphaAlnum, 48)
	for _, tc := range []struct {
		name, text string
		want       []string
	}{
		{"alone", "the token is " + ref + ".", nil},
		{"two references", ref + " " + ref2 + " " + ref + ref2, nil},
		{"token then reference", a + ref, []string{a}},
		{"token space reference", a + " " + ref, []string{a}},
		{"reference then token", ref + a, []string{a}},
		{"reference space token", ref + " " + a, []string{a}},
		{"token between", ref + a + ref2, []string{a}},
		{"tokens around", a + ref + b, []string{a, b}},
		{"tokens around with words", "k1 " + a + ", " + ref + ", " + b + ".", []string{a, b}},
		{"quoted beside", `"` + a + `" ` + ref, []string{a}},
		{"assigned beside", "FOO=" + a + " BAR=" + ref, []string{a}},
		{"half a token", ref + a[:20], nil},
		{"long run through a reference", a + ref + a + ref + a, []string{a, a, a}},
		{"text that only looks like one", "[secret in file /home/u/" + a + "]", nil},
	} {
		got := entropyHits(tc.text)
		if !slices.Equal(got, tc.want) && !(len(got) == 0 && len(tc.want) == 0) {
			t.Errorf("%s: %q, want %q", tc.name, abbreviate2(got), abbreviate2(tc.want))
		}
		for _, c := range promptsecret.Scan(tc.text, own) {
			if strings.Contains(tc.text[c.Start:c.End], "[secret in file") && strings.HasPrefix(tc.name, "token") {
				t.Errorf("%s: candidate %q holds a reference", tc.name, tc.text[c.Start:c.End])
			}
		}
	}
}

// Candidates never overlap, stay inside the text and on character
// boundaries, and the same text scanned twice gives the same candidates, over
// random mixes of tokens, words and punctuation.
func TestEntropyScanInvariants(t *testing.T) {
	t.Parallel()
	r := rand.New(rand.NewPCG(7, 163))
	pieces := []string{" ", " ", "\n", ".", ",", "=", `"`, "'", "`", "(", ")", "é", "🙂", "日", "/", "-", "_", ":", "token ", "key=",
		"API_KEY=", "the ", "is ", "and ", "https://x.test/", "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167", ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57")}
	for i := range 300 {
		var sb strings.Builder
		for range 12 {
			switch r.IntN(4) {
			case 0:
				sb.WriteString(gen(r.Uint64(), []string{alphaLetters, alphaAlnum, alphaB64, alphaURLSafe}[r.IntN(4)], 30+r.IntN(70)))
			default:
				sb.WriteString(pieces[r.IntN(len(pieces))])
			}
		}
		text := sb.String()
		cs := promptsecret.Scan(text, own)
		again := promptsecret.Scan(text, own)
		if fmt.Sprint(cs) != fmt.Sprint(again) {
			t.Fatalf("case %d: two scans differ", i)
		}
		for j, c := range cs {
			if c.Start < 0 || c.End > len(text) || c.Start >= c.End || (j > 0 && c.Start < cs[j-1].End) {
				t.Fatalf("case %d: candidate %+v in %q", i, c, text)
			}
			if c.Start > 0 && text[c.Start]&0xC0 == 0x80 || c.End < len(text) && text[c.End]&0xC0 == 0x80 {
				t.Fatalf("case %d: candidate %+v splits a character in %q", i, c, text)
			}
			if strings.Contains(text[c.Start:c.End], "[secret in file ") && slices.Contains(c.Kinds, "entropy") {
				t.Fatalf("case %d: entropy candidate holds a reference: %q", i, text[c.Start:c.End])
			}
		}
	}
}
