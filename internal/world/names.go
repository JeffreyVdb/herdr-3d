package world

import (
	"hash/fnv"
	"strconv"
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

// PickName chooses a name for a new worker that is not in taken. The start
// position in Names is derived from the worker id, so the choice is stable
// for the same id and floor contents, and floors don't all start with the
// same name. When every name is taken it appends " 2", " 3", ….
func PickName(id string, taken map[string]bool) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	start := int(h.Sum32() % uint32(len(Names)))
	for n := 1; ; n++ {
		for i := range Names {
			name := Names[(start+i)%len(Names)]
			if n > 1 {
				name += " " + strconv.Itoa(n)
			}
			if !taken[name] {
				return name
			}
		}
	}
}
