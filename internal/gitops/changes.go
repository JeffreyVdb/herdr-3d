package gitops

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Limits of Changes.
const (
	// DefaultChangesTimeout bounds all the git calls of one Changes.
	DefaultChangesTimeout = 10 * time.Second
	// MaxDiff caps the diff Changes returns: whole files, in Files order.
	MaxDiff = 256 << 10
	// MaxUntrackedContent is the largest untracked file given a diff.
	MaxUntrackedContent = 64 << 10
	// MaxChangedFiles caps Files (Stat still counts every file).
	MaxChangedFiles = 5000
	// maxUntrackedCount is the largest untracked file whose lines are
	// counted, maxUntrackedRead how much of them one Changes reads in all.
	maxUntrackedCount = 1 << 20
	maxUntrackedRead  = 16 << 20
	// maxRecord bounds one NUL-terminated record of git's -z output.
	maxRecord = 64 << 10
	// binarySniff is how much of a file git looks at for a NUL (binary).
	binarySniff = 8000
)

// Empty trees: what an unborn branch is diffed against (SHA-1, SHA-256).
var emptyTrees = []string{"4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	"6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"}

// ErrChangesTimeout is a Changes whose git calls took longer than the
// ChangesTimeout together.
var ErrChangesTimeout = errors.New("git took too long")

var revRe = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64}|HEAD)$`)

// validRev reports whether rev may be diffed against: a full commit or
// tree id, or HEAD.
func validRev(rev string) bool { return revRe.MatchString(rev) }

// Changes reads the git state of the work tree dir is in, for the Changes
// panel: status, the merge-base with origin/<default branch>, per-file
// counts and the unified diff against it (the working tree, staged
// changes included; untracked text files as new files). Only read-only git
// runs; untracked files are read inside the work tree only. It returns
// ErrNotRepo outside a work tree and ErrChangesTimeout (wrapped) when the
// git calls take longer than ChangesTimeout together.
func (g *Git) Changes(ctx context.Context, dir string) (*proto.WorkerChanges, error) {
	timeout := g.ChangesTimeout
	if timeout <= 0 {
		timeout = DefaultChangesTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := g.changes(ctx, dir)
	if err != nil && ctx.Err() != nil {
		return nil, fmt.Errorf("%w (%s): %w", ErrChangesTimeout, timeout, err)
	}
	return res, err
}

func (g *Git) changes(ctx context.Context, dir string) (*proto.WorkerChanges, error) {
	top, err := g.TopLevel(ctx, dir)
	if err != nil {
		return nil, err
	}
	out, err := g.run(ctx, opStatusV2, map[string]string{"dir": top})
	if err != nil {
		return nil, err
	}
	st := parseStatus(out)
	res := &proto.WorkerChanges{Cwd: dir, Head: st.head, Ahead: st.ahead, Behind: st.behind, Files: []proto.ChangedFile{},
		Omitted: []string{}}
	if st.branch != "" {
		res.Branch = &st.branch
	}
	if st.upstream != "" {
		res.Upstream = &st.upstream
	}

	revs := []string{"HEAD"}
	if st.head == "" {
		revs = emptyTrees // unborn: everything is new
	} else if def := g.DefaultBranch(ctx, top); def != "" {
		ref := "origin/" + def
		if out, err := g.run(ctx, opMergeBase, map[string]string{"dir": top, "ref": ref}); err == nil {
			if sha := strings.TrimSpace(string(out)); validRev(sha) && sha != "HEAD" {
				res.Base = &proto.ChangesBase{Ref: ref, SHA: sha}
				revs = []string{sha}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var d *diffReader
	for i, rev := range revs {
		d = &diffReader{budget: MaxDiff}
		if err = g.diffAgainst(ctx, top, rev, d); err == nil || i == len(revs)-1 {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	res.Stat = d.stat

	// Files: git's diff order, then paths only status lists (changed
	// against HEAD, not against the base), then untracked files.
	listed := map[string]bool{}
	for _, n := range d.files {
		f := proto.ChangedFile{Path: n.path, OrigPath: n.orig, Index: ".", Worktree: ".", Insertions: n.ins,
			Deletions: n.del, Binary: n.binary}
		if s, ok := st.tracked[n.path]; ok {
			f.Index, f.Worktree = s.index, s.worktree
			if f.OrigPath == "" {
				f.OrigPath = s.orig
			}
		}
		res.Files = append(res.Files, f)
		listed[n.path] = true
	}
	truncated := d.cut || len(d.omitted) > 0
	for _, s := range st.order {
		switch {
		case listed[s.path]:
		case len(res.Files) >= MaxChangedFiles:
			truncated = true
		default:
			res.Files = append(res.Files, proto.ChangedFile{Path: s.path, OrigPath: s.orig, Index: s.index, Worktree: s.worktree})
			listed[s.path] = true
		}
	}
	diff, omitted, total := &d.out, d.omitted, d.total
	if len(st.untracked) > 0 {
		root, err := os.OpenRoot(top)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		readBudget := maxUntrackedRead
		for _, p := range st.untracked {
			if len(res.Files) >= MaxChangedFiles {
				truncated = true
				break
			}
			f, patch := untrackedFile(root, p, &readBudget)
			res.Files = append(res.Files, f)
			if patch == nil {
				continue
			}
			total += int64(len(patch))
			if len(patch) <= MaxDiff-diff.Len() {
				diff.Write(patch)
			} else {
				omitted = append(omitted, p)
				truncated = true
			}
		}
	}
	res.Diff, res.DiffBytes, res.Truncated, res.Omitted = diff.String(), total, truncated, omitted
	return res, nil
}

// diffAgainst streams `git diff --numstat --patch -z <rev>` into d.
func (g *Git) diffAgainst(ctx context.Context, top, rev string, d *diffReader) error {
	pr, pw := io.Pipe()
	errc := make(chan error, 1)
	go func() {
		err := g.pipe(ctx, opDiff, map[string]string{"dir": top, "rev": rev}, pw)
		pw.CloseWithError(err)
		errc <- err
	}()
	perr := d.read(pr)
	if perr != nil {
		pr.CloseWithError(perr) // git's writes fail; it exits
	}
	err := <-errc
	if err != nil {
		return err
	}
	return perr
}

// status is `git status --porcelain=v2 --branch -z` parsed.
type status struct {
	head, branch, upstream string
	ahead, behind          int
	tracked                map[string]statusEntry
	order                  []statusEntry
	untracked              []string
}

type statusEntry struct {
	path, orig      string
	index, worktree string
}

func parseStatus(out []byte) status {
	st := status{tracked: map[string]statusEntry{}}
	recs := bytes.Split(out, []byte{0})
	// The last piece is what follows the final NUL: empty, or a record cut
	// by the output cap.
	recs = recs[:len(recs)-1]
	for i := 0; i < len(recs); i++ {
		rec := string(recs[i])
		switch {
		case strings.HasPrefix(rec, "# "):
			key, val, _ := strings.Cut(rec[2:], " ")
			switch key {
			case "branch.oid":
				if val != "(initial)" {
					st.head = val
				}
			case "branch.head":
				if val != "(detached)" {
					st.branch = val
				}
			case "branch.upstream":
				st.upstream = val
			case "branch.ab":
				a, b, _ := strings.Cut(val, " ")
				st.ahead, _ = strconv.Atoi(strings.TrimPrefix(a, "+"))
				st.behind, _ = strconv.Atoi(strings.TrimPrefix(b, "-"))
			}
		case strings.HasPrefix(rec, "? "):
			st.untracked = append(st.untracked, rec[2:])
		case strings.HasPrefix(rec, "1 "), strings.HasPrefix(rec, "2 "), strings.HasPrefix(rec, "u "):
			// Fields before the path: 1 → 8, 2 → 9 (and the original path in
			// the next record), u → 10.
			n := map[byte]int{'1': 8, '2': 9, 'u': 10}[rec[0]]
			parts := strings.SplitN(rec, " ", n+1)
			if len(parts) != n+1 || len(parts[1]) != 2 {
				continue
			}
			e := statusEntry{path: parts[n], index: parts[1][:1], worktree: parts[1][1:]}
			if rec[0] == '2' && i+1 < len(recs) {
				i++
				e.orig = string(recs[i])
			}
			st.tracked[e.path] = e
			st.order = append(st.order, e)
		}
	}
	return st
}

// numstat is one file of git diff --numstat.
type numstat struct {
	path, orig string
	ins, del   int
	binary     bool
}

// diffReader reads `git diff --numstat --patch -z`: the numstat records,
// an empty record, then the patch. It keeps whole file patches that fit in
// the budget (a file whose patch is split in two, a type change, has the
// same header line twice) and counts the rest.
type diffReader struct {
	budget  int
	files   []numstat // at most MaxChangedFiles
	stat    proto.ChangesStat
	out     bytes.Buffer
	omitted []string
	total   int64
	cut     bool // files beyond MaxChangedFiles, or patches beyond the numstat

	next  int    // index of the file the current patch belongs to
	key   []byte // the current patch's header line
	cur   bytes.Buffer
	size  int
	began bool
}

func (d *diffReader) read(r io.Reader) error {
	br := bufio.NewReaderSize(r, 64<<10)
	n := 0
	for {
		rec, err := readRecord(br)
		if err == io.EOF && rec == nil {
			return nil // nothing changed
		}
		if err != nil {
			return err
		}
		if len(rec) == 0 {
			break
		}
		ins, rest, ok1 := strings.Cut(string(rec), "\t")
		del, path, ok2 := strings.Cut(rest, "\t")
		if !ok1 || !ok2 {
			return fmt.Errorf("git diff --numstat: unexpected %q", rec)
		}
		f := numstat{path: path}
		if path == "" { // a rename: the old and the new path follow
			var orig, dst []byte
			if orig, err = readRecord(br); err == nil {
				dst, err = readRecord(br)
			}
			if err != nil {
				return err
			}
			f.orig, f.path = string(orig), string(dst)
		}
		if ins == "-" && del == "-" {
			f.binary = true
		} else {
			f.ins, _ = strconv.Atoi(ins)
			f.del, _ = strconv.Atoi(del)
		}
		d.stat.Files++
		d.stat.Insertions += f.ins
		d.stat.Deletions += f.del
		if n++; n <= MaxChangedFiles {
			d.files = append(d.files, f)
		} else {
			d.cut = true
		}
	}
	lineStart := true
	for {
		b, err := br.ReadSlice('\n')
		if len(b) > 0 {
			if lineStart && bytes.HasPrefix(b, []byte("diff --git ")) {
				if !d.began || !bytes.Equal(b, d.key) {
					d.finish()
					d.key = append(d.key[:0], b...)
					d.began = true
				}
			}
			d.size += len(b)
			if d.size <= d.budget {
				d.cur.Write(b)
			}
			lineStart = b[len(b)-1] == '\n'
		}
		switch {
		case err == nil, errors.Is(err, bufio.ErrBufferFull):
		case errors.Is(err, io.EOF):
			d.finish()
			return nil
		default:
			return err
		}
	}
}

// finish ends the current file's patch: into the diff if it fits, else
// omitted.
func (d *diffReader) finish() {
	if d.size == 0 {
		return
	}
	d.total += int64(d.size)
	i := d.next
	d.next++
	switch {
	case i >= len(d.files):
		d.cut = true
	case d.size <= d.budget-d.out.Len():
		d.out.Write(d.cur.Bytes())
	default:
		d.omitted = append(d.omitted, d.files[i].path)
	}
	d.cur.Reset()
	d.size = 0
}

// readRecord reads one NUL-terminated record (without the NUL).
func readRecord(br *bufio.Reader) ([]byte, error) {
	var rec []byte
	for {
		b, err := br.ReadSlice(0)
		rec = append(rec, b...)
		if len(rec) > maxRecord {
			return nil, errors.New("git: record too long")
		}
		switch {
		case err == nil:
			return rec[:len(rec)-1], nil
		case errors.Is(err, bufio.ErrBufferFull):
		case errors.Is(err, io.EOF) && len(rec) > 0:
			return nil, io.ErrUnexpectedEOF
		default:
			return rec, err
		}
	}
}

// untrackedFile describes an untracked path inside root and, for a text
// file up to MaxUntrackedContent, its new-file patch. Symlinks, other
// non-regular files and anything that would leave root get no content.
func untrackedFile(root *os.Root, path string, budget *int) (proto.ChangedFile, []byte) {
	f := proto.ChangedFile{Path: path, Untracked: true}
	fi, err := root.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxUntrackedCount || fi.Size() > int64(*budget) {
		return f, nil
	}
	file, err := root.Open(path)
	if err != nil {
		return f, nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUntrackedCount+1))
	*budget -= len(data)
	if err != nil || len(data) > maxUntrackedCount {
		return f, nil
	}
	if bytes.IndexByte(data[:min(len(data), binarySniff)], 0) >= 0 {
		f.Binary = true
		return f, nil
	}
	lines := bytes.Count(data, []byte{'\n'})
	if len(data) > 0 && data[len(data)-1] != '\n' {
		lines++
	}
	f.Insertions = lines
	if len(data) > MaxUntrackedContent {
		return f, nil
	}
	return f, newFilePatch(path, fi.Mode(), data, lines)
}

// newFilePatch is the patch git shows for a new file.
func newFilePatch(path string, mode fs.FileMode, data []byte, lines int) []byte {
	var b bytes.Buffer
	a, bp := quotePath("a/"+path), quotePath("b/"+path)
	fileMode := "100644"
	if mode&0o111 != 0 {
		fileMode = "100755"
	}
	fmt.Fprintf(&b, "diff --git %s %s\nnew file mode %s\n", a, bp, fileMode)
	if lines == 0 {
		return b.Bytes()
	}
	tab := ""
	if strings.Contains(path, " ") {
		tab = "\t" // like git, so the path's end is unambiguous
	}
	fmt.Fprintf(&b, "--- /dev/null\n+++ %s%s\n", bp, tab)
	if lines == 1 {
		b.WriteString("@@ -0,0 +1 @@\n")
	} else {
		fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", lines)
	}
	for len(data) > 0 {
		line, rest, found := bytes.Cut(data, []byte{'\n'})
		b.WriteByte('+')
		b.Write(line)
		b.WriteByte('\n')
		if !found {
			b.WriteString("\\ No newline at end of file\n")
		}
		data = rest
	}
	return b.Bytes()
}

// quotePath quotes a path like git's diff headers do (core.quotePath on):
// in double quotes, with C escapes, when it has control characters, a
// quote, a backslash or bytes beyond ASCII.
func quotePath(p string) string {
	needs := false
	for i := 0; i < len(p); i++ {
		if c := p[i]; c < 0x20 || c == '"' || c == '\\' || c >= 0x7f {
			needs = true
			break
		}
	}
	if !needs {
		return p
	}
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(p); i++ {
		switch c := p[i]; c {
		case '\a':
			b.WriteString(`\a`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\v':
			b.WriteString(`\v`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		default:
			if c < 0x20 || c >= 0x7f {
				fmt.Fprintf(&b, `\%03o`, c)
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
