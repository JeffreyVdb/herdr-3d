//go:build linux

package secretfiles

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Files is an open protected secrets directory.
type Files struct {
	dir   string
	parts []string
	st    *store.Store
	now   func() time.Time
	log   *slog.Logger
	uid   uint32

	mu      sync.Mutex // one operation at a time: writes, removals and sweeps never interleave
	lock    int        // the lock file, held while open
	changed func()

	rmu     sync.Mutex           // never held with mu waited for: Revoked is asked on the hub goroutine
	revoked map[string]time.Time // round 5: a revoked file's path → when
}

// lockName is the lock file in the directory (not a name nameRe matches).
const lockName = ".lock"

// Open validates dir (ValidDir), creates it 0700 (and its parent, at most:
// the runtime directory itself must exist), verifies it and every
// directory above it, and takes its lock. It does not sweep (Sweep).
func Open(o Options) (*Files, error) {
	if o.Store == nil {
		return nil, errors.New("secretfiles: no store")
	}
	if !ValidDir(o.Dir) {
		return nil, fmt.Errorf("%w: %q is not an absolute path of letters, digits, '.', '_' and '-'", ErrUnavailable, o.Dir)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Changed == nil {
		o.Changed = func() {}
	}
	f := &Files{dir: o.Dir, parts: strings.Split(strings.TrimPrefix(o.Dir, "/"), "/"), st: o.Store, now: o.Now, log: o.Log,
		uid: uint32(os.Getuid()), lock: -1, changed: o.Changed, revoked: map[string]time.Time{}}
	root, err := f.openRoot(true)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	fd, err := openAt(root, lockName, unix.O_RDWR|unix.O_CREAT, 0o600)
	if err != nil {
		return nil, fmt.Errorf("%w: its lock file: %v", ErrUnavailable, err)
	}
	if err := f.verify(fd, unix.S_IFREG, 0o600); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("%w: its lock file: %v", ErrUnavailable, err)
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		unix.Close(fd)
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, ErrBusy
		}
		return nil, fmt.Errorf("%w: its lock: %v", ErrUnavailable, err)
	}
	f.lock = fd
	return f, nil
}

// Dir is the directory.
func (f *Files) Dir() string { return f.dir }

// IsFilePath reports a path of the shape of this directory's files (its
// directory, an owner directory and a file, both named as this package
// names them): what the bridge's references to its files hold. It says
// nothing of whether the file is there.
func (f *Files) IsFilePath(path string) bool {
	rest, ok := strings.CutPrefix(path, f.dir+"/")
	if !ok {
		return false
	}
	dir, name, ok := strings.Cut(rest, "/")
	return ok && nameRe.MatchString(dir) && nameRe.MatchString(name)
}

// FileAt is the file a path of IsFilePath's shape names (false: it has
// not that shape). It says nothing of whether the file is there.
func (f *Files) FileAt(path string) (File, bool) {
	if !f.IsFilePath(path) {
		return File{}, false
	}
	dir, name, _ := strings.Cut(strings.TrimPrefix(path, f.dir+"/"), "/")
	return File{Dir: dir, Name: name, Path: path}, true
}

// Close lets the lock go.
func (f *Files) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lock < 0 {
		return nil
	}
	err := unix.Close(f.lock)
	f.lock = -1
	return err
}

// openAt opens one component under parent without following a symlink
// anywhere: openat2 with RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH, or, where the
// kernel has no openat2 (ENOSYS), openat with O_NOFOLLOW, the same for one
// component. Any other error is the answer (never a weaker retry).
func openAt(parent int, name string, flags int, mode uint32) (int, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
		return -1, fmt.Errorf("invalid name %q", name)
	}
	flags |= unix.O_NOFOLLOW | unix.O_CLOEXEC
	for range 3 {
		fd, err := unix.Openat2(parent, name, &unix.OpenHow{Flags: uint64(flags), Mode: uint64(mode),
			Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_BENEATH})
		switch {
		case errors.Is(err, unix.ENOSYS):
			return unix.Openat(parent, name, flags, mode)
		case errors.Is(err, unix.EAGAIN), errors.Is(err, unix.EINTR):
			continue
		}
		return fd, err
	}
	return -1, unix.EAGAIN
}

