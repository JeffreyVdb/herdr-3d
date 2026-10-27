package cmdrequest

import (
	"regexp"
	"strings"
	"unicode"
)

// #220: before an account phrase moves a command to the bridge, the rest of
// the reply must not mention another machine. The detector is closed and
// leans towards firing: a false hit only keeps the command off the bridge.
// It fires on "on", "onto" or "from" before any word ("on your Mac", "On
// root", "from prod", "on `kiswe-mbp`"), ssh/scp/rsync/sftp/mosh, a
// user@host shape, "remote"/"remotely", an IPv4 address and machine nouns
// anywhere. http(s) URLs are blanked first: opening a URL is not running a
// command there.

var (
	machineURL       = regexp.MustCompile(`(?i)\bhttps?://[^\s<>()\[\]"'` + "`" + `]*`)
	machineMentionRE = regexp.MustCompile(`(?i)` +
		`\b(?:on|onto|from)\s+["'` + "`" + `“‘(\[<]*\w` +
		`|\b(?:ssh|scp|rsync|sftp|mosh)\b` +
		`|\w@\w` +
		`|\bremote(?:ly|s)?\b` +
		`|\b\d{1,3}(?:\.\d{1,3}){3}\b` +
		`|\b(?:macs?|macbooks?|imacs?|laptops?|desktops?|servers?|hosts?|hostnames?|machines?|box|boxes|vms?|containers?|phones?|workstations?|pcs?|computers?|nodes?)\b`)
)

// machineMention reports whether text mentions a machine.
func machineMention(text string) bool {
	text = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, text)
	return machineMentionRE.MatchString(machineURL.ReplaceAllString(text, " "))
}
