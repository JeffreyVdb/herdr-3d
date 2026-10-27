package cmdrequest

import (
	"strings"
	"unicode"
)

// #220: an execution account or privilege ("as your user", "under your
// account", "as root", "with sudo") names no machine, so the model's
// "other" for it is the bridge. The grammar is closed and matches the whole
// host text: [as|under|with] [your|the|a|an|my] [own] noun. Anything else,
// a possessive ("your user's Mac"), a machine beside the account ("your
// user on the build server"), user@host, a hostname with "user" or "root"
// in it, is not an account phrase: a miss keeps the command off the bridge.
//
// The phrase alone is not enough (accountOnly): the reply must use it as an
// account, led by "as", "under" or "with" (a bare "root" can be a host's
// name), and must not mention another machine (machineMention).

var (
	accountLeads   = map[string]bool{"as": true, "under": true, "with": true}
	accountDets    = map[string]bool{"your": true, "the": true, "a": true, "an": true, "my": true}
	accountNouns   = map[string]bool{"user": true, "account": true, "user account": true, "login": true, "admin": true, "administrator": true}
	accountBareOK  = map[string]bool{"root": true, "root user": true, "superuser": true, "yourself": true, "sudo": true}
	accountQuotes  = strings.NewReplacer("“", `"`, "”", `"`, "‘", "'", "’", "'")
	accountWrapped = []string{`"`, "'", "`"}
)

// accountHost reports whether hostText is only an execution account or a
// privilege, compared without regard to case, runs of whitespace, quotes
// around it or a trailing full stop or comma.
func accountHost(hostText string) bool {
	ok, _ := accountPhrase(hostText)
	return ok
}

// accountPhrase is accountHost, and whether the phrase starts with a lead.
func accountPhrase(hostText string) (ok, led bool) {
	s := strings.TrimRight(strings.Join(strings.Fields(accountQuotes.Replace(hostText)), " "), ".,")
	for _, q := range accountWrapped {
		if len(s) >= 2 && strings.HasPrefix(s, q) && strings.HasSuffix(s, q) {
			s = strings.TrimRight(strings.TrimSpace(s[1:len(s)-1]), ".,")
			break
		}
	}
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false, false
		}
	}
	words := strings.Fields(strings.ToLower(s))
	qualified := false
	if len(words) > 0 && accountLeads[words[0]] {
		words, qualified, led = words[1:], true, true
	}
	if len(words) > 0 && accountDets[words[0]] {
		words, qualified = words[1:], true
		if len(words) > 0 && words[0] == "own" {
			words = words[1:]
		}
	}
	noun := strings.Join(words, " ")
	return accountBareOK[noun] || (qualified && accountNouns[noun]), led
}

// accountOnly reports whether an "other" entry's host text, for the command
// at reply[at:end], is only an execution account: an account phrase, used as
// one in the reply, which mentions no other machine. Both reply checks read
// the reply with the command and a path-shaped cwd blanked out; a cwd that
// is not a path could hide a machine ("On your Mac") and stays.
func accountOnly(reply string, at, end int, cwd, hostText string) bool {
	ok, led := accountPhrase(hostText)
	if !ok {
		return false
	}
	b := []byte(reply)
	blank := func(i, j int) {
		for ; i < j; i++ {
			b[i] = ' '
		}
	}
	blank(at, end)
	if cwd != "" && (cwd[0] == '/' || cwd[0] == '~') && strings.IndexFunc(cwd, unicode.IsSpace) < 0 {
		for i := 0; ; {
			j := strings.Index(reply[i:], cwd)
			if j < 0 {
				break
			}
			blank(i+j, i+j+len(cwd))
			i += j + len(cwd)
		}
	}
	prose := string(b)
	return accountLed(prose, hostText, led) && !machineMention(prose)
}

// accountLed reports whether hostText occurs in prose (ASCII case aside, not
// inside a word) and, unless it starts with a lead itself, every occurrence
// follows a lead word, with only whitespace between.
func accountLed(prose, hostText string, led bool) bool {
	n := 0
	for i := 0; i+len(hostText) <= len(prose); i++ {
		if !asciiFoldEqual(prose[i:i+len(hostText)], hostText) ||
			(wordByte(hostText[0]) && i > 0 && wordByte(prose[i-1])) ||
			(wordByte(hostText[len(hostText)-1]) && i+len(hostText) < len(prose) && wordByte(prose[i+len(hostText)])) {
			continue
		}
		n++
		if led {
			continue
		}
		before := strings.TrimRightFunc(prose[:i], unicode.IsSpace)
		if len(before) == len(prose[:i]) {
			return false
		}
		w := len(before)
		for w > 0 && wordByte(before[w-1]) {
			w--
		}
		if !accountLeads[strings.ToLower(before[w:])] {
			return false
		}
	}
	return n > 0
}

func wordByte(c byte) bool {
	return c == '_' || '0' <= c && c <= '9' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}

// asciiFoldEqual is strings.EqualFold for ASCII letters only, so byte
// offsets in the reply stay put.
func asciiFoldEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}
