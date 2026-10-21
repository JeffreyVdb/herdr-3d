package herdr

// #176 part 2: the herdr CLI's version, read once (`herdr --version`): the
// controller takes terminal.mouse from herdr 0.9.2 on; an older CLI ignores
// the line with a note on its stderr.

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version is a herdr release, by its numbers.
type Version struct{ Major, Minor, Patch int }

func (v Version) String() string {
	return strconv.Itoa(v.Major) + "." + strconv.Itoa(v.Minor) + "." + strconv.Itoa(v.Patch)
}

// AtLeast reports whether v is o or later.
func (v Version) AtLeast(o Version) bool {
	if v.Major != o.Major {
		return v.Major > o.Major
	}
	if v.Minor != o.Minor {
		return v.Minor > o.Minor
	}
	return v.Patch >= o.Patch
}

// MouseVersion is the first herdr whose controller takes terminal.mouse.
var MouseVersion = Version{0, 9, 2}

var versionRe = regexp.MustCompile(`(?:^|[^0-9.])v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?`)

// ParseVersion reads the first version number in `herdr --version`'s output
// ("herdr 0.9.1", "herdr v0.10.0-rc.1 (abc123)"): a pre-release or a build
// counts as its release, a missing patch as 0. False when there is none.
func ParseVersion(out string) (Version, bool) {
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	m := versionRe.FindStringSubmatch(line)
	if m == nil {
		return Version{}, false
	}
	n := func(s string) int { v, _ := strconv.Atoi(s); return v }
	return Version{n(m[1]), n(m[2]), n(m[3])}, true
}

// versionRetry is how soon a version that could not be read is tried again.
const versionRetry = time.Minute

// versionCache is Control's `herdr --version`, read once.
type versionCache struct {
	mu    sync.Mutex
	ok    bool
	v     Version
	tried time.Time // the last read that failed
}

// Version is the herdr CLI's version (`herdr --version`), read once and
// kept; a read that failed (or output without a version) is tried again
// after a minute, and false meanwhile.
func (c *Control) Version(ctx context.Context) (Version, bool) {
	c.ver.mu.Lock()
	defer c.ver.mu.Unlock()
	if c.ver.ok {
		return c.ver.v, true
	}
	if !c.ver.tried.IsZero() && time.Since(c.ver.tried) < versionRetry {
		return Version{}, false
	}
	out, err := c.run(ctx, opVersion, nil)
	if err == nil {
		if v, ok := ParseVersion(string(out)); ok {
			c.ver.v, c.ver.ok = v, true
			return v, true
		}
	}
	c.ver.tried = time.Now()
	return Version{}, false
}

// MouseClicks reports whether the herdr CLI's controller takes mouse clicks
// (terminal.mouse, herdr 0.9.2 and later).
func (c *Control) MouseClicks(ctx context.Context) bool {
	v, ok := c.Version(ctx)
	return ok && v.AtLeast(MouseVersion)
}