const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY

// verify checks an opened descriptor: its type, our uid, exactly mode.
func (f *Files) verify(fd int, kind, mode uint32) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	switch {
	case st.Mode&unix.S_IFMT != kind:
		return errors.New("not the expected type")
	case st.Uid != f.uid:
		return fmt.Errorf("owned by uid %d, not us", st.Uid)
	case st.Mode&0o7777 != mode:
		return fmt.Errorf("mode %#o, not %#o", st.Mode&0o7777, mode)
	}
	return nil
}

// openRoot opens the directory from "/", one component at a time, never
// through a symlink. A directory above it must be a directory owned by root
// or us that others cannot write to (unless sticky, as /tmp); the directory
// itself must be ours and 0700. With create, its last two components are
// made (0700) when missing.
func (f *Files) openRoot(create bool) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	for i, name := range f.parts {
		last := i == len(f.parts)-1
		child, err := openAt(fd, name, dirFlags, 0)
		if errors.Is(err, unix.ENOENT) && create && i >= len(f.parts)-2 {
			if err = unix.Mkdirat(fd, name, 0o700); err == nil || errors.Is(err, unix.EEXIST) {
				child, err = openAt(fd, name, dirFlags, 0)
			}
		}
		unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ENOENT) && !create {
				return -1, err
			}
			return -1, fmt.Errorf("%w: /%s: %v", ErrUnavailable, strings.Join(f.parts[:i+1], "/"), err)
		}
		fd = child
		if last {
			err = f.verify(fd, unix.S_IFDIR, 0o700)
		} else {
			err = f.verifyAbove(fd)
		}
		if err != nil {
			unix.Close(fd)
			return -1, fmt.Errorf("%w: /%s: %v", ErrUnavailable, strings.Join(f.parts[:i+1], "/"), err)
		}
	}
	return fd, nil
}

func (f *Files) verifyAbove(fd int) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	switch {
	case st.Mode&unix.S_IFMT != unix.S_IFDIR:
		return errors.New("not a directory")
	case st.Uid != 0 && st.Uid != f.uid:
		return fmt.Errorf("owned by uid %d", st.Uid)
	case st.Mode&0o022 != 0 && st.Mode&unix.S_ISVTX == 0:
		return errors.New("others may write to it")
	}
	return nil
}

// Write keeps each secret, its bytes exactly as given, in a new file of the
// owner's directory (made when it has none; a pending owner's with
// expires), and returns them in order. All or nothing: on any failure the
// files written are removed.
func (f *Files) Write(ctx context.Context, owner Owner, expires time.Time, secrets [][]byte) ([]File, error) {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	root, err := f.openRoot(true)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	dir, dfd, fresh, err := f.ownerDir(ctx, root, owner, expires)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dfd)
	var out []File
	undo := func(cause error) ([]File, error) {
		for _, x := range out {
			cause = errors.Join(cause, f.unlink(ctx, dfd, x.Dir, x.Name))
		}
		if fresh {
			cause = errors.Join(cause, ignoreENOENT(unix.Unlinkat(root, dir, unix.AT_REMOVEDIR)), f.st.RemoveSecretOwner(ctx, dir))
		}
		return nil, cause
	}
	for _, b := range secrets {
		name, err := f.writeFile(dfd, b)
		if err != nil {
			return undo(err)
		}
		if err := f.st.AddSecretFile(ctx, dir, name); err != nil {
			return undo(errors.Join(err, ignoreENOENT(unix.Unlinkat(dfd, name, 0))))
		}
		out = append(out, File{Dir: dir, Name: name, Path: f.dir + "/" + dir + "/" + name})
	}
	return out, nil
}

