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
	"sync/atomic"
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
	// MaxThumbDisk is the default bound on the thumbnails the disk cache
	// keeps, apart from MaxDisk: some 2,000 at the #125 sample's 30 kB.
	MaxThumbDisk = 64 << 20
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

// How a thumbnail is encoded (#125, docs/decisions.md 2026-10-20). A change
// to any of these changes MakeThumb's bytes for the same image: bump
// thumbVersion too when the code changes them some other way, so the
// derived disk cache drops what the old one made.
const (
	thumbVersion = 1
	// jpegQuality is a JPEG thumbnail's quality.
	jpegQuality = 82
	// pngKeepPct: an opaque thumbnail of a PNG, GIF or WebP stays PNG when
	// its lossless bytes are at most this % of its JPEG bytes. Flat
	// interface and text screenshots keep exact edges for little more; a
	// photograph or a busy screenshot cut down (5 to 9 times the JPEG
	// bytes in the #125 sample) is JPEG.
	pngKeepPct = 200
	// pngLevel is the PNG thumbnails' compression: the default level is
	// some 6% smaller than BestSpeed for some 5 ms more, paid once now
	// that the thumbnail is kept on disk.
	pngLevel = png.DefaultCompression
)

// thumbVariant names the thumbnails MakeThumb makes: the disk cache keeps
// them in t/<thumbVariant>/ and removes every other variant.
var thumbVariant = fmt.Sprintf("v%d-%dpx-q%d-png%d-z%d", thumbVersion, ThumbSide, jpegQuality, pngKeepPct, -pngLevel)

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

// MakeThumb decodes b and cuts a thumbnail. A JPEG stays JPEG. Anything
// else (a GIF's first frame, WebP, PNG) is PNG when the thumbnail has
// transparency (kept, never put on a background), and otherwise JPEG
// unless the lossless PNG is at most pngKeepPct % of the JPEG's bytes. An
// image already within ThumbSide is re-encoded unchanged in size (its
// bytes may be far smaller).
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
	thumb := func(mime string, data []byte) (Thumb, error) {
		return Thumb{Mime: mime, Width: w, Height: h, Data: data}, nil
	}
	if m != JPEG && !opaque(out) && !opaque(src) {
		data, err := encodePNG(out, 0)
		if err != nil {
			return Thumb{}, err
		}
		return thumb(PNG, data)
	}
	var jbuf bytes.Buffer
	// flatten: an opaque image is as it is (a resize may round an edge's
	// alpha off 255).
	if err := jpeg.Encode(&jbuf, flatten(out), &jpeg.Options{Quality: jpegQuality}); err != nil {
		return Thumb{}, err
	}
	if m == JPEG {
		return thumb(JPEG, jbuf.Bytes())
	}
	data, err := encodePNG(out, jbuf.Len()*pngKeepPct/100)
	switch {
	case err == nil:
		return thumb(PNG, data)
	case errors.Is(err, errOverBudget):
		return thumb(JPEG, jbuf.Bytes())
	}
	return Thumb{}, err
}

// errOverBudget: a PNG grew past what it may be.
var errOverBudget = errors.New("png over budget")

// encodePNG is img as PNG at pngLevel; with budget > 0, errOverBudget as
// soon as it is longer than that (the encoder stops there).
func encodePNG(img image.Image, budget int) ([]byte, error) {
	w := &budgetWriter{budget: budget}
	if err := (&png.Encoder{CompressionLevel: pngLevel}).Encode(w, img); err != nil {
		return nil, err
	}
	return w.buf.Bytes(), nil
}

type budgetWriter struct {
	buf    bytes.Buffer
	budget int
}

func (w *budgetWriter) Write(p []byte) (int, error) {
	if w.budget > 0 && w.buf.Len()+len(p) > w.budget {
		return 0, errOverBudget
	}
	return w.buf.Write(p)
}

