// Package handoff is the filing cabinet's one writer (#223): a handoff is a
// Markdown file under the handoff directory (--handoff-dir, ~/handoff/ by
// default), <dir>/<floor>/<yyyymmdd-hhmm>-<worker>-<slug>.md, and a row of
// the store's handoff table with its full-text index. Every creation mode
// files through Service.File: the literal last reply (#223), and later the
// agent's and the configured LLM's (parts 2 and 3) and a send home's handoff
// (worker.fire's reserved handoff field).
//
// A file is written as a dot-named .tmp in the floor's directory, synced, and
// then linked to its final name, which never replaces a file (a name taken
// gets -2, -3, …); the .tmp goes after. Only then is the row added, in one
// transaction with its index row; when that fails the file is removed again.
// A crash between the two leaves a complete file, which the startup
// Reconcile registers. Deleting moves the file to <dir>/.trash/<floor>/ and
// removes the row and its index row in one transaction. Standard library and
// the store only; no model call anywhere.
package handoff

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Limits.
const (
	// MaxBody is the most bytes a handoff's text may have (1 MiB): a larger
	// literal reply is refused, never clipped.
	MaxBody = 1 << 20
	// MaxFile is the most a handoff file may have, front matter included
	// (handoff.get and the reconcile read no more).
	MaxFile = MaxBody + 64<<10
	// MaxTitle is the most characters (runes) of a title.
	MaxTitle = 80
	// maxSlug is the most bytes of a file name's slug.
	maxSlug = 48
	// maxName is the most bytes of a file name's worker part.
	maxName = 32
	// maxSuffix bounds the collision suffixes tried.
	maxSuffix = 999
)

// TrashDir is where deleted handoffs go, under the handoff directory.
const TrashDir = ".trash"

// Errors.
var (
	ErrEmpty    = errors.New("the handoff has no text")
	ErrTooLarge = fmt.Errorf("the handoff is larger than %d bytes", MaxBody)
	ErrInvalid  = errors.New("the handoff text is not valid UTF-8")
	ErrOutside  = errors.New("the path is not in the handoff directory")
	ErrOpReused = errors.New("the operation id was used for another handoff")
	ErrNotFound = store.ErrNotFound
)

// Index is the store's part: *store.Store.
type Index interface {
	AddHandoff(ctx context.Context, h store.Handoff, body string) (store.Handoff, error)
	ReindexHandoff(ctx context.Context, id int64, title string, size, mtime int64, body string) error
	DeleteHandoff(ctx context.Context, id int64) error
	HandoffByID(ctx context.Context, id int64) (store.Handoff, error)
	HandoffByOp(ctx context.Context, op string) (store.Handoff, error)
	HandoffBySource(ctx context.Context, worker, turn, hash string) (store.Handoff, error)
	AllHandoffs(ctx context.Context) ([]store.Handoff, error)
}

// Service files, reads and deletes the handoffs of one directory.
type Service struct {
	dir string
	idx Index
	now func() time.Time
	mu  sync.Mutex // one filing or deletion at a time
}

// New is the service of dir (absolute; created 0700 when a handoff is
// filed). now nil: time.Now.
func New(dir string, idx Index, now func() time.Time) (*Service, error) {
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("handoff directory %q is not absolute", dir)
	}
	if now == nil {
		now = time.Now
	}
	return &Service{dir: filepath.Clean(dir), idx: idx, now: now}, nil
}

// Dir is the handoff directory.
func (s *Service) Dir() string { return s.dir }

// Source is what a handoff is of: the bridge's metadata, never the client's.
type Source struct {
	Floor, WorkerID, WorkerName, Label, Harness, Model, Cwd, Branch, AgentSession string
	// Kind is store.HandoffLiteral (agent and llm later).
	Kind string
	// Turn, Items and Hash are the source's identity (literal: the
	// transcript candidate's id, its ids and spans as JSON, its hash).
	Turn, Items, Hash string
	// Op is the filing operation's idempotency key ("": none).
	Op string
}

