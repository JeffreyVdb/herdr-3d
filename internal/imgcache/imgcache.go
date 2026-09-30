// Package imgcache is the bridge's content-addressed cache of the images
// in agent transcripts (M16 phase 2), and what it does to them: sniff the
// type, read the size, cut a thumbnail. Pure Go, no cgo.
//
// An image is keyed by the sha256 of its bytes. The cache holds at most
// MaxMemory bytes in memory (least recently used out first) and,
// optionally, a directory of 0600 files in a 0700 directory, so bytes that
// left memory come back without reading the transcript again. What is in
// it is private (screenshots, pasted images): it never leaves the bridge
// except to a connection that was sent the hash (internal/server).
package imgcache

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif" // registers the decoder for image.DecodeConfig / Decode
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registers the decoder for image.DecodeConfig / Decode
)

// Limits.
const (
	// MaxMemory is the default bound on the bytes the memory cache holds.
	MaxMemory = 64 << 20
	// MaxDisk is the default bound on the bytes the disk cache keeps.
	MaxDisk = 512 << 20
	// MaxImage is the largest image the bridge takes (an inline image, a
	// file): 25 MiB.
	MaxImage = 25 << 20
	// ThumbSide is the longest side of a thumbnail, in px.
	ThumbSide = 480
	// maxPixels bounds what is decoded to cut a thumbnail.
	maxPixels = 100_000_000
	// decodeSlots is how many thumbnails are cut at once.
	decodeSlots = 2
)

// The image types the bridge serves. Anything else is "binary".
const (
	PNG    = "image/png"
	JPEG   = "image/jpeg"
	GIF    = "image/gif"
	WEBP   = "image/webp"
	Binary = "binary"
)

// Errors.
var (
	ErrNotImage = errors.New("not a png, jpeg, gif or webp image")
	ErrTooLarge = errors.New("image too large")
)

// Hash is the key of image bytes: their sha256, in hex.
func Hash(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ValidHash reports whether s can be a Hash.
func ValidHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Sniff is the image type of the first bytes of b ("" when it is not one
// the bridge serves): looked at, not trusted from a header or a name.
func Sniff(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return PNG
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return JPEG
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return GIF
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return WEBP
	}
	return ""
}

// Info is what is known of an image without decoding it.
type Info struct {
	Mime          string
	Width, Height int
}

// Inspect sniffs b and reads its dimensions from its header. An image the
// standard decoders cannot read the header of still has its Mime (Width
// and Height 0).
func Inspect(b []byte) (Info, error) {
	m := Sniff(b)
	if m == "" {
		return Info{Mime: Binary}, ErrNotImage
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return Info{Mime: m}, nil
	}
	return Info{Mime: m, Width: cfg.Width, Height: cfg.Height}, nil
}

// Thumb is an image cut down to at most ThumbSide px on its longest side.
type Thumb struct {
	Mime          string
	Width, Height int
	Data          []byte
}

// MakeThumb decodes b and cuts a thumbnail: JPEG stays JPEG, everything
// else (a GIF's first frame, WebP, PNG) is PNG. An image already within
// ThumbSide is re-encoded unchanged in size (its bytes may be far smaller).
func MakeThumb(b []byte) (Thumb, error) {
	m := Sniff(b)
	if m == "" {
		return Thumb{}, ErrNotImage
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return Thumb{}, fmt.Errorf("image header: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return Thumb{}, fmt.Errorf("%w: %d x %d px", ErrTooLarge, cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return Thumb{}, fmt.Errorf("image decode: %w", err)
	}
	w, h := fit(src.Bounds().Dx(), src.Bounds().Dy(), ThumbSide)
	var out image.Image = src
	if w != src.Bounds().Dx() || h != src.Bounds().Dy() {
		dst := image.NewNRGBA(image.Rect(0, 0, w, h))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
		out = dst
	}
	var buf bytes.Buffer
	if m == JPEG {
		if err := jpeg.Encode(&buf, flatten(out), &jpeg.Options{Quality: 82}); err != nil {
			return Thumb{}, err
		}
		return Thumb{Mime: JPEG, Width: w, Height: h, Data: buf.Bytes()}, nil
	}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, out); err != nil {
		return Thumb{}, err
	}
	return Thumb{Mime: PNG, Width: w, Height: h, Data: buf.Bytes()}, nil
}

// fit scales w x h so its longest side is at most side (never up).
func fit(w, h, side int) (int, int) {
	if w <= side && h <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, (h*side+w/2)/w)
	}
	return max(1, (w*side+h/2)/h), side
}

