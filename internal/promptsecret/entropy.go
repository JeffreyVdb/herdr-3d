package promptsecret

// The entropy rule (#163, from #150's research): a token with no prefix and
// no introduction ("Actually, token is this one: <64 letters>") that no
// known format, name or phrase finds, proposed because it looks random:
// language independent, no model. It adds to the other detectors and never
// replaces one (entropySpans, detect).
//
// The lexical run. A candidate is one maximal run of the ASCII bytes
// [A-Za-z0-9] and '_' '-' '+' '/' (base64, url-safe base64, snake and kebab
// case), with up to two '=' right after it as base64 padding when neither
// another '=' nor a run byte follows them: an '=' that is followed by one
// ("API_KEY=<tok>", "a==b") ends the run and is never part of it. The
// candidate's bytes are exactly the typed run (and its padding): no decoding,
// no normalizing; a non-ASCII byte is never part of a run and is a boundary
// ("é<tok>", "<tok>…", "«<tok>»", a CJK or emoji neighbour). The bytes of an
// own file reference are boundaries too (Scan): the rule reads only typed
// bytes, so a reference is never part of a candidate and a candidate is never
// "shaped" by a reference's mask (never borrowed).
//
// The word. A run is a candidate only when it is the whole word, that is
// when what stands right around it is a boundary, not more of a word:
//
//   - before it: the start of the text, a blank, a quote or backtick, one of
//     ( [ { < > , ; : = | *, or a non-ASCII byte (so API_KEY=<tok>,
//     token:<tok>, "<tok>", `<tok>`, (<tok>) and a JSON "\n<tok>" qualify;
//     a '.', '@', '%', '#', '$', '&', '~' or '\' before it (a domain, a
//     file name, a mention, a percent-escape, a variable) does not);
//   - after it: the end, a blank, a quote or backtick, one of ) ] } > , ; * |
//     <, a non-ASCII byte, or a '\' before n, r, t or a quote (a JSON or shell
//     escape), or sentence punctuation ('.', ':', '!', '?', any run of them)
//     that is itself followed by one of those, never by a word byte: a
//     sentence's "<tok>." and "<tok>?" qualify, "<tok>.png", "<tok>.example.org",
//     "<tok>?page=2", "<tok>:8080", "<tok>(x)", "<tok>[0]" and "<tok>@host" do
//     not;
//   - a URL (a "://" earlier in the same blank-or-quote delimited piece, or a
//     piece that starts "//" after a scheme's colon) and a data: URI (";base64,"
//     before it, or a "data:" piece) are one word whatever stands inside them;
//   - a run longer than entropyMaxLen is one long word: it proposes nothing,
//     never a plausible substring of it.
//
// What is measured. The run's length (padding excluded) must be in
// [entropyMinLen, entropyMaxLen] and its Shannon entropy at least
// entropyMinBits per byte. The entropy is the Gitleaks one (shannonEntropy,
// gitleaks.go: each symbol's frequency over the length, log2) computed over
// bytes; a run is ASCII, so upstream's runes and these bytes agree. A hex
// string cannot exceed 4 bits (16 symbols), so hex hashes, UUIDs and git ids
// fall short by themselves (TestEntropyNegatives); base64 can reach 6, so
// the other classes are left out by what surrounds or starts them
// (publicContext, publicRun, notRandom, pemBlock). A run that is a repeated
// block, a placeholder, a redaction or a sequence of consecutive bytes is
// not random whatever its entropy.

import (
	"math"
	"regexp"
	"strings"
)

// KindEntropy is the kind of a candidate the entropy rule found.
const KindEntropy = "entropy"

// The measured window: docs/decisions.md, #163.
const (
	entropyMinLen  = 32
	entropyMaxLen  = 512
	entropyMinBits = 4.5
)

// runByte is a byte of a run.
func runByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		c == '_' || c == '-' || c == '+' || c == '/'
}

// entropySpans are the entropy rule's spans in text; refs are the own
// references (their bytes are boundaries).
func entropySpans(text string, refs []span) []span {
	var out []span
	var pem [][2]int
	pemDone := false
	at := 0
	for _, r := range append(append([]span(nil), refs...), span{start: len(text), end: len(text)}) {
		if a, b := at, min(r.start, len(text)); a < b {
			out = entropyRuns(text, a, b, out, &pem, &pemDone)
		}
		at = max(at, r.end)
	}
	return out
}