// ownerDir opens the owner's directory: the first it has that is still
// there, else a new one (fresh) with its row.
func (f *Files) ownerDir(ctx context.Context, root int, owner Owner, expires time.Time) (string, int, bool, error) {
	rows, err := f.st.SecretOwnersOf(ctx, owner.Kind, owner.ID)
	if err != nil {
		return "", -1, false, err
	}
	for _, r := range rows {
		fd, err := openAt(root, r.Dir, dirFlags, 0)
		if errors.Is(err, unix.ENOENT) { // gone (the runtime directory was emptied): forget it
			if err := f.st.RemoveSecretOwner(ctx, r.Dir); err != nil {
				return "", -1, false, err
			}
			continue
		}
		if err == nil {
			if err = f.verify(fd, unix.S_IFDIR, 0o700); err != nil {
				unix.Close(fd)
			}
		}
		if err != nil {
			return "", -1, false, fmt.Errorf("%w: an owner directory: %v", ErrUnavailable, err)
		}
		return r.Dir, fd, false, nil
	}
	for range 8 {
		name := rand.Text()
		err := unix.Mkdirat(root, name, 0o700)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", -1, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		fd, err := openAt(root, name, dirFlags, 0)
		if err == nil {
			if err = f.verify(fd, unix.S_IFDIR, 0o700); err != nil {
				unix.Close(fd)
			}
		}
		if err == nil {
			row := store.SecretOwner{Dir: name, Kind: owner.Kind, OwnerID: owner.ID}
			if owner.Kind == OwnerPending {
				row.ExpiresAt = expires
			}
			if err = f.st.AddSecretOwner(ctx, row); err != nil {
				unix.Close(fd)
			}
		}
		if err != nil {
			return "", -1, false, errors.Join(err, ignoreENOENT(unix.Unlinkat(root, name, unix.AT_REMOVEDIR)))
		}
		return name, fd, true, nil
	}
	return "", -1, false, errors.New("no free owner directory name")
}

// writeFile writes b to a new file (exclusive, 0600) in the directory dfd:
// its name. Nothing is left behind when it fails.
func (f *Files) writeFile(dfd int, b []byte) (string, error) {
	for range 8 {
		name := rand.Text()
		fd, err := openAt(dfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL, 0o600)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", err
		}
		file := os.NewFile(uintptr(fd), name) // owns fd now
		err = f.verify(fd, unix.S_IFREG, 0o600)
		if err == nil {
			err = writeAll(file, b)
		}
		if err = errors.Join(err, file.Close()); err != nil {
			return "", errors.Join(err, ignoreENOENT(unix.Unlinkat(dfd, name, 0)))
		}
		return name, nil
	}
	return "", errors.New("no free file name")
}

// writeAll writes every byte of b: a short write without an error is one.
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if n < 0 || n > len(b) {
			return errors.New("invalid write count")
		}
		b = b[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func ignoreENOENT(err error) error {
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	return err
}

// unlink removes one file and its row.
func (f *Files) unlink(ctx context.Context, dfd int, dir, name string) error {
	return errors.Join(ignoreENOENT(unix.Unlinkat(dfd, name, 0)), f.st.RemoveSecretFile(ctx, dir, name))
}

// Remove removes files (a failed submission's), each with its row. Their
// owner directory stays (it is the owner's).
func (f *Files) Remove(ctx context.Context, files []File) error {
	if len(files) == 0 {
		return nil
	}
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	root, err := f.openRoot(false)
	if errors.Is(err, unix.ENOENT) {
		root = -1
	} else if err != nil {
		return err
	}
	defer func() {
		if root >= 0 {
			unix.Close(root)
		}
	}()
	var errs error
	for _, x := range files {
		if !nameRe.MatchString(x.Dir) || !nameRe.MatchString(x.Name) {
			errs = errors.Join(errs, fmt.Errorf("not a protected file: %q", x.Path))
			continue
		}
		if root < 0 {
			errs = errors.Join(errs, f.st.RemoveSecretFile(ctx, x.Dir, x.Name))
			continue
		}
		dfd, err := openAt(root, x.Dir, dirFlags, 0)
		if errors.Is(err, unix.ENOENT) {
			errs = errors.Join(errs, f.st.RemoveSecretFile(ctx, x.Dir, x.Name))
			continue
		}
		if err != nil {
			errs = errors.Join(errs, err)
			continue
		}
		errs = errors.Join(errs, f.unlink(ctx, dfd, x.Dir, x.Name))
		unix.Close(dfd)
	}
	return errs
}

// Exists reports whether every file is still there: a regular 0600 file of
// ours (a retry reuses them only then).
func (f *Files) Exists(files []File) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	root, err := f.openRoot(false)
	if err != nil {
		return false
	}
	defer unix.Close(root)
	for _, x := range files {
		if !nameRe.MatchString(x.Dir) || !nameRe.MatchString(x.Name) {
			return false
		}
		dfd, err := openAt(root, x.Dir, dirFlags, 0)
		if err != nil {
			return false
		}
		var st unix.Stat_t
		err = unix.Fstatat(dfd, x.Name, &st, unix.AT_SYMLINK_NOFOLLOW)
		unix.Close(dfd)
		if err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Uid != f.uid || st.Mode&0o7777 != 0o600 {
			return false
		}
	}
	return true
}

