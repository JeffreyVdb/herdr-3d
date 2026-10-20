// Run from the repository root:
//
//	go run docs/research/transcript-screenshot-bench/thumbs.go /private/corpus
//	go run docs/research/transcript-screenshot-bench/thumbs.go serve [-legacy] [-addr 127.0.0.1:0] /private/corpus
//
// The corpus is capture.mjs's directory: images/ (originals), thumbs/ (the
// previews the bridge served) and capture-results.json. Inputs must be
// private local files; only aggregate measurements are printed. The new
// previews are written to <corpus>/policy/ (0600, for browser.mjs) and the
// cache directories are made under $TMPDIR and removed.
//
// The first form measures the preview policy (#125): bytes of the previews
// before and after, the PNG-keeping threshold, the encoders alone, and
// imgcache.Cache's paths (memory hit, derived disk hit, original disk hit
// that converts, fully cold). serve answers the full-app scenario
// (app.mjs): GET /thumb?hash= and /full?hash= with transcript.image's ack
// data, from an imgcache.Cache (-legacy: the code before #125, previews
// kept only in memory), and /reset?bridge=cold|restart, /stats[?clear=1].
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "serve" {
		serve(os.Args[2:])
		return
	}
	if len(os.Args) != 2 {
		fail("usage: thumbs.go /private/corpus | thumbs.go serve [-legacy] [-addr host:port] /private/corpus")
	}
	measure(os.Args[1])
}

func fail(msg string, a ...any) {
	fmt.Fprintf(os.Stderr, msg+"\n", a...)
	os.Exit(2)
}

// --- the corpus ---

type ref struct {
	Hash       string `json:"hash"`
	SourceMime string `json:"sourceMime"`
	ThumbMime  string `json:"thumbMime"`
	Bytes      int    `json:"bytes"`
}

// source is what a ref's preview is cut from: its original, or (captures
// keep at most 30 originals) the served preview standing in for it, which
// is then its own image with its own hash.
type source struct {
	ref
	data     []byte
	hash     string // imgcache.Hash(data)
	original bool
	served   []byte // the preview the bridge served (thumbs/)
}

func loadCorpus(dir string) []source {
	var refs []ref
	b, err := os.ReadFile(filepath.Join(dir, "capture-results.json"))
	if err == nil {
		err = json.Unmarshal(b, &refs)
	}
	if err != nil {
		fail("%s/capture-results.json: %v", dir, err)
	}
	var out []source
	for _, r := range refs {
		s := source{ref: r}
		s.served, _ = os.ReadFile(filepath.Join(dir, "thumbs", r.Hash+".png"))
		if orig, err := os.ReadFile(filepath.Join(dir, "images", r.Hash+".png")); err == nil {
			s.data, s.original = orig, true
		} else {
			s.data = s.served
		}
		if len(s.data) == 0 {
			continue
		}
		s.hash = imgcache.Hash(s.data)
		out = append(out, s)
	}
	if len(out) == 0 {
		fail("%s: no images", dir)
	}
	return out
}

// --- the code before #125 ---

// legacyThumb is imgcache.MakeThumb before #125: JPEG stays JPEG q82,
// everything else is PNG at BestSpeed.
func legacyThumb(b []byte) (imgcache.Thumb, error) {
	src, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return imgcache.Thumb{}, err
	}
	out := resize(src)
	var buf bytes.Buffer
	if imgcache.Sniff(b) == imgcache.JPEG {
		err = jpeg.Encode(&buf, flatten(out), &jpeg.Options{Quality: 82})
		return imgcache.Thumb{Mime: imgcache.JPEG, Width: out.Bounds().Dx(), Height: out.Bounds().Dy(), Data: buf.Bytes()}, err
	}
	err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, out)
	return imgcache.Thumb{Mime: imgcache.PNG, Width: out.Bounds().Dx(), Height: out.Bounds().Dy(), Data: buf.Bytes()}, err
}

// resize is MakeThumb's: at most ThumbSide px, CatmullRom.
func resize(src image.Image) image.Image {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	side := imgcache.ThumbSide
	if w <= side && h <= side {
		return src
	}
	tw, th := side, max(1, (h*side+w/2)/w)
	if h > w {
		tw, th = max(1, (w*side+h/2)/h), side
	}
	dst := image.NewNRGBA(image.Rect(0, 0, tw, th))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	return dst
}

