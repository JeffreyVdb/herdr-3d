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
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

var ctx = context.Background()

type fixture struct {
	f   *secretfiles.Files
	st  *store.Store
	dir string
	db  string
	now *time.Time
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
	fx.f, err = secretfiles.Open(secretfiles.Options{Dir: fx.dir, Store: st, Now: func() time.Time { return *fx.now }, Log: nil})
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
	if err := fx.f.Release(ctx, secretfiles.Worker("w-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fx.dir, w1[0].Dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("w-1's directory: %v", err)
	}
	if !fx.f.Exists(w2) {
		t.Fatal("w-2's file went too")
	}
	if err := fx.f.Release(ctx, secretfiles.Worker("w-1")); err != nil { // again: nothing
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
	if err := fx.f.ReleaseExpired(ctx); err != nil || !fx.f.Exists(f1) || !fx.f.Exists(f2) {
		t.Fatalf("before the expiry: %v", err)
	}
	*fx.now = exp
	if err := fx.f.ReleaseExpired(ctx); err != nil {
		t.Fatal(err)
	}
	if !fx.f.Exists(f1) || fx.f.Exists(f2) {
		t.Fatal("expiry: the claimed file went, or the unclaimed one stayed")
	}
	if rows, _ := fx.st.SecretOwnersOf(ctx, "worker", "w-3"); len(rows) != 1 || !rows[0].ExpiresAt.IsZero() {
		t.Fatalf("claimed rows %+v", rows)
	}
	if err := fx.f.Release(ctx, secretfiles.Worker("w-3")); err != nil || fx.f.Exists(f1) {
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

// liveSet is a Sweep's liveness: these workers are live.
func liveSet(ids ...string) func(context.Context) (func(string) bool, error) {
	return func(context.Context) (func(string) bool, error) {
		return func(id string) bool { return slices.Contains(ids, id) }, nil
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
	if err := fx.f.Release(ctx, secretfiles.Worker("w")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the symlink's target went")
	}
}
