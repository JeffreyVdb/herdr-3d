# Excalidraw scene data and Go-generated pins

Checked **2026-10-01**. The npm registry's stable `latest` is **@excalidraw/excalidraw 0.18.1**, published **2026-04-20T20:24:36.743Z**. Checked tag **v0.18.1**, commit **a2ec2889babf7d2295469c6d90ebe77fae57df84**, and the published 0.18.1 declarations. Its dependency is **fractional-indexing 3.2.0**. Do not use current master types: at this release, element types are still in `packages/excalidraw/element/types.ts`, not `packages/element/src/types.ts`. [npm registry][registry], [release package][package], [element types][types]

## Recommended contract

Keep a versioned per-floor scene containing ordered elements **including deletion tombstones**, a small allowlisted appState, and a binary-file metadata manifest. Store image bytes separately under SHA-256 names; reconstruct Excalidraw `files` for clients. Generate complete image/text elements and valid indices in Go; the browser repairs text dimensions after loading fonts. Use HTTP for scene snapshots, binary files and PNG, and WebSocket for revision notifications. Use a floor revision compare-and-swap for saves and reconcile server snapshots into current browser elements. These are implementation recommendations based on the serialization, restoration, reconciliation and transport behavior below, and satisfy issue #15's storage/history/pin requirements. [issue][issue], [serialization][json], [merge][reconcile], [repo transport][protocol]

## 1. Scene serialization and persistence

`serializeAsJSON(elements, appState, files, type)` requires the fourth argument (`"local"` or `"database"`). Both emit `type:"excalidraw"`, **scene format version 2**, `source`, `elements`, and `appState`, using pretty JSON. `source` is `window.EXCALIDRAW_EXPORT_SOURCE || window.location.origin`, not a fixed excalidraw.com string. `"local"` includes a `files` dictionary, filtered to files referenced by live images; `"database"` sets files to undefined, so the key is absent. **Both remove deleted elements** and clear `lastCommittedPoint` on linear elements. Scene format `version:2`, element versions, binary-file versions and the bridge revision are four distinct concepts. [serialization][json], [element cleanup][elements], [constants][constants]

The exact appState keys with `export:true` and `server:true` in 0.18.1 are **`viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled`**. Defaults are white, 20, 5 and false. Persist these four; use the library's cleaned appState or the same explicit allowlist. Export settings (`exportBackground`, `exportWithDarkMode`, `exportScale`, `exportEmbedScene`) are browser preferences, excluded from both export/server state; set them explicitly when generating the board PNG. [appState][appstate], [constants][constants]

Do not persist collaborators, selection/group selection, active edits, resizing/drag state, pointer state, DOM sizes/offsets, file handles, menus/dialogs, zoom/scroll, tool/current style preferences, theme or undo history as shared board state. The upstream server/export configuration excludes these; some may be kept separately as per-browser preferences. `restoreAppState` is a defaulting/migration function, **not a persistence sanitizer**: supplied values generally win, then local state, then defaults, with special tool/zoom/grid migrations. Allowlist before storage. [appState policy][appstate], [restoration][restore]

Suggested disk envelope (application-owned schema, not a verbatim Excalidraw export):

```json
{
  "schemaVersion": 1,
  "floorRevision": 42,
  "excalidrawVersion": "0.18.1",
  "scene": {
    "type": "excalidraw", "version": 2, "source": "herdr-3d",
    "elements": [],
    "appState": {"viewBackgroundColor":"#ffffff","gridSize":20,"gridStep":5,"gridModeEnabled":false}
  },
  "fileManifest": {},
  "renderRevision": 41
}
```

Retain files referenced by tombstones and all retained history snapshots, not just live elements. Garbage collect only when absent from every retained reference. Keep the last 20 revisions and mark rendering stale when `renderRevision != floorRevision`; do not present a stale PNG as current. This is the recommended adaptation of the ticket, rather than the file-export cleaner which would discard merge tombstones. [issue][issue], [serialization][json], [reference retention][office-server]

### Restore tolerance and minimal inputs

`restore(data, localAppState, localElements, options?)` returns `{elements,appState,files}`; absent scene data produces defaults/empty arrays and an empty files object. `restoreElements(elements, localElements, {repairBindings?,refreshDimensions?})` repairs missing base properties: id, coordinates, version/nonce, colors/styles, seed, groups, frame id, links, locks and index. It removes selection elements, filters invisible elements, repairs duplicate ids and normalizes dimensions. Image-specific defaults: status `"pending"`, scale `[1,1]`, crop null; **fileId is copied, not synthesized**. Text defaults include alignment, container null, autoResize true, originalText from text and line height, but **missing numeric fontSize/fontFamily are not supplied by the normal non-legacy text path**. [restore][restore], [small-element filter][size]

