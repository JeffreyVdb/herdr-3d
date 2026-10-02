package world

import (
	"hash/fnv"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Names are the display names the bridge hands out to workers: original,
// short and cute. Keep it free of anyone's IP (no Minions/Illumination
// names, no other franchise characters). Only append: a worker keeps its
// stored name, but PickName's choice for a new worker depends on the list.
var Names = []string{
	"Nibble", "Pixel", "Mochi", "Sprocket", "Pip", "Noodle", "Biscuit", "Tofu",
	"Doodle", "Pebble", "Button", "Fizz", "Bramble", "Widget", "Sprout", "Dumpling",
	"Waffle", "Muffin", "Pickle", "Bean", "Jellybean", "Marble", "Pudding", "Crumpet",
	"Nugget", "Truffle", "Wobble", "Bloop", "Zippy", "Tinker", "Cog", "Rivet",
	"Sparky", "Fuzzy", "Pom", "Poppy", "Clover", "Maple", "Nimbus", "Comet",
	"Pogo", "Kazoo", "Banjo", "Yoyo", "Kiwi", "Mango", "Plum", "Peanut",
	"Cashew", "Pretzel", "Churro", "Bagel", "Scone", "Toffee", "Fudge", "Sherbet",
	"Gumdrop", "Taffy", "Bonbon", "Cupcake", "Sprinkle", "Custard", "Wasabi", "Miso",
	"Udon", "Soba", "Yuzu", "Lychee", "Quokka", "Wombat", "Puffin", "Gecko",
	"Newt", "Tadpole", "Minnow", "Acorn", "Pinecone", "Thimble", "Zigzag", "Squiggle",
	"Blip", "Boop", "Chirp", "Jingle", "Tumble", "Scooter", "Glimmer", "Twinkle",
	"Flicker", "Ember", "Cinder", "Fidget", "Bitsy", "Byte", "Qubit", "Dongle",
	"Pesto", "Nutmeg", "Paprika", "Sesame",
}

// PickName chooses a name for a new worker. held is every name no newcomer
// may take (owned by a worker, or released within the name hold);
// released maps the held names whose owner left to when it left, so a
// name missing from it (or with a zero time) is owned by a worker on the
// floor. The start position in Names is derived from the worker id, so the
// choice is stable for the same id and floor contents, and floors don't all
// start with the same name.
//
// The result never has a digit. A free name of Names comes first. When
// every one is held, the held name released least recently is recycled (its
// hold ends early; ties go to the earlier entry of Names). A name of a live
// worker is never recycled: when all of Names are owned (more live workers
// on a floor than names), a newcomer gets a two-word name of two entries of
// Names ("Pixel Mochi"), unique among held, found from the same start. The
// compounds are len(Names)² many, far beyond any floor's worker cap; should
// they run out anyway, the first one is returned.
func PickName(id string, held map[string]bool, released map[string]time.Time) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	start := int(h.Sum32() % uint32(len(Names)))
	n := len(Names)
	for i := range Names {
		if name := Names[(start+i)%n]; !held[name] {
			return name
		}
	}
	if oldest := recyclable(held, released); oldest != "" {
		return oldest
	}
	first := ""
	for i := range Names {
		for k := 1; k < n; k++ {
			name := Names[(start+i)%n] + " " + Names[(start+i+k)%n]
			if first == "" {
				first = name
			}
			if !held[name] {
				return name
			}
		}
	}
	return first
}

// recyclable returns the held name of Names released longest ago, ties to
// the earlier entry of Names (so it does not depend on a worker id), or "" if
// every one is owned by a worker.
func recyclable(held map[string]bool, released map[string]time.Time) string {
	oldest := ""
	var at time.Time
	for _, name := range Names {
		if t := released[name]; held[name] && !t.IsZero() && (oldest == "" || t.Before(at)) {
			oldest, at = name, t
		}
	}
	return oldest
}

// Pickable reports whether a worker may be hired under the requested label
// now: a name of Names or a compound that is not held, or the very name
// PickName would recycle. A label with a digit (a legacy suffixed name) is
// never pickable: IsName still accepts those for stored workers only.
func Pickable(name string, held map[string]bool, released map[string]time.Time) bool {
	if !IsName(name) || strings.ContainsAny(name, "0123456789") {
		return false
	}
	if !held[name] {
		return true
	}
	for _, n := range Names {
		if !held[n] {
			return false
		}
	}
	return name == recyclable(held, released)
}

// IsName reports whether name is one this package hands out: an entry of
// Names, two entries joined by a space (PickName's last resort), or, for
// workers named before names stopped growing numbers, an entry with a
// " <n>" suffix (n ≥ 2), which is kept for the life of its worker and never
// handed out again.
func IsName(name string) bool {
	if slices.Contains(Names, name) {
		return true
	}
	i := strings.LastIndexByte(name, ' ')
	if i <= 0 {
		return false
	}
	base, suffix := name[:i], name[i+1:]
	if slices.Contains(Names, base) {
		n, err := strconv.Atoi(suffix)
		return slices.Contains(Names, suffix) || err == nil && n >= 2 && strconv.Itoa(n) == suffix
	}
	return false
}