// flatten puts an image on white (JPEG has no alpha).
func flatten(img image.Image) image.Image {
	if o, ok := img.(interface{ Opaque() bool }); ok && o.Opaque() {
		return img
	}
	dst := image.NewRGBA(img.Bounds())
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, img.Bounds().Min, draw.Over)
	return dst
}

// Config configures a Cache.
type Config struct {
	// MaxBytes bounds the memory (default MaxMemory).
	MaxBytes int64
	// Dir, if set, is the disk cache's directory (made 0700); MaxDiskBytes
	// bounds it (default MaxDisk).
	Dir          string
	MaxDiskBytes int64
}

// DefaultDir is the disk cache's default place: $XDG_CACHE_HOME/herdr-world/img
// (~/.cache/herdr-world/img). "" when neither is known.
func DefaultDir() string {
	if x := os.Getenv("XDG_CACHE_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, "herdr-world", "img")
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return filepath.Join(h, ".cache", "herdr-world", "img")
	}
	return ""
}

type memEntry struct {
	key  string
	data []byte
	meta Thumb // thumbnails: mime and size (Data is data)
}

// Cache is the content-addressed image store.
type Cache struct {
	max     int64
	dir     string
	maxDisk int64

	mu    sync.Mutex
	lru   *list.List // of *memEntry, most recent first
	items map[string]*list.Element
	size  int64

	dmu      sync.Mutex
	diskSize int64
	diskInit bool

	slots chan struct{}
	tmu   sync.Mutex // one thumbnail per hash is cut at a time
	tw    map[string]*thumbWait
}

type thumbWait struct {
	done chan struct{}
	t    Thumb
	err  error
}

