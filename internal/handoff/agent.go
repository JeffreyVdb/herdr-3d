package handoff

// #224: a handoff the worker's agent writes. The bridge reserves the file
// the agent is told to write, <dir>/.pending/<floor>/<op>.md, before its
// prompt goes out: a hidden directory Reconcile never registers from, so an
// agent-written file is never filed by itself. Once the bridge saw the
// agent's turn end with the file complete, Adopt files its text as an agent
// handoff through File (the bridge's front matter and title rules, a free
// name in the floor's directory, the row and its index) and removes the
// reserved file. The agent's own front matter is dropped: the bridge
// decides the provenance.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// PendingDir is where agents write the handoffs they were asked for, under
// the handoff directory.
const PendingDir = ".pending"

// Errors of an agent's file.
var (
	ErrNoFile     = errors.New("the agent has not written the handoff file")
	ErrIncomplete = errors.New("the handoff file is still being written (its .tmp is there)")
)

// Reserve is the file the agent of op writes for floor:
// <dir>/.pending/<floor>/<op>.md, its directory made (0700, never through a
// symlink). Whatever is there already for op (left by a crash before its
// request was stored) is removed: a file that existed before the request is
// never adopted.
func (s *Service) Reserve(floor, op string) (string, error) {
	if op == "" || op != filepath.Base(op) || strings.HasPrefix(op, ".") {
		return "", fmt.Errorf("%w: op %q", ErrOutside, op)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, PendingDir, FloorDir(floor))
	if err := s.mkdirs(dir); err != nil {
		return "", err
	}
	path := filepath.Join(dir, op+".md")
	for _, p := range []string{path, path + ".tmp"} {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
	}
	return path, nil
}

// pendingFile checks path is a reserved file: <dir>/.pending/<floor>/<name>.md,
// no symlinked directory on the way.
func (s *Service) pendingFile(path string) error {
	if err := s.inside(path); err != nil {
		return err
	}
	rel, _ := filepath.Rel(s.dir, filepath.Clean(path))
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 3 || parts[0] != PendingDir || strings.HasPrefix(parts[1], ".") || strings.HasPrefix(parts[2], ".") ||
		!strings.HasSuffix(parts[2], ".md") {
		return fmt.Errorf("%w: %s", ErrOutside, path)
	}
	return s.realDirs(filepath.Dir(path))
}

// Written reports whether the agent's file at a reserved path is there and
// complete: ErrNoFile when it is not there, ErrIncomplete while its .tmp
// is, nil for a regular file (empty or not; Adopt checks the text).
func (s *Service) Written(path string) error {
	if err := s.pendingFile(path); err != nil {
		return err
	}
	if _, err := os.Lstat(path + ".tmp"); err == nil {
		return ErrIncomplete
	}
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return ErrNoFile
	case err != nil:
		return err
	case !fi.Mode().IsRegular():
		return fmt.Errorf("%s is not a regular file", path)
	}
	return nil
}

// Adopt files the agent's file at a reserved path as a handoff of src
// (Kind store.HandoffAgent): it must be complete (Written), a regular file
// of at most MaxFile bytes whose text, without any front matter the agent
// wrote, is nonempty UTF-8 of at most MaxBody bytes. The text is filed with
// the bridge's front matter (File: the title its first H1, else the
// fallback), and the reserved file goes. existing: src.Op was filed before
// (a retry), that handoff is answered.
func (s *Service) Adopt(ctx context.Context, src Source, path string) (store.Handoff, bool, error) {
	if err := s.Written(path); err != nil {
		return store.Handoff{}, false, err
	}
	b, _, err := readFile(path)
	if err != nil {
		return store.Handoff{}, false, err
	}
	src.Kind = store.HandoffAgent
	h, existing, err := s.File(ctx, src, StripFrontMatter(string(b)))
	if err != nil {
		return store.Handoff{}, false, err
	}
	_ = os.Remove(path)
	syncDir(filepath.Dir(path))
	return h, existing, nil
}

// Discard moves a reserved file the bridge will not adopt (its request
// failed or was cancelled) to the trash, <dir>/.trash/<floor>/, so the
// agent's text is not lost; its .tmp goes. Nothing there: nothing to do.
func (s *Service) Discard(path string) error {
	if err := s.pendingFile(path); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.Remove(path + ".tmp")
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return err
	case !fi.Mode().IsRegular():
		return os.Remove(path)
	}
	trash := filepath.Join(s.dir, TrashDir, filepath.Base(filepath.Dir(path)))
	if err := s.mkdirs(trash); err != nil {
		return err
	}
	name := filepath.Base(path)
	_, err = moveNew(path, trash, "agent-"+strings.TrimSuffix(name, ".md"), ".md")
	return err
}

// CleanPending discards (Discard) every reserved file, and its .tmp, whose
// path keep does not hold (at startup: those of no pending request). It
// returns how many reserved paths went.
func (s *Service) CleanPending(keep map[string]bool) (int, error) {
	root := filepath.Join(s.dir, PendingDir)
	if err := s.realDirs(root); err != nil {
		return 0, err
	}
	floors, err := os.ReadDir(root)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n := 0
	for _, fd := range floors {
		if !fd.IsDir() || strings.HasPrefix(fd.Name(), ".") {
			continue
		}
		dir := filepath.Join(root, fd.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		gone := map[string]bool{}
		for _, f := range files {
			md := filepath.Join(dir, strings.TrimSuffix(f.Name(), ".tmp"))
			if !keep[md] && strings.HasSuffix(md, ".md") && !gone[md] {
				gone[md] = true
				if s.Discard(md) == nil {
					n++
				}
			}
		}
	}
	return n, nil
}

// StripFrontMatter is a file's text without a leading front matter block
// (a "---" line, anything, a "---" line), whatever its keys or quoting; a
// text whose first "---" is never closed is all body.
func StripFrontMatter(s string) string {
	t := strings.ReplaceAll(strings.TrimPrefix(s, "\ufeff"), "\r\n", "\n")
	if !strings.HasPrefix(t, "---\n") {
		return s
	}
	lines := strings.SplitAfter(t[4:], "\n")
	n := 4
	for _, l := range lines {
		n += len(l)
		if strings.TrimRight(l, " \t\n") == "---" {
			return t[n:]
		}
	}
	return s
}