A practical minimal image for restoring is `{id:"i",type:"image",x:0,y:0,width:320,height:180,fileId:"hash"}` with matching `files.hash`. A practical minimal text is `{id:"t",type:"text",x:0,y:0,width:200,height:25,text:"Hello",fontSize:20,fontFamily:5,lineHeight:1.25}`. These are JSON inputs to repair, not complete `ExcalidrawElement` TypeScript values. An element with **both dimensions exactly zero is filtered before restoration**; use positive dimensions. Empty text is retained as a version-bumped tombstone. Unknown types return null; arbitrary malformed field values are not guaranteed to be fixed safely. Prefer the complete shapes below and validate server input. [restore][restore], [small-element filter][size]

Crucial: `refreshDimensions:true` is reached only after the early return controlled by `repairBindings`; request **both flags**. `restoreElements`'s `localElements` argument is explicitly **not reconciliation**: a greater local version makes restoration bump the incoming element above that local version. Restore remote data with `localElements:null`, then call `reconcileElements`. `updateScene` itself synchronizes indices but does not call general restore. [restore][restore], [App updateScene][app]

## 2. Exact image and text fields

Both element types inherit this complete base field set; only `customData` is optional in the type. Other fields may explicitly hold null as indicated. Units: positions/sizes in scene coordinates, angle in radians, opacity 0–100 and updated in epoch milliseconds. [types][types]

| Field | Type / meaning |
|---|---|
| `id` | string, unique element identity |
| `x`, `y`, `width`, `height`, `angle` | numbers; angle branded as Radians in TS |
| `strokeColor`, `backgroundColor` | strings |
| `fillStyle` | `hachure`, `cross-hatch`, `solid`, `zigzag` |
| `strokeWidth`, `roughness`, `opacity` | numbers |
| `strokeStyle` | `solid`, `dashed`, `dotted` |
| `roundness` | null or `{type:number,value?:number}`; known type values 1, 2, 3 |
| `seed` | integer for deterministic rough rendering |
| `version`, `versionNonce` | integer revision, integer tie breaker |
| `index` | branded fractional-index string or null |
| `isDeleted` | boolean |
| `groupIds` | readonly string array, deepest group first |
| `frameId` | string or null |
| `boundElements` | null or readonly `{id:string,type:"arrow"|"text"}[]` |
| `updated` | number, epoch ms |
| `link` | string or null |
| `locked` | boolean |
| `customData?` | object `Record<string,any>`; keep JSON-compatible |

Image adds exactly `type:"image"`, `fileId:string|null` (FileId brand), `status:"pending"|"saved"|"error"`, `scale:[number,number]`, `crop:null|{x,y,width,height,naturalWidth,naturalHeight}` (all crop fields numeric). Use `[1,1]` normally; negative axis values flip the picture. `newImageElement` forces strokeColor `"transparent"`, starts at version 1/nonce 0, and defaults to fileId null, pending, scale `[1,1]`, crop null. Use saved when the bridge has persisted the file. [types][types], [constructors][new]

Text adds exactly `type:"text"`, `fontSize:number`, `fontFamily:number`, `text:string`, `originalText:string`, `textAlign:"left"|"center"|"right"`, `verticalAlign:"top"|"middle"|"bottom"`, `containerId:string|null`, `autoResize:boolean`, `lineHeight:number` (unitless TS brand). **There is no baseline field.** `newTextElement` normalizes/measures text, defaults to size 20, Excalifont, left/top, null container, autoResize true and a per-font lineHeight, and calls `newElementWith`, making the normal constructed text version **2** with a random nonce. New Go-created text can validly start at version 1; version 2 below mirrors the constructor. [types][types], [constructors][new], [mutation][mutate]

Numeric font ids: **Virgil 1, Helvetica 2, Cascadia 3, Excalifont 5 (current default), Nunito 6, Lilita One 7, Comic Shanns 8, Liberation Sans 9**; 4 is reserved/unused. Font metadata marks 1/2/3 deprecated, Helvetica local-only and Liberation Sans server-side. Excalifont lineHeight is **1.25**. [constants][constants], [font metadata][fontmeta]

