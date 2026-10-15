// Package whiteboard is M13's per-floor whiteboard storage: the Excalidraw
// scene of each floor, versioned (the last Keep versions kept), its image
// files stored once by the sha256 of their bytes, the PNG render the game
// shows in the room, and agents' pins appended in Go. Pure Go, files only:
// the bridge's HTTP routes and commands sit on top (internal/server).
//
// On disk, <root>/<floor>/ (0700, files 0600):
//
//	head.json        the current version, its author, the render's version, the stale pins (small, bounded)
//	v/<n>.json       version n: the scene (elements incl. tombstones, appState) and its files' manifest
//	v/<n>.files.json the ids of the files version n uses (for the collection)
//	files/<sha256>   one image's bytes; the name is the sha256 of exactly these bytes
//	renders/<n>.png  the client's export of version n; head.render_version names the current one
//
// Every write is a temp file renamed into place, and a commit only adds
// files until head.json is written last, so a crash leaves the previous
// version current with its own render; what the new head no longer names
// is removed after it.
package whiteboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // the types an image may be
	_ "image/jpeg"
	"image/png"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "golang.org/x/image/webp"
)

// Errors. The server maps them to the protocol's codes.
var (
	ErrInvalidFloor = errors.New("not a floor name")
	ErrInvalid      = errors.New("invalid whiteboard data")
	ErrTooLarge     = errors.New("too large")
	ErrUnsupported  = errors.New("unsupported image type")
	ErrHashMismatch = errors.New("the file id is not the sha256 of its bytes")
	ErrMissingFile  = errors.New("an image's file is not stored")
	ErrNotFound     = errors.New("not found")
)

// ConflictError is a save whose base version is not the current one.
type ConflictError struct{ Current int64 }

func (e *ConflictError) Error() string {
	return fmt.Sprintf("the whiteboard is at version %d: merge it and save again", e.Current)
}

// Keep is how many versions a floor keeps.
const Keep = 20

// DefaultFileGrace is how long an image file no version uses is kept: it
// may be on its way into a save.
const DefaultFileGrace = time.Hour

// syscallNoFollow: the store's own files are never read through a link.
const syscallNoFollow = syscall.O_NOFOLLOW

// maxRequests is how many pin request ids a floor remembers.
const maxRequests = 64

// maxStalePins is how many stale pins head.json lists (the newest): the
// room's note and the overlay show a few, and the head stays small.
const maxStalePins = 100

// maxHead is the most head.json may be. Its content is bounded (Keep
// versions without their files, maxStalePins, maxRequests), and a commit
// refuses a head over it before it writes anything, so the store never
// writes a head it would not read.
const maxHead = 1 << 20

// maxUses is the most a version's files list (v/<n>.files.json) may be:
// MaxElements ids.
const maxUses = int64(MaxElements)*68 + 1024

