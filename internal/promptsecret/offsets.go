package promptsecret

// Offsets on the wire are UTF-16 code units (docs/protocol.md "Prompt
// secrets"), as the game's strings index; the bridge works in UTF-8 bytes.
// A range may start or end at any code point, never inside a surrogate pair.

import "unicode/utf8"

// Offsets converts between a text's byte offsets and its UTF-16 offsets.
type Offsets struct {
	text string
	u16  []int // byte offset → UTF-16 offset (at code point starts and the end; -1 inside a code point)
	b8   []int // UTF-16 offset → byte offset (-1 inside a surrogate pair)
}

// NewOffsets indexes text (valid UTF-8).
func NewOffsets(text string) *Offsets {
	o := &Offsets{text: text, u16: make([]int, len(text)+1)}
	for i := range o.u16 {
		o.u16[i] = -1
	}
	u := 0
	for i, r := range text {
		o.u16[i] = u
		o.b8 = append(o.b8, i)
		if r >= 0x10000 && r <= utf8.MaxRune {
			o.b8 = append(o.b8, -1)
			u += 2
		} else {
			u++
		}
	}
	o.u16[len(text)] = u
	o.b8 = append(o.b8, len(text))
	return o
}

// Len is the text's length in UTF-16 code units.
func (o *Offsets) Len() int { return len(o.b8) - 1 }

// UTF16 is the UTF-16 offset of byte offset b (a code point boundary).
func (o *Offsets) UTF16(b int) int {
	if b < 0 || b >= len(o.u16) || o.u16[b] < 0 {
		return -1
	}
	return o.u16[b]
}

// Byte is the byte offset of UTF-16 offset u; false when u is out of range
// or inside a surrogate pair.
func (o *Offsets) Byte(u int) (int, bool) {
	if u < 0 || u >= len(o.b8) || o.b8[u] < 0 {
		return 0, false
	}
	return o.b8[u], true
}