Complete valid image (hash is illustrative; the files dictionary must supply actual image bytes under that exact id):

```json
{
  "id": "pin-image-01",
  "type": "image",
  "x": 1000,
  "y": 100,
  "width": 320,
  "height": 180,
  "angle": 0,
  "strokeColor": "transparent",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "index": "a0",
  "roundness": null,
  "seed": 123456789,
  "version": 1,
  "versionNonce": 0,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1790841600000,
  "link": null,
  "locked": false,
  "customData": {
    "herdr": {
      "author": "Nibble",
      "kind": "agent-pin",
      "requestId": "request-01"
    }
  },
  "fileId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "status": "saved",
  "scale": [
    1,
    1
  ],
  "crop": null
}
```

Complete valid text:

```json
{
  "id": "pin-note-01",
  "type": "text",
  "x": 1000,
  "y": 320,
  "width": 240,
  "height": 25,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "index": "a1",
  "roundness": null,
  "seed": 123456789,
  "version": 2,
  "versionNonce": 987654321,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1790841600000,
  "link": null,
  "locked": false,
  "customData": {
    "herdr": {
      "author": "Nibble",
      "kind": "agent-pin",
      "requestId": "request-01"
    }
  },
  "text": "Review the layout",
  "originalText": "Review the layout",
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "left",
  "verticalAlign": "top",
  "containerId": null,
  "autoResize": true,
  "lineHeight": 1.25
}
```

The text example's 240×25 is a **server placeholder**, not a measured claim about that phrase; refresh width in the browser before generating the final PNG. These examples combine the pinned type definitions and constructor defaults with chosen positions, ids, author metadata and file/status; they are not copied scene fixtures. [types][types], [constructors][new]

## 3. Fractional indices and a Go append implementation

The index encodes z-order, not position or a floating-point number. fractional-indexing 3.2.0 uses alphabet `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`, a variable-length integer part headed by A–Z/a–z, plus an optional fractional suffix. Compare strings with ordinary byte/codepoint lexicographic ordering, **not localeCompare**. Empty scene starts `a0`; appends go `a1` … `az`, then `b00`. Insertion between `a0` and `a1` yields `a0V`. Do not parse keys as numbers, concatenate a scene counter, or append `0` (fractional suffixes cannot end in zero). [fractional-indexing 3.2.0][fi-lib], [Excalidraw ordering][fi]

`restoreElements` always calls `syncInvalidIndices`, which repairs missing/duplicate/out-of-order indices according to array order and mutates elements via `mutateElement` (therefore bumping version/nonce/updated). **“Invalid” here checks presence and neighbor ordering, not full key grammar**: a single element with index `"garbage"` can survive, and later key generation against it can throw. Missing/null is supported; syntactically arbitrary strings are not a safe shortcut. [index repair][fi], [mutation][mutate], [restore][restore]

Omitting/null index is acceptable for a legacy complete snapshot restored before use. For incremental server pins, generate a real key: use the last/highest valid index among **all ordered elements including tombstones**, and serialize append operations under the floor lock. Otherwise different clients can repair the same pin differently and reconciliation may move it. The Go function below implements only `generateKeyBetween(last,null)`; it deliberately adds stricter input alphabet validation, including integer saturation handling. It is not a full between-two-keys port. [fi-lib][fi-lib], [fi][fi], [merge][reconcile]

```go
package main

import (
 "fmt"
 "strings"
)

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// AppendIndex implements generateKeyBetween(last, null) with base62.
// Empty last means an empty scene. Reject malformed keys at the boundary.
func AppendIndex(last string) (string, error) {
 if last == "" { return "a0", nil }
 head := last[0]
 n := 0
 switch {
 case head >= 'a' && head <= 'z': n = int(head-'a')+2
 case head >= 'A' && head <= 'Z': n = int('Z'-head)+2
 default: return "", fmt.Errorf("invalid index head")
 }
 if len(last) < n { return "", fmt.Errorf("short integer part") }
 for i:=1; i<len(last); i++ {
  if strings.IndexByte(digits,last[i]) < 0 { return "", fmt.Errorf("invalid digit") }
 }
 if last == "A"+strings.Repeat("0",26) || (len(last)>n && last[len(last)-1]=='0') {
  return "", fmt.Errorf("invalid order key")
 }
 integer := []byte(last[:n])
 carry := true
 for i:=n-1; carry && i>=1; i-- {
  d:=strings.IndexByte(digits,integer[i])+1
  if d==len(digits) { integer[i]='0' } else { integer[i]=digits[d]; carry=false }
 }
 if !carry { return string(integer),nil }
 if head=='Z' { return "a0",nil }
 if head=='z' {
  // The integer part is saturated. midpoint(fraction, null).
  fraction:=last[n:]
  suffix:=""
  for {
   d:=0
   if len(fraction)>0 { d=strings.IndexByte(digits,fraction[0]) }
   if len(digits)-d>1 { suffix+=string(digits[(d+len(digits)+1)/2]); break }
   suffix+=string(digits[d])
   if len(fraction)>0 { fraction=fraction[1:] }
  }
  return last[:n]+suffix,nil
 }
 integer[0]++
 if integer[0]>'a' { integer=append(integer,'0') } else { integer=integer[:len(integer)-1] }
 return string(integer),nil
}

```