// The image types a board stores: what imgcache serves.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// floorRe is herdr's session name rule (herdr.ValidSessionName): a floor
// id (#58: a real floor's session name, or a virtual floor's "v-<12 hex>",
// itself such a name) is one path component, never "." or "..".
var floorRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidFloor reports whether name can be a floor id (a herdr session name
// or a virtual floor's id).
func ValidFloor(name string) bool {
	return floorRe.MatchString(name) && name[0] != '-' && strings.Trim(name, ".") != ""
}

// StalePin is a pin added since the render was made: the board in the room
// does not show it yet, so it is listed beside it.
type StalePin struct {
	ID      string `json:"id"` // element id
	Kind    string `json:"kind"`
	Author  string `json:"author"`
	Note    string `json:"note,omitempty"` // a note's first 140 characters
	File    string `json:"file,omitempty"` // an image's file id
	Version int64  `json:"version"`
	At      int64  `json:"at"`
}

// Head is a floor's current state.
type Head struct {
	Version int64  `json:"version"` // 0: never saved
	Author  string `json:"author"`
	At      int64  `json:"at"` // unix ms
	// RenderVersion is the version render.png shows (Render false: the
	// board was empty then, there is no PNG). Stale when it is behind Version.
	RenderVersion int64      `json:"render_version"`
	Render        bool       `json:"render"`
	StalePins     []StalePin `json:"stale_pins"` // the newest maxStalePins
	// Retained lists the kept versions (their files are in
	// v/<n>.files.json: a head with each version's files grew with them).
	Retained []Retained   `json:"retained,omitempty"`
	Requests []pinRequest `json:"requests,omitempty"`
}

// Stale reports whether render.png is behind the current version.
func (h Head) Stale() bool { return h.RenderVersion != h.Version }

// Retained is one kept version.
type Retained struct {
	Version int64  `json:"version"`
	Author  string `json:"author"`
	At      int64  `json:"at"`
}

type pinRequest struct {
	ID       string   `json:"id"`
	Elements []string `json:"elements"`
	Version  int64    `json:"version"`
}

// Snapshot is one version of a floor's board.
type Snapshot struct {
	Schema            int                 `json:"schema"`
	Floor             string              `json:"floor"`
	Version           int64               `json:"version"`
	Author            string              `json:"author"`
	At                int64               `json:"at"`
	ExcalidrawVersion string              `json:"excalidraw_version"`
	Scene             Scene               `json:"scene"`
	Files             map[string]FileMeta `json:"files"`
}

// Board is a floor's current snapshot with its head.
type Board struct {
	Head
	Snapshot Snapshot
}

// Store keeps the boards of every floor under one root.
type Store struct {
	root string
	// Now is the clock (default time.Now); FileGrace how long an unused
	// file is kept (default DefaultFileGrace). Set them before use.
	Now       func() time.Time
	FileGrace time.Duration

	mu     sync.Mutex
	floors map[string]*sync.Mutex
}

// New returns a store under root (created 0700 on the first write).
func New(root string) *Store {
	return &Store{root: root, Now: time.Now, FileGrace: DefaultFileGrace, floors: map[string]*sync.Mutex{}}
}

// DefaultRoot is $XDG_DATA_HOME/herdr-3d/whiteboards, else
// ~/.local/share/herdr-3d/whiteboards.
func DefaultRoot() string {
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" || !filepath.IsAbs(dir) {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dir, "herdr-3d", "whiteboards")
}

// Root is the store's directory.
func (s *Store) Root() string { return s.root }

func (s *Store) lock(floor string) (func(), error) {
	if !ValidFloor(floor) {
		return nil, ErrInvalidFloor
	}
	s.mu.Lock()
	m := s.floors[floor]
	if m == nil {
		m = &sync.Mutex{}
		s.floors[floor] = m
	}
	s.mu.Unlock()
	m.Lock()
	return m.Unlock, nil
}

func (s *Store) dir(floor string) string { return filepath.Join(s.root, floor) }

func (s *Store) versionPath(floor string, v int64, ext string) string {
	return filepath.Join(s.dir(floor), "v", strconv.FormatInt(v, 10)+ext)
}

func (s *Store) renderPath(floor string, v int64) string {
	return filepath.Join(s.dir(floor), "renders", strconv.FormatInt(v, 10)+".png")
}

func (s *Store) nowMS() int64 { return s.Now().UnixMilli() }

// ---- reading ---------------------------------------------------------------

func readJSON(path string, v any, limit int64) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscallNoFollow, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() || fi.Size() > limit {
		return fmt.Errorf("%s: not a regular file of at most %d bytes", path, limit)
	}
	return json.NewDecoder(f).Decode(v)
}

func (s *Store) readHead(floor string) (Head, error) {
	var h Head
	err := readJSON(filepath.Join(s.dir(floor), "head.json"), &h, maxHead)
	if errors.Is(err, fs.ErrNotExist) {
		return Head{StalePins: []StalePin{}}, nil
	}
	if h.StalePins == nil {
		h.StalePins = []StalePin{}
	}
	return h, err
}

func (s *Store) readSnapshot(floor string, v int64) (Snapshot, error) {
	if v == 0 {
		return Snapshot{Schema: 1, Floor: floor, ExcalidrawVersion: ExcalidrawVersion, Scene: emptyScene(), Files: map[string]FileMeta{}}, nil
	}
	var sn Snapshot
	err := readJSON(s.versionPath(floor, v, ".json"), &sn, MaxScene+MaxScene/2)
	if errors.Is(err, fs.ErrNotExist) {
		return sn, fmt.Errorf("%w: version %d of %s", ErrNotFound, v, floor)
	}
	if sn.Scene.Elements == nil {
		sn.Scene.Elements = []json.RawMessage{}
	}
	if sn.Files == nil {
		sn.Files = map[string]FileMeta{}
	}
	return sn, err
}