// Claim gives a pending owner's files to worker id: they live as the
// worker's from now on. ErrNotPending: it has none (never had a file, was
// claimed already, or expired, even if the janitor has not removed them
// yet).
func (f *Files) Claim(ctx context.Context, token, workerID string) error {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	n, err := f.st.ClaimSecretOwner(ctx, token, workerID, f.now())
	if err == nil && n == 0 {
		err = ErrNotPending
	}
	return err
}

// Lease lets worker id hold files it does not own (round 5: a handoff's
// successor): each lives as long as its owner or any worker holding it.
// A file with no row (gone), or of one of the worker's own directories, is
// left out: how many it holds now that it did not.
func (f *Files) Lease(ctx context.Context, workerID string, files []File) (int, error) {
	if len(files) == 0 {
		return 0, nil
	}
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	var errs error
	for _, x := range files {
		if !nameRe.MatchString(x.Dir) || !nameRe.MatchString(x.Name) {
			errs = errors.Join(errs, fmt.Errorf("not a protected file: %q", x.Path))
			continue
		}
		ok, err := f.st.AddSecretLease(ctx, store.SecretFile{Dir: x.Dir, Name: x.Name}, workerID)
		if ok {
			n++
		}
		errs = errors.Join(errs, err)
	}
	return n, errs
}

// Release ends an owner (a worker that really ended, a pending owner whose
// request failed): it holds nothing from now on. Each file of its
// directories goes with its row unless a live worker holds it by a lease
// (the directory and its row stay for those); each file it held by a lease
// is let go, and goes too when neither its owner nor another holder is
// live. liveness is read with the directory locked; the owner itself is
// never live.
func (f *Files) Release(ctx context.Context, owner Owner, liveness Liveness) error {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	live, err := liveness(ctx)
	if err != nil {
		return err
	}
	rows, err := f.st.SecretOwnersOf(ctx, owner.Kind, owner.ID)
	if err != nil {
		return err
	}
	dirs := map[string]bool{}
	for _, r := range rows {
		dirs[r.Dir] = true
	}
	if owner.Kind == OwnerWorker {
		leases, err := f.st.SecretLeasesOf(ctx, owner.ID)
		if err != nil {
			return err
		}
		for _, l := range leases {
			dirs[l.Dir] = true
		}
		if err := f.st.RemoveSecretLeasesOf(ctx, owner.ID); err != nil {
			return err
		}
	}
	if len(dirs) == 0 {
		return nil
	}
	return f.reconcile(ctx, dirs, f.ending(live, owner))
}

// ReleaseExpired removes the pending owners whose expiry passed (their
// files a live worker holds by a lease stay).
func (f *Files) ReleaseExpired(ctx context.Context, liveness Liveness) error {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	live, err := liveness(ctx)
	if err != nil {
		return err
	}
	rows, err := f.st.SecretOwners(ctx)
	if err != nil {
		return err
	}
	now := f.now()
	dirs := map[string]bool{}
	for _, r := range rows {
		if r.Kind == OwnerPending && expired(r, now) {
			dirs[r.Dir] = true
		}
	}
	return f.reconcile(ctx, dirs, f.ending(live, Owner{}))
}