func flatten(img image.Image) image.Image {
	if o, ok := img.(interface{ Opaque() bool }); ok && o.Opaque() {
		return img
	}
	dst := image.NewRGBA(img.Bounds())
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, img.Bounds().Min, draw.Over)
	return dst
}

// --- measure ---

type stat struct {
	Variant  string  `json:"variant"`
	Images   int     `json:"images"`
	Bytes    int     `json:"bytes,omitempty"`
	MedianMS float64 `json:"median_ms"`
	P95MS    float64 `json:"p95_ms"`
}

func stats(variant string, n, bytes int, ms []float64) stat {
	sort.Float64s(ms)
	return stat{variant, n, bytes, round(ms[len(ms)/2]), round(ms[int(float64(len(ms)-1)*.95)])}
}

func round(x float64) float64 { return float64(int(x*1000+.5)) / 1000 }

func since(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

const reps = 3 // measured passes, after one unmeasured

func measure(dir string) {
	corpus := loadCorpus(dir)
	var withOrig []source
	for _, s := range corpus {
		if s.original {
			withOrig = append(withOrig, s)
		}
	}
	emit := func(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }

	// Bytes: every preview before (as served) and after (the new policy cut
	// from the original; a preview without its original stays as served).
	type group struct{ Before, After, Images, PNGAfter int }
	groups := map[string]*group{}
	var before, after int
	var ratios []float64
	type pair struct{ png, jpeg int }
	var pairs []pair
	// The new previews, for browser.mjs: <corpus>/policy/<ref hash>, private.
	pdir := filepath.Join(dir, "policy")
	if err := os.MkdirAll(pdir, 0o700); err != nil {
		fail("%v", err)
	}
	for _, s := range corpus {
		g := groups[s.SourceMime]
		if g == nil {
			g = &group{}
			groups[s.SourceMime] = g
		}
		now := s.served
		if s.original {
			th, err := imgcache.MakeThumb(s.data)
			if err != nil {
				fail("MakeThumb: %v", err)
			}
			now = th.Data
			if err := os.WriteFile(filepath.Join(pdir, s.Hash), th.Data, 0o600); err != nil {
				fail("%v", err)
			}
			if th.Mime == imgcache.PNG {
				g.PNGAfter++
			}
			if s.SourceMime != imgcache.JPEG {
				px, _, _ := image.Decode(bytes.NewReader(s.served))
				var p, j bytes.Buffer
				_ = png.Encode(&p, px)
				_ = jpeg.Encode(&j, px, &jpeg.Options{Quality: 82})
				pairs = append(pairs, pair{p.Len(), j.Len()})
				ratios = append(ratios, float64(p.Len())/float64(j.Len()))
			}
		}
		g.Before += len(s.served)
		g.After += len(now)
		g.Images++
		before += len(s.served)
		after += len(now)
	}
	sort.Float64s(ratios)
	emit(map[string]any{"previews": len(corpus), "originals": len(withOrig), "before_bytes": before, "after_bytes": after,
		"reduction_pct": round(100 * (1 - float64(after)/float64(before))), "by_source": groups})
	if len(ratios) > 0 {
		emit(map[string]any{"png_default_over_jpeg": map[string]float64{"min": round(ratios[0]), "median": round(ratios[len(ratios)/2]), "max": round(ratios[len(ratios)-1])}})
		// What other thresholds would have kept as PNG, and the total then.
		for _, k := range []float64{1.5, 2, 3, 4, 5, 6} {
			total, kept := before, 0
			for _, s := range corpus {
				if s.original && s.SourceMime != imgcache.JPEG {
					total -= len(s.served)
				} else if s.original {
					th, _ := imgcache.MakeThumb(s.data)
					total += len(th.Data) - len(s.served)
				}
			}
			for _, p := range pairs {
				if float64(p.png) <= k*float64(p.jpeg) {
					total += p.png
					kept++
				} else {
					total += p.jpeg
				}
			}
			emit(map[string]any{"keep_png_at_most_x_jpeg": k, "kept_png": kept, "of": len(pairs), "reduction_pct": round(100 * (1 - float64(total)/float64(before)))})
		}
	}

	// Conversion of each original, before and after #125.
	for _, v := range []struct {
		name string
		cut  func([]byte) (imgcache.Thumb, error)
	}{{"legacy MakeThumb (decode+resize+encode)", legacyThumb}, {"new MakeThumb (decode+resize+encode)", imgcache.MakeThumb}} {
		var ms []float64
		total := 0
		for _, s := range withOrig {
			for rep := range reps + 1 {
				t := time.Now()
				th, err := v.cut(s.data)
				if err != nil {
					fail("%s: %v", v.name, err)
				}
				if rep > 0 {
					ms = append(ms, since(t))
				} else {
					total += len(th.Data)
				}
			}
		}
		emit(stats(v.name, len(withOrig), total, ms))
	}

	// The encoders alone, on the previews' pixels (PNG, GIF, WebP sources).
	for _, v := range []string{"png-speed", "png-default", "png-best", "jpeg-q82"} {
		var ms []float64
		total, n := 0, 0
		for _, s := range withOrig {
			if s.SourceMime == imgcache.JPEG {
				continue
			}
			px := resize(must(image.Decode(bytes.NewReader(s.data))))
			for rep := range reps + 1 {
				var buf bytes.Buffer
				t := time.Now()
				switch v {
				case "png-speed":
					_ = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, px)
				case "png-default":
					_ = png.Encode(&buf, px)
				case "png-best":
					_ = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, px)
				case "jpeg-q82":
					_ = jpeg.Encode(&buf, px, &jpeg.Options{Quality: 82})
				}
				if rep > 0 {
					ms = append(ms, since(t))
				} else {
					total += buf.Len()
				}
			}
			n++
		}
		if n > 0 {
			emit(stats(v+" (encode only)", n, total, ms))
		}
	}

	// imgcache.Cache's paths, per image (every image a new Cache: no warm
	// neighbour). The disk is the page cache's: a cold disk read is slower.
	tmp, err := os.MkdirTemp("", "h3d-thumb-bench-")
	if err != nil {
		fail("%v", err)
	}
	defer os.RemoveAll(tmp)
	paths := map[string][]float64{}
	for _, s := range corpus {
		load := func() ([]byte, error) { return s.data, nil }
		for rep := range reps + 1 {
			cdir := filepath.Join(tmp, fmt.Sprint(rep))
			_ = os.RemoveAll(cdir)
			c, _ := imgcache.New(imgcache.Config{Dir: cdir})
			t := time.Now()
			if _, err := c.Thumb(s.hash, load); err != nil {
				fail("cold: %v", err)
			}
			cold := since(t)
			t = time.Now()
			_, _ = c.Thumb(s.hash, load)
			mem := since(t)
			c, _ = imgcache.New(imgcache.Config{Dir: cdir}) // a restart
			t = time.Now()
			_, _ = c.Thumb(s.hash, nil)
			disk := since(t)
			_ = os.RemoveAll(filepath.Join(cdir, "t")) // the derived previews gone, the original kept
			c, _ = imgcache.New(imgcache.Config{Dir: cdir})
			t = time.Now()
			if _, err := c.Thumb(s.hash, nil); err != nil {
				fail("original disk: %v", err)
			}
			orig := since(t)
			if rep > 0 {
				paths["memory hit"] = append(paths["memory hit"], mem)
				paths["derived disk hit (restart)"] = append(paths["derived disk hit (restart)"], disk)
				paths["original disk hit, converts"] = append(paths["original disk hit, converts"], orig)
				paths["fully cold (load, hash, store, convert)"] = append(paths["fully cold (load, hash, store, convert)"], cold)
			}
		}
	}
	for _, k := range []string{"memory hit", "derived disk hit (restart)", "original disk hit, converts", "fully cold (load, hash, store, convert)"} {
		emit(stats("Cache.Thumb: "+k, len(corpus), 0, paths[k]))
	}
}