// Head returns a floor's current state (version 0 for a board never saved).
func (s *Store) Head(floor string) (Head, error) {
	unlock, err := s.lock(floor)
	if err != nil {
		return Head{}, err
	}
	defer unlock()
	return s.readHead(floor)
}

// Get returns a floor's current board.
func (s *Store) Get(floor string) (Board, error) {
	unlock, err := s.lock(floor)
	if err != nil {
		return Board{}, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return Board{}, err
	}
	sn, err := s.readSnapshot(floor, h.Version)
	return Board{Head: h, Snapshot: sn}, err
}

// Version returns one kept version of a floor's board (ErrNotFound when it
// is not kept).
func (s *Store) Version(floor string, v int64) (Snapshot, error) {
	unlock, err := s.lock(floor)
	if err != nil {
		return Snapshot{}, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return Snapshot{}, err
	}
	if !slices.ContainsFunc(h.Retained, func(r Retained) bool { return r.Version == v }) {
		return Snapshot{}, fmt.Errorf("%w: version %d of %s is not kept", ErrNotFound, v, floor)
	}
	return s.readSnapshot(floor, v)
}

// File returns a stored image's bytes and type.
func (s *Store) File(floor, id string) ([]byte, string, error) {
	if !ValidFloor(floor) {
		return nil, "", ErrInvalidFloor
	}
	if !ValidFileID(id) {
		return nil, "", fmt.Errorf("%w: file %s", ErrNotFound, clip(id))
	}
	b, err := readLimited(filepath.Join(s.dir(floor), "files", id), MaxFile)
	if err != nil {
		return nil, "", fmt.Errorf("%w: file %s", ErrNotFound, id)
	}
	return b, sniff(b), nil
}

// Render returns the current render (renders/<render_version>.png) and the
// version it shows (ErrNotFound: none).
func (s *Store) Render(floor string) ([]byte, int64, error) {
	unlock, err := s.lock(floor)
	if err != nil {
		return nil, 0, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return nil, 0, err
	}
	if !h.Render {
		return nil, h.RenderVersion, fmt.Errorf("%w: no render of %s", ErrNotFound, floor)
	}
	b, err := readLimited(s.renderPath(floor, h.RenderVersion), MaxRender)
	if err != nil {
		return nil, h.RenderVersion, fmt.Errorf("%w: no render of %s", ErrNotFound, floor)
	}
	return b, h.RenderVersion, nil
}

func readLimited(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscallNoFollow, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > limit {
		return nil, fmt.Errorf("%s: not a regular file of at most %d bytes", path, limit)
	}
	b := make([]byte, fi.Size())
	if _, err := f.ReadAt(b, 0); err != nil && fi.Size() > 0 {
		return nil, err
	}
	return b, nil
}

func sniff(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

// ---- writing ---------------------------------------------------------------

// ensure makes the floor's directories 0700.
func (s *Store) ensure(floor string) error {
	for _, d := range []string{s.root, s.dir(floor), filepath.Join(s.dir(floor), "v"), filepath.Join(s.dir(floor), "files"), filepath.Join(s.dir(floor), "renders")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
		fi, err := os.Lstat(d)
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is not a directory", d)
		}
		if fi.Mode().Perm() != 0o700 {
			if err := os.Chmod(d, 0o700); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeFile is how the store writes a file (a test makes one fail).
var writeFile = writeAtomic

// writeAtomic writes data to path through a 0600 temp file in its directory.
func writeAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_ = f.Chmod(0o600)
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if werr == nil {
		werr = serr
	}
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(name, path)
	}
	if werr != nil {
		_ = os.Remove(name)
	}
	return werr
}

func (s *Store) writeJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeFile(path, b)
}