// Revoke removes every file worker id holds now (round 5): those of its
// own directories (with the directories) and those it holds by a lease,
// for every holder, with their rows: how many it held. The worker keeps
// running; a text that refers to one of them refers to nothing. Each path
// is Revoked before its file goes. A directory a lease kept for its holders
// (its owner ended) goes once none of them holds a file in it.
func (f *Files) Revoke(ctx context.Context, workerID string, liveness Liveness) (int, error) {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	live, err := liveness(ctx)
	if err != nil {
		return 0, err
	}
	own, err := f.st.SecretOwnersOf(ctx, OwnerWorker, workerID)
	if err != nil {
		return 0, err
	}
	leases, err := f.st.SecretLeasesOf(ctx, workerID)
	if err != nil {
		return 0, err
	}
	var held []store.SecretFile
	for _, r := range own {
		names, err := f.st.SecretFiles(ctx, r.Dir)
		if err != nil {
			return 0, err
		}
		for _, n := range names {
			held = append(held, store.SecretFile{Dir: r.Dir, Name: n})
		}
	}
	for _, l := range leases {
		held = append(held, l.SecretFile)
	}
	paths := make([]string, len(held))
	for i, x := range held {
		paths[i] = f.dir + "/" + x.Dir + "/" + x.Name
	}
	f.markRevoked(paths) // before any goes: a send that checks its references now finds them
	root, err := f.openRoot(false)
	if errors.Is(err, unix.ENOENT) {
		root = -1
	} else if err != nil {
		return 0, err
	}
	defer func() {
		if root >= 0 {
			unix.Close(root)
		}
	}()
	var errs error
	for _, r := range own {
		if root >= 0 {
			if err := f.removeDir(root, r.Dir); err != nil {
				errs = errors.Join(errs, err)
				continue
			}
		}
		errs = errors.Join(errs, f.st.RemoveSecretOwner(ctx, r.Dir))
	}
	dirs := map[string]bool{}
	for _, l := range leases {
		dirs[l.Dir] = true
		if root < 0 {
			errs = errors.Join(errs, f.st.RemoveSecretFile(ctx, l.Dir, l.Name))
			continue
		}
		dfd, err := openAt(root, l.Dir, dirFlags, 0)
		if errors.Is(err, unix.ENOENT) {
			errs = errors.Join(errs, f.st.RemoveSecretFile(ctx, l.Dir, l.Name))
			continue
		}
		if err != nil {
			errs = errors.Join(errs, err)
			continue
		}
		errs = errors.Join(errs, f.unlink(ctx, dfd, l.Dir, l.Name))
		unix.Close(dfd)
	}
	if errs != nil {
		return len(held), errs
	}
	return len(held), f.reconcile(ctx, dirs, f.ending(live, Owner{}))
}

// markRevoked remembers revoked paths (RevokedFor).
func (f *Files) markRevoked(paths []string) {
	f.rmu.Lock()
	defer f.rmu.Unlock()
	now := f.now()
	for p, at := range f.revoked {
		if now.Sub(at) > RevokedFor {
			delete(f.revoked, p)
		}
	}
	for _, p := range paths {
		f.revoked[p] = now
	}
}

// Revoked reports whether any of the paths is a file Revoke removed (in the
// last RevokedFor): a text that refers to one is not sent (round 5). It
// never waits for the directory's lock (the hub goroutine asks it).
func (f *Files) Revoked(paths ...string) bool {
	f.rmu.Lock()
	defer f.rmu.Unlock()
	for _, p := range paths {
		if _, ok := f.revoked[p]; ok {
			return true
		}
	}
	return false
}

func expired(r store.SecretOwner, now time.Time) bool {
	return !r.ExpiresAt.IsZero() && !now.Before(r.ExpiresAt)
}

// holder reports whether an owner keeps its directory: a live worker, a
// pending owner not expired.
type holder func(store.SecretOwner) bool

// ending is the holder test of an operation that ends owner (Kind "":
// none): live's workers and the pending owners not expired, never owner.
func (f *Files) ending(live func(string) bool, owner Owner) holder {
	now := f.now()
	return func(r store.SecretOwner) bool {
		if r.Kind == owner.Kind && r.OwnerID == owner.ID {
			return false
		}
		switch r.Kind {
		case OwnerWorker:
			return live(r.OwnerID)
		case OwnerPending:
			return !expired(r, now)
		}
		return false
	}
}