// entropyRuns reads the runs of the part [a, b) of text (a reference or the
// text's edge on both sides).
func entropyRuns(text string, a, b int, out []span, pem *[][2]int, pemDone *bool) []span {
	for i := a; i < b; {
		if !runByte(text[i]) {
			i++
			continue
		}
		s := i
		for i < b && runByte(text[i]) {
			i++
		}
		e := i
		trimmed := false
		if s > a && text[s-1] == '\\' && strings.IndexByte("nrt", text[s]) >= 0 {
			s++ // an escaped newline or tab glued before the token
			trimmed = true
		}
		if e-s < entropyMinLen || e-s > entropyMaxLen {
			continue
		}
		p := e
		for p < b && p-e < 2 && text[p] == '=' {
			p++
		}
		if p > e && p < b && (runByte(text[p]) || text[p] == '=') {
			p = e // an assignment's '=', not padding
		}
		i = p
		run := text[s:e]
		switch {
		case !trimmed && !boundaryBefore(text, a, s), !boundaryAfter(text, p, b):
		case !random(run), placeholderRun(run), publicRun(run), pathRun(run):
		case urlWord(text, a, s), publicContext(text, a, s):
		case pemBlock(text, s, pem, pemDone):
		default:
			out = append(out, span{start: s, end: p, kind: KindEntropy, rank: rankEntropy})
		}
	}
	return out
}

// boundaryBefore reports a boundary before the run at s in the part from a.
func boundaryBefore(text string, a, s int) bool {
	if s == a {
		return true
	}
	c := text[s-1]
	return c >= 0x80 || isSpace(c) || strings.IndexByte("\"'`([{<>,;:=|*", c) >= 0
}

// boundaryAfter reports a boundary at p, after the run, in the part ending at b.
func boundaryAfter(text string, p, b int) bool {
	q := p
	for q < b && strings.IndexByte(".!?:", text[q]) >= 0 {
		q++
	}
	if q == b {
		return true
	}
	c := text[q]
	switch {
	case c >= 0x80, isSpace(c), strings.IndexByte("\"'`)]}>,;*|<", c) >= 0:
		return true
	case c == '\\':
		return q+1 == b || strings.IndexByte("nrt\"'", text[q+1]) >= 0
	}
	return false
}

// urlWord reports a run inside a URL or a data URI: the blank-or-quote
// delimited piece before it (at most 2 KiB) holds "://" or ";base64,", is a
// "data:" URI, or ends in a scheme's colon with the run starting "//".
func urlWord(text string, a, s int) bool {
	j := s
	for j > a && s-j < 2048 && !isSpace(text[j-1]) && strings.IndexByte("\"'`", text[j-1]) < 0 {
		j--
	}
	piece := text[j:s]
	return strings.Contains(piece, "://") || strings.Contains(piece, ";base64,") ||
		strings.HasPrefix(strings.TrimLeft(piece, "([{<"), "data:") ||
		strings.HasPrefix(text[s:], "//") && strings.HasSuffix(piece, ":")
}

var (
	// integrity is a subresource-integrity or lockfile hash's algorithm.
	integrity = regexp.MustCompile(`^(?:sha(?:1|224|256|384|512)|sha3-\d+|md5|blake2[bs]?)-`)
	// publicBlobs start the base64 of an SSH public key's blob (its length
	// and type name): ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp*, sk-*.
	publicBlobs = []string{"AAAAB3NzaC1", "AAAAC3NzaC1", "AAAAE2VjZHNhLXNoYTItbmlzdHA", "AAAAGnNrLXNzaC1", "AAAAInNrLWVjZHNhLXNoYTItbmlzdHA"}
)

// placeholderRun reports a run that says it is no secret: notASecret's
// placeholders and redactions that the run's alphabet can spell ("your-…",
// "…_here", "replace-…", "insert-…", "enter-…", "redacted", and a public
// key's type word). (The masks of x and the other classes have no entropy
// to reach the threshold, and its templates and paths hold bytes no run
// holds: notASecret's regexps would only cost time here.)
func placeholderRun(run string) bool {
	lower := strings.ToLower(run)
	for _, p := range []string{"your-", "your_", "replace-", "replace_", "insert-", "insert_", "enter-", "enter_", "ssh-rsa", "ssh-dss", "ssh-ed25519", "sk-ssh-", "sk-ecdsa-", "ecdsa-sha2-"} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return strings.HasSuffix(lower, "-here") || strings.HasSuffix(lower, "_here") || strings.Contains(lower, "redacted")
}

// publicRun reports a run that is a public value by how it starts: a
// lockfile or SRI hash ("sha512-…") or an SSH public key's blob.
func publicRun(run string) bool {
	if integrity.MatchString(strings.ToLower(run[:min(len(run), 10)])) {
		return true
	}
	for _, p := range publicBlobs {
		if strings.HasPrefix(run, p) {
			return true
		}
	}
	return false
}

// publicWords end the words before a run that name a hash or a public id
// (never a secret), and publicOf the words that make "<word> id" one.
var (
	publicWords = map[string]bool{"hash": true, "digest": true, "checksum": true, "integrity": true, "fingerprint": true,
		"etag": true, "uuid": true, "guid": true, "sha": true, "md5": true, "commit": true, "h1": true}
	publicOf = map[string]bool{"build": true, "trace": true, "span": true, "request": true, "correlation": true,
		"image": true, "container": true, "commit": true, "revision": true, "release": true, "run": true, "job": true,
		"pipeline": true, "deployment": true, "instance": true}
	fillers = map[string]bool{"is": true, "are": true, "was": true, "the": true, "a": true, "an": true, "of": true,
		"to": true, "be": true, "equals": true, "eq": true, "set": true}
	shaWord = regexp.MustCompile(`^sha\d+$`)
)