// checkImage sniffs b and reads its size from its header.
func checkImage(b []byte) (string, image.Config, error) {
	if len(b) > MaxFile {
		return "", image.Config{}, fmt.Errorf("%w: an image is at most %d bytes", ErrTooLarge, MaxFile)
	}
	m := sniff(b)
	if !imageTypes[m] {
		return "", image.Config{}, fmt.Errorf("%w: only PNG, JPEG, GIF and WebP images are stored", ErrUnsupported)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return m, cfg, fmt.Errorf("%w: the image cannot be read: %v", ErrInvalid, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return m, cfg, fmt.Errorf("%w: %d x %d px", ErrTooLarge, cfg.Width, cfg.Height)
	}
	return m, cfg, nil
}

// Hash is the file id of b: its sha256 in hex.
func Hash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// PutFile stores an image file under id, which must be the sha256 of b. A
// file already stored is not written again (stored false).
func (s *Store) PutFile(floor, id string, b []byte) (stored bool, mime string, err error) {
	if !ValidFloor(floor) {
		return false, "", ErrInvalidFloor
	}
	if !ValidFileID(id) {
		return false, "", fmt.Errorf("%w: a file id is 64 lower-case hex digits", ErrInvalid)
	}
	if len(b) > MaxFile {
		return false, "", fmt.Errorf("%w: an image is at most %d bytes", ErrTooLarge, MaxFile)
	}
	if Hash(b) != id {
		return false, "", ErrHashMismatch
	}
	mime, _, err = checkImage(b)
	if err != nil {
		return false, mime, err
	}
	unlock, err := s.lock(floor)
	if err != nil {
		return false, "", err
	}
	defer unlock()
	stored, err = s.putFile(floor, id, b)
	return stored, mime, err
}

// putFile writes a checked file (under the floor's lock).
func (s *Store) putFile(floor, id string, b []byte) (bool, error) {
	if err := s.ensure(floor); err != nil {
		return false, err
	}
	dir := filepath.Join(s.dir(floor), "files")
	path := filepath.Join(dir, id)
	if fi, err := os.Lstat(path); err == nil && fi.Mode().IsRegular() && fi.Size() == int64(len(b)) {
		now := s.Now()
		_ = os.Chtimes(path, now, now) // in use again: the collection keeps it
		return false, nil
	}
	total, err := dirSize(dir)
	if err != nil {
		return false, err
	}
	if total+int64(len(b)) > MaxFloorFiles {
		return false, fmt.Errorf("%w: a floor's images are at most %d MiB together", ErrTooLarge, MaxFloorFiles>>20)
	}
	return true, writeFile(path, b)
}

func dirSize(dir string) (int64, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, e := range ents {
		if fi, err := e.Info(); err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
	}
	return n, nil
}

// manifest describes the stored files a scene uses: every live image's
// file must be stored; a tombstone's may be gone.
func (s *Store) manifest(floor string, els []element, prev map[string]FileMeta) (map[string]FileMeta, []string, error) {
	live, dead := fileRefs(els)
	out := map[string]FileMeta{}
	var all []string
	for i, id := range append(live, dead...) {
		fi, err := os.Lstat(filepath.Join(s.dir(floor), "files", id))
		if err != nil || !fi.Mode().IsRegular() {
			if i < len(live) {
				return nil, nil, fmt.Errorf("%w: %s (upload it first)", ErrMissingFile, id)
			}
			continue
		}
		meta, ok := prev[id]
		if !ok {
			b, err := readLimited(filepath.Join(s.dir(floor), "files", id), MaxFile)
			if err != nil {
				return nil, nil, err
			}
			meta = FileMeta{MimeType: sniff(b), Size: fi.Size(), Created: s.nowMS()}
		}
		out[id] = meta
		all = append(all, id)
	}
	return out, all, nil
}

// SaveInput is a client's save: the scene JSON ({"elements","appState"}),
// the PNG it exported, the version it is based on and who saved.
type SaveInput struct {
	Base   int64
	Author string
	Scene  []byte
	Render []byte
}

// CheckRender checks a PNG render: a PNG of at most MaxRenderSide px a side
// and MaxRender bytes.
func CheckRender(b []byte) error {
	if len(b) > MaxRender {
		return fmt.Errorf("%w: render.png is at most %d bytes", ErrTooLarge, MaxRender)
	}
	if sniff(b) != "image/png" {
		return fmt.Errorf("%w: the render must be a PNG", ErrUnsupported)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("%w: the render cannot be read: %v", ErrInvalid, err)
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > MaxRenderSide || cfg.Height > MaxRenderSide {
		return fmt.Errorf("%w: render.png is %d x %d px, at most %d a side", ErrTooLarge, cfg.Width, cfg.Height, MaxRenderSide)
	}
	return nil
}

// Save stores a new version of a floor's board with its render, if in.Base
// is the current version (else a *ConflictError naming the current one).
func (s *Store) Save(floor string, in SaveInput) (Head, error) {
	raw, els, app, err := parseScene(in.Scene)
	if err != nil {
		return Head{}, err
	}
	if err := CheckRender(in.Render); err != nil {
		return Head{}, err
	}
	unlock, err := s.lock(floor)
	if err != nil {
		return Head{}, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return Head{}, err
	}
	if in.Base != h.Version {
		return h, &ConflictError{Current: h.Version}
	}
	prev, err := s.readSnapshot(floor, h.Version)
	if err != nil {
		return Head{}, err
	}
	if err := s.ensure(floor); err != nil {
		return Head{}, err
	}
	files, used, err := s.manifest(floor, els, prev.Files)
	if err != nil {
		return Head{}, err
	}
	scene := emptyScene()
	scene.Elements, scene.AppState = raw, app
	return s.commit(floor, h, scene, files, used, cleanAuthor(in.Author), commitOpts{render: in.Render})
}

// commitOpts is what a commit does beside the scene.
type commitOpts struct {
	render   []byte      // Save: the new version's render (nil: the current one stays, a pin)
	noRender bool        // Clear: the new version has none
	head     func(*Head) // more changes to the new head
}

// commit writes the next version: v/<n>.json, v/<n>.files.json and its
// render (renders/<n>.png), all new files that replace nothing current,
// then head.json, which makes them current. Only then are the versions past
// Keep, the renders the head does not name and unused files removed.
func (s *Store) commit(floor string, h Head, scene Scene, files map[string]FileMeta, used []string, author string, o commitOpts) (Head, error) {
	now := s.nowMS()
	n := h
	n.Version, n.Author, n.At = h.Version+1, author, now
	switch {
	case o.render != nil:
		n.RenderVersion, n.Render, n.StalePins = n.Version, true, []StalePin{}
	case o.noRender:
		n.RenderVersion, n.Render, n.StalePins = n.Version, false, []StalePin{}
	}
	if o.head != nil {
		o.head(&n)
	}
	if len(n.StalePins) > maxStalePins {
		n.StalePins = slices.Clone(n.StalePins[len(n.StalePins)-maxStalePins:])
	}
	n.Retained = append(slices.Clone(h.Retained), Retained{Version: n.Version, Author: author, At: now})
	var gone []int64
	if len(n.Retained) > Keep {
		for _, r := range n.Retained[:len(n.Retained)-Keep] {
			gone = append(gone, r.Version)
		}
		n.Retained = slices.Clone(n.Retained[len(n.Retained)-Keep:])
	}
	head, err := json.Marshal(n)
	if err != nil {
		return Head{}, err
	}
	if len(head) > maxHead {
		return Head{}, fmt.Errorf("%w: the board's head would be %d bytes", ErrTooLarge, len(head))
	}
	if used == nil {
		used = []string{}
	}
	sn := Snapshot{Schema: 1, Floor: floor, Version: n.Version, Author: author, At: now, ExcalidrawVersion: ExcalidrawVersion, Scene: scene, Files: files}
	if err := s.writeJSON(s.versionPath(floor, n.Version, ".json"), sn); err != nil {
		return Head{}, err
	}
	if err := s.writeJSON(s.versionPath(floor, n.Version, ".files.json"), used); err != nil {
		return Head{}, err
	}
	if o.render != nil {
		if err := writeFile(s.renderPath(floor, n.Version), o.render); err != nil {
			return Head{}, err
		}
	}
	if err := writeFile(filepath.Join(s.dir(floor), "head.json"), head); err != nil {
		return Head{}, err
	}
	for _, v := range gone {
		_ = os.Remove(s.versionPath(floor, v, ".json"))
		_ = os.Remove(s.versionPath(floor, v, ".files.json"))
	}
	s.collect(floor, n)
	return n, nil
}

// collect removes image files that no kept version uses and that are older
// than FileGrace (one may be on its way into a save), every render but the
// current one, and leftover temp files and versions no head names. When a
// kept version's files list cannot be read, no image file is removed.
func (s *Store) collect(floor string, h Head) {
	keep := map[string]bool{}
	versions := map[string]bool{}
	known := true
	for _, r := range h.Retained {
		versions[strconv.FormatInt(r.Version, 10)+".json"] = true
		versions[strconv.FormatInt(r.Version, 10)+".files.json"] = true
		var ids []string
		if err := readJSON(s.versionPath(floor, r.Version, ".files.json"), &ids, maxUses); err != nil {
			known = false
			continue
		}
		for _, f := range ids {
			keep[f] = true
		}
	}
	cutoff := s.Now().Add(-s.FileGrace)
	dir := filepath.Join(s.dir(floor), "files")
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		fi, err := e.Info()
		if !known || err != nil || keep[e.Name()] || fi.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
	vdir := filepath.Join(s.dir(floor), "v")
	ents, _ = os.ReadDir(vdir)
	for _, e := range ents {
		if versions[e.Name()] {
			continue
		}
		if fi, err := e.Info(); err == nil && fi.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(vdir, e.Name()))
		}
	}
	// Renders are written under the floor's lock only: any but the head's is
	// an old one or a failed commit's.
	current := ""
	if h.Render {
		current = strconv.FormatInt(h.RenderVersion, 10) + ".png"
	}
	rdir := filepath.Join(s.dir(floor), "renders")
	ents, _ = os.ReadDir(rdir)
	for _, e := range ents {
		if e.Name() != current {
			_ = os.Remove(filepath.Join(rdir, e.Name()))
		}
	}
}

