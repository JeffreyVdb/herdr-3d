package gitops

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func gitTestEnv(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// gitRaw runs git and returns its stdout as is, whatever its exit code.
func gitRaw(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	var ee *exec.ExitError
	if err != nil && !errors.As(err, &ee) {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return string(out)
}

// cloneWithOrigin makes a bare origin (default branch main, origin/HEAD
// set) with one commit of files, and a clone of it.
func cloneWithOrigin(t *testing.T, files map[string]string) (work string) {
	t.Helper()
	root := t.TempDir()
	origin, work := filepath.Join(root, "origin.git"), filepath.Join(root, "work")
	git(t, root, "init", "-q", "--bare", "-b", "main", origin)
	git(t, root, "clone", "-q", origin, work)
	for p, c := range files {
		write(t, filepath.Join(work, p), c)
	}
	git(t, work, "add", "-A")
	git(t, work, "commit", "-q", "-m", "base")
	git(t, work, "push", "-q", "origin", "main")
	git(t, work, "remote", "set-head", "origin", "main")
	return work
}

func fileByPath(files []proto.ChangedFile) map[string]proto.ChangedFile {
	m := map[string]proto.ChangedFile{}
	for _, f := range files {
		m[f.Path] = f
	}
	return m
}

var statSummary = regexp.MustCompile(`(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?`)

// A staged, an unstaged, an untracked, a renamed and a binary file, a
// commit ahead of origin: what Changes reports is what git status and git
// diff --stat say.
func TestChangesMatchGit(t *testing.T) {
	gitTestEnv(t)
	lines50 := ""
	for i := range 50 {
		lines50 += "line " + strconv.Itoa(i) + "\n"
	}
	work := cloneWithOrigin(t, map[string]string{"f.txt": "one\ntwo\nthree\n", "old.txt": lines50, "bin.dat": "\x00\x01bin"})
	git(t, work, "checkout", "-q", "-b", "feat")
	git(t, work, "branch", "-q", "-u", "origin/main")
	write(t, filepath.Join(work, "ahead.txt"), "committed\n")
	git(t, work, "add", "ahead.txt")
	git(t, work, "commit", "-q", "-m", "ahead")
	write(t, filepath.Join(work, "staged.txt"), "a\nb\n")
	git(t, work, "add", "staged.txt")
	write(t, filepath.Join(work, "f.txt"), "one\n2\nthree\nfour\n")
	git(t, work, "mv", "old.txt", "new.txt")
	write(t, filepath.Join(work, "bin.dat"), "\x00\x02bin2")
	write(t, filepath.Join(work, "notes.txt"), "n1\nn2\nn3\nn4")
	mb := git(t, work, "merge-base", "HEAD", "origin/main")

	sub := filepath.Join(work, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := (&Git{}).Changes(context.Background(), sub)
	if err != nil {
		t.Fatal(err)
	}
	if res.Cwd != sub {
		t.Errorf("cwd = %q", res.Cwd)
	}
	if res.Branch == nil || *res.Branch != "feat" || res.Upstream == nil || *res.Upstream != "origin/main" ||
		res.Ahead != 1 || res.Behind != 0 || res.Head != git(t, work, "rev-parse", "HEAD") {
		t.Errorf("branch %v upstream %v ahead %d behind %d head %q", res.Branch, res.Upstream, res.Ahead, res.Behind, res.Head)
	}
	if res.Base == nil || *res.Base != (proto.ChangesBase{Ref: "origin/main", SHA: mb}) {
		t.Errorf("base = %+v, want origin/main %s", res.Base, mb)
	}
	files := fileByPath(res.Files)

	// Every entry of git status --porcelain=v2 --branch, with its states.
	status := gitRaw(t, work, "status", "--porcelain=v2", "--branch")
	sawAB := false
	for _, line := range strings.Split(strings.TrimSpace(status), "\n") {
		head, orig, _ := strings.Cut(line, "\t") // a rename: "<new>\t<old>"
		fields := strings.Fields(head)
		switch fields[0] {
		case "#":
			if fields[1] == "branch.ab" {
				sawAB = true
				if fields[2] != "+"+strconv.Itoa(res.Ahead) || fields[3] != "-"+strconv.Itoa(res.Behind) {
					t.Errorf("status %q, got ahead %d behind %d", line, res.Ahead, res.Behind)
				}
			}
		case "?":
			if f := files[fields[1]]; !f.Untracked || f.Index != "" {
				t.Errorf("untracked %s = %+v", fields[1], f)
			}
		case "1", "2":
			path := fields[len(fields)-1]
			f := files[path]
			if f.Index != fields[1][:1] || f.Worktree != fields[1][1:] || f.OrigPath != orig || f.Untracked {
				t.Errorf("status %q, got %+v", line, f)
			}
		}
	}
	if !sawAB {
		t.Error("git status shows no ahead/behind")
	}
	if f := files["ahead.txt"]; f.Index != "." || f.Worktree != "." || f.Insertions != 1 {
		t.Errorf("committed-only file = %+v", f)
	}
	if f := files["notes.txt"]; f.Insertions != 4 || f.Deletions != 0 || f.Binary {
		t.Errorf("untracked notes.txt = %+v", f)
	}
	if f := files["bin.dat"]; !f.Binary || f.Insertions != 0 {
		t.Errorf("binary = %+v", f)
	}
	if f := files["new.txt"]; f.OrigPath != "old.txt" || f.Index != "R" {
		t.Errorf("rename = %+v", f)
	}

	// git diff --stat <merge-base>: its totals and per-file counts.
	stat := strings.TrimSpace(gitRaw(t, work, "diff", "--stat=200", mb))
	lines := strings.Split(stat, "\n")
	m := statSummary.FindStringSubmatch(lines[len(lines)-1])
	if m == nil {
		t.Fatalf("no summary in %q", stat)
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	if want := (proto.ChangesStat{Files: atoi(m[1]), Insertions: atoi(m[2]), Deletions: atoi(m[3])}); res.Stat != want {
		t.Errorf("stat = %+v, git diff --stat says %+v", res.Stat, want)
	}
	for _, line := range lines[:len(lines)-1] {
		name, count, _ := strings.Cut(line, "|")
		name = strings.TrimSpace(name)
		if _, after, ok := strings.Cut(name, " => "); ok {
			name = after
		}
		f, ok := files[name]
		count = strings.TrimSpace(count)
		switch {
		case !ok:
			t.Errorf("git diff --stat lists %q, Changes does not", name)
		case strings.HasPrefix(count, "Bin"):
			if !f.Binary {
				t.Errorf("%s: git says binary, got %+v", name, f)
			}
		default:
			n, _, _ := strings.Cut(count, " ")
			if atoi(n) != f.Insertions+f.Deletions {
				t.Errorf("%s: git diff --stat %q, got +%d -%d", name, count, f.Insertions, f.Deletions)
			}
		}
	}
	if res.Stat.Files != 5 || res.Stat.Insertions != 5 || res.Stat.Deletions != 1 {
		t.Errorf("stat = %+v, want 5 files, 5 insertions, 1 deletion", res.Stat) // hand count
	}

	// The diff: git diff <merge-base>, then the untracked file as git shows
	// a new file (without its index line).
	newFile := gitRaw(t, work, "diff", "--no-index", "/dev/null", "notes.txt")
	newFile = regexp.MustCompile(`(?m)^index .*\n`).ReplaceAllString(newFile, "")
	want := gitRaw(t, work, "diff", mb) + newFile
	if res.Diff != want {
		t.Errorf("diff =\n%s\nwant\n%s", res.Diff, want)
	}
	if res.DiffBytes != int64(len(want)) || res.Truncated || len(res.Omitted) != 0 {
		t.Errorf("diff_bytes %d (want %d), truncated %v, omitted %q", res.DiffBytes, len(want), res.Truncated, res.Omitted)
	}
	// Files: diff order, then untracked.
	var order []string
	for _, f := range res.Files {
		order = append(order, f.Path)
	}
	if w := []string{"ahead.txt", "bin.dat", "f.txt", "new.txt", "staged.txt", "notes.txt"}; !slices.Equal(order, w) {
		t.Errorf("files = %q, want %q", order, w)
	}
}

// A diff over 256 KiB keeps whole files that fit, in files order, and
// lists the rest.
func TestChangesTruncated(t *testing.T) {
	gitTestEnv(t)
	work := cloneWithOrigin(t, map[string]string{"a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n"})
	big := strings.Repeat("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n", 3000) // ~187 KiB
	write(t, filepath.Join(work, "a.txt"), big)
	write(t, filepath.Join(work, "b.txt"), big) // together over the cap
	write(t, filepath.Join(work, "c.txt"), "c\nc2\n")
	write(t, filepath.Join(work, "u.txt"), "untracked\n")
	res, err := (&Git{}).Changes(context.Background(), work)
	if err != nil {
		t.Fatal(err)
	}
	full := gitRaw(t, work, "diff", git(t, work, "merge-base", "HEAD", "origin/main"))
	if !res.Truncated || !slices.Equal(res.Omitted, []string{"b.txt"}) {
		t.Fatalf("truncated %v, omitted %q", res.Truncated, res.Omitted)
	}
	if len(res.Diff) > MaxDiff || !strings.Contains(res.Diff, "diff --git a/a.txt") || strings.Contains(res.Diff, "a/b.txt") ||
		!strings.Contains(res.Diff, "diff --git a/c.txt") || !strings.HasSuffix(res.Diff, "+untracked\n") {
		t.Errorf("diff (%d bytes) has the wrong files", len(res.Diff))
	}
	untracked := "diff --git a/u.txt b/u.txt\nnew file mode 100644\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1 @@\n+untracked\n"
	if res.DiffBytes != int64(len(full)+len(untracked)) {
		t.Errorf("diff_bytes = %d, want %d", res.DiffBytes, len(full)+len(untracked))
	}
	if res.Stat.Files != 3 || res.Stat.Insertions != 6001 || res.Stat.Deletions != 2 {
		t.Errorf("stat = %+v", res.Stat)
	}
}

// Without origin there is no base: the diff is against HEAD. Detached,
// there is no branch. Outside a repository: ErrNotRepo.
func TestChangesNoOrigin(t *testing.T) {
	gitTestEnv(t)
	root := t.TempDir()
	work := filepath.Join(root, "work")
	git(t, root, "init", "-q", "-b", "main", work)
	write(t, filepath.Join(work, "f.txt"), "one\n")
	git(t, work, "add", "f.txt")
	git(t, work, "commit", "-q", "-m", "one")
	write(t, filepath.Join(work, "f.txt"), "one\ntwo\n")
	res, err := (&Git{}).Changes(context.Background(), work)
	if err != nil {
		t.Fatal(err)
	}
	if res.Base != nil || res.Upstream != nil || res.Branch == nil || *res.Branch != "main" || res.Ahead != 0 {
		t.Errorf("base %+v upstream %v branch %v ahead %d", res.Base, res.Upstream, res.Branch, res.Ahead)
	}
	if res.Diff != gitRaw(t, work, "diff", "HEAD") || res.Stat != (proto.ChangesStat{Files: 1, Insertions: 1}) {
		t.Errorf("diff %q stat %+v", res.Diff, res.Stat)
	}
	git(t, work, "checkout", "-q", "--detach")
	if res, err = (&Git{}).Changes(context.Background(), work); err != nil || res.Branch != nil {
		t.Fatalf("detached: branch %v, %v", res.Branch, err)
	}
	if _, err := (&Git{}).Changes(context.Background(), root); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("outside a repo: %v", err)
	}

	// An unborn branch: the staged file is new.
	fresh := filepath.Join(root, "fresh")
	git(t, root, "init", "-q", "-b", "main", fresh)
	write(t, filepath.Join(fresh, "a.txt"), "a\n")
	git(t, fresh, "add", "a.txt")
	res, err = (&Git{}).Changes(context.Background(), fresh)
	if err != nil {
		t.Fatal(err)
	}
	if res.Head != "" || res.Base != nil || len(res.Files) != 1 || res.Files[0].Index != "A" || res.Files[0].Insertions != 1 {
		t.Errorf("unborn: head %q files %+v", res.Head, res.Files)
	}
}

// Untracked files: a symlink out of the tree, a big file and a binary file
// get no content; nothing is read outside the work tree.
func TestChangesUntracked(t *testing.T) {
	gitTestEnv(t)
	work := cloneWithOrigin(t, map[string]string{"a.txt": "a\n"})
	secret := filepath.Join(t.TempDir(), "secret")
	write(t, secret, "do not read\n")
	if err := os.Symlink(secret, filepath.Join(work, "link")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(work, "big.txt"), strings.Repeat("x\n", MaxUntrackedContent)) // 128 KiB
	write(t, filepath.Join(work, "bin"), "ab\x00cd")
	write(t, filepath.Join(work, "dir", "s p.txt"), "one line")
	if err := os.WriteFile(filepath.Join(work, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := (&Git{}).Changes(context.Background(), work)
	if err != nil {
		t.Fatal(err)
	}
	files := fileByPath(res.Files)
	if f := files["link"]; !f.Untracked || f.Insertions != 0 || strings.Contains(res.Diff, "do not read") {
		t.Errorf("symlink = %+v, diff %q", f, res.Diff)
	}
	if f := files["big.txt"]; f.Insertions != MaxUntrackedContent || strings.Contains(res.Diff, "big.txt") {
		t.Errorf("big = %+v", f)
	}
	if f := files["bin"]; !f.Binary || strings.Contains(res.Diff, "b/bin") {
		t.Errorf("binary = %+v", f)
	}
	want := "diff --git a/dir/s p.txt b/dir/s p.txt\nnew file mode 100644\n--- /dev/null\n+++ b/dir/s p.txt\t\n" +
		"@@ -0,0 +1 @@\n+one line\n\\ No newline at end of file\n" +
		"diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+#!/bin/sh\n"
	if res.Diff != want || res.Truncated {
		t.Errorf("diff =\n%q\nwant\n%q", res.Diff, want)
	}
	if got, want := quotePath("a/tést\t\"x\\"), `"a/t\303\251st\t\"x\\"`; got != want {
		t.Errorf("quotePath = %s, want %s", got, want)
	}
}

// A hung git is cut by the shared deadline (10 s by default).
func TestChangesDeadline(t *testing.T) {
	var deadline time.Duration
	hung := func(ctx context.Context, argv []string) ([]byte, []byte, error) {
		if dl, ok := ctx.Deadline(); ok && deadline == 0 {
			deadline = time.Until(dl)
		}
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	start := time.Now()
	_, err := (&Git{Run: hung, ChangesTimeout: 50 * time.Millisecond}).Changes(context.Background(), "/repo")
	if !errors.Is(err, ErrChangesTimeout) || time.Since(start) > 5*time.Second {
		t.Fatalf("err = %v after %s", err, time.Since(start))
	}

	// By default: 10 s for all the calls together.
	deadline = 0
	calls := 0
	status := "# branch.oid " + strings.Repeat("a", 40) + "\x00# branch.head main\x00"
	(&Git{Run: func(ctx context.Context, argv []string) ([]byte, []byte, error) {
		if dl, ok := ctx.Deadline(); ok && calls == 0 {
			deadline = time.Until(dl)
		}
		calls++
		switch argv[3] {
		case "rev-parse":
			return []byte("/repo\n"), nil, nil
		case "status":
			return []byte(status), nil, nil
		}
		return nil, nil, errors.New("exit status 1")
	}}).Changes(context.Background(), "/repo")
	if deadline <= 9*time.Second || deadline > DefaultChangesTimeout || DefaultChangesTimeout != 10*time.Second {
		t.Fatalf("deadline = %s", deadline)
	}
}

// The diff reader keeps whole file patches, counts the rest, and folds a
// type change's two patches into one file.
func TestDiffReader(t *testing.T) {
	out := "1\t1\tf1\x000\t0\t\x00old\x00new\x00-\t-\tbin\x00\x00" +
		"diff --git a/f1 b/f1\ndeleted file mode 100644\n--- a/f1\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n" +
		"diff --git a/f1 b/f1\nnew file mode 120000\n--- /dev/null\n+++ b/f1\n@@ -0,0 +1 @@\n+t\n" +
		"diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n" +
		"diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n"
	d := &diffReader{budget: MaxDiff}
	if err := d.read(strings.NewReader(out)); err != nil {
		t.Fatal(err)
	}
	patch := out[strings.Index(out, "diff --git"):]
	if d.out.String() != patch || d.total != int64(len(patch)) || d.cut || len(d.omitted) != 0 {
		t.Fatalf("out %q total %d cut %v omitted %q", d.out.String(), d.total, d.cut, d.omitted)
	}
	if len(d.files) != 3 || d.files[1] != (numstat{path: "new", orig: "old"}) || !d.files[2].binary ||
		d.stat != (proto.ChangesStat{Files: 3, Insertions: 1, Deletions: 1}) {
		t.Fatalf("files %+v stat %+v", d.files, d.stat)
	}
	// A budget that only fits the rename and the binary file.
	d = &diffReader{budget: 150}
	if err := d.read(strings.NewReader(out)); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(d.omitted, []string{"f1"}) || !bytes.HasPrefix(d.out.Bytes(), []byte("diff --git a/old b/new")) {
		t.Fatalf("omitted %q out %q", d.omitted, d.out.String())
	}
	if err := (&diffReader{}).read(strings.NewReader("")); err != nil {
		t.Fatalf("no changes: %v", err)
	}
	if err := (&diffReader{}).read(strings.NewReader("1\t1\tf")); err == nil {
		t.Fatal("cut numstat accepted")
	}
}
