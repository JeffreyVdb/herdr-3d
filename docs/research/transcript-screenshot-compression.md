# Transcript screenshot compression and rendering

2026-10-20. Source investigation for screenshot-heavy transcripts, using Julie-Houben on
`jeff-claude-dev` as the intended measured workload. This note separates observed implementation from proposed
optimizations; source inspection alone does not identify the cause of the reported slowdown. Live measurements and recommendations follow the source findings below.
Ticket: [#125](https://github.com/JeffreyVdb/herdr-3d/issues/125).

## What the current code does

| Stage | Current implementation | Consequence to measure |
| --- | --- | --- |
| Transcript discovery | Inline image resolution decodes base64, hashes the complete original, inspects its header, and caches the original. It memoizes by transcript offset/image position. [images.go:215](../../internal/transcript/images.go#L215) | Initial transcript work can be expensive before any thumbnail is requested. Recompressing outgoing thumbnails does not eliminate this work. |
| Thumbnail generation | Fully decodes the original, resizes with CatmullRom to a maximum 480 px side, then encodes JPEG originals as quality 82 JPEG; PNG, GIF and **WebP originals become PNG with `png.BestSpeed`**. [imgcache.go:134](../../internal/imgcache/imgcache.go#L134) | There is a specific compression seam with room to compare stronger PNG and WebP. Source decode/resize costs remain even if output encoding changes. |
| Bridge cache | Original bytes and thumbnail bytes share a 64 MiB memory LRU; original bytes have an optional 512 MiB disk cache. Thumbnail entries use `t:<hash>` and are stored only in memory. Two thumbnail conversions run concurrently and requests for the same hash share work. [limits](../../internal/imgcache/imgcache.go#L38), [Thumb](../../internal/imgcache/imgcache.go#L349) | Restart or memory eviction can repeat decode/resize/encode despite a warm original disk cache. Measure memory hits, disk-original hits and completely cold loads separately. |
| Delivery | `transcript.image` returns image bytes as base64 inside its result, both for thumbnails and full originals. [transcript.go:1107](../../internal/server/transcript.go#L1107) | Encoded image size affects delivery and JSON/string work. Base64 is `4 × ceil(bytes / 3)` characters before the JSON envelope. [RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648.html#section-4) |
| Browser cache | Four requests run at once. At most 240 thumbnails / 40 MiB of encoded blobs are retained per feed; full images have a separate three-image cache. Base64 conversion uses `atob`, a byte-copy loop, Blob and object URL. [imageFeed.ts:34](../../game/src/laptop/imageFeed.ts#L34), [conversion](../../game/src/laptop/imageFeed.ts#L46), [eviction](../../game/src/laptop/imageFeed.ts#L346) | Compressed blob limits are not decoded bitmap limits. Smaller outputs can reduce transfer/string/blob costs without reducing raster dimensions. |
| Browser display | Images already load through IntersectionObserver with a 240 px margin, reserve aspect ratio, and set `decoding="async"`. Typical maximum display side is 420 px alone or 240 px in a strip. [transcriptImages.ts:74](../../game/src/laptop/transcriptImages.ts#L74), [observer](../../game/src/laptop/transcriptImages.ts#L177) | Existing lazy loading means image count alone does not imply every thumbnail is initially downloaded. Measure actual requests and decoded images. |
| Timeline DOM | `set` creates every loaded row; `apply` renders changed rows and calls `regroup`. `regroup` examines every row and undoes/rebuilds image-only runs after each change. [transcriptRender.ts:859](../../game/src/laptop/transcriptRender.ts#L859), [regroup](../../game/src/laptop/transcriptRender.ts#L905) | DOM work and scrolling can remain expensive with warm thumbnails. Profile separately from network and encode time. |

## Codec choices

These are candidates for the **derived preview**, preserving the original for the lightbox and downloads.

| Candidate | Why test it | Tradeoff / implementation requirement |
| --- | --- | --- |
| PNG default/best compression | Keeps the existing pure-Go encoder and exact preview pixels; compare with the unusually fast current setting. | More encode CPU can worsen cold loads. Go exposes speed/compression choices; benchmark total conversion as well as encoding alone. [Go PNG API](https://pkg.go.dev/image/png#CompressionLevel) |
| Lossless WebP | Preserves text and hard UI edges. WebP supports lossless, lossy and alpha; this is a sensible baseline for screenshots. | Do not assume published average savings apply to these images. The existing `x/image/webp` dependency is a **decoder**, not an encoder. A production encoder needs an explicit dependency/build decision because imgcache documents pure Go/no cgo. [WebP overview](https://developers.google.com/speed/webp), [Go decoder API](https://pkg.go.dev/golang.org/x/image/webp), [imgcache contract](../../internal/imgcache/imgcache.go#L1) |
| Near-lossless / lossy WebP | Can trade a small visible difference for fewer bytes in already-resized previews. | Check small text, thin lines, dark backgrounds and transparency visually. Near-lossless preprocesses pixel values; lossless quality settings change compression effort rather than fidelity. Include effort in the recorded settings. [cwebp options](https://developers.google.com/speed/webp/docs/cwebp) |
| AVIF | Useful comparison if it wins enough bytes at acceptable latency. | Measure encode **and browser decode** on the deployed browser/hardware. It requires another encoder and variant handling; AVIF currently is not an accepted source type in imgcache's sniff/decode path. General AVIF improvements are not proof of an advantage for small text-heavy previews. [AVIF tooling](https://web.dev/articles/compress-images-avif), [current supported types](../../internal/imgcache/imgcache.go#L55) |

Keep the comparison at identical resized pixels before comparing codecs. Otherwise a different resize filter or
dimension can masquerade as better compression. For previews, judge readability at actual display scale as well as
pixel metrics. An engineering preference is lossless first, then visually reviewed near-lossless/lossy alternatives
if their measured advantage justifies the fidelity tradeoff.

## Improvements beyond compression

1. **Cache derived thumbnails on disk with a versioned variant key.** Include original hash, dimensions, codec,
   quality/effort and algorithm version. Keep the existing private file modes and authorization gate. This targets
   repeated CPU work after memory eviction/restart, and permits a more expensive encoder to pay its cost once.
   Current thumbnail caching is confined to memory. [Thumb](../../internal/imgcache/imgcache.go#L349)
2. **Choose preview dimensions deliberately.** A 480 × 480 RGBA8 bitmap contains 921,600 pixel bytes (~0.88 MiB);
   240 such bitmaps would contain ~211 MiB, before browser overhead. This is an arithmetic illustration, **not an
   observed browser memory measurement**. A smaller encoded WebP of the same dimensions does not change that pixel
   count. Compare 240/480 variants with actual CSS size and device pixel ratio, retaining a sharper variant where
   needed. The image standard distinguishes encoded media from the bitmap decoded for presentation.
   [HTML image decoding](https://html.spec.whatwg.org/multipage/images.html#decoding-images)
3. **Profile timeline maintenance with warm images.** Incremental regrouping or windowing can target measured DOM
   costs. `content-visibility: auto` can skip offscreen layout/paint, but does not remove rows, stop JavaScript loops,
   or replace lazy loading. Validate scroll anchoring, find-in-page, focus, and screenshot-strip merging before using
   it. [Current regrouping](../../game/src/laptop/transcriptRender.ts#L905),
   [Chrome guidance](https://web.dev/articles/content-visibility)
4. **Consider binary delivery after measuring base64/JSON costs.** A binary WebSocket payload or authorized image
   endpoint can avoid base64 expansion and the main-thread byte-copy loop. This is a separate protocol change; retain
   the rule that only hashes admitted to the connection/watch can be served. Do not replace that check with a
   publicly fetchable content hash. [Current authorization and response](../../internal/server/transcript.go#L1107),
   [browser conversion](../../game/src/laptop/imageFeed.ts#L46)

`decoding="async"` is already present; it is a scheduling hint, not a promise to reduce total decode time or memory.
[HTML specification](https://html.spec.whatwg.org/multipage/images.html#decoding-images)

## Benchmark and ticket acceptance evidence

Use a representative sample of Julie-Houben images, including text/UI screenshots, photos if present, alpha, large
dimensions, and repeated hashes. Keep screenshots and transcript content private; publish aggregate measurements and
reproducible commands/settings rather than real image bytes.

- Record source count, unique hashes, formats, dimensions and total source bytes. Distinguish missing images.
- Compare production `MakeThumb` with PNG default/best, lossless WebP, near-lossless WebP and one AVIF setting at the
  same dimensions. Report total bytes, median/p95 conversion time, settings, tool versions and CPU model.
- Separately time decode, resize and encode. Time a memory hit, an original disk hit requiring conversion, and a fully
  cold load; do not describe one-image warm codec timing as end-to-end transcript performance.
- In a browser, compare opening, scrolling back through screenshot-heavy history and receiving updates. Record image
  requests, payload bytes, time to visible thumbnails, long tasks/frame gaps and browser process memory. Repeat with
  warm thumbnails to isolate timeline work. Include DPR/browser version and controlled throttling if used.
- Require preserved lightbox originals, no new duplicate requests, correct cache invalidation, bounded conversion
  concurrency, private cache files, and unchanged hash admission. Select the codec using measured total latency and
  readability, not file size alone.

No application code was changed by this source investigation.

## Measured workload and results

Read-only capture on 2026-10-20 from Julie-Houben on the office bridge (`v1.60.0`), using the real
`transcript.watch`, `transcript.images`, and `transcript.image` commands. The captured page contained 425 timeline
items and 40 unique available image hashes: 20 PNG and 20 JPEG. PNG originals included 516 × 918,
2048 × 1069 and portrait images up to 1152 × 2048. This is one screenshot/photo-heavy workload; it is not a
representative survey of all transcript content. Originals and transcript text remain in a private temporary directory.

The 40 production thumbnails totaled **4,030,365 bytes**: **3,524,188 PNG bytes** and **506,177 JPEG bytes**.
Their actual JSON acknowledgement frames totaled **5,378,830 bytes**. In contrast, the watch acknowledgement was
185,070 bytes and the complete image-reference list was 11,194 bytes. Image bytes are fetched separately;
the transcript acknowledgement does not carry all those screenshots.

Through the live SSH connection, the initial watch took 433 ms and the list 72 ms. A serial pass over all 40
already-generated previews took 2.20 seconds; median second-request latency was 64.5 ms for PNG and 29.4 ms for
JPEG. These are observed request/response times including the tunnel, server and transfer, **not** isolated encode
measurements. They do not establish how long opening the app takes, since the app requests four previews concurrently
and only as needed. No cache was cleared and no service was restarted.

### Codec comparison at identical production preview pixels

All values below replace **only the 20 PNG previews**, retaining the existing JPEG previews. Sizes are decimal MB.
ImageMagick 7.1.2-34 on an Intel Core i7-10750H (Linux); three process invocations per image, median per image, then
median/p95 across the 20 PNGs. Timings include process startup and decoding an existing preview, exclude original
image decode/resize, and are exploratory local measurements rather than production encoder predictions.

| Preview encoding | PNG group MB | PNG byte reduction | Whole 40-preview byte reduction | Median / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Current Go PNG BestSpeed | 3.524 | baseline | baseline | see Go measurement below |
| ImageMagick PNG level 6 | 3.214 | 8.8% | 7.7% | 90 / 111 |
| ImageMagick PNG level 9 | 3.117 | 11.6% | 10.1% | 448 / 588 |
| Lossless WebP, method 4, quality 100 | 2.245 | 36.3% | 31.7% | 596 / 1276 |
| Near-lossless WebP, method 1, quality 75 | 1.788 | 49.3% | 43.1% | 187 / 255 |
| Lossy WebP, method 4, quality 82 | 0.299 | 91.5% | 80.0% | 36 / 49 |
| AVIF, speed 6, 4:4:4, quality 55 | 0.198 | 94.4% | 82.5% | 234 / 335 |
| JPEG quality 82, 4:2:0, white background | 0.488 | 86.2% | 75.3% | 17 / 20 |

The AVIF toolchain uses ImageMagick's HEIC/AVIF delegate. Equal quality numbers across formats are not equivalent
fidelity. Lossy candidates require readability/alpha review; they are not pixel-preserving substitutes. A spot check
of one WebP q82 preview retained the text but showed visible changes in textured backgrounds. Full originals must stay
unchanged and accessible through the lightbox.

Decoded pixel signatures matched for **all 20 quality-100 lossless WebPs**. The quality-75 "lossless" command changed
pixels in all 20, so it is correctly classified above as **near-lossless**: ImageMagick sets `near_lossless` from
`quality`, even with the lossless flag. [ImageMagick WebP options](https://imagemagick.org/webp/)

A separate Go 1.27 benchmark directly called the production `imgcache.MakeThumb` on all 20 original PNGs (four passes,
first omitted). Median/p95 full conversion was **172 / 228 ms per original**. On decoded production preview pixels,
Go's current PNG encode alone took **12.7 / 18.4 ms**; default PNG **17.6 / 24.4 ms**, best PNG **497 / 768 ms**,
and JPEG q82 **5.7 / 8.4 ms**. Default/best PNG saved only 6.6%/10.2% in Go. Go JPEG produced 505,983 bytes,
an **85.6% reduction** in the PNG group and **75.0% across the whole set**. These encode-only timings exclude original
decode and resize; the full production timing shows why changing the encoder alone cannot remove all cold CPU cost.
This also makes JPEG a useful dependency-free baseline for opaque photographic previews. A production JPEG path must
flatten alpha deliberately and retain a suitable lossless preview for content requiring exact pixels.

### Browser probe and practical limits

The accompanying browser harness mounts the actual `mountTranscript`, `Thumbs`, and `ImageFeed` modules in Chromium,
with the same captured items and local image responses. It scrolls through the whole timeline and back, recording
requests, frame gaps and long tasks. This isolates transcript work from the 3D scene and the office network. The
"without images" control removes image refs while retaining text; its shorter document means total traversal time is
**not** directly comparable. All codec comparisons retain the same document height and pixels dimensions.

Initial exploratory runs showed frame gaps during image-heavy traversal and long tasks on opening even with image
refs removed. This establishes that reducing bytes does not eliminate every opening/rendering cost. It does **not**
identify `Timeline.regroup` as the cause. See the final isolated browser results below; a full application profile on
the user's hardware remains an implementation acceptance check.

Chromium **149.0.7827.55**, 1200 × 900 viewport, DPR 1, no artificial CPU/network throttling: a repeated current-PNG
run after module warm-up mounted the view in **49.8 ms**, loaded all 40 images while traversing 12,056 px of history,
and had a **33.8 ms maximum/p95 frame gap** during the traversal. The repeated WebP q82 run mounted in **48.8 ms**,
loaded the same 40 images at the same document height, and had a **16.8 ms maximum/p95 gap**. AVIF q55 was **16.9 ms**.
The fully warm return traversal had maximum gaps of **20.1 ms PNG / 17.6 ms WebP / 17.7 ms AVIF**. The small number of
animation-frame samples makes these exploratory signals, not stable population percentiles or an FPS guarantee.

The without-image control still recorded a 64 ms opening long task. Long-task durations around opening include the
benchmark's own argument/data setup and forced layout as well as application work, so they do not attribute a specific
renderer bottleneck. The script reports them for subsequent profiling, not as isolated `regroup` CPU measurements.
The first PNG mount in a new page took about 123 ms; the repeated mount took about 50 ms, another reason not to compare
an initial PNG run to a later codec run without warm-up. Sanitized raw measurements are in
[results.json](transcript-screenshot-bench/results.json).

### Recommended ticket scope

1. Prototype compact derived previews against both WebP and the existing pure-Go JPEG q82 baseline. Preserve originals,
   alpha where required and a lossless option for text/annotations. Select by measured readability, total cold/warm
   latency and build constraints, not a fixed quality number. The sample supports a target of at least **70% fewer
   total preview bytes** for the visually approved lossy path; the measured lossless option saves about 32% overall.
2. Persist versioned derived previews in the existing private bounded cache so restarts and original-cache pressure
   do not force expensive source decode/resize again. Preserve hash admission, disk modes, limits and concurrency.
3. Add a screenshot-heavy performance scenario: cold/warm bridge cache, cold/warm client, concurrent image requests,
   scrolling and live updates. Measure before changing timeline regrouping/windowing or image delivery. Compression
   reduces bytes and string work; it does not reduce decoded dimensions or guarantee a proportional FPS gain.
4. Treat AVIF and binary delivery as follow-ups if their measured benefit justifies encoder/protocol complexity.
   In this sample AVIF q55 saves only another 102 KB across 20 previews relative to WebP q82 while encoding much slower;
   this is not an equal-fidelity comparison.

### Reproduction

Run from the repository root after `make setup`. The scripts deliberately write no screenshot/transcript content into
the repository. Use a private output directory and an existing SSH socket forward to the office bridge; do not clear
the running bridge's cache. The capture script reads the first image-list page (up to 1000 refs), captures every
available preview on that page, and fetches at most 30 originals. `.png` capture filenames may contain JPEG bytes;
all tools sniff the actual format. No source images, hashes or private transcript text are included in published results.

```sh
node docs/research/transcript-screenshot-bench/capture.mjs /private/office.sock WORKER_ID /private/corpus
python docs/research/transcript-screenshot-bench/codecs.py /private/corpus
go run docs/research/transcript-screenshot-bench/thumbs.go /private/corpus/images
portlease run --project herdr-3d --worktree . --name bench --service screenshot-bench -- \
  node docs/research/transcript-screenshot-bench/browser.mjs /private/corpus
```

The browser probe exercises already-local acknowledgements, excluding JSON transport parsing and network delay;
it must not be presented as a live bridge end-to-end speedup. Generalized harnesses and sanitized aggregate results
are in [transcript-screenshot-bench](transcript-screenshot-bench/).
