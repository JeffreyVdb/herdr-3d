// Package drops reads Drop Zone's data directory for M13's "Pin a drop"
// (and later #13's composer): the most recent files, newest first, and an
// image's bytes or thumbnail. It only reads, never writes there. Every read
// goes through imgcache's allowlist with the data directory as the one root
// (absolute clean paths, no symlink out, regular files, walked down without
// following a link), as the transcripts' path images do.
package drops

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
)

// Limits of drops.list.
const (
	DefaultLimit = 20
	MaxLimit     = 50
	// maxScan bounds the directory entries looked at, so a huge data
	// directory costs a bounded walk.
	maxScan = 20000
)

// Drop is one file in Drop Zone's data directory.
type Drop struct {
	Path  string `json:"path"` // absolute, as Drop Zone stored it
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // unix ms
	// Mime is the sniffed image type ("" for anything else); Image says it
	// can be pinned (a PNG, JPEG, GIF or WebP of at most imgcache.MaxImage).
	Mime  string `json:"mime"`
	Image bool   `json:"image"`
	// Reason is why a file cannot be pinned: imgcache's not_image or too_large.
	Reason string `json:"reason,omitempty"`
}

// ErrNoRoot: no data directory is configured.
var ErrNoRoot = errors.New("Drop Zone's data directory is not configured")

// List returns the limit (1..MaxLimit, else DefaultLimit) most recently
// modified regular files in root and its date folders (root/<dir>/<file>,
// one level down, as Drop Zone partitions them), newest first. Hidden
// files and folders, links and anything but regular files are skipped. A
// root that does not exist has no drops.
func List(root string, limit int) ([]Drop, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, ErrNoRoot
	}
	if limit < 1 || limit > MaxLimit {
		limit = DefaultLimit
	}
	root = filepath.Clean(root)
	type cand struct {
		path  string
		size  int64
		mtime int64
	}
	var all []cand
	scanned := 0
	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		ents, err := os.ReadDir(dir)
		if err != nil {
			if dir == root && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			if dir == root {
				return err
			}
			return nil // an unreadable folder has no drops
		}
		for _, e := range ents {
			if scanned++; scanned > maxScan {
				return nil
			}
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			p := filepath.Join(dir, e.Name())
			switch t := e.Type(); {
			case t.IsDir() && depth == 0:
				if err := walk(p, 1); err != nil {
					return err
				}
			case t.IsRegular():
				fi, err := e.Info()
				if err == nil {
					all = append(all, cand{p, fi.Size(), fi.ModTime().UnixMilli()})
				}
			}
		}
		return nil
	}
	if err := walk(root, 0); err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].mtime != all[j].mtime {
			return all[i].mtime > all[j].mtime
		}
		return all[i].path < all[j].path
	})
	if len(all) > limit {
		all = all[:limit]
	}
	out := make([]Drop, 0, len(all))
	for _, c := range all {
		d := Drop{Path: c.path, Name: filepath.Base(c.path), Size: c.size, MTime: c.mtime}
		_, mime, err := imgcache.SniffPath(c.path, []string{root})
		switch {
		case err != nil:
			continue // gone, or no longer what it was, since the listing
		case mime == "":
			d.Reason = imgcache.ReasonNotImage
		case c.size > imgcache.MaxImage:
			d.Mime, d.Reason = mime, imgcache.ReasonTooLarge
		default:
			d.Mime, d.Image = mime, true
		}
		out = append(out, d)
	}
	return out, nil
}

// Read returns a drop's bytes and image info: an image under root only.
func Read(root, path string) ([]byte, imgcache.Info, error) {
	if root == "" {
		return nil, imgcache.Info{}, ErrNoRoot
	}
	_, b, info, err := imgcache.LoadPath(path, []string{root})
	return b, info, err
}

// Thumb returns a drop's thumbnail (imgcache.ThumbSide px at most).
func Thumb(root, path string) (imgcache.Thumb, error) {
	b, _, err := Read(root, path)
	if err != nil {
		return imgcache.Thumb{}, err
	}
	return imgcache.MakeThumb(b)
}