Verification: compiled and tested outside the repository against **6,008 vectors generated by pinned fractional-indexing 3.2.0**, covering 5,000 appends, 1,000 interior fractional keys, A/Z/a/z boundaries and saturated integer/fractional keys; also empty-scene and malformed-key cases. The code lives in the verification scratch directory listed below. This is a reproducible local experiment, not an upstream benchmark. [reference algorithm][fi-lib]

## 4. Text sizing and notes without a browser

Go should set explicit fontSize 20, fontFamily 5, lineHeight 1.25, left/top alignment, positive placeholder width and `height = lineCount * 20 * 1.25`, with `text` and `originalText` both holding normalized LF text. For an uncontained note use autoResize true: after a dimension refresh the browser measures width/height. For fixed-width wrapping use autoResize false and a chosen width (e.g. 320); refresh wraps text and keeps the specified width. These are recommended provisional sizes; width cannot be accurately inferred from character count, especially with CJK/emoji/fallback fonts. [constructors/refresh][new], [text measurements][measure], [font metadata][fontmeta]

Neither default `restore`, default `restoreElements`, the component's initial scene restore, nor the export wrapper requests dimension refresh. The component's font-loaded handler clears caches and triggers redraw, but **does not remeasure element geometry there**. Therefore autoResize true does not by itself promise that a server placeholder becomes correct on load/export. Explicitly load fonts, then restore new pins using `{repairBindings:true,refreshDimensions:true}`. Use raw canonical note text when refreshing provisional pins, rather than repeatedly wrapping previously wrapped text. [restore][restore], [component initialization][app], [font handling][fonts], [export wrapper][export]

Prefer a standalone text pin first, tagged with `customData.herdr.author`, kind and request id. Place x beyond the max live right extent plus a margin and arrange pins in a column, excluding tombstones from layout. For a sticky note container, emit a rectangle first and text next in stacking order, with text.containerId referencing the rectangle and rectangle.boundElements containing `{id:textId,type:"text"}`. Use both repair flags. Allow 5 units of bound-text padding per side and sufficiently generous rectangle dimensions; restore's dimension refresh is not the same as the editing path's container-growth operation. Persist the browser-normalized pin with a genuine element version bump if its canonical geometry/content changes. [binding repair][restore], [text geometry][text], [constructors][new], [padding][constants], [mutation][mutate]

Public-API-only font/dimension normalization is included in the TypeScript snippet below: a tiny `exportToCanvas` pass registers/loads used font faces, then dimension refresh measures with the correct fonts. Apply this to **new provisional pins**, not repeatedly to every live local stroke. The tiny warmup is a suggested public API workaround, not an official text-measure API. Ensure all font faces are self-hosted before calling it. [canvas export font loading][scene-export], [font handling][fonts], [package README][npm]

## 5. Binary files, bytes and identifiers

The exact `BinaryFileData` is `{id:FileId,mimeType,dataURL:DataURL,created:number,lastRetrieved?:number,version?:number}`. Both timestamps are epoch milliseconds; `lastRetrieved` supports cleanup decisions; optional `version` indicates dataURL/schema updates. `FileId` and DataURL are branded strings in TypeScript; the type defines no length or regex requirement on FileId. Use nonempty SHA-256 hex ids as an application convention, validate those server-side and keep scene.fileId, dictionary key and file.id identical. The reference office's 1–100 `\w`/hyphen regex is its own policy, not an Excalidraw type requirement. [file types][binary], [FileId][types], [reference checks][office-shared]

