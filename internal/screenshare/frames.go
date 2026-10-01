package screenshare

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"time"
)

// DefaultTTL is how long a stored frame lives (the ticket's 10 minutes);
// DefaultSweep how often the janitor looks.
const (
	DefaultTTL   = 10 * time.Minute
	DefaultSweep = 30 * time.Second
)

// ErrNoRuntimeDir: neither $XDG_RUNTIME_DIR nor /run/user/<uid> is there,
// so there is no tmpfs to put frames on (they never go to a disk-backed
// /tmp by default).
var ErrNoRuntimeDir = errors.New("no runtime directory for screen frames: set XDG_RUNTIME_DIR or --screen-dir")

// DefaultDir is $XDG_RUNTIME_DIR/herdr-world/screen. Without the variable it
// falls back to /run/user/<uid>/herdr-world/screen when that runtime
// directory exists and is ours (fallback true: the caller says so in its
// log), else ErrNoRuntimeDir.
func DefaultDir() (dir string, fallback bool, err error) {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return filepath.Join(d, "herdr-world", "screen"), false, nil
	}
	run := filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
	if ownDir(run) == nil {
		return filepath.Join(run, "herdr-world", "screen"), true, nil
	}
	return "", false, ErrNoRuntimeDir
}

var (
	idRe    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	frameRe = regexp.MustCompile(`^frame-([0-9]{1,15})-[0-9a-f]{32}\.jpg$`)
)

// ValidID reports a frame request id: 32 lowercase hex digits (128 random
// bits, what the hub makes).
func ValidID(id string) bool { return idRe.MatchString(id) }

// Frames is the frame store: one private directory (0700, ours, not a
// symlink), one 0600 file per grab, named for when it was stored, removed
// TTL later by Sweep.
type Frames struct {
	dir string
	ttl time.Duration
	now func() time.Time
	log *slog.Logger
}

// Options configure Open.
type Options struct {
	TTL time.Duration    // default DefaultTTL
	Now func() time.Time // default time.Now: the clock frame names and ages are read on
	Log *slog.Logger
}

// Open creates (or tightens) dir to 0700 and sweeps what is past its TTL,
// and a temporary file a crash left behind.
func Open(dir string, o Options) (*Frames, error) {
	if o.TTL <= 0 {
		o.TTL = DefaultTTL
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("screen frame directory must be absolute: %q", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := ownDir(dir); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil { // MkdirAll leaves an existing directory as it was
		return nil, err
	}
	f := &Frames{dir: dir, ttl: o.TTL, now: o.Now, log: o.Log}
	if _, err := f.sweep(true); err != nil {
		return nil, err
	}
	return f, nil
}

// ownDir checks that dir is a directory (not a symlink to one) owned by us.
func ownDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s is owned by uid %d, not us", dir, st.Uid)
	}
	return nil
}

// Dir is where the frames are.
func (f *Frames) Dir() string { return f.dir }

// TTL is how long a frame lives.
func (f *Frames) TTL() time.Duration { return f.ttl }

// Save stores one frame under its request id and returns its path. The file
// is written to a temporary name and renamed, so a reader never sees half a
// frame.
func (f *Frames) Save(id string, b []byte) (string, error) {
	if !ValidID(id) {
		return "", fmt.Errorf("bad frame id %q", id)
	}
	tmp, err := os.CreateTemp(f.dir, ".tmp-*")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	_ = tmp.Chmod(0o600) // CreateTemp makes 0600 files; the mode is the point
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	path := filepath.Join(f.dir, fmt.Sprintf("frame-%d-%s.jpg", f.now().UnixMilli(), id))
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return path, nil
}

// Sweep removes the frames stored TTL ago or longer (by the time in their
// name, on the store's clock) and returns how many went.
func (f *Frames) Sweep() (int, error) { return f.sweep(false) }

func (f *Frames) sweep(startup bool) (int, error) {
	ents, err := os.ReadDir(f.dir)
	if err != nil {
		return 0, err
	}
	cut := f.now().Add(-f.ttl).UnixMilli()
	n := 0
	var errs []error
	for _, e := range ents {
		name := e.Name()
		old := false
		if m := frameRe.FindStringSubmatch(name); m != nil {
			at, _ := strconv.ParseInt(m[1], 10, 64)
			old = at <= cut
		} else if startup && len(name) > 5 && name[:5] == ".tmp-" {
			old = true // a Save that never finished
		}
		if !old || !e.Type().IsRegular() {
			continue
		}
		if err := os.Remove(filepath.Join(f.dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
			continue
		}
		n++
	}
	return n, errors.Join(errs...)
}

// Run sweeps every `every` (default DefaultSweep) until ctx is done.
func (f *Frames) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = DefaultSweep
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := f.Sweep(); err != nil {
				f.log.Warn("screen frame sweep failed", "dir", f.dir, "err", err)
			} else if n > 0 {
				f.log.Debug("screen frames expired", "n", n)
			}
		}
	}
}
