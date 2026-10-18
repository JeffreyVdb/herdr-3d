// Package secretfiles keeps the prompt secrets the user chose to protect
// (#108) as private files on the bridge host:
// <dir>/<owner directory>/<file>, the directory $XDG_RUNTIME_DIR/herdr-world/
// secrets by default (a validated /run/user/<uid> without the variable),
// owner directories 0700 and files 0600, both named by crypto/rand.Text
// (never a fragment of a secret). Every operation goes down from "/" one
// component at a time and never follows a symlink (openat2 with
// RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH, or one O_NOFOLLOW component at a
// time where openat2 is missing), creates exclusively, writes every byte as
// given, and removes what it made when anything fails. An existing directory
// of the wrong owner or mode is refused, never repaired.
//
// An owner is a worker (its files live until the worker really ends) or a
// pending owner (a token with an expiry, for a request that has no worker
// yet; Claim gives its files to the worker it became). The store keeps only
// the opaque names, the owners and the expiries: never a secret byte.
// Unlinking a file is not a secure erasure of its bytes (tmpfs pages can be
// swapped). One bridge at a time holds a directory (a lock file in it).
//
// Linux only: elsewhere Open fails with ErrUnsupported.
package secretfiles

import (
	"crypto/rand"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Options configure Open.
type Options struct {
	Dir   string       // absolute, ValidDir
	Store *store.Store // the owners and names
	Now   func() time.Time
	Log   *slog.Logger
}

// Kinds of Owner.
const (
	OwnerWorker  = "worker"
	OwnerPending = "pending"
)

// Owner is whose files they are: a worker's id, or a pending owner's token.
type Owner struct{ Kind, ID string }

// Worker is the owner of worker id's files.
func Worker(id string) Owner { return Owner{Kind: OwnerWorker, ID: id} }

// NewPending is a new pending owner (a random token).
func NewPending() Owner { return Owner{Kind: OwnerPending, ID: rand.Text()} }

// File is one protected file: its owner directory's and its own opaque
// names, and its absolute path (what a prompt references).
type File struct{ Dir, Name, Path string }

var (
	// ErrUnavailable: no private runtime directory to keep files in
	// (neither $XDG_RUNTIME_DIR nor /run/user/<uid>, or one that is unsafe).
	ErrUnavailable = errors.New("no private runtime directory for protected prompt secrets")
	// ErrUnsupported: protected files need Linux.
	ErrUnsupported = errors.New("protected prompt secrets need Linux")
	// ErrBusy: another bridge holds the directory.
	ErrBusy = errors.New("another bridge holds the protected secrets directory")
)

// DefaultDir is $XDG_RUNTIME_DIR/herdr-world/secrets. Without the variable it
// falls back to /run/user/<uid>/herdr-world/secrets when that runtime
// directory is ours (fallback true: the caller says so in its log), else
// ErrUnavailable.
func DefaultDir() (dir string, fallback bool, err error) {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return filepath.Join(d, "herdr-world", "secrets"), false, nil
	}
	run := filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
	if ownedDir(run) {
		return filepath.Join(run, "herdr-world", "secrets"), true, nil
	}
	return "", false, ErrUnavailable
}

// safePath is the grammar of a directory a prompt can reference: absolute,
// no blank, no bracket, no shell metacharacter (Reference's text stays one
// unambiguous word).
var safePath = regexp.MustCompile(`^(?:/[A-Za-z0-9._-]+)+$`)

// ValidDir reports a directory Open accepts (clean: no . or .. part).
func ValidDir(dir string) bool { return safePath.MatchString(dir) && filepath.Clean(dir) == dir }

// ownedDir reports a directory (not a symlink to one) owned by us.
func ownedDir(dir string) bool {
	fi, err := os.Lstat(dir)
	if err != nil || !fi.IsDir() {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// nameRe is the grammar of the names this package makes (rand.Text).
var nameRe = regexp.MustCompile(`^[A-Z2-7]{26,64}$`)