Declared image MIME types are PNG, JPEG, GIF, WebP, SVG (`image/svg+xml`), BMP, ICO (`image/x-icon`), AVIF and JFIF (`image/jfif`); BinaryFileData additionally permits `application/octet-stream` for unknown/future data, which does **not** mean arbitrary bytes will render. Our existing `/upload` allows only PNG/JPEG/GIF/WebP; support additional board formats explicitly or normalize to a supported raster, rather than assuming the old handler accepts them. [constants][constants], [binary types][binary], [repo upload][protocol]

Recommendation: decode/validate the incoming data URL once; hash/store the resulting bytes; retain mimeType/id/created/version in a manifest; serve raw bytes over a dedicated authenticated board-file HTTP route and reconstruct `data:${mimeType};base64,...` in the client (or serve BinaryFileData JSON over HTTP). Verify client-supplied hashes against bytes. Preserve referenced history bytes. A local inline dataURL avoids image-origin taint while export still needs local fonts. `POST /upload` is a Drop Zone forwarding endpoint, not already a board-asset store; use its transport/authentication pattern, not its unrelated storage semantics. [binary types][binary], [existing upload][protocol], [reference HTTP file flow][office-app]

## 6. PNG export API and behavior

Current exported signature is effectively:

```ts
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeleted }
  from '@excalidraw/excalidraw/element/types';

declare function exportToBlob(opts: {
  elements: readonly NonDeleted<ExcalidrawElement>[];
  appState?: Partial<Omit<AppState, 'offsetTop' | 'offsetLeft'>>;
  files: BinaryFiles | null;
  maxWidthOrHeight?: number;
  exportingFrame?: ExcalidrawFrameLikeElement | null;
  getDimensions?: (width: number, height: number) =>
    { width: number; height: number; scale?: number };
  mimeType?: string;
  quality?: number;
  exportPadding?: number;
}): Promise<Blob>
```

Use live elements, files, PNG, maxWidthOrHeight 2400, explicit positive padding, exportScale 1, exportBackground true, chosen viewBackgroundColor, exportWithDarkMode false and exportEmbedScene false. PNG quality is ignored. **getDimensions is ignored when maxWidthOrHeight is supplied.** With the maximum set, if bounds are already smaller it uses exportScale, so an exportScale above 1 can defeat the apparent hard cap; setting 1 avoids this. Export loads fonts and image cache asynchronously; await its result, handle missing files and verify fonts load from helper-served URLs. [export implementation][export], [canvas export][scene-export]

Background is included by default (`getDefaultAppState().exportBackground` true); explicit exportBackground false gives transparency. `exportWithDarkMode` independently controls dark rendering/filtering, not just the UI theme. The export wrapper restores data **without** dimension refresh, so normalize provisional note geometry first. [export][export], [appState defaults][appstate], [canvas export][scene-export]

**Empty scene does not have an unconditional throw in public `exportToBlob`**: empty bounds are `[0,0,0,0]`, default padding 10 produces a 20×20 canvas; with padding 0 the zero-sized canvas can make toBlob return null, yielding `couldn't export to blob`. The internal menu-oriented `exportCanvas` path separately rejects empty scenes. Handle an empty board explicitly (blank board PNG of a known size) instead of relying on this small padded export. This conclusion is source-derived; no Chrome rendering experiment was run. [public export][export], [canvas dimensions][scene-export], [bounds][bounds], [menu export][data-index], [default padding][constants]

## 7. Versions, conflicts and preserving active strokes

On each element mutation `version` increments, a random `versionNonce` is assigned, and `updated` is set to epoch ms. Constructor seed is about visual reproducibility, not conflict resolution. Reconciliation does **not** use updated timestamps: it prefers the higher version, or the **lower nonce** on equal versions. At exactly equal version+nonce the remote copy wins. It protects local elements referenced by editingTextElement, resizingElement and newElement; local ids absent from remote are retained. It orders by fractional index and repairs duplicates. Retain tombstones so deletions do not look like absent elements which the local side reintroduces. [mutation][mutate], [merge implementation][reconcile], [types][types]

Recommended single-writer bridge scheme (application design):