// Clear starts a floor's board over: a new version in which every element
// is a tombstone (an open client reconciles the deletes; older tombstones
// are dropped) and no render. The versions before stay in the history.
func (s *Store) Clear(floor, author string) (Head, error) {
	unlock, err := s.lock(floor)
	if err != nil {
		return Head{}, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return Head{}, err
	}
	prev, err := s.readSnapshot(floor, h.Version)
	if err != nil {
		return Head{}, err
	}
	if err := s.ensure(floor); err != nil {
		return Head{}, err
	}
	now := s.nowMS()
	scene := emptyScene()
	scene.AppState = prev.Scene.AppState
	for _, raw := range prev.Scene.Elements {
		var e element
		if json.Unmarshal(raw, &e) != nil || e.IsDeleted {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		m["isDeleted"] = json.RawMessage("true")
		m["version"] = json.RawMessage(strconv.FormatInt(e.Version+1, 10))
		m["versionNonce"] = json.RawMessage(strconv.FormatInt(rand31(), 10))
		m["updated"] = json.RawMessage(strconv.FormatInt(now, 10))
		b, err := json.Marshal(m)
		if err != nil {
			return Head{}, err
		}
		scene.Elements = append(scene.Elements, b)
	}
	return s.commit(floor, h, scene, map[string]FileMeta{}, nil, cleanAuthor(author), commitOpts{noRender: true})
}

// PinResult is what a pin did.
type PinResult struct {
	Head     Head
	Elements []json.RawMessage // the elements it appended
	Repeated bool              // a request id seen before: nothing new was pinned
}

// Pin appends an agent's image or note to a floor's board as a new version.
// The render goes stale: the pin is listed in Head.StalePins until a client
// saves the board again with a fresh render.
func (s *Store) Pin(floor string, p Pin) (PinResult, error) {
	author := cleanAuthor(p.Author)
	if len(p.RequestID) > 128 {
		return PinResult{}, fmt.Errorf("%w: a request id is at most 128 bytes", ErrInvalid)
	}
	var note string
	var cfg image.Config
	var fileID string
	switch {
	case len(p.Image) > 0 && p.Note != "":
		return PinResult{}, fmt.Errorf("%w: pin an image or a note, not both", ErrInvalid)
	case len(p.Image) > 0:
		var err error
		if _, cfg, err = checkImage(p.Image); err != nil {
			return PinResult{}, err
		}
		fileID = Hash(p.Image)
	default:
		var err error
		if note, err = cleanNote(p.Note); err != nil {
			return PinResult{}, err
		}
	}
	unlock, err := s.lock(floor)
	if err != nil {
		return PinResult{}, err
	}
	defer unlock()
	h, err := s.readHead(floor)
	if err != nil {
		return PinResult{}, err
	}
	prev, err := s.readSnapshot(floor, h.Version)
	if err != nil {
		return PinResult{}, err
	}
	if p.RequestID != "" {
		for _, r := range h.Requests {
			if r.ID == p.RequestID {
				return PinResult{Head: h, Repeated: true, Elements: elementsByID(prev.Scene.Elements, r.Elements)}, nil
			}
		}
	}
	if err := s.ensure(floor); err != nil {
		return PinResult{}, err
	}
	els := make([]element, 0, len(prev.Scene.Elements))
	for _, raw := range prev.Scene.Elements {
		var e element
		if json.Unmarshal(raw, &e) == nil {
			els = append(els, e)
		}
	}
	if len(els)+1 > MaxElements {
		return PinResult{}, fmt.Errorf("%w: the board has %d elements", ErrTooLarge, len(els))
	}
	index, err := AppendIndex(lastIndex(els))
	if err != nil {
		return PinResult{}, err
	}
	now := s.nowMS()
	x, y := pinSpot(els)
	id := newID()
	tag := Tag{Author: author, Kind: PinKindTag, RequestID: p.RequestID, At: now}
	stale := StalePin{ID: id, Author: author, Version: h.Version + 1, At: now}
	files := prev.Files
	var el []byte
	if fileID != "" {
		if _, err := s.putFile(floor, fileID, p.Image); err != nil {
			return PinResult{}, err
		}
		if _, ok := files[fileID]; !ok {
			files = cloneFiles(files)
			files[fileID] = FileMeta{MimeType: sniff(p.Image), Size: int64(len(p.Image)), Created: now}
		}
		w, hh := fitPin(cfg.Width, cfg.Height)
		el, err = json.Marshal(newImage(id, index, x, y, w, hh, fileID, tag, now))
		stale.Kind, stale.File = PinImage, fileID
	} else {
		el, err = json.Marshal(newText(id, index, x, y, note, tag, now))
		stale.Kind, stale.Note = PinNote, excerpt(note)
	}
	if err != nil {
		return PinResult{}, err
	}
	scene := prev.Scene
	scene.Elements = append(slices.Clone(prev.Scene.Elements), el)
	all := append(els, element{Type: "image", FileID: &fileID})
	_, used, err := s.manifest(floor, all, files)
	if err != nil {
		return PinResult{}, err
	}
	n, err := s.commit(floor, h, scene, keepOnly(files, used), used, author, commitOpts{head: func(n *Head) {
		n.StalePins = append(slices.Clone(h.StalePins), stale)
		if p.RequestID != "" {
			n.Requests = append(slices.Clone(h.Requests), pinRequest{ID: p.RequestID, Elements: []string{id}, Version: n.Version})
			if len(n.Requests) > maxRequests {
				n.Requests = n.Requests[len(n.Requests)-maxRequests:]
			}
		}
	}})
	if err != nil {
		return PinResult{}, err
	}
	return PinResult{Head: n, Elements: []json.RawMessage{el}}, nil
}

func cloneFiles(m map[string]FileMeta) map[string]FileMeta {
	out := make(map[string]FileMeta, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	return out
}

func keepOnly(m map[string]FileMeta, ids []string) map[string]FileMeta {
	out := make(map[string]FileMeta, len(ids))
	for _, id := range ids {
		if v, ok := m[id]; ok {
			out[id] = v
		}
	}
	return out
}

func elementsByID(raws []json.RawMessage, ids []string) []json.RawMessage {
	var out []json.RawMessage
	for _, raw := range raws {
		var e struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &e) == nil && slices.Contains(ids, e.ID) {
			out = append(out, raw)
		}
	}
	return out
}

func excerpt(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > 140 {
		return string(r[:139]) + "…"
	}
	return s
}
