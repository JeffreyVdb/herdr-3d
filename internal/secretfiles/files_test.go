//go:build linux

package secretfiles_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

var ctx = context.Background()

type fixture struct {
	f       *secretfiles.Files
	st      *store.Store
	dir     string
	db      string
	now     *time.Time
	changes atomic.Int32 // Options.Changed calls
}

func open(t *testing.T) *fixture {
	t.Helper()
	base := t.TempDir()
	db := filepath.Join(base, "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	fx := &fixture{st: st, dir: filepath.Join(base, "run", "herdr-world", "secrets"), db: db, now: &now}
	if err := os.Mkdir(filepath.Join(base, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	fx.f, err = secretfiles.Open(secretfiles.Options{Dir: fx.dir, Store: st, Now: func() time.Time { return *fx.now }, Log: nil,
		Changed: func() { fx.changes.Add(1) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fx.f.Close() })
	return fx
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode()
}

func TestWriteKeepsTheExactBytes(t *testing.T) {
	t.Parallel()
	fx := open(t)
	secrets := [][]byte{
		[]byte("wólk🌧️Zeven9!"),
		[]byte("-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3Bl\nbnNz\n-----END OPENSSH PRIVATE KEY-----"),
		[]byte(`a!B@c#D$e%F^g&H*i(J)k=L+M;'"\` + "`$(rm -rf /)\t "),
		[]byte("same"), []byte("same"),
	}
	files, err := fx.f.Write(ctx, secretfiles.Worker("w-1"), time.Time{}, secrets)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(secrets) {
		t.Fatalf("files %+v", files)
	}
	if mode(t, fx.dir) != os.ModeDir|0o700 {
		t.Errorf("root mode %v", mode(t, fx.dir))
	}
	for i, x := range files {
		if x.Path != filepath.Join(fx.dir, x.Dir, x.Name) || x.Dir != files[0].Dir {
			t.Errorf("file %d: %+v", i, x)
		}
		b, err := os.ReadFile(x.Path)
		if err != nil || !bytes.Equal(b, secrets[i]) {
			t.Errorf("file %d holds %q (%v), want %q", i, b, err, secrets[i])
		}
		if m := mode(t, x.Path); m != 0o600 {
			t.Errorf("file %d mode %v", i, m)
		}
		if strings.Contains(x.Path, "same") || strings.Contains(x.Path, "Zeven") {
			t.Errorf("a name holds a secret: %s", x.Path)
		}
	}
	if files[3].Name == files[4].Name {
		t.Error("two identical secrets share a file")
	}
	if m := mode(t, filepath.Join(fx.dir, files[0].Dir)); m != os.ModeDir|0o700 {
		t.Errorf("owner dir mode %v", m)
	}
	if !fx.f.Exists(files) {
		t.Error("files do not exist")
	}
	// The database holds names, never bytes.
	for _, suffix := range []string{"", "-wal", "-shm"} {
		b, _ := os.ReadFile(fx.db + suffix)
		for _, s := range secrets {
			if len(s) > 4 && bytes.Contains(b, s) {
				t.Errorf("world.db%s holds a secret", suffix)
			}
		}
	}
	// A second write of the same owner goes in the same directory.
	more, err := fx.f.Write(ctx, secretfiles.Worker("w-1"), time.Time{}, [][]byte{[]byte("x")})
	if err != nil || more[0].Dir != files[0].Dir {
		t.Fatalf("second write %+v %v", more, err)
	}
	// Remove takes files and rows, not the directory.
	if err := fx.f.Remove(ctx, files[:2]); err != nil {
		t.Fatal(err)
	}
	if fx.f.Exists(files[:1]) || !fx.f.Exists(files[2:]) {
		t.Fatal("remove took the wrong files")
	}
	if names, _ := fx.st.SecretFiles(ctx, files[0].Dir); len(names) != 4 {
		t.Fatalf("rows %q", names)
	}
}

// A path of the directory's own shape: what the bridge's references hold
// (a scan leaves those alone), nothing else.
func TestIsFilePath(t *testing.T) {
	t.Parallel()
	fx := open(t)
	files, err := fx.f.Write(ctx, secretfiles.Worker("w-1"), time.Time{}, [][]byte{[]byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	x := files[0]
	if !fx.f.IsFilePath(x.Path) {
		t.Fatalf("%s is not a file path", x.Path)
	}
	gh := "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	for _, p := range []string{
		"/x", "/token=" + gh, fx.dir, fx.dir + "/" + x.Dir, fx.dir + "/" + x.Dir + "/", fx.dir + "/" + x.Dir + "/" + gh,
		fx.dir + "/" + gh + "/" + x.Name, fx.dir + "/" + x.Dir + "/" + x.Name + "/" + x.Name, fx.dir + "x/" + x.Dir + "/" + x.Name,
		"/tmp" + x.Path, fx.dir + "/" + x.Dir + "/" + strings.ToLower(x.Name), fx.dir + "/../" + x.Dir + "/" + x.Name,
		fx.dir + "/" + x.Dir + "/.lock",
	} {
		if fx.f.IsFilePath(p) {
			t.Errorf("%s is a file path", p)
		}
	}
}

func TestReleaseAndPendingOwners(t *testing.T) {
	t.Parallel()
	fx := open(t)
	w1, _ := fx.f.Write(ctx, secretfiles.Worker("w-1"), time.Time{}, [][]byte{[]byte("one")})
	w2, _ := fx.f.Write(ctx, secretfiles.Worker("w-2"), time.Time{}, [][]byte{[]byte("two")})
	if err := fx.f.Release(ctx, secretfiles.Worker("w-1"), liveSet()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fx.dir, w1[0].Dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("w-1's directory: %v", err)
	}
	if !fx.f.Exists(w2) {
		t.Fatal("w-2's file went too")
	}
	if err := fx.f.Release(ctx, secretfiles.Worker("w-1"), liveSet()); err != nil { // again: nothing
		t.Fatal(err)
	}

	// A pending owner: claimed, its files are the worker's; unclaimed, they
	// go when it expires.
	p1, p2 := secretfiles.NewPending(), secretfiles.NewPending()
	if p1.ID == p2.ID || p1.Kind != secretfiles.OwnerPending {
		t.Fatalf("pending %+v %+v", p1, p2)
	}
	exp := fx.now.Add(time.Minute)
	f1, err := fx.f.Write(ctx, p1, exp, [][]byte{[]byte("p1")})
	if err != nil {
		t.Fatal(err)
	}
	f2, _ := fx.f.Write(ctx, p2, exp, [][]byte{[]byte("p2")})
	if err := fx.f.Claim(ctx, p1.ID, "w-3"); err != nil {
		t.Fatal(err)
	}
	// #108 round 2: claimed once only (a token never takes another worker's
	// files), never an expired one nor one with no files.
	if err := fx.f.Claim(ctx, p1.ID, "w-4"); !errors.Is(err, secretfiles.ErrNotPending) {
		t.Fatalf("a second claim: %v", err)
	}
	if err := fx.f.Claim(ctx, "w-3", "w-4"); !errors.Is(err, secretfiles.ErrNotPending) {
		t.Fatalf("a worker's id as a token: %v", err)
	}
	if err := fx.f.Claim(ctx, secretfiles.NewPending().ID, "w-4"); !errors.Is(err, secretfiles.ErrNotPending) {
		t.Fatalf("a token with no files: %v", err)
	}
	if err := fx.f.ReleaseExpired(ctx, liveSet()); err != nil || !fx.f.Exists(f1) || !fx.f.Exists(f2) {
		t.Fatalf("before the expiry: %v", err)
	}
	*fx.now = exp
	if err := fx.f.Claim(ctx, p2.ID, "w-4"); !errors.Is(err, secretfiles.ErrNotPending) {
		t.Fatalf("an expired owner (not swept yet): %v", err)
	}
	if err := fx.f.ReleaseExpired(ctx, liveSet()); err != nil {
		t.Fatal(err)
	}
	if !fx.f.Exists(f1) || fx.f.Exists(f2) {
		t.Fatal("expiry: the claimed file went, or the unclaimed one stayed")
	}
	if rows, _ := fx.st.SecretOwnersOf(ctx, "worker", "w-3"); len(rows) != 1 || !rows[0].ExpiresAt.IsZero() {
		t.Fatalf("claimed rows %+v", rows)
	}
	if err := fx.f.Release(ctx, secretfiles.Worker("w-3"), liveSet()); err != nil || fx.f.Exists(f1) {
		t.Fatalf("release of the claimed: %v", err)
	}
}

func TestSweep(t *testing.T) {
	t.Parallel()
	fx := open(t)
	live, _ := fx.f.Write(ctx, secretfiles.Worker("live"), time.Time{}, [][]byte{[]byte("a")})
	asleep, _ := fx.f.Write(ctx, secretfiles.Worker("asleep"), time.Time{}, [][]byte{[]byte("b")})
	closed, _ := fx.f.Write(ctx, secretfiles.Worker("closed"), time.Time{}, [][]byte{[]byte("c")})
	pending, _ := fx.f.Write(ctx, secretfiles.NewPending(), fx.now.Add(time.Second), [][]byte{[]byte("d")})
	// An orphan directory (no row), a stray file in a kept directory (no
	// row), a row whose file is gone, a row whose directory is gone, and a
	// name this package never makes.
	orphan := filepath.Join(fx.dir, "ORPHANORPHANORPHANORPHAN22")
	must(t, os.Mkdir(orphan, 0o700))
	must(t, os.WriteFile(filepath.Join(orphan, "AAAAAAAAAAAAAAAAAAAAAAAAAA"), []byte("x"), 0o600))
	stray := filepath.Join(fx.dir, live[0].Dir, "STRAYSTRAYSTRAYSTRAYSTRAY2")
	must(t, os.WriteFile(stray, []byte("y"), 0o600))
	must(t, fx.st.AddSecretFile(ctx, live[0].Dir, "GONEGONEGONEGONEGONEGONE22"))
	must(t, fx.st.AddSecretOwner(ctx, store.SecretOwner{Dir: "NODIRNODIRNODIRNODIRNODIR2", Kind: "worker", OwnerID: "live"}))
	other := filepath.Join(fx.dir, "not-ours")
	must(t, os.Mkdir(other, 0o700))

	*fx.now = fx.now.Add(time.Second)
	removed, err := fx.f.Sweep(ctx, liveSet("live", "asleep"))
	if err != nil {
		t.Fatal(err)
	}
	if removed != 3 { // the orphan, the closed worker's, the expired pending
		t.Errorf("removed %d", removed)
	}
	if !fx.f.Exists(live) || !fx.f.Exists(asleep) || fx.f.Exists(closed) || fx.f.Exists(pending) {
		t.Error("sweep kept or removed the wrong owners")
	}
	for _, p := range []string{orphan, stray} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s stayed", p)
		}
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("a name the package does not make was removed")
	}
	if names, _ := fx.st.SecretFiles(ctx, live[0].Dir); !slices.Equal(names, []string{live[0].Name}) {
		t.Errorf("live rows %q", names)
	}
	rows, _ := fx.st.SecretOwners(ctx)
	if len(rows) != 2 {
		t.Errorf("rows %+v", rows)
	}
	// The directory gone altogether (a reboot): the rows go.
	must(t, os.RemoveAll(fx.dir))
	if _, err := fx.f.Sweep(ctx, liveSet("live", "asleep")); err != nil {
		t.Fatal(err)
	}
	if rows, _ := fx.st.SecretOwners(ctx); len(rows) != 0 {
		t.Errorf("rows after the directory went: %+v", rows)
	}
}

// liveSet is a Sweep's (a Release's, a Revoke's) liveness: these workers
// are live.
func liveSet(ids ...string) secretfiles.Liveness {
	return func(context.Context) (func(string) bool, error) {
		return func(id string) bool { return slices.Contains(ids, id) }, nil
	}
}

// #108 round 5: a file another worker holds by a lease lives while its
// owner or any holder does: a release keeps it for a live holder (with its
// owner directory), an expiry too, and the janitor removes it once no
// holder is live, forgetting the leases of a worker that is not.
func TestLeases(t *testing.T) {
	t.Parallel()
	fx := open(t)
	a, _ := fx.f.Write(ctx, secretfiles.Worker("a"), time.Time{}, [][]byte{[]byte("a1"), []byte("a2")})
	b, _ := fx.f.Write(ctx, secretfiles.Worker("b"), time.Time{}, [][]byte{[]byte("b1")})
	lease := func(worker string, files []secretfiles.File, want int) {
		t.Helper()
		before := fx.changes.Load()
		if n, err := fx.f.Lease(ctx, worker, files); err != nil || n != want {
			t.Fatalf("lease to %s: %d %v, want %d", worker, n, err, want)
		}
		if fx.changes.Load() == before {
			t.Fatal("a lease told no one")
		}
	}
	gone := secretfiles.File{Dir: a[0].Dir, Name: "GONEGONEGONEGONEGONEGONE22", Path: a[0].Path + "X"}
	lease("b", []secretfiles.File{a[0], gone}, 1) // a file with no row is left out
	lease("c", a[:1], 1)
	lease("b", b, 0)     // its own
	lease("b", a[:1], 0) // held already
	if got, ok := fx.f.FileAt(a[0].Path); !ok || got != a[0] {
		t.Fatalf("FileAt %+v %v", got, ok)
	}
	if _, ok := fx.f.FileAt(fx.dir + "/x/" + a[0].Name); ok {
		t.Fatal("FileAt took a name the package does not make")
	}
	counts, _ := fx.st.SecretFileCounts(ctx)
	if counts["a"] != 2 || counts["b"] != 2 || counts["c"] != 1 {
		t.Fatalf("counts %v", counts)
	}

	// a ends: a1 stays for b and c, a2 goes; its directory stays for them.
	if err := fx.f.Release(ctx, secretfiles.Worker("a"), liveSet("a", "b", "c")); err != nil {
		t.Fatal(err)
	}
	if !fx.f.Exists(a[:1]) || fx.f.Exists(a[1:]) {
		t.Fatal("a's end: its leased file went, or the other stayed")
	}
	if rows, _ := fx.st.SecretOwnersOf(ctx, "worker", "a"); len(rows) != 1 {
		t.Fatalf("a's directory row %+v", rows)
	}
	// b ends: a1 stays for c; b's own file goes.
	if err := fx.f.Release(ctx, secretfiles.Worker("b"), liveSet("c")); err != nil {
		t.Fatal(err)
	}
	if !fx.f.Exists(a[:1]) || fx.f.Exists(b) {
		t.Fatal("b's end")
	}
	// The janitor, c gone too (it ended while the bridge was down): a1 and
	// a's directory go, and c's lease is forgotten.
	if n, err := fx.f.Sweep(ctx, liveSet()); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(fx.dir, a[0].Dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a's directory: %v", err)
	}
	if l, _ := fx.st.SecretLeases(ctx); len(l) != 0 {
		t.Fatalf("leases %+v", l)
	}

	// A pending owner's file a worker holds outlives its expiry while the
	// worker lives; the sweep keeps it then, and the worker's end takes it.
	p := secretfiles.NewPending()
	pf, _ := fx.f.Write(ctx, p, fx.now.Add(time.Minute), [][]byte{[]byte("p1"), []byte("p2")})
	lease("d", pf[:1], 1)
	*fx.now = fx.now.Add(time.Minute)
	if err := fx.f.ReleaseExpired(ctx, liveSet("d")); err != nil {
		t.Fatal(err)
	}
	if !fx.f.Exists(pf[:1]) || fx.f.Exists(pf[1:]) {
		t.Fatal("expiry: the held file went, or the other stayed")
	}
	if _, err := fx.f.Sweep(ctx, liveSet("d")); err != nil || !fx.f.Exists(pf[:1]) {
		t.Fatalf("sweep with its holder live: %v", err)
	}
	if err := fx.f.Release(ctx, secretfiles.Worker("d"), liveSet()); err != nil {
		t.Fatal(err)
	}
	if fx.f.Exists(pf[:1]) {
		t.Fatal("the holder's end kept it")
	}
	if rows, _ := fx.st.SecretOwners(ctx); len(rows) != 0 {
		t.Fatalf("rows %+v", rows)
	}
}

// #108 round 5: Revoke removes every file a worker holds, its own and those
// it holds by a lease, for every holder, and nothing else; each path is
// Revoked before its file goes.
func TestRevoke(t *testing.T) {
	t.Parallel()
	fx := open(t)
	w, _ := fx.f.Write(ctx, secretfiles.Worker("w"), time.Time{}, [][]byte{[]byte("w1"), []byte("w2")})
	x, _ := fx.f.Write(ctx, secretfiles.Worker("x"), time.Time{}, [][]byte{[]byte("x1"), []byte("x2")})
	z, _ := fx.f.Write(ctx, secretfiles.Worker("z"), time.Time{}, [][]byte{[]byte("z1")})
	e, _ := fx.f.Write(ctx, secretfiles.Worker("ended"), time.Time{}, [][]byte{[]byte("e1")})
	must2 := func(n int, err error) {
		t.Helper()
		if err != nil || n != 1 {
			t.Fatalf("lease: %d %v", n, err)
		}
	}
	must2(fx.f.Lease(ctx, "w", x[:1]))
	must2(fx.f.Lease(ctx, "y", w[:1]))
	must2(fx.f.Lease(ctx, "w", e))
	must(t, fx.f.Release(ctx, secretfiles.Worker("ended"), liveSet("w", "x", "y", "z"))) // e1 stays for w
	if fx.f.Revoked(w[0].Path) {
		t.Fatal("revoked before Revoke")
	}
	before := fx.changes.Load()
	n, err := fx.f.Revoke(ctx, "w", liveSet("w", "x", "y", "z"))
	if err != nil || n != 4 {
		t.Fatalf("revoke: %d %v", n, err)
	}
	if fx.changes.Load() == before {
		t.Fatal("a revoke told no one")
	}
	for _, f := range []secretfiles.File{w[0], w[1], x[0], e[0]} {
		if fx.f.Exists([]secretfiles.File{f}) || !fx.f.Revoked(f.Path) {
			t.Errorf("%s: still there, or not revoked", f.Path)
		}
	}
	if !fx.f.Exists(x[1:]) || !fx.f.Exists(z) || fx.f.Revoked(x[1].Path, z[0].Path) {
		t.Fatal("another worker's file it does not hold was revoked")
	}
	for _, d := range []string{w[0].Dir, e[0].Dir} { // its own, and the ended owner's it kept a file in
		if _, err := os.Stat(filepath.Join(fx.dir, d)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("directory %s: %v", d, err)
		}
	}
	if l, _ := fx.st.SecretLeases(ctx); len(l) != 0 {
		t.Fatalf("leases %+v", l)
	}
	if counts, _ := fx.st.SecretFileCounts(ctx); counts["w"] != 0 || counts["y"] != 0 || counts["x"] != 1 || counts["z"] != 1 {
		t.Fatalf("counts %v", counts)
	}
	// Nothing held: 0. Written again, its files are new.
	if n, err := fx.f.Revoke(ctx, "w", liveSet("w")); err != nil || n != 0 {
		t.Fatalf("again: %d %v", n, err)
	}
	again, err := fx.f.Write(ctx, secretfiles.Worker("w"), time.Time{}, [][]byte{[]byte("w3")})
	if err != nil || fx.f.Revoked(again[0].Path) {
		t.Fatalf("written after: %v", err)
	}
	// A revoked path is remembered for RevokedFor, then forgotten (on the
	// next revoke).
	*fx.now = fx.now.Add(secretfiles.RevokedFor + time.Second)
	if _, err := fx.f.Revoke(ctx, "z", liveSet("z")); err != nil {
		t.Fatal(err)
	}
	if fx.f.Revoked(w[0].Path) || !fx.f.Revoked(z[0].Path) {
		t.Fatal("RevokedFor")
	}
	if _, err := fx.f.Revoke(ctx, "x", func(context.Context) (func(string) bool, error) { return nil, errors.New("no workers") }); err == nil ||
		!fx.f.Exists(x[1:]) {
		t.Fatalf("an unreadable liveness revoked: %v", err)
	}
}

// The workers' liveness is read with the directory locked (review S2): a
// worker that starts and writes while it is read keeps its files, and a
// liveness that cannot be read sweeps nothing.
func TestSweepReadsLivenessLocked(t *testing.T) {
	t.Parallel()
	fx := open(t)
	written := make(chan []secretfiles.File, 1)
	_, err := fx.f.Sweep(ctx, func(context.Context) (func(string) bool, error) {
		go func() {
			files, err := fx.f.Write(ctx, secretfiles.Worker("new"), time.Time{}, [][]byte{[]byte("x")})
			if err != nil {
				t.Error(err)
			}
			written <- files
		}()
		select { // the write waits for the sweep (read before the lock, it would land first)
		case files := <-written:
			written <- files
		case <-time.After(50 * time.Millisecond):
		}
		return func(string) bool { return false }, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files := <-written; len(files) != 1 || !fx.f.Exists(files) {
		t.Fatalf("the new worker's files %+v", files)
	}
	boom := errors.New("no workers")
	if n, err := fx.f.Sweep(ctx, func(context.Context) (func(string) bool, error) { return nil, boom }); n != 0 || !errors.Is(err, boom) {
		t.Fatalf("unreadable liveness: %d %v", n, err)
	}
	if rows, _ := fx.st.SecretOwners(ctx); len(rows) != 1 {
		t.Fatalf("rows %+v", rows)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Unsafe directories are refused, never repaired.
func TestUnsafeDirectoriesAreRefused(t *testing.T) {
	t.Parallel()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	openDir := func(dir string) error {
		f, err := secretfiles.Open(secretfiles.Options{Dir: dir, Store: st})
		if err == nil {
			f.Close()
		}
		return err
	}
	base := t.TempDir()
	// A symlink as the directory, or above it.
	real := filepath.Join(base, "real")
	must(t, os.Mkdir(real, 0o700))
	must(t, os.Symlink(real, filepath.Join(base, "link")))
	for _, d := range []string{filepath.Join(base, "link"), filepath.Join(base, "link", "secrets")} {
		if err := openDir(d); !errors.Is(err, secretfiles.ErrUnavailable) {
			t.Errorf("%s: %v", d, err)
		}
	}
	// The wrong mode.
	loose := filepath.Join(base, "loose")
	must(t, os.Mkdir(loose, 0o755))
	if err := openDir(loose); !errors.Is(err, secretfiles.ErrUnavailable) || mode(t, loose) != os.ModeDir|0o755 {
		t.Errorf("0755: %v, mode now %v", err, mode(t, loose))
	}
	// A directory above it others may write to.
	open := filepath.Join(base, "open")
	must(t, os.Mkdir(open, 0o700))
	must(t, os.Chmod(open, 0o777))
	if err := openDir(filepath.Join(open, "secrets")); !errors.Is(err, secretfiles.ErrUnavailable) {
		t.Errorf("world-writable parent: %v", err)
	}
	// Missing beyond the last two parts: never made.
	if err := openDir(filepath.Join(base, "a", "b", "c")); !errors.Is(err, secretfiles.ErrUnavailable) {
		t.Errorf("missing parents: %v", err)
	}
	// Paths a prompt cannot reference plainly.
	for _, d := range []string{"relative/x", filepath.Join(base, "with space"), filepath.Join(base, "x]"), base + "/../x", "/"} {
		if secretfiles.ValidDir(d) || !errors.Is(openDir(d), secretfiles.ErrUnavailable) {
			t.Errorf("%q accepted", d)
		}
	}
	// One bridge at a time.
	held := filepath.Join(base, "held")
	f, err := secretfiles.Open(secretfiles.Options{Dir: held, Store: st})
	if err != nil {
		t.Fatal(err)
	}
	if err := openDir(held); !errors.Is(err, secretfiles.ErrBusy) {
		t.Errorf("second open: %v", err)
	}
	f.Close()
	if err := openDir(held); err != nil {
		t.Errorf("after close: %v", err)
	}
}

// An owner directory swapped for a symlink, or loosened, is refused: nothing
// is written through it.
func TestOwnerDirectoryTampering(t *testing.T) {
	t.Parallel()
	fx := open(t)
	files, _ := fx.f.Write(ctx, secretfiles.Worker("w"), time.Time{}, [][]byte{[]byte("a")})
	owner := filepath.Join(fx.dir, files[0].Dir)
	elsewhere := t.TempDir()
	must(t, os.RemoveAll(owner))
	must(t, os.Symlink(elsewhere, owner))
	if _, err := fx.f.Write(ctx, secretfiles.Worker("w"), time.Time{}, [][]byte{[]byte("b")}); !errors.Is(err, secretfiles.ErrUnavailable) {
		t.Fatalf("through a symlink: %v", err)
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Fatalf("written through the symlink: %v", entries)
	}
	must(t, os.Remove(owner))
	must(t, os.Mkdir(owner, 0o755))
	if _, err := fx.f.Write(ctx, secretfiles.Worker("w"), time.Time{}, [][]byte{[]byte("c")}); !errors.Is(err, secretfiles.ErrUnavailable) {
		t.Fatalf("a loosened owner directory: %v", err)
	}
	if mode(t, owner) != os.ModeDir|0o755 {
		t.Fatal("repaired")
	}
	// Its release unlinks a symlink inside, never its target.
	must(t, os.Chmod(owner, 0o700))
	target := filepath.Join(elsewhere, "keep")
	must(t, os.WriteFile(target, []byte("k"), 0o600))
	must(t, os.Symlink(target, filepath.Join(owner, "LINKLINKLINKLINKLINKLINK22")))
	if err := fx.f.Release(ctx, secretfiles.Worker("w"), liveSet()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the symlink's target went")
	}
}
