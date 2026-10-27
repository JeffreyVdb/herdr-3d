package cmdrequest

import "strings"

// #220: an execution account or privilege ("as your user", "under your
// account", "as root", "with sudo") names no machine, so the model's
// "other" for it is the bridge. The grammar is closed and matches the whole
// host text: [as|under|with] [your|the|a|an|my] [own] noun. Anything else,
// a possessive ("your user's Mac"), a machine beside the account ("your
// user on the build server"), user@host, a hostname with "user" or "root"
// in it, is not an account phrase: a miss keeps the command off the bridge.

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
	s := strings.TrimRight(strings.Join(strings.Fields(accountQuotes.Replace(hostText)), " "), ".,")
	for _, q := range accountWrapped {
		if len(s) >= 2 && strings.HasPrefix(s, q) && strings.HasSuffix(s, q) {
			s = strings.TrimRight(strings.TrimSpace(s[1:len(s)-1]), ".,")
			break
		}
	}
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	words := strings.Fields(strings.ToLower(s))
	qualified := false
	if len(words) > 0 && accountLeads[words[0]] {
		words, qualified = words[1:], true
	}
	if len(words) > 0 && accountDets[words[0]] {
		words, qualified = words[1:], true
		if len(words) > 0 && words[0] == "own" {
			words = words[1:]
		}
	}
	noun := strings.Join(words, " ")
	return accountBareOK[noun] || (qualified && accountNouns[noun])
}