1. Every floor has a monotonic integer `revision`. A save submits `{baseRevision,scene,fileManifest,render}` over HTTP. Under a per-floor lock, accept only if baseRevision equals current revision, then commit revision+1 and retain the last 20 snapshots. A stale save gets HTTP 409 plus current revision; it never silently overwrites a pin.
2. Agent pin appends under the same lock, with stable unique element ids and valid indices, increments revision, stores author metadata, keeps the previous render, and emits `whiteboard.updated{floor,version,author}`. Use an idempotent request id for append retries.
3. The open client fetches the latest scene/files on the event, restores **remote only with null localElements**, and synchronously calls `reconcileElements` against the API's latest elements **including deleted** and current appState. Then updateScene with captureUpdate NEVER and addFiles. Keep local appState; do not replace selection/edit state with the saved appState. Re-read current local elements after async fetch/font normalization, rather than using a stale pre-fetch array.
4. On 409, merge current server scene into current local state and retry with the new base revision when safe to save. Keep dirty changes made after the request snapshot; acknowledgements clear only the acknowledged dirty generation. Avoid merging/replacing the same locally edited pin during an active interaction; schedule that specific pin's normalization when idle. Go-generated pins affect new ids, so existing freehand elements remain local during merge.
5. Bind PNGs to the scene revision they render. An agent pin arriving during export must prevent an older PNG from being marked current; CAS render upload against the rendered revision. If scene and PNG are separate requests, staging blobs plus a manifest commit can associate them atomically. Save/export when an interaction completes, then debounce; notify immediately but do not treat an unfinished stroke snapshot as final.

These steps adapt the ticket's counter/history/stale-render requirements to Excalidraw's actual merging semantics. This is per-element deterministic conflict resolution within a revision-checked snapshot protocol, **not text-character merging**: simultaneous edits to the same note still choose a whole element. [issue][issue], [merge][reconcile], [updateScene/store behavior][app], [reference merge][office-app]

Strict TypeScript snippet, checked against the published 0.18.1 declarations. Uses type-only subpath imports (runtime imports must come from the package root; package wildcard subpaths only export declarations):

```ts
import { CaptureUpdateAction, exportToBlob, exportToCanvas,
  reconcileElements, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

export async function normalizeNewPins(raw: ExcalidrawElement[], files: BinaryFiles) {
  const first = restoreElements(raw, null);
  // Public export API registers and loads the required font faces.
  await exportToCanvas({ elements: first.filter(e => !e.isDeleted), files,
    maxWidthOrHeight: 1, appState: { exportScale: 1 }, exportPadding: 10 });
  return restoreElements(raw, null, { repairBindings: true, refreshDimensions: true });
}

export function mergeServerScene(api: ExcalidrawImperativeAPI,
  remote: ExcalidrawElement[], files: BinaryFiles) {
  api.addFiles(Object.values(files));
  // Do not pass local elements into restore: that would bump remote versions.
  const restored = restoreElements(remote, null, { repairBindings: true });
  const merged = reconcileElements(api.getSceneElementsIncludingDeleted(),
    restored as RemoteExcalidrawElement[], api.getAppState());
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
}

export async function boardPNG(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements().filter(e => !e.isDeleted);
  if (!elements.length) {
    const canvas = document.createElement('canvas');
    canvas.width = 2400; canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.fillStyle = api.getAppState().viewBackgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
  }
  return exportToBlob({ elements, files: api.getFiles(), mimeType: 'image/png',
    maxWidthOrHeight: 2400, exportPadding: 20,
    appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor,
      exportBackground: true, exportWithDarkMode: false,
      exportEmbedScene: false, exportScale: 1 } });
}

```

The `RemoteExcalidrawElement` assertion marks restored remote origin; it is an upstream nominal brand, not a reason to skip input validation. The raw scene inputs must be validated before they become `ExcalidrawElement[]`. The caller awaits provisional-pin normalization before merge/export, and retains dirty-generation/base-revision logic described above. [remote brand][reconcile], [package exports][package]

## 8. Scene sizes and transport

There is no evidence-based universal “typical scene” size. Compact JSON measurements of the **specific two examples above**: image 635 bytes; text 704 bytes, UTF-8, files excluded. Thus 100 comparable flat elements are roughly 60–80 KiB and 1,000 roughly 0.6–0.8 MiB (derived estimates, not user-scene telemetry). Pretty serialization is larger; long text and freehand points vary widely. Base64 grows N raw bytes to `4*ceil(N/3)` characters before the dataURL prefix and JSON; a 1 MiB image becomes about 1.33 MiB even before scene overhead. These are arithmetic measurements/estimates, not package limits. [field/serialization basis][types], [serializer][json]

