package usage

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// maxObservedModel bounds a model id taken from a transcript (the value
// of a workspace token is capped at 80 as well).
const maxObservedModel = 80

// CleanEffort returns an effort level a transcript reports as the catalog
// writes it (lower case letters, up to 16 as the bridge accepts a launch
// effort), else "": an effort that is not one is unknown, never guessed.
func CleanEffort(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" || len(s) > 16 {
		return ""
	}
	for _, r := range s {
		if r < 'a' || r > 'z' {
			return ""
		}
	}
	return s
}

// CleanModel returns a model id a transcript reports in the form the hire
// catalog launches it with: Claude's "[1m]" window mark dropped (the
// catalog's ids cannot hold it), so a direct hire's transcript names the
// model its record does. "" for none, Claude Code's own "<synthetic>", and
// an id that is not plain text.
func CleanModel(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSpace(strings.TrimSuffix(s, oneM))
	if s == "" || s == "<synthetic>" || len(s) > maxObservedModel || !utf8.ValidString(s) {
		return ""
	}
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return ""
	}
	return s
}