// publicContext reports a run that the words right before it, on its line
// and in its part, call a hash, a public key or a public id: "sha256: ",
// "the build id is ", "public key: ", an "ssh-ed25519 " type word, "h1:".
func publicContext(text string, a, s int) bool {
	frag := text[max(a, s-80):s]
	if k := strings.LastIndexByte(frag, '\n'); k >= 0 {
		frag = frag[k+1:]
	}
	if f := strings.Fields(frag); len(f) > 0 && sshPublic.MatchString(strings.Trim(f[len(f)-1], "\"'`(,")) {
		return true
	}
	words := strings.FieldsFunc(strings.ToLower(frag), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	var last []string // the last three words that are no filler, nearest first
	for i := len(words) - 1; i >= 0 && len(last) < 3; i-- {
		if !fillers[words[i]] {
			last = append(last, words[i])
		}
	}
	for k, w := range last {
		switch {
		case w == "public":
			return true
		case k == 0 && (publicWords[w] || shaWord.MatchString(w)):
			return true
		case k == 0 && (w == "id" || w == "ids") && len(last) > 1 && publicOf[last[1]]:
			return true
		}
	}
	return false
}

// pathRun reports a run that is a file path or a slug: it has a '/' and most
// of its other bytes stand in segments of one case ("src/fonts/x/X-LICENSE",
// "/tmp/a-very-long-directory-name/b"), or it starts at the root with a
// plain directory ("/home/u/x", "/nix/store/…"). A random base64 run has
// mixed-case segments (its '/' falls about every 64 bytes), so it is
// not one.
func pathRun(run string) bool {
	if strings.IndexByte(run, '/') < 0 {
		return false
	}
	if root, _, ok := strings.Cut(run[1:], "/"); ok && run[0] == '/' && root != "" &&
		(strings.ToLower(root) == root || strings.ToUpper(root) == root) {
		return true
	}
	plain, total := 0, 0
	for _, seg := range strings.Split(run, "/") {
		total += len(seg)
		if strings.ToLower(seg) == seg || strings.ToUpper(seg) == seg {
			plain += len(seg)
		}
	}
	return plain*10 >= total*6
}

// pemBlock reports s inside a PEM block that is no private key (BEGIN to
// END, or to the next blank line or the text's end when it is not closed): a
// public key, a certificate or a request's body lines are base64 with no
// secret. A private key's lines stay proposed (the pem rule's block wins the
// overlap when it is whole; this finds the body of one it does not read). The
// blocks are found once, when the first run asks.
func pemBlock(text string, s int, blocks *[][2]int, done *bool) bool {
	if !*done {
		*done = true
		for i := 0; ; {
			k := strings.Index(text[i:], "-----BEGIN ")
			if k < 0 {
				break
			}
			b := i + k
			label := text[b+len("-----BEGIN "):]
			label = label[:max(0, strings.IndexByte(label, '\n'))]
			end := len(text)
			if j := strings.Index(text[b:], "-----END "); j >= 0 {
				end = b + j
			} else if j := strings.Index(text[b:], "\n\n"); j >= 0 {
				end = b + j
			}
			if !strings.Contains(label, "PRIVATE KEY") {
				*blocks = append(*blocks, [2]int{b, end})
			}
			i = max(end, b+1)
		}
	}
	for _, r := range *blocks {
		if r[0] <= s && s < r[1] {
			return true
		}
	}
	return false
}

// random reports a run that looks random: its entropy reaches entropyMinBits
// and it is no repeated block and no sequence of consecutive bytes.
func random(run string) bool {
	return byteEntropy(run) >= entropyMinBits && !periodic(run) && !sequential(run)
}

// byteEntropy is the Shannon entropy of s in bits per byte: shannonEntropy's
// formula over bytes (the same value for ASCII).
func byteEntropy(s string) float64 {
	var counts [256]int
	for i := 0; i < len(s); i++ {
		counts[s[i]]++
	}
	var h float64
	inv := 1.0 / float64(len(s))
	for _, n := range counts {
		if n > 0 {
			f := float64(n) * inv
			h -= f * math.Log2(f)
		}
	}
	return h
}

// periodic reports a run made of one block repeated (abcdef…abcdef…ab):
// its shortest period is at most half its length.
func periodic(s string) bool {
	fail := make([]int, len(s))
	for i, k := 1, 0; i < len(s); i++ {
		for k > 0 && s[i] != s[k] {
			k = fail[k-1]
		}
		if s[i] == s[k] {
			k++
		}
		fail[i] = k
	}
	p := len(s) - fail[len(s)-1]
	return p <= len(s)/2
}

// sequential reports a run in which a quarter of the neighbouring bytes are
// consecutive (abcdefghij…, 0123456789…; a random base64 run has about 3%).
func sequential(s string) bool {
	n := 0
	for i := 1; i < len(s); i++ {
		if d := int(s[i]) - int(s[i-1]); d == 1 || d == -1 {
			n++
		}
	}
	return n*4 >= len(s)-1
}