The repository's **256 KiB maxClientMsg** applies to a complete WebSocket message; frame fragmentation does not bypass it. Raw images/PNG belong on HTTP, and sufficiently large **scene JSON itself also belongs on HTTP**, not only the files. Keep WebSocket messages as ids/revisions/control or genuinely bounded deltas, counting UTF-8 bytes plus the envelope; one freehand element alone can exceed the cap. Reuse the helper's same-origin Host/token/Origin protections for new routes and define explicit scene/blob limits. The existing raw `/upload` body cap is 25 MiB; its helper allows an extra 4 KiB, while logos have a 1 MiB upload cap. These existing caps are route-specific, not automatic board-route allowances. [protocol][protocol], [decisions][decisions]

The office reference allows 20,000 elements, 512 KiB per element, 16 MiB scene JSON, 6 MiB per dataURL and 64 MiB total files; its client batches to 900,000 JavaScript string characters for a 2 MB socket. **Those values and JS length accounting cannot be copied into this 256 KiB byte-limited bridge.** Treat them as reference policy, not Excalidraw limits. Large scenes require capped counts/coordinates/text/point arrays, debounced serialization, asset deduplication, HTTP backpressure, and careful 20-version retention; copying multi-megabyte inline dataURLs into every history snapshot is wasteful. [reference limits][office-shared], [reference batching][office-app], [repo limits][protocol]

## 9. What agent-office actually stores and hashes

Checked reference commit **a8fa16f18b485f10eb9ff51d041aa0633d6a44ef**, including whiteboard.ts, whiteboard-app.ts, shared/whiteboard.ts and server/whiteboard.ts. The shell lazy-imports whiteboard-app, sets EXCALIDRAW_ASSET_PATH first, mounts a React island, tracks board-open peers and redraws the 3D preview after changes/closing. The preview may also cause lazy loading (after 1.5 s at arrival); it is not restricted to opening the overlay. Preview uses canvas, transparent background, padding 12 and a custom dimensions callback capped at 3× scale. [shell][office-shell], [client app][office-app]

The server keeps a Map by element id, merges by version/lower nonce, and persists the **bare ordered element array** as `whiteboard/elements.json`; it does **not** call serializeAsJSON or store full appState. It saves after 2 s via a temp file + rename, retains deletion tombstones for seven days at load, and garbage-collects file ids unused even by tombstones. Files are stored under `whiteboard/files/<id>.json` as **BinaryFileData JSON containing dataURL**, not raw decoded image files. Dedupe trusts the supplied id: addFile returns early for an existing id and does not itself verify a SHA hash. The client describes ids as image hashes, uploads before publishing an image element, and uses HTTP POST/GET with BinaryFileData JSON. Our bridge should explicitly verify content hashes and store decoded bytes as requested by #15. [server storage][office-server], [client file flow][office-app], [checks][office-shared], [issue][issue]

The client restores remote elements, calls reconcileElements and updateScene with NEVER, preserves locally newer elements, batches changed elements every 50 ms and handles reconnect resync. It does not maintain the ticket's last-20 per-floor revision history or persisted render.png; the preview is client-rendered canvas. Copy the reconciliation separation and HTTP asset flow, then add the ticket's stronger persistence/version/render contract. [client sync][office-app], [server store][office-server], [issue][issue]

## Pitfalls

- Export/database serialization drops tombstones; retain raw canonical elements separately for merging/history. [json][json], [cleanup][elements]
- Missing text fontSize/fontFamily is not repaired; dimension refresh requires both options and loaded fonts. Component startup and export do not refresh geometry. [restore][restore], [App][app], [export][export]
- Index “repair” does not prove grammar validity, and can bump element revisions; generate valid indices once in Go and preserve stable canonical ordering. [fi][fi], [mutate][mutate]
- restore's localElements option can elevate stale remote versions; restore with null, then reconcile. [restore][restore]
- updateScene replacing a fetched snapshot directly loses unsaved strokes; use latest local elements, including tombstones, and NEVER for remote updates. [reconcile][reconcile], [App][app]
- Revision-checked scene saves need revision-checked PNG commits too; preserve images referenced by retained history. [issue][issue]
- maxWidthOrHeight plus exportScale above 1 is not a strict 2400 cap; maxWidthOrHeight disables getDimensions. [export][export]
- There is no public empty-scene unconditional throw; generate a deliberate blank board PNG. [export][export], [bounds][bounds]
- Excalidraw is a React component with React/ReactDOM peer dependencies. A vanilla TypeScript game needs an isolated lazy React adapter for the editor; the snippets above are utility/bridge integration, not a claim that the editor is framework-free. Set the local font asset path before loading Excalidraw; do not let fallback CDN requests escape. [package][package], [npm self-hosting][npm], [reference adapter][office-app]
- Existing Drop Zone upload storage and limits are not board storage; new HTTP routes must be proxied/authenticated by the helper. [protocol][protocol]