// File files body as a handoff of src. existing: the operation (or the same
// source of the same worker, its file still there) was filed before, and that
// handoff is returned instead of a second one.
func (s *Service) File(ctx context.Context, src Source, body string) (h store.Handoff, existing bool, err error) {
	switch {
	case strings.TrimSpace(body) == "":
		return store.Handoff{}, false, ErrEmpty
	case len(body) > MaxBody:
		return store.Handoff{}, false, ErrTooLarge
	case !utf8.ValidString(body):
		return store.Handoff{}, false, ErrInvalid
	}
	if src.Kind == "" {
		src.Kind = store.HandoffLiteral
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if prev, err := s.idx.HandoffByOp(ctx, src.Op); err == nil {
		if prev.WorkerID != src.WorkerID || prev.SourceHash != src.Hash || prev.SourceTurn != src.Turn {
			return store.Handoff{}, false, ErrOpReused
		}
		return prev, true, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.Handoff{}, false, err
	}
	if src.Turn != "" && src.Hash != "" {
		if prev, err := s.idx.HandoffBySource(ctx, src.WorkerID, src.Turn, src.Hash); err == nil {
			if s.handoffFile(prev.Path) == nil {
				if _, serr := os.Lstat(prev.Path); serr == nil {
					return prev, true, nil
				}
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			return store.Handoff{}, false, err
		}
	}
	now := s.now()
	h = store.Handoff{Floor: src.Floor, WorkerID: src.WorkerID, WorkerName: src.WorkerName, Label: src.Label,
		Harness: src.Harness, Model: src.Model, Cwd: src.Cwd, Branch: src.Branch, AgentSession: src.AgentSession,
		Title: Title(body, src.WorkerName, now), CreatedAt: now.UnixMilli(), Source: src.Kind, SourceTurn: src.Turn,
		SourceItems: src.Items, SourceHash: src.Hash, Op: src.Op}
	dir, err := s.floorDir(src.Floor)
	if err != nil {
		return store.Handoff{}, false, err
	}
	if err := s.mkdirs(dir); err != nil {
		return store.Handoff{}, false, err
	}
	content := FrontMatter(h, now) + body
	base := now.Format("20060102-1504") + "-" + nameOf(src.WorkerName) + "-" + Slug(h.Title)
	path, err := writeNew(dir, base, ".md", []byte(content))
	if err != nil {
		return store.Handoff{}, false, err
	}
	h.Path = path
	if fi, err := os.Stat(path); err == nil {
		h.Size, h.MTime = fi.Size(), fi.ModTime().UnixNano()
	}
	added, err := s.idx.AddHandoff(ctx, h, body)
	if err != nil {
		// Not registered: no handoff. The file goes again (a crash here
		// leaves it, and the reconcile registers it).
		_ = os.Remove(path)
		return store.Handoff{}, false, fmt.Errorf("registering the handoff: %w", err)
	}
	return added, false, nil
}

// writeNew writes b to a dot-named .tmp in dir, syncs it, and links it to
// dir/<base><ext>, or <base>-2<ext>, … when the name is taken: never over a
// file. It returns the path.
func writeNew(dir, base, ext string, b []byte) (string, error) {
	f, err := os.CreateTemp(dir, ".handoff-*.tmp")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return "", err
	}
	for i := 1; i <= maxSuffix; i++ {
		name := base + ext
		if i > 1 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		path := filepath.Join(dir, name)
		err := os.Link(tmp, path)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		syncDir(dir)
		return path, nil
	}
	return "", fmt.Errorf("no free name for %s%s in %s", base, ext, dir)
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

// floorDir is a floor's directory, checked to be in the handoff directory.
func (s *Service) floorDir(floor string) (string, error) {
	dir := filepath.Join(s.dir, FloorDir(floor))
	if err := s.inside(dir); err != nil {
		return "", err
	}
	return dir, nil
}

// inside checks path is in the handoff directory (not the directory
// itself, not the trash's parent).
func (s *Service) inside(path string) error {
	rel, err := filepath.Rel(s.dir, filepath.Clean(path))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("%w: %s", ErrOutside, path)
	}
	return nil
}

// realDirs checks that every directory from the handoff directory down to
// dir that exists is a directory and not a symlink: nothing outside the
// handoff directory is reached through one. (A symlink made between the
// check and the use is not caught: the directory is the user's own.)
func (s *Service) realDirs(dir string) error {
	rel, err := filepath.Rel(s.dir, filepath.Clean(dir))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("%w: %s", ErrOutside, dir)
	}
	if rel == "." {
		return nil
	}
	cur := s.dir
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return fmt.Errorf("%w: %s is not a directory", ErrOutside, cur)
		}
	}
	return nil
}

