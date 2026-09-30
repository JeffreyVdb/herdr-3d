package transcript

import (
	"encoding/base64"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Images are the transcripts' images (M16 phase 2): the content-addressed
// cache they are filed in and the roots a path image may be read under.
// One per bridge, shared by every Log; a nil *Images still decodes and
// hashes inline images (nothing is kept, so none can be fetched later) and
// serves no path.
type Images struct {
	// Cache holds the images' bytes and thumbnails (nil: nothing is kept).
	Cache *imgcache.Cache
	// Roots are the directories a path image may be under, for every
	// transcript: Drop Zone's data, ~/.codex/generated_images. A worker's
	// own cwd is added per log (WithCwd).
	Roots []string
}

// Option configures Follow and Read.
type Option func(*Log)

// WithImages sets the images a log resolves its ImageRefs with.
func WithImages(im *Images) Option { return func(l *Log) { l.env.images = im } }

// WithCwd adds the worker's own directory to the roots of the log's path
// images.
func WithCwd(cwd string) Option { return func(l *Log) { l.env.cwd = cwd } }

// imgSrc is where an image's bytes are: base64 in a line, or a path.
type imgSrc struct {
	// off, n and j find an inline image again: the line at off, n bytes
	// long, and the j-th image the parse of that line made.
	off      int64
	n, j     int
	b64      string
	declared string // the mime the transcript says (checked against the bytes)
	path     string // Source path: the file (or, for an inline one that was a URL, the text)
	external bool   // a URL: never fetched
	// roots is a path image's extra roots: the exact file a Codex
	// view_image call named.
	roots []string
}

// imgRef is an image a contribution puts in an item: its (unresolved) ref
// and where the bytes are.
type imgRef struct {
	ref *proto.ImageRef
	src *imgSrc
}

// parseCtx makes the image refs of one line.
type parseCtx struct {
	off int64
	n   int
	j   int
}

func newParseCtx(off int64, line []byte) *parseCtx { return &parseCtx{off: off, n: len(line)} }

// inline is an image whose base64 is in the line. A mime the transcript
// gives is only a hint: the bytes are sniffed.
func (pc *parseCtx) inline(declared, b64, origin, kind string) imgRef {
	src := &imgSrc{off: pc.off, n: pc.n, j: pc.j, b64: b64, declared: declared}
	pc.j++
	return imgRef{ref: &proto.ImageRef{Source: proto.ImageInline, Origin: origin, Kind: kind}, src: src}
}

// path is an image a path names.
func (pc *parseCtx) path(path, origin, kind string, roots ...string) imgRef {
	src := &imgSrc{off: pc.off, n: pc.n, j: pc.j, path: path, roots: roots}
	pc.j++
	return imgRef{ref: &proto.ImageRef{Source: proto.ImagePath, Path: path, Origin: origin, Kind: kind}, src: src}
}

// external is an image a URL names (Claude's url source, a remote Codex
// image_url): it is text for the view, never fetched.
func (pc *parseCtx) external(url, origin, kind string) imgRef {
	r := pc.path(url, origin, kind)
	r.src.external = true
	return r
}

// dataURL splits "data:image/png;base64,XXXX".
func dataURL(s string) (mime, b64 string, ok bool) {
	rest, found := strings.CutPrefix(s, "data:")
	if !found {
		return "", "", false
	}
	head, data, found := strings.Cut(rest, ",")
	if !found {
		return "", "", false
	}
	parts := strings.Split(head, ";")
	if len(parts) < 2 || parts[len(parts)-1] != "base64" {
		return "", "", false
	}
	return parts[0], data, true
}

// imageEnv is what a Log resolves its refs with.
type imageEnv struct {
	images *Images
	cwd    string

	mu      sync.Mutex
	memo    map[memoKey]memoVal  // inline images by place in the file
	paths   map[pathKey]memoVal  // path images by file identity
	hashLoc map[string]hashPlace // where to read an image's bytes again
}

type memoKey struct {
	off int64
	j   int
}

type pathKey struct {
	real  string
	size  int64
	mtime int64
}

// memoVal is what is known of one image.
type memoVal struct {
	hash          string
	mime          string
	bytes         int64
	width, height int
	unavailable   bool
	reason        string
}

type hashPlace struct {
	off  int64
	n    int
	j    int
	path string
	// roots are the extra roots a path image was read under.
	roots []string
}

// maxMemo bounds the remembered images of a log (a session with more starts
// over: they are decoded again when asked).
const maxMemo = 50_000

func newImageEnv() *imageEnv {
	return &imageEnv{memo: map[memoKey]memoVal{}, paths: map[pathKey]memoVal{}, hashLoc: map[string]hashPlace{}}
}

func (e *imageEnv) roots(extra []string) []string {
	var rs []string
	if e.images != nil {
		rs = append(rs, e.images.Roots...)
	}
	if e.cwd != "" {
		rs = append(rs, e.cwd)
	}
	return append(rs, extra...)
}

func (e *imageEnv) cache() *imgcache.Cache {
	if e.images == nil {
		return nil
	}
	return e.images.Cache
}

// resolve fills ref from its source.
func (e *imageEnv) resolve(ref *proto.ImageRef, src *imgSrc) {
	var v memoVal
	switch {
	case src == nil:
		v = memoVal{unavailable: true, reason: imgcache.ReasonInvalid}
	case src.external:
		v = memoVal{unavailable: true, reason: imgcache.ReasonNotAllowed}
	case ref.Source == proto.ImagePath:
		v = e.resolvePath(src)
	default:
		v = e.resolveInline(src)
	}
	ref.Hash, ref.Mime, ref.Bytes, ref.Width, ref.Height = v.hash, v.mime, v.bytes, v.width, v.height
	ref.Unavailable, ref.Reason = v.unavailable, v.reason
	if v.unavailable {
		ref.Hash = ""
	}
	if src != nil && ref.Source == proto.ImagePath && e.images != nil && !v.unavailable && ref.Origin == proto.OriginAgent &&
		ref.Kind == "" {
		ref.Kind = proto.KindViewed
	}
	if ref.Source == proto.ImagePath && !v.unavailable && e.underGenerated(src.path) {
		ref.Kind = proto.KindGenerated
	}
}

func (e *imageEnv) underGenerated(path string) bool {
	if e.images == nil {
		return false
	}
	for _, r := range e.images.Roots {
		if filepath.Base(r) == "generated_images" && (path == r || strings.HasPrefix(path, r+string(filepath.Separator))) {
			return true
		}
	}
	return false
}

func (e *imageEnv) resolveInline(src *imgSrc) memoVal {
	k := memoKey{src.off, src.j}
	e.mu.Lock()
	v, ok := e.memo[k]
	e.mu.Unlock()
	if ok {
		return v
	}
	data, err := decodeB64(src.b64)
	switch {
	case err != nil || len(data) == 0:
		v = memoVal{unavailable: true, reason: imgcache.ReasonInvalid}
	case len(data) > imgcache.MaxImage:
		v = memoVal{unavailable: true, reason: imgcache.ReasonTooLarge}
	default:
		hash := imgcache.Hash(data)
		info, ierr := imgcache.Inspect(data)
		v = memoVal{hash: hash, mime: info.Mime, bytes: int64(len(data)), width: info.Width, height: info.Height}
		if ierr == nil {
			if c := e.cache(); c != nil {
				c.Put(hash, data)
			}
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.memo) >= maxMemo {
		e.memo = map[memoKey]memoVal{}
	}
	e.memo[k] = v
	if v.hash != "" && v.mime != imgcache.Binary {
		if _, ok := e.hashLoc[v.hash]; !ok {
			e.hashLoc[v.hash] = hashPlace{off: src.off, n: src.n, j: src.j}
		}
	}
	return v
}

func (e *imageEnv) resolvePath(src *imgSrc) memoVal {
	roots := e.roots(src.roots)
	pi, err := imgcache.CheckPath(src.path, roots)
	if err != nil {
		return memoVal{unavailable: true, reason: imgcache.Reason(err)}
	}
	k := pathKey{pi.Real, pi.Size, pi.MTime}
	e.mu.Lock()
	v, ok := e.paths[k]
	e.mu.Unlock()
	if ok {
		e.mu.Lock()
		if !v.unavailable {
			e.notePath(v.hash, src)
		}
		e.mu.Unlock()
		return v
	}
	_, data, info, err := imgcache.LoadPath(src.path, roots)
	if err != nil {
		v = memoVal{unavailable: true, reason: imgcache.Reason(err)}
	} else {
		hash := imgcache.Hash(data)
		v = memoVal{hash: hash, mime: info.Mime, bytes: int64(len(data)), width: info.Width, height: info.Height}
		if c := e.cache(); c != nil {
			c.Put(hash, data)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.paths) >= maxMemo {
		e.paths = map[pathKey]memoVal{}
	}
	e.paths[k] = v
	if !v.unavailable {
		e.notePath(v.hash, src)
	}
	return v
}

// notePath remembers where to read a path image again (under mu).
func (e *imageEnv) notePath(hash string, src *imgSrc) {
	if _, ok := e.hashLoc[hash]; !ok {
		e.hashLoc[hash] = hashPlace{path: src.path, roots: src.roots}
	}
}

func decodeB64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if strings.ContainsAny(s, "\r\n\t ") {
		s = strings.Map(func(r rune) rune {
			if r == '\r' || r == '\n' || r == '\t' || r == ' ' {
				return -1
			}
			return r
		}, s)
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("not base64")
}

// ErrNoImage is an image hash the log has no place for.
var ErrNoImage = errors.New("no such image in the transcript")

// Image returns the bytes of the image with hash that this log's items
// showed: from the cache, else read again from the transcript line (or the
// file) it came from. The bytes are checked against the hash.
func (l *Log) Image(hash string) ([]byte, error) {
	if !imgcache.ValidHash(hash) {
		return nil, ErrNoImage
	}
	e := l.env
	if c := e.cache(); c != nil {
		if b, ok := c.Get(hash); ok {
			return b, nil
		}
	}
	e.mu.Lock()
	place, ok := e.hashLoc[hash]
	e.mu.Unlock()
	if !ok {
		return nil, ErrNoImage
	}
	var data []byte
	switch {
	case place.path != "":
		_, b, _, err := imgcache.LoadPath(place.path, e.roots(place.roots))
		if err != nil {
			return nil, err
		}
		data = b
	default:
		cs, err := l.parseAt(place.off, place.n)
		if err != nil {
			return nil, err
		}
		var src *imgSrc
		for i := range cs {
			for _, ir := range cs[i].imgs {
				if ir.src.j == place.j {
					src = ir.src
				}
			}
		}
		if src == nil {
			return nil, ErrNoImage
		}
		if data, err = decodeB64(src.b64); err != nil {
			return nil, err
		}
	}
	if imgcache.Hash(data) != hash {
		return nil, ErrNoImage // the file changed under the hash
	}
	if c := e.cache(); c != nil {
		c.Put(hash, data)
	}
	return data, nil
}

// Thumb returns the thumbnail of the image with hash.
func (l *Log) Thumb(hash string) (imgcache.Thumb, error) {
	c := l.env.cache()
	if c == nil {
		b, err := l.Image(hash)
		if err != nil {
			return imgcache.Thumb{}, err
		}
		return imgcache.MakeThumb(b)
	}
	return c.Thumb(hash, func() ([]byte, error) { return l.Image(hash) })
}

// Knows reports whether an item of this log showed an image with hash.
func (l *Log) Knows(hash string) bool {
	l.env.mu.Lock()
	defer l.env.mu.Unlock()
	_, ok := l.env.hashLoc[hash]
	return ok
}