// New makes a Cache. A Dir that cannot be made is an error.
func New(cfg Config) (*Cache, error) {
	c := &Cache{max: cfg.MaxBytes, dir: cfg.Dir, maxDisk: cfg.MaxDiskBytes, lru: list.New(),
		items: map[string]*list.Element{}, slots: make(chan struct{}, decodeSlots), tw: map[string]*thumbWait{}}
	if c.max <= 0 {
		c.max = MaxMemory
	}
	if c.maxDisk <= 0 {
		c.maxDisk = MaxDisk
	}
	if c.dir != "" {
		if err := os.MkdirAll(c.dir, 0o700); err != nil {
			return nil, err
		}
		// MkdirAll leaves an existing directory as it was.
		if err := os.Chmod(c.dir, 0o700); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Bytes is how many bytes the memory cache holds now.
func (c *Cache) Bytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.size
}

// Len is how many entries (images and thumbnails) the memory cache holds.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

func (c *Cache) memGet(key string) (*memEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.lru.MoveToFront(el)
	return el.Value.(*memEntry), true
}

func (c *Cache) memPut(e *memEntry) {
	n := int64(len(e.data))
	if n > c.max {
		return // larger than the whole cache: never held
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[e.key]; ok {
		c.size -= int64(len(el.Value.(*memEntry).data))
		c.lru.Remove(el)
	}
	c.items[e.key] = c.lru.PushFront(e)
	c.size += n
	for c.size > c.max {
		el := c.lru.Back()
		if el == nil {
			break
		}
		old := el.Value.(*memEntry)
		c.lru.Remove(el)
		delete(c.items, old.key)
		c.size -= int64(len(old.data))
	}
}

// Put files the bytes of an image under hash (which the caller computed
// with Hash). Bytes over MaxImage are not kept.
func (c *Cache) Put(hash string, data []byte) {
	if !ValidHash(hash) || len(data) == 0 || len(data) > MaxImage {
		return
	}
	c.memPut(&memEntry{key: hash, data: data})
	c.diskPut(hash, data)
}

// Get returns the bytes filed under hash: from memory, else from the disk
// cache (checked against the hash; a file that does not match is removed).
func (c *Cache) Get(hash string) ([]byte, bool) {
	if !ValidHash(hash) {
		return nil, false
	}
	if e, ok := c.memGet(hash); ok {
		return e.data, true
	}
	data, ok := c.diskGet(hash)
	if !ok {
		return nil, false
	}
	c.memPut(&memEntry{key: hash, data: data})
	return data, true
}

// Thumb returns the thumbnail of the image under hash, cut from load()'s
// bytes if there is none yet. load is called when the thumbnail is not
// cached and the image is not either; it returns the image's bytes.
func (c *Cache) Thumb(hash string, load func() ([]byte, error)) (Thumb, error) {
	key := "t:" + hash
	if e, ok := c.memGet(key); ok {
		return Thumb{Mime: e.meta.Mime, Width: e.meta.Width, Height: e.meta.Height, Data: e.data}, nil
	}
	c.tmu.Lock()
	if w, ok := c.tw[key]; ok {
		c.tmu.Unlock()
		<-w.done
		return w.t, w.err
	}
	w := &thumbWait{done: make(chan struct{})}
	c.tw[key] = w
	c.tmu.Unlock()
	defer func() {
		c.tmu.Lock()
		delete(c.tw, key)
		c.tmu.Unlock()
		close(w.done)
	}()
	if e, ok := c.memGet(key); ok {
		w.t = Thumb{Mime: e.meta.Mime, Width: e.meta.Width, Height: e.meta.Height, Data: e.data}
		return w.t, nil
	}
	data, ok := c.Get(hash)
	if !ok {
		var err error
		if data, err = load(); err != nil {
			w.err = err
			return Thumb{}, err
		}
		if Hash(data) != hash {
			w.err = errors.New("image changed")
			return Thumb{}, w.err
		}
		c.Put(hash, data)
	}
	c.slots <- struct{}{}
	t, err := MakeThumb(data)
	<-c.slots
	if err != nil {
		w.err = err
		return Thumb{}, err
	}
	c.memPut(&memEntry{key: key, data: t.Data, meta: Thumb{Mime: t.Mime, Width: t.Width, Height: t.Height}})
	w.t = t
	return t, nil
}

// --- disk ---

func (c *Cache) path(hash string) string { return filepath.Join(c.dir, hash) }

func (c *Cache) diskGet(hash string) ([]byte, bool) {
	if c.dir == "" {
		return nil, false
	}
	f, err := os.OpenFile(c.path(hash), os.O_RDONLY, 0)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > MaxImage {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxImage+1))
	if err != nil || Hash(b) != hash {
		_ = os.Remove(c.path(hash)) // damaged or replaced: not what it says
		return nil, false
	}
	now := time.Now()
	_ = os.Chtimes(c.path(hash), now, now) // recently used
	return b, true
}

func (c *Cache) diskPut(hash string, data []byte) {
	if c.dir == "" {
		return
	}
	c.dmu.Lock()
	defer c.dmu.Unlock()
	if _, err := os.Stat(c.path(hash)); err == nil {
		return
	}
	c.initDisk()
	f, err := os.CreateTemp(c.dir, ".tmp-*")
	if err != nil {
		return
	}
	name := f.Name()
	// CreateTemp makes 0600 files; be explicit, the mode is the point.
	_ = f.Chmod(0o600)
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(name, c.path(hash)) != nil {
		_ = os.Remove(name)
		return
	}
	c.diskSize += int64(len(data))
	c.trimDisk()
}

// initDisk counts what is there and removes leftovers (under dmu).
func (c *Cache) initDisk() {
	if c.diskInit {
		return
	}
	c.diskInit = true
	ents, _ := os.ReadDir(c.dir)
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if strings.HasPrefix(e.Name(), ".tmp-") {
			_ = os.Remove(filepath.Join(c.dir, e.Name()))
			continue
		}
		c.diskSize += fi.Size()
	}
}

// trimDisk removes the least recently used files past the bound (under dmu).
func (c *Cache) trimDisk() {
	if c.diskSize <= c.maxDisk {
		return
	}
	ents, _ := os.ReadDir(c.dir)
	type file struct {
		name string
		size int64
		mt   int64
	}
	var files []file
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() || !ValidHash(e.Name()) {
			continue
		}
		files = append(files, file{e.Name(), fi.Size(), fi.ModTime().UnixNano()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mt < files[j].mt })
	for _, f := range files {
		if c.diskSize <= c.maxDisk {
			break
		}
		if os.Remove(filepath.Join(c.dir, f.name)) == nil {
			c.diskSize -= f.size
		}
	}
}

// Dir is the disk cache's directory ("": none).
func (c *Cache) Dir() string { return c.dir }

// ReadFile reads a regular file of at most MaxImage bytes without
// following a symlink at its end (callers resolve the path first).
func ReadFile(path string) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	if fi.Size() > MaxImage {
		return nil, ErrTooLarge
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxImage+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxImage {
		return nil, ErrTooLarge
	}
	return b, nil
}