// mkdirs makes dir, a directory in the handoff directory, and its parents,
// never through a symlink.
func (s *Service) mkdirs(dir string) error {
	if err := s.realDirs(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return s.realDirs(dir)
}

// handoffFile checks a row's path is a handoff file of the directory: in a
// floor's directory (or the trash), a .md name, no symlinked directory on
// the way.
func (s *Service) handoffFile(path string) error {
	if err := s.inside(path); err != nil {
		return err
	}
	rel, _ := filepath.Rel(s.dir, path)
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 2 || parts[0] == TrashDir || strings.HasPrefix(parts[1], ".") || !strings.HasSuffix(parts[1], ".md") {
		return fmt.Errorf("%w: %s", ErrOutside, path)
	}
	return s.realDirs(filepath.Dir(path))
}

// Read is a handoff and its body (the file without its front matter); the
// file must be a regular one of at most MaxFile bytes.
func (s *Service) Read(ctx context.Context, id int64) (store.Handoff, string, error) {
	h, err := s.idx.HandoffByID(ctx, id)
	if err != nil {
		return store.Handoff{}, "", err
	}
	if err := s.handoffFile(h.Path); err != nil {
		return store.Handoff{}, "", err
	}
	b, _, err := readFile(h.Path)
	if err != nil {
		return store.Handoff{}, "", err
	}
	_, body := SplitFrontMatter(string(b))
	return h, body, nil
}

// readFile reads a regular file (no symlink) of at most MaxFile bytes.
func readFile(path string) ([]byte, fs.FileInfo, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("%s is not a regular file", path)
	}
	if fi.Size() > MaxFile {
		return nil, nil, fmt.Errorf("%w: %s has %d bytes", ErrTooLarge, path, fi.Size())
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFile+1))
	if err != nil {
		return nil, nil, err
	}
	if len(b) > MaxFile {
		return nil, nil, fmt.Errorf("%w: %s grew", ErrTooLarge, path)
	}
	return b, fi, nil
}

