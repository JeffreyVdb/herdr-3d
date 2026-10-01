package whiteboard

import (
	"errors"
	"strings"
)

// Excalidraw's z-order keys (fractional-indexing 3.2.0, the version
// @excalidraw/excalidraw 0.18.1 depends on): base 62, a variable-length
// integer part headed by a-z (positive) or A-Z (negative), then an optional
// fraction that never ends in "0". Keys compare as plain byte strings.
// Only appending is needed here (generateKeyBetween(last, null)): an agent's
// pin goes on top of everything. docs/research/excalidraw-data.md, section 3.

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var errBadIndex = errors.New("not a fractional index key")

// integerLen is the length of a key's integer part, from its head; 0 when the
// head is not a letter.
func integerLen(head byte) int {
	switch {
	case head >= 'a' && head <= 'z':
		return int(head-'a') + 2
	case head >= 'A' && head <= 'Z':
		return int('Z'-head) + 2
	}
	return 0
}

// ValidIndex reports whether s is a key fractional-indexing accepts: a
// letter head, an integer part of the length the head says, base-62 digits,
// a fraction not ending in "0", and not the reserved smallest key.
func ValidIndex(s string) bool {
	if s == "" {
		return false
	}
	n := integerLen(s[0])
	if n == 0 || len(s) < n {
		return false
	}
	for i := 1; i < len(s); i++ {
		if strings.IndexByte(digits, s[i]) < 0 {
			return false
		}
	}
	if s == "A"+strings.Repeat("0", 26) {
		return false
	}
	return len(s) == n || s[len(s)-1] != '0'
}

// AppendIndex is the key after last (generateKeyBetween(last, null)); "" is
// an empty scene, whose first key is "a0".
func AppendIndex(last string) (string, error) {
	if last == "" {
		return "a0", nil
	}
	if !ValidIndex(last) {
		return "", errBadIndex
	}
	head := last[0]
	n := integerLen(head)
	integer := []byte(last[:n])
	carry := true
	for i := n - 1; carry && i >= 1; i-- {
		d := strings.IndexByte(digits, integer[i]) + 1
		if d == len(digits) {
			integer[i] = '0'
		} else {
			integer[i] = digits[d]
			carry = false
		}
	}
	if !carry {
		return string(integer), nil
	}
	switch head {
	case 'Z':
		return "a0", nil
	case 'z':
		// The integer part cannot grow: the midpoint of the fraction and 1.
		fraction, suffix := last[n:], ""
		for {
			d := 0
			if len(fraction) > 0 {
				d = strings.IndexByte(digits, fraction[0])
			}
			if len(digits)-d > 1 {
				suffix += string(digits[(d+len(digits)+1)/2])
				break
			}
			suffix += string(digits[d])
			if len(fraction) > 0 {
				fraction = fraction[1:]
			}
		}
		return last[:n] + suffix, nil
	}
	// A longer (a-y) or shorter (A-Y) integer part with the next head.
	integer[0]++
	if integer[0] > 'a' {
		integer = append(integer, '0')
	} else {
		integer = integer[:len(integer)-1]
	}
	return string(integer), nil
}