## Verification and source artifacts

No repository files were edited and no builds/tests were run in the repository. Strict TypeScript `tsc --noEmit` passed in `/tmp/h3d-exca-data-check` using **@excalidraw/excalidraw 0.18.1**. The standalone Go append function passed the 6,008 upstream-vector comparison plus invalid/empty cases. JSON examples were parsed and measured by the findings writer. Browser font layout, image decoding, and the complete concurrent-save protocol were not exercised; conclusions about those behaviors are pinned-source analysis and implementation recommendations.

Parallel search results: `/tmp/exca-search.json`; extraction results: `/tmp/exca-extract.json`. Pinned raw source and registry metadata: `/tmp/exca-research`. Compile/algorithm verification: `/tmp/h3d-exca-data-check`.

## Sources

- [registry](https://registry.npmjs.org/@excalidraw/excalidraw)
- [npm](https://www.npmjs.com/package/@excalidraw/excalidraw/v/0.18.1)
- [package](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/package.json)
- [types](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/types.ts)
- [json](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/json.ts)
- [elements](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/index.ts)
- [constants](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/constants.ts)
- [appstate](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/appState.ts)
- [restore](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/restore.ts)
- [size](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/sizeHelpers.ts)
- [new](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/newElement.ts)
- [mutate](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/mutateElement.ts)
- [fontmeta](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/FontMetadata.ts)
- [fi](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fractionalIndex.ts)
- [fi-lib](https://github.com/rocicorp/fractional-indexing/blob/v3.2.0/src/index.js)
- [measure](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/textMeasurements.ts)
- [text](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/textElement.ts)
- [fonts](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/Fonts.ts)
- [binary](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/types.ts)
- [export](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/utils/export.ts)
- [scene-export](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/scene/export.ts)
- [bounds](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/bounds.ts)
- [data-index](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/index.ts)
- [reconcile](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/reconcile.ts)
- [app](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx)
- [issue](https://github.com/JeffreyVdb/herdr-3d/issues/15)
- [protocol](https://github.com/JeffreyVdb/herdr-3d/blob/8ed87fb76876fe3b7e2eb406d954d31b69b0a77f/docs/protocol.md)
- [decisions](https://github.com/JeffreyVdb/herdr-3d/blob/8ed87fb76876fe3b7e2eb406d954d31b69b0a77f/docs/decisions.md)
- [office-shell](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/client/ui/whiteboard.ts)
- [office-app](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/client/ui/whiteboard-app.ts)
- [office-server](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/server/whiteboard.ts)
- [office-shared](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/shared/whiteboard.ts)

[registry]: https://registry.npmjs.org/@excalidraw/excalidraw
[npm]: https://www.npmjs.com/package/@excalidraw/excalidraw/v/0.18.1
[package]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/package.json
[types]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/types.ts
[json]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/json.ts
[elements]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/index.ts
[constants]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/constants.ts
[appstate]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/appState.ts
[restore]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/restore.ts
[size]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/sizeHelpers.ts
[new]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/newElement.ts
[mutate]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/mutateElement.ts
[fontmeta]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/FontMetadata.ts
[fi]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fractionalIndex.ts
[fi-lib]: https://github.com/rocicorp/fractional-indexing/blob/v3.2.0/src/index.js
[measure]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/textMeasurements.ts
[text]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/textElement.ts
[fonts]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/Fonts.ts
[binary]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/types.ts
[export]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/utils/export.ts
[scene-export]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/scene/export.ts
[bounds]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/element/bounds.ts
[data-index]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/index.ts
[reconcile]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/reconcile.ts
[app]: https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx
[issue]: https://github.com/JeffreyVdb/herdr-3d/issues/15
[protocol]: https://github.com/JeffreyVdb/herdr-3d/blob/8ed87fb76876fe3b7e2eb406d954d31b69b0a77f/docs/protocol.md
[decisions]: https://github.com/JeffreyVdb/herdr-3d/blob/8ed87fb76876fe3b7e2eb406d954d31b69b0a77f/docs/decisions.md
[office-shell]: https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/client/ui/whiteboard.ts
[office-app]: https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/client/ui/whiteboard-app.ts
[office-server]: https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/server/whiteboard.ts
[office-shared]: https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f18b485f10eb9ff51d041aa0633d6a44ef/src/shared/whiteboard.ts