func must[T any](v T, _ string, err error) T {
	if err != nil {
		fail("%v", err)
	}
	return v
}

// --- serve ---

type server struct {
	legacy bool
	byRef  map[string]source
	tmp    string

	mu    sync.Mutex
	cache *imgcache.Cache
	gen   int
	// legacy: previews in memory only, two cut at a time, one per hash.
	mem   map[string]imgcache.Thumb
	slots chan struct{}
	wait  map[string]chan struct{}

	reqs    int
	bytes   int
	thumbMS []float64
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	legacy := fs.Bool("legacy", false, "the code before #125: previews in memory only, PNG at BestSpeed")
	addr := fs.String("addr", "127.0.0.1:0", "listen address")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		fail("usage: thumbs.go serve [-legacy] [-addr host:port] /private/corpus")
	}
	s := &server{legacy: *legacy, byRef: map[string]source{}}
	for _, src := range loadCorpus(fs.Arg(0)) {
		s.byRef[src.Hash] = src
	}
	var err error
	if s.tmp, err = os.MkdirTemp("", "h3d-thumb-serve-"); err != nil {
		fail("%v", err)
	}
	defer os.RemoveAll(s.tmp)
	s.reset("cold")
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fail("%v", err)
	}
	fmt.Printf("listening %s\n", ln.Addr())
	mux := http.NewServeMux()
	mux.HandleFunc("/thumb", func(w http.ResponseWriter, r *http.Request) { s.image(w, r, proto.ImageThumb) })
	mux.HandleFunc("/full", func(w http.ResponseWriter, r *http.Request) { s.image(w, r, proto.ImageFull) })
	mux.HandleFunc("/reset", func(w http.ResponseWriter, r *http.Request) {
		if err := s.reset(r.URL.Query().Get("bridge")); err != nil {
			http.Error(w, err.Error(), 400)
		}
	})
	// /stats: what was served since the last /stats?clear=1 (or reset).
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		out := map[string]any{"requests": s.reqs, "bytes": s.bytes}
		if len(s.thumbMS) > 0 {
			ms := slices.Clone(s.thumbMS)
			out["thumb_ms"] = stats("", len(ms), 0, ms)
		}
		if r.URL.Query().Get("clear") == "1" {
			s.reqs, s.bytes, s.thumbMS = 0, 0, nil
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	_ = http.Serve(ln, mux)
}