// heldFiles are the files a live worker holds by a lease (f.mu held); the
// leases of a worker that is not live are forgotten (stale: it ended while
// the bridge was down, or its release failed).
func (f *Files) heldFiles(ctx context.Context, live func(string) bool) (map[store.SecretFile]bool, error) {
	leases, err := f.st.SecretLeases(ctx)
	if err != nil {
		return nil, err
	}
	held, stale := map[store.SecretFile]bool{}, map[string]bool{}
	for _, l := range leases {
		if live(l.WorkerID) {
			held[l.SecretFile] = true
		} else {
			stale[l.WorkerID] = true
		}
	}
	var errs error
	for w := range stale {
		errs = errors.Join(errs, f.st.RemoveSecretLeasesOf(ctx, w))
	}
	return held, errs
}

// reconcile settles owner directories whose owner may no longer hold them
// (f.mu held): each whose owner does not (holds) keeps only the files a
// live worker holds by a lease, and goes with its row once none is left.
func (f *Files) reconcile(ctx context.Context, dirs map[string]bool, holds holder) error {
	if len(dirs) == 0 {
		return nil
	}
	rows, err := f.st.SecretOwners(ctx)
	if err != nil {
		return err
	}
	var ended []store.SecretOwner
	for _, r := range rows {
		if dirs[r.Dir] && !holds(r) {
			ended = append(ended, r)
		}
	}
	if len(ended) == 0 {
		return nil
	}
	live := func(id string) bool { return holds(store.SecretOwner{Kind: OwnerWorker, OwnerID: id}) }
	held, err := f.heldFiles(ctx, live)
	root, rerr := f.openRoot(false)
	if errors.Is(rerr, unix.ENOENT) { // nothing on disk: only rows to forget
		for _, r := range ended {
			err = errors.Join(err, f.st.RemoveSecretOwner(ctx, r.Dir))
		}
		return err
	}
	if rerr != nil {
		return errors.Join(err, rerr)
	}
	defer unix.Close(root)
	for _, r := range ended {
		_, cerr := f.collect(ctx, root, r.Dir, held)
		err = errors.Join(err, cerr)
	}
	return err
}

// collect removes what an owner directory whose owner no longer holds it
// keeps for nobody (f.mu held): the files no live worker holds by a lease,
// with their rows (and what has no row), then the directory and its row
// once nothing is left. gone: the directory went.
func (f *Files) collect(ctx context.Context, root int, dir string, held map[store.SecretFile]bool) (gone bool, err error) {
	keep := false
	for x := range held {
		if x.Dir == dir {
			keep = true
			break
		}
	}
	if !keep {
		if err := f.removeDir(root, dir); err != nil {
			return false, err
		}
		return true, f.st.RemoveSecretOwner(ctx, dir)
	}
	known, err := f.st.SecretFiles(ctx, dir)
	if err != nil {
		return false, err
	}
	dfd, err := openAt(root, dir, dirFlags, 0)
	if errors.Is(err, unix.ENOENT) {
		return true, f.st.RemoveSecretOwner(ctx, dir)
	}
	if err != nil {
		return false, err
	}
	var errs error
	for _, n := range known {
		if !held[store.SecretFile{Dir: dir, Name: n}] {
			errs = errors.Join(errs, f.unlink(ctx, dfd, dir, n))
		}
	}
	unix.Close(dfd)
	return false, errors.Join(errs, f.sweepFiles(ctx, root, dir))
}

