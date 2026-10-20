# Transcript open latency and the empty first screen

2026-10-20. Why opening a worker's transcript can show an empty overlay for a second or more, including transcripts
with few or no images, which #125 (compact, persistently cached image previews) does not address. Read-only
investigation on `main` at `4d5c380`: Chromium 149.0.7827.55, Intel Core i7-10750H, Linux.
Ticket: [#126](https://github.com/JeffreyVdb/herdr-3d/issues/126).

**Finding:** in normal transcripts the bridge answers in tens to a few hundred milliseconds. Most of the wait is the
**client's first render**: the whole page's rows are built, then laid out in one main-thread task, which reached
1.7 s on a 6 MB Claude transcript in an isolated page with no 3D scene. Until that task ends, the view shows nothing,
or "No conversation yet.".

## What happens on open

| Stage | Current implementation | Consequence |
| --- | --- | --- |
| Watch | Sitting down starts `transcript.watch` with limit 200 ([TranscriptWatches.watch](../../game/src/laptop/transcriptWatches.ts#L197)). The overlay unhides, then the render module loads ([show](../../game/src/laptop/transcriptMode.ts#L469), [loadRenderer](../../game/src/laptop/transcriptMode.ts#L30)). | The module is a 140 kB / 43 kB gzip chunk in a production build. Until it loads, the overlay is empty. |
| Bridge log | The watch kicks the usage tracker. The tracker makes a `transcript.Log` for a watched worker only ([syncTranscript](../../internal/server/transcript.go#L951)). `Follow` indexes the whole JSONL from byte 0 ([build](../../internal/transcript/log.go#L188)). | A new watch rebuilds the index. That takes 30–150 ms for 3–30 MB files here. |
| First page | `Subscribe(200)` reads each page item's lines back from the file and parses them again ([items](../../internal/transcript/log.go#L463)). The limit counts visible items. Hidden ones come along. | Its cost tracks the **bytes of those lines**, not the item count. A page can carry several times more hidden rows than visible ones. |
| Mount | The view mounts with whatever items are there. Before the ack, that's none, so it shows "No conversation yet." ([tx-empty](../../game/src/laptop/transcriptRender.ts#L1100), [mounted](../../game/src/laptop/transcriptMode.ts#L645)). | Nothing tells "ack not here yet" from "empty". `TranscriptWatches.ready(id)` has the signal ([ready](../../game/src/laptop/transcriptWatches.ts#L141)). |
| First render | `setItems` builds every row of the page. `afterChange` then calls `stick(true)`, which sets `scrollTop = scrollHeight` ([setItems](../../game/src/laptop/transcriptRender.ts#L1308), [stick](../../game/src/laptop/transcriptRender.ts#L2441)). | Reading `scrollHeight` forces a synchronous style and layout of the whole timeline. The build and the layout are one long task. Nothing paints until it ends, including the 3D scene and any spinner driven by JavaScript. |

## Bridge measurements

[open.go](transcript-open-bench/open.go) times the production `transcript.Follow` → `Ready` → `Subscribe(200)` path.
It ran on 25 local transcripts (16 Claude, 9 Codex), three passes each; the passes agree to a few ms.

| Transcript | Index build | First page | Page JSON |
| --- | ---: | ---: | ---: |
| Claude, 4.5–8.7 MB | 33–80 ms | 24–57 ms | 390–770 kB |
| Claude, 10–30 MB | 82–148 ms | 16–183 ms | 260–665 kB |
| Codex, 3–6 MB | 26–43 ms | 35–63 ms | 330–925 kB |
| Codex, 17 MB | 101–105 ms | 141–142 ms | 64 kB |
| **Codex, 220 MB** | **1,244–1,256 ms** | **1,852–1,865 ms** | 196 kB |

[watch.mjs](transcript-open-bench/watch.mjs) timed real `transcript.watch` acks on the running local bridge. All five
workers acked in **13–47 ms** (113–467 kB, 138–710 items), on both a first and a repeated round. Those logs may have
been built already, for example by an open game client. This is the bridge's answer time on this host, not a cold
remote open. A remote bridge adds the transfer of a few hundred kB per ack.

The 220 MB Codex rollout is an outlier. Its `custom_tool_call_output` lines total 142 MB in 57 lines, the largest
14 MB, plus 74 MB of `item_completed` events. The first page re-reads and re-parses every such line it touches,
although a list item shows only a capped summary.

## Client measurements

[browser.mjs](transcript-open-bench/browser.mjs) mounts the real `mountTranscript` in headless Chromium (1200 × 900,
DPR 1) with no 3D scene and no network. It replays each first page that `open.go` captured and times `setItems` and
the first frame after it. Results, first pass (the second pass is within about ±30%):

| First page | Items | DOM elements | `setItems` | First frame | Long tasks |
| --- | ---: | ---: | ---: | ---: | --- |
| Claude, 14 files | 780–1,070 | 7.0k–43k | 172–1,114 ms | 256–1,715 ms, median ~510 ms | 2, up to 1.2 s |
| Claude, worst | 1,070 | 43,272 | 980–1,114 ms | 1,557–1,683 ms | 2, up to 1.2 s |
| Codex, 8 files | 68–603 | 0.4k–3.4k | 13–155 ms | 17–191 ms | 0–1, up to 271 ms |

[profile.mjs](transcript-open-bench/profile.mjs) profiled the worst page. **~1.5 s of 2.2 s is self-time in
`stick`**, which is the forced layout. Building the rows (`renderRow`, then `changesBlock` → `diffLines`) is
~0.2 s. `stick` is not the cause: the same layout would happen before the next frame anyway. It only makes the cost
synchronous and easy to attribute.

That page's DOM:

- About 37k of its 43k elements are diff-line cells: 9,320 `tx-dl` rows, each with two `tx-dn` cells and a `tx-dt`.
  They come from 157 changes blocks, rendered expanded by default (`data-changes="shown"`, #21).
- 871 rows are system rows, built and then hidden with `display: none`
  ([CSS](../../game/src/laptop/transcript.css#L536)).
- Of the page's 1,070 items, 870 are hidden: 538 notices and 333 unknown.

### Two experiments

[experiments.mjs](transcript-open-bench/experiments.mjs) measured the first frame on the same pages, after a warm-up
run:

| Page | Today | `.tx-item { content-visibility: auto; contain-intrinsic-size: auto 80px }` | Newest 150 items only |
| --- | ---: | ---: | ---: |
| 1,070 items | 1,715 ms | 303 ms | 89 ms |
| 973 items | 1,110 ms | 226 ms | 124 ms |
| 1,039 items | 748 ms | 185 ms | 27 ms |
| 877 items | 606 ms | 150 ms | 25 ms |
| 936 items | 484 ms | 242 ms | 44 ms |

Rendering the newest screenful first is the larger lever. `content-visibility` is cheap, but it still builds every
row. Neither experiment checked behaviour: scroll anchoring, staying at the bottom while sizes are estimates,
find-in-page, focus, and #125's screenshot-strip merging all need validation in the implementation.

The harness runs no WebGL scene. In the app, the render loop freezes for the same long task, so the perceived blank
time is likely at least these first-frame numbers.

## Recommendations (ticket scope)

1. **A loading state.**
   - Show a loading indicator from the moment the overlay unhides until the first rows have painted: module import,
     watch ack and first layout.
   - Show "No conversation yet." only after an ack with zero items. Pending and unavailable transcripts keep their own
     wording.
   - Animate with `transform` or `opacity` and make the render yield (point 2). Otherwise the animation freezes during
     the long task.
   - Respect `prefers-reduced-motion`. When a resync starts the view over, don't flash an empty state.
2. **Paint the newest rows first.**
   - On the first `setItems` and on a reset, render and stick to the newest screenful. Build older rows in yielding
     chunks of a few milliseconds above it, holding the scroll position the way the child view's `loadOlder` does
     ([loadOlder](../../game/src/laptop/transcriptRender.ts#L1263)).
   - Build hidden system rows only when they show, and diff lines only when their block is near the viewport.
     #21's default stays: diffs show, and the counts stay in the header.
   - `Timeline.regroup` ([regroup](../../game/src/laptop/transcriptRender.ts#L910)) must not turn into a
     whole-timeline pass per chunk.
3. **Bound the bridge outliers** (secondary).
   - Build a capped list item without re-reading and re-parsing whole multi-MB lines. For example, record what the
     summary needs at index time, and read full content only for `full` / `loadItem`.
   - Consider capping the hidden items a page carries.
   - Log the build wait, page read time and ack size per watch. Today only an empty ack is logged
     ([transcript watch acked empty](../../internal/server/transcript.go#L703)).

Acceptance:

- On the worst page above, the newest rows paint in ≤ 150 ms after the ack in this harness, and no task exceeds
  50 ms while older rows fill in.
- Something visible shows the transcript is loading from the moment the overlay unhides.
- Measure the same opens in the real app, with the scene running, before and after the change.

## Reproduction

Run from the repository root after `make setup`. The page dumps contain transcript text: write them to a private
directory, never into the repository. The scripts print sizes and timings only.

```sh
mkdir -m 700 /private/acks
OUT=/private/acks go run docs/research/transcript-open-bench/open.go claude ~/.claude/projects/*/SESSION.jsonl
OUT=/private/acks go run docs/research/transcript-open-bench/open.go codex ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
node docs/research/transcript-open-bench/watch.mjs /run/user/$UID/herdr-world/bridge.sock 2
portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
  node docs/research/transcript-open-bench/browser.mjs /private/acks
portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
  node docs/research/transcript-open-bench/experiments.mjs /private/acks
portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
  node docs/research/transcript-open-bench/profile.mjs /private/acks/claude-03.json
```

`watch.mjs` watches and then unwatches every Claude and Codex worker of the bridge it connects to; it sends nothing
else. No application code was changed by this investigation.