// opaque reports whether img says it has no transparency (an image that
// cannot say is taken as having some).
func opaque(img image.Image) bool {
	o, ok := img.(interface{ Opaque() bool })
	return ok && o.Opaque()
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
	if opaque(img) {
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
	// MaxThumbDiskBytes bounds the thumbnails kept under Dir (default
	// MaxThumbDisk).
	MaxThumbDiskBytes int64
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

	// The thumbnails' disk (t/<thumbVariant>/<hash>), as dmu and its two
	// for the images.
	maxThumbDisk   int64
	tdmu           sync.Mutex
	thumbDiskSize  int64
	thumbDiskInit  bool
	thumbDiskReads atomic.Int64 // tests: reads of a thumbnail file

	slots chan struct{}
	tmu   sync.Mutex // one thumbnail per hash is cut at a time
	tw    map[string]*thumbWait
	cut   func([]byte) (Thumb, error) // MakeThumb (tests count it)
}

type thumbWait struct {
	done chan struct{}
	t    Thumb
	err  error
}

// New makes a Cache. A Dir that cannot be made is an error.
func New(cfg Config) (*Cache, error) {
	c := &Cache{max: cfg.MaxBytes, dir: cfg.Dir, maxDisk: cfg.MaxDiskBytes, maxThumbDisk: cfg.MaxThumbDiskBytes, lru: list.New(),
		items: map[string]*list.Element{}, slots: make(chan struct{}, decodeSlots), tw: map[string]*thumbWait{}, cut: MakeThumb}
	if c.max <= 0 {
		c.max = MaxMemory
	}
	if c.maxDisk <= 0 {
		c.maxDisk = MaxDisk
	}
	if c.maxThumbDisk <= 0 {
		c.maxThumbDisk = MaxThumbDisk
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

// Thumb returns the thumbnail of the image under hash: from memory, else
// from the disk cache's thumbnails, else cut from the image's bytes. load
// is called when neither has the thumbnail and the cache does not have
// the image either; it returns the image's bytes. One hash is read or cut
// once however many ask at a time, and cutting waits for a decode slot.
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
	if t, ok := c.thumbDiskGet(hash); ok {
		c.memPut(&memEntry{key: key, data: t.Data, meta: Thumb{Mime: t.Mime, Width: t.Width, Height: t.Height}})
		w.t = t
		return t, nil
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
	t, err := c.cut(data)
	<-c.slots
	if err != nil {
		w.err = err
		return Thumb{}, err
	}
	c.memPut(&memEntry{key: key, data: t.Data, meta: Thumb{Mime: t.Mime, Width: t.Width, Height: t.Height}})
	c.thumbDiskPut(hash, t)
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

// --- thumbnails on disk (#125) ---
//
// A thumbnail does not hash to its image's name, so it is kept apart from
// the images: <dir>/t/<thumbVariant>/<hash>, under its own bound. A file
// is a header, then the thumbnail's bytes:
//
//	"h3dthumb" | format 1 | mime 'j' or 'p' | width, height (uint16 BE)
//	| sha256(hash, thumbVariant, mime, width, height, bytes)
//
// The sum names the image and the variant: a damaged file, or one moved
// from another name or variant, is a miss, removed and cut again.

const (
	thumbMagic  = "h3dthumb"
	thumbHeader = len(thumbMagic) + 1 + 1 + 2 + 2 + sha256.Size
	// maxThumbFile bounds a thumbnail file's read (an RGBA PNG of
	// ThumbSide x ThumbSide is under 1 MiB).
	maxThumbFile = 4 << 20
)

func (c *Cache) thumbDir() string { return filepath.Join(c.dir, "t", thumbVariant) }

func thumbSum(hash string, mime byte, w, h int, data []byte) []byte {
	s := sha256.New()
	s.Write([]byte(hash))
	s.Write([]byte(thumbVariant))
	s.Write([]byte{0, mime, byte(w >> 8), byte(w), byte(h >> 8), byte(h)})
	s.Write(data)
	return s.Sum(nil)
}

var thumbMimes = map[byte]string{'j': JPEG, 'p': PNG}

func (c *Cache) thumbDiskGet(hash string) (Thumb, bool) {
	if c.dir == "" || !ValidHash(hash) {
		return Thumb{}, false
	}
	c.initThumbDisk()
	c.thumbDiskReads.Add(1)
	p := filepath.Join(c.thumbDir(), hash)
	f, err := os.OpenFile(p, os.O_RDONLY, 0)
	if err != nil {
		return Thumb{}, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return Thumb{}, false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxThumbFile+1))
	t, ok := parseThumb(hash, b)
	if err != nil || !ok {
		_ = os.Remove(p) // damaged or not this image's
		return Thumb{}, false
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now) // recently used
	return t, true
}

// parseThumb checks a thumbnail file of hash and returns its thumbnail.
func parseThumb(hash string, b []byte) (Thumb, bool) {
	if len(b) <= thumbHeader || len(b) > maxThumbFile || string(b[:len(thumbMagic)]) != thumbMagic || b[len(thumbMagic)] != 1 {
		return Thumb{}, false
	}
	h := b[len(thumbMagic)+1:]
	mime, ok := thumbMimes[h[0]]
	w, ht := int(h[1])<<8|int(h[2]), int(h[3])<<8|int(h[4])
	data := b[thumbHeader:]
	if !ok || w < 1 || ht < 1 || w > ThumbSide || ht > ThumbSide || Sniff(data) != mime ||
		!bytes.Equal(h[5:5+sha256.Size], thumbSum(hash, h[0], w, ht, data)) {
		return Thumb{}, false
	}
	return Thumb{Mime: mime, Width: w, Height: ht, Data: data}, true
}

func (c *Cache) thumbDiskPut(hash string, t Thumb) {
	if c.dir == "" || !ValidHash(hash) || t.Width > ThumbSide || t.Height > ThumbSide {
		return
	}
	var mime byte
	for k, m := range thumbMimes {
		if m == t.Mime {
			mime = k
		}
	}
	if mime == 0 || thumbHeader+len(t.Data) > maxThumbFile {
		return
	}
	c.initThumbDisk()
	c.tdmu.Lock()
	defer c.tdmu.Unlock()
	if mkPrivate(filepath.Join(c.dir, "t")) != nil || mkPrivate(c.thumbDir()) != nil {
		return
	}
	p := filepath.Join(c.thumbDir(), hash)
	if fi, err := os.Lstat(p); err == nil {
		c.thumbDiskSize -= fi.Size() // replaced (it was damaged)
	}
	f, err := os.CreateTemp(c.thumbDir(), ".tmp-*")
	if err != nil {
		return
	}
	name := f.Name()
	_ = f.Chmod(0o600)
	head := append([]byte(thumbMagic), 1, mime, byte(t.Width>>8), byte(t.Width), byte(t.Height>>8), byte(t.Height))
	head = append(head, thumbSum(hash, mime, t.Width, t.Height, t.Data)...)
	_, werr := f.Write(append(head, t.Data...))
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(name, p) != nil {
		_ = os.Remove(name)
		return
	}
	c.thumbDiskSize += int64(len(head) + len(t.Data))
	c.trimThumbDisk()
}

// mkPrivate makes dir 0700 (an existing one too).
func mkPrivate(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// initThumbDisk, once: removes the other variants under t/ and leftovers
// in this one, and counts what is there.
func (c *Cache) initThumbDisk() {
	c.tdmu.Lock()
	defer c.tdmu.Unlock()
	if c.thumbDiskInit {
		return
	}
	c.thumbDiskInit = true
	top := filepath.Join(c.dir, "t")
	ents, _ := os.ReadDir(top)
	for _, e := range ents {
		if e.Name() != thumbVariant || !e.IsDir() {
			_ = os.RemoveAll(filepath.Join(top, e.Name()))
		}
	}
	ents, _ = os.ReadDir(c.thumbDir())
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if !fi.Mode().IsRegular() || !ValidHash(e.Name()) {
			_ = os.RemoveAll(filepath.Join(c.thumbDir(), e.Name()))
			continue
		}
		c.thumbDiskSize += fi.Size()
	}
}

// trimThumbDisk removes the least recently used thumbnails past the bound
// (under tdmu), counting again what is there.
func (c *Cache) trimThumbDisk() {
	if c.thumbDiskSize <= c.maxThumbDisk {
		return
	}
	ents, _ := os.ReadDir(c.thumbDir())
	type file struct {
		name string
		size int64
		mt   int64
	}
	var files []file
	c.thumbDiskSize = 0
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil || !fi.Mode().IsRegular() || !ValidHash(e.Name()) {
			continue
		}
		files = append(files, file{e.Name(), fi.Size(), fi.ModTime().UnixNano()})
		c.thumbDiskSize += fi.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mt < files[j].mt })
	for _, f := range files {
		if c.thumbDiskSize <= c.maxThumbDisk {
			break
		}
		if os.Remove(filepath.Join(c.thumbDir(), f.name)) == nil {
			c.thumbDiskSize -= f.size
		}
	}
}

// Dir is the disk cache's directory ("": none).
func (c *Cache) Dir() string { return c.dir }