// Delete moves a handoff's file to the trash and forgets it (row and index
// row). A file already gone is only forgotten.
func (s *Service) Delete(ctx context.Context, id int64) (store.Handoff, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, err := s.idx.HandoffByID(ctx, id)
	if err != nil {
		return store.Handoff{}, err
	}
	if err := s.handoffFile(h.Path); err != nil {
		return store.Handoff{}, err
	}
	if _, err := os.Lstat(h.Path); err == nil {
		trash := filepath.Join(s.dir, TrashDir, FloorDir(h.Floor))
		if err := s.mkdirs(trash); err != nil {
			return store.Handoff{}, err
		}
		name := filepath.Base(h.Path)
		ext := filepath.Ext(name)
		if _, err := moveNew(h.Path, trash, strings.TrimSuffix(name, ext), ext); err != nil {
			return store.Handoff{}, fmt.Errorf("moving to the trash: %w", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return store.Handoff{}, err
	}
	if err := s.idx.DeleteHandoff(ctx, id); err != nil && !errors.Is(err, store.ErrNotFound) {
		// The file is in the trash: the reconcile forgets the row.
		return store.Handoff{}, err
	}
	return h, nil
}

// moveNew moves path into dir as <base><ext> (or -2, … when taken), never
// over a file.
func moveNew(path, dir, base, ext string) (string, error) {
	for i := 1; i <= maxSuffix; i++ {
		name := base + ext
		if i > 1 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		to := filepath.Join(dir, name)
		err := os.Link(path, to)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := os.Remove(path); err != nil {
			_ = os.Remove(to)
			return "", err
		}
		syncDir(dir)
		syncDir(filepath.Dir(path))
		return to, nil
	}
	return "", fmt.Errorf("no free name for %s%s in %s", base, ext, dir)
}

// Reconciled is what Reconcile did.
type Reconciled struct {
	Removed    int // rows whose file is gone
	Reindexed  int // rows whose file changed
	Registered int // files without a row (a crash after the write)
	Tmp        int // leftover .tmp files removed
}

// Reconcile brings the index in line with the directory (at startup): a row
// whose file is gone is forgotten, one whose file changed (size or mtime) is
// read and indexed again, a handoff file without a row is registered from
// its front matter, and leftover .tmp files go.
func (s *Service) Reconcile(ctx context.Context) (Reconciled, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var r Reconciled
	rows, err := s.idx.AllHandoffs(ctx)
	if err != nil {
		return r, err
	}
	known := map[string]bool{}
	for _, h := range rows {
		known[h.Path] = true
		fi, err := os.Lstat(h.Path)
		switch {
		case s.handoffFile(h.Path) != nil, errors.Is(err, fs.ErrNotExist), err == nil && !fi.Mode().IsRegular():
			if err := s.idx.DeleteHandoff(ctx, h.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
				return r, err
			}
			r.Removed++
		case err != nil:
			return r, err
		case fi.Size() != h.Size || fi.ModTime().UnixNano() != h.MTime:
			b, fi, err := readFile(h.Path)
			if err != nil {
				if err := s.idx.DeleteHandoff(ctx, h.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
					return r, err
				}
				r.Removed++
				continue
			}
			_, body := SplitFrontMatter(string(b))
			at := time.UnixMilli(h.CreatedAt)
			if err := s.idx.ReindexHandoff(ctx, h.ID, Title(body, h.WorkerName, at), fi.Size(), fi.ModTime().UnixNano(), body); err != nil {
				return r, err
			}
			r.Reindexed++
		}
	}
	floors, err := os.ReadDir(s.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	for _, fd := range floors {
		if !fd.IsDir() || strings.HasPrefix(fd.Name(), ".") {
			continue
		}
		dir := filepath.Join(s.dir, fd.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			name, path := f.Name(), filepath.Join(dir, f.Name())
			switch {
			case strings.HasPrefix(name, ".handoff-") && strings.HasSuffix(name, ".tmp"):
				if os.Remove(path) == nil {
					r.Tmp++
				}
			case !f.Type().IsRegular() || known[path] || s.handoffFile(path) != nil:
			default:
				ok, err := s.register(ctx, path)
				if err != nil {
					return r, err
				}
				if ok {
					r.Registered++
				}
			}
		}
	}
	return r, nil
}

// register adds a handoff file without a row, when its front matter is the
// bridge's (a source and a date), with the op and source identity it names,
// so a retry of that filing finds it. An op another row has (a copy of a
// file) is left out.
func (s *Service) register(ctx context.Context, path string) (bool, error) {
	b, fi, err := readFile(path)
	if err != nil {
		return false, nil
	}
	fm, body := SplitFrontMatter(string(b))
	at, err := time.Parse(time.RFC3339, fm["date"])
	switch {
	case err != nil, fm["source"] == "", strings.TrimSpace(body) == "":
		return false, nil
	}
	switch fm["source"] {
	case store.HandoffLiteral, store.HandoffAgent, store.HandoffLLM:
	default:
		return false, nil
	}
	floor := fm["floor"]
	if floor == "" || FloorDir(floor) != filepath.Base(filepath.Dir(path)) {
		floor = filepath.Base(filepath.Dir(path))
	}
	h := store.Handoff{Floor: floor, WorkerID: fm["worker_id"], WorkerName: fm["worker"], Label: fm["label"], Harness: fm["harness"],
		Model: fm["model"], Cwd: fm["cwd"], Branch: fm["branch"], AgentSession: fm["session"], Path: path,
		Title: Title(body, fm["worker"], at), CreatedAt: at.UnixMilli(), Source: fm["source"], SourceTurn: fm["source_turn"],
		SourceItems: fm["source_items"], SourceHash: fm["source_hash"], Op: fm["op"], Size: fi.Size(), MTime: fi.ModTime().UnixNano()}
	if h.Op != "" {
		if _, err := s.idx.HandoffByOp(ctx, h.Op); err == nil {
			h.Op = ""
		} else if !errors.Is(err, store.ErrNotFound) {
			return false, err
		}
	}
	if _, err := s.idx.AddHandoff(ctx, h, body); err != nil {
		return false, err
	}
	return true, nil
}

// frontKeys are the front matter's keys, in order.
var frontKeys = []string{"date", "floor", "worker", "worker_id", "label", "branch", "harness", "model", "session", "cwd", "source",
	"source_turn", "source_items", "source_hash", "op"}

// FrontMatter is the bridge's front matter of a handoff filed at: its
// metadata as YAML, each value a JSON (so YAML) quoted string, empty ones
// left out; the body follows it unchanged.
func FrontMatter(h store.Handoff, at time.Time) string {
	vals := map[string]string{"date": at.Local().Format(time.RFC3339), "floor": h.Floor, "worker": h.WorkerName,
		"worker_id": h.WorkerID, "label": h.Label, "branch": h.Branch, "harness": h.Harness, "model": h.Model,
		"session": h.AgentSession, "cwd": h.Cwd, "source": h.Source, "source_turn": h.SourceTurn, "source_items": h.SourceItems,
		"source_hash": h.SourceHash, "op": h.Op}
	var b strings.Builder
	b.WriteString("---\n")
	for _, k := range frontKeys {
		if v := vals[k]; v != "" {
			q, _ := json.Marshal(v)
			b.WriteString(k + ": " + string(q) + "\n")
		}
	}
	b.WriteString("---\n")
	return b.String()
}

// SplitFrontMatter splits a handoff file into its front matter (the values
// FrontMatter writes) and its body. A file without one is all body.
func SplitFrontMatter(s string) (map[string]string, string) {
	fm := map[string]string{}
	if !strings.HasPrefix(s, "---\n") {
		return fm, s
	}
	end := strings.Index(s[4:], "\n---\n")
	if end < 0 {
		if strings.HasPrefix(s[4:], "---\n") { // an empty one
			return fm, s[8:]
		}
		return fm, s
	}
	head, body := s[4:4+end], s[4+end+5:]
	for _, line := range strings.Split(head, "\n") {
		k, v, ok := strings.Cut(line, ": ")
		if !ok {
			continue
		}
		var str string
		if json.Unmarshal([]byte(v), &str) == nil {
			fm[k] = str
		}
	}
	return fm, body
}

// Title is a handoff's title, derived from its text: the first H1 (outside
// code fences), else the first nonempty line, else the worker and the date;
// blanks collapsed, Markdown heading marks taken off, at most MaxTitle
// characters. No model is asked.
func Title(body, worker string, at time.Time) string {
	fence := ""
	first := ""
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if f := fenceOf(t); f != "" {
			switch {
			case fence == "":
				fence = f
			case strings.HasPrefix(t, fence) && strings.TrimSpace(strings.TrimLeft(t, fence[:1])) == "":
				fence = ""
			}
			continue
		}
		if fence != "" {
			if first == "" && t != "" {
				first = t
			}
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if text, level := heading(t); indent <= 3 && level == 1 {
			if h := clean(text); h != "" {
				return h
			}
		}
		if first == "" && t != "" {
			first = t
		}
	}
	if first != "" {
		if text, level := heading(first); level > 0 {
			first = text
		}
		if c := clean(first); c != "" {
			return c
		}
	}
	name := strings.TrimSpace(worker)
	if name == "" {
		name = "Handoff"
	}
	return clean(name + " " + at.Local().Format("2006-01-02 15:04"))
}

// heading is an ATX heading's text and level (0: t is none): "## Text ##"
// is "Text", 2.
func heading(t string) (string, int) {
	rest := strings.TrimLeft(t, "#")
	level := len(t) - len(rest)
	if level == 0 || level > 6 || (rest != "" && rest[0] != ' ' && rest[0] != '\t') {
		return "", 0
	}
	rest = strings.TrimSpace(rest)
	if closing := strings.TrimRight(rest, "#"); closing == "" || strings.HasSuffix(closing, " ") {
		rest = strings.TrimSpace(closing)
	}
	return rest, level
}

// fenceOf is the fence a line opens or closes ("```" or "~~~", as long as
// the line has it), "" when it is none.
func fenceOf(t string) string {
	for _, c := range []string{"`", "~"} {
		if strings.HasPrefix(t, c+c+c) {
			n := len(t) - len(strings.TrimLeft(t, c))
			return t[:n]
		}
	}
	return ""
}

// clean collapses blanks and control characters and caps a title.
func clean(s string) string {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if utf8.RuneCountInString(s) <= MaxTitle {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:MaxTitle-1])) + "…"
}

// Slug is a title as a file name part: lowercase ASCII letters and digits,
// runs of anything else one "-", at most 48 bytes; "handoff" when nothing
// is left.
func Slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
		default:
			dash = true
		}
		if b.Len() >= maxSlug {
			break
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > maxSlug {
		s = strings.Trim(s[:maxSlug], "-")
	}
	if s == "" {
		return "handoff"
	}
	return s
}

// nameOf is a worker's name as a file name part (Slug, shorter; "worker"
// when nothing is left).
func nameOf(worker string) string {
	s := Slug(worker)
	if s == "handoff" && strings.TrimSpace(worker) == "" {
		return "worker"
	}
	if len(s) > maxName {
		s = strings.Trim(s[:maxName], "-")
	}
	return s
}

// FloorDir is a floor's directory name: its name with every byte that is
// not an ASCII letter, digit, '.', '_' or '-' a '-', never starting with a
// dot (not the trash, not hidden); "floor" when nothing is left.
func FloorDir(floor string) string {
	b := []byte(floor)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			b[i] = '-'
		}
	}
	s := string(bytes.TrimLeft(b, "."))
	if len(s) > 64 {
		s = s[:64]
	}
	if s == "" {
		return "floor"
	}
	return s
}