// removeDir removes an owner directory: its files and symlinks (never
// followed), then the directory. Anything else in it is refused, left
// there.
func (f *Files) removeDir(root int, dir string) error {
	if !nameRe.MatchString(dir) {
		return fmt.Errorf("not an owner directory: %q", dir)
	}
	dfd, err := openAt(root, dir, dirFlags, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	names, err := list(dfd)
	if err != nil {
		unix.Close(dfd)
		return err
	}
	var errs error
	for _, n := range names {
		var st unix.Stat_t
		if err := unix.Fstatat(dfd, n, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			errs = errors.Join(errs, ignoreENOENT(err))
			continue
		}
		if t := st.Mode & unix.S_IFMT; t != unix.S_IFREG && t != unix.S_IFLNK {
			errs = errors.Join(errs, fmt.Errorf("owner directory %s holds something else than files", dir))
			continue
		}
		errs = errors.Join(errs, ignoreENOENT(unix.Unlinkat(dfd, n, 0)))
	}
	unix.Close(dfd)
	if errs != nil {
		return errs
	}
	return ignoreENOENT(unix.Unlinkat(root, dir, unix.AT_REMOVEDIR))
}

// list is the names in the directory dfd (read through a duplicate, so dfd
// stays open and positioned).
func list(dfd int) ([]string, error) {
	dup, err := unix.Openat(dfd, ".", dirFlags|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	d := os.NewFile(uintptr(dup), ".")
	defer d.Close()
	return d.Readdirnames(-1)
}

// Sweep reconciles the directory with the store (at start, and from time to
// time): it removes owner directories with no row, those of a worker that
// is not live (closed or unknown) and expired pending owners, the files of
// a kept directory with no row, and the rows whose directory or file is
// gone; round 5: a directory whose owner no longer holds it keeps the files
// a live worker holds by a lease (the others go), and a worker that is not
// live holds nothing (its leases are forgotten). Names this package does
// not make are left alone (logged). liveness is read with the directory
// locked, so no file is written, claimed or leased between that read and
// the sweep (a worker whose files are there was live before them). removed
// is how many owner directories went.
func (f *Files) Sweep(ctx context.Context, liveness Liveness) (removed int, err error) {
	defer f.changed()
	f.mu.Lock()
	defer f.mu.Unlock()
	live, err := liveness(ctx)
	if err != nil {
		return 0, err
	}
	rows, err := f.st.SecretOwners(ctx)
	if err != nil {
		return 0, err
	}
	byDir := map[string]store.SecretOwner{}
	for _, r := range rows {
		byDir[r.Dir] = r
	}
	root, err := f.openRoot(false)
	if errors.Is(err, unix.ENOENT) { // nothing on disk (a reboot emptied it)
		var errs error
		for _, r := range rows {
			errs = errors.Join(errs, f.st.RemoveSecretOwner(ctx, r.Dir))
		}
		return 0, errs
	}
	if err != nil {
		return 0, err
	}
	defer unix.Close(root)
	names, err := list(root)
	if err != nil {
		return 0, err
	}
	holds := f.ending(live, Owner{})
	held, errs := f.heldFiles(ctx, live)
	onDisk := map[string]bool{}
	for _, n := range names {
		if n == lockName {
			continue
		}
		if !nameRe.MatchString(n) {
			f.log.Warn("protected secrets: an unknown name in the directory, left alone", "dir", f.dir, "bytes", len(n))
			continue
		}
		onDisk[n] = true
		r, known := byDir[n]
		switch {
		case !known:
			if err := f.removeDir(root, n); err != nil {
				errs = errors.Join(errs, err)
				continue
			}
			removed++
		case holds(r):
			errs = errors.Join(errs, f.sweepFiles(ctx, root, n))
		default:
			gone, err := f.collect(ctx, root, n, held)
			errs = errors.Join(errs, err)
			if gone {
				removed++
			}
		}
	}
	for _, r := range rows {
		if !onDisk[r.Dir] {
			errs = errors.Join(errs, f.st.RemoveSecretOwner(ctx, r.Dir))
		}
	}
	return removed, errs
}

// sweepFiles removes a kept owner directory's files that have no row (a
// crash between the file and its row) and the rows whose file is gone.
func (f *Files) sweepFiles(ctx context.Context, root int, dir string) error {
	known, err := f.st.SecretFiles(ctx, dir)
	if err != nil {
		return err
	}
	dfd, err := openAt(root, dir, dirFlags, 0)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	names, err := list(dfd)
	if err != nil {
		return err
	}
	isKnown := map[string]bool{}
	for _, n := range known {
		isKnown[n] = true
	}
	present := map[string]bool{}
	var errs error
	for _, n := range names {
		present[n] = true
		if isKnown[n] {
			continue
		}
		var st unix.Stat_t
		if err := unix.Fstatat(dfd, n, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			continue
		}
		if t := st.Mode & unix.S_IFMT; t == unix.S_IFREG || t == unix.S_IFLNK {
			errs = errors.Join(errs, ignoreENOENT(unix.Unlinkat(dfd, n, 0)))
		}
	}
	for _, n := range known {
		if !present[n] {
			errs = errors.Join(errs, f.st.RemoveSecretFile(ctx, dir, n))
		}
	}
	return errs
}
