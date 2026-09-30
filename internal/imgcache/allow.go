package imgcache

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Why a path image is not available. The path is text in the transcript,
// written by the agent or the user; the bridge reads it only when it is
// under a root it was told to serve.
var (
	ErrNotAllowed = errors.New("path is not under an allowed root")
	ErrMissing    = errors.New("no such file")
	ErrNotFile    = errors.New("not a regular file")
)

// Reasons, as the protocol says them (ImageRef.Reason).
const (
	ReasonNotAllowed = "not_allowed"
	ReasonMissing    = "missing"
	ReasonTooLarge   = "too_large"
	ReasonNotImage   = "not_image"
	ReasonInvalid    = "invalid"
)

// Reason is the protocol's word for err.
func Reason(err error) string {
	switch {
	case errors.Is(err, ErrNotAllowed):
		return ReasonNotAllowed
	case errors.Is(err, ErrMissing):
		return ReasonMissing
	case errors.Is(err, ErrTooLarge):
		return ReasonTooLarge
	case errors.Is(err, ErrNotImage):
		return ReasonNotImage
	}
	return ReasonInvalid
}

// readFile reads an allowed file (tests count the reads).
var readFile = ReadFile

// PathImage is an image file that passed the allowlist.
type PathImage struct {
	Real  string // the path after EvalSymlinks
	Size  int64
	MTime int64 // unix ns
}

// CheckPath applies the allowlist to path without reading the file: it is
// absolute and clean, inside one of roots (before and after EvalSymlinks:
// a symlink under a root that leads out is refused), and a regular file of
// at most MaxImage bytes. A path outside every root is refused before any
// file system call.
func CheckPath(path string, roots []string) (PathImage, error) {
	if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || filepath.Clean(path) != path {
		return PathImage{}, ErrNotAllowed
	}
	var usable []string
	for _, r := range roots {
		// "/" would allow everything; a relative root means nothing.
		if r != "" && filepath.IsAbs(r) && filepath.Clean(r) != "/" {
			usable = append(usable, filepath.Clean(r))
		}
	}
	roots = usable
	var lexical []string // the roots the path is under, as written
	for _, r := range roots {
		if within(r, path) {
			lexical = append(lexical, filepath.Clean(r))
		}
	}
	// Also the roots as their real places: a root that is a symlink is
	// still a root, and a path may name it either way.
	var realRoots []string
	for _, r := range roots {
		if rr, err := filepath.EvalSymlinks(r); err == nil && rr != "/" {
			realRoots = append(realRoots, rr)
		}
	}
	underReal := false
	for _, rr := range realRoots {
		if within(rr, path) {
			underReal = true
		}
	}
	if len(lexical) == 0 && !underReal {
		return PathImage{}, ErrNotAllowed
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return PathImage{}, ErrMissing
	}
	ok := false
	for _, rr := range realRoots {
		if within(rr, real) {
			ok = true
		}
	}
	if !ok {
		return PathImage{}, ErrNotAllowed
	}
	fi, err := os.Lstat(real)
	if err != nil {
		return PathImage{}, ErrMissing
	}
	if !fi.Mode().IsRegular() {
		return PathImage{}, ErrNotFile
	}
	if fi.Size() > MaxImage {
		return PathImage{}, ErrTooLarge
	}
	return PathImage{Real: real, Size: fi.Size(), MTime: fi.ModTime().UnixNano()}, nil
}

// LoadPath checks path and reads it: an image of a type the bridge serves.
func LoadPath(path string, roots []string) (PathImage, []byte, Info, error) {
	pi, err := CheckPath(path, roots)
	if err != nil {
		return pi, nil, Info{}, err
	}
	b, err := readFile(pi.Real)
	if err != nil {
		if errors.Is(err, ErrTooLarge) {
			return pi, nil, Info{}, err
		}
		return pi, nil, Info{}, ErrMissing
	}
	info, err := Inspect(b)
	if err != nil {
		return pi, nil, info, err
	}
	return pi, b, info, nil
}

// within reports whether path is root or below it.
func within(root, path string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}