// reset: "cold" is a new bridge with an empty cache directory, "restart" a
// new one on the same directory (the memory lost, the disk kept).
func (s *server) reset(mode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch mode {
	case "cold":
		s.gen++
	case "restart":
	default:
		return errors.New("bridge=cold|restart")
	}
	dir := filepath.Join(s.tmp, fmt.Sprint(s.gen))
	c, err := imgcache.New(imgcache.Config{Dir: dir})
	if err != nil {
		return err
	}
	s.cache, s.mem, s.wait = c, map[string]imgcache.Thumb{}, map[string]chan struct{}{}
	s.slots = make(chan struct{}, 2)
	s.reqs, s.bytes, s.thumbMS = 0, 0, nil
	return nil
}

func (s *server) image(w http.ResponseWriter, r *http.Request, size string) {
	src, ok := s.byRef[r.URL.Query().Get("hash")]
	if !ok {
		http.Error(w, "no such image", 404)
		return
	}
	t0 := time.Now()
	var th imgcache.Thumb
	var err error
	if size == proto.ImageFull {
		info, _ := imgcache.Inspect(src.data)
		th = imgcache.Thumb{Mime: info.Mime, Width: info.Width, Height: info.Height, Data: src.data}
	} else if s.legacy {
		th, err = s.legacyThumb(src)
	} else {
		s.mu.Lock()
		c := s.cache
		s.mu.Unlock()
		th, err = c.Thumb(src.hash, func() ([]byte, error) { return src.data, nil })
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ms := since(t0)
	s.mu.Lock()
	s.reqs++
	s.bytes += len(th.Data)
	if size == proto.ImageThumb {
		s.thumbMS = append(s.thumbMS, ms)
	}
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(proto.TranscriptImageResult{Mime: th.Mime, Width: th.Width, Height: th.Height, Bytes: len(th.Data),
		Size: size, Data: base64.StdEncoding.EncodeToString(th.Data)})
}

func (s *server) legacyThumb(src source) (imgcache.Thumb, error) {
	for {
		s.mu.Lock()
		if th, ok := s.mem[src.hash]; ok {
			s.mu.Unlock()
			return th, nil
		}
		if ch, ok := s.wait[src.hash]; ok {
			s.mu.Unlock()
			<-ch
			continue
		}
		ch := make(chan struct{})
		s.wait[src.hash] = ch
		slots, mem, wait := s.slots, s.mem, s.wait
		s.mu.Unlock()
		slots <- struct{}{}
		th, err := legacyThumb(src.data)
		<-slots
		s.mu.Lock()
		if err == nil {
			mem[src.hash] = th
		}
		delete(wait, src.hash)
		s.mu.Unlock()
		close(ch)
		return th, err
	}
}
