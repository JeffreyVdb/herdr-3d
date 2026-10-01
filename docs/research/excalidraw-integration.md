# Excalidraw integration research — 2026-10-01

## Verified baseline and recommendation

The live npm registry reports **`@excalidraw/excalidraw@0.18.1`** as `latest`, published **2026-04-20T20:24:36.743Z**; `next` and `rc` are not stable versions. This is the registry actually observed for the requested date, rather than an assumed future release. The source checked is **v0.18.1**, commit **a2ec2889babf7d2295469c6d90ebe77fae57df84**. Package tarball and pinned source were downloaded into `/tmp/exca-research`, outside the repository. [npm registry](https://registry.npmjs.org/@excalidraw/excalidraw), [pinned package source](https://github.com/excalidraw/excalidraw/tree/a2ec2889babf7d2295469c6d90ebe77fae57df84)

Use a lazy React island, self-host **all** fonts, persist scene JSON plus independently stored image bytes, and create a bounded PNG on each committed save. Keep both the game input dispatcher and movement tick suspended for the entire overlay lifetime. This implements the issue's vanilla-game architecture and local-only persistence requirements. [issue #15](https://github.com/JeffreyVdb/herdr-3d/issues/15), [reference whiteboard](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard.ts)

## 1. Package compatibility

- ESM (`type: module`); root exports production/dev ESM and declaration files. Peers are **`react` and `react-dom`: `^17.0.2 || ^18.2.0 || ^19.0.0`**, so React 19 is explicitly supported. Use matching React/react-dom majors. CSS import is **`@excalidraw/excalidraw/index.css`**. Internal runtime deep imports are not public exports; type imports such as `@excalidraw/excalidraw/types` and `.../element/types` are supported. [0.18.1 package.json](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/package.json), [actual npm metadata](https://registry.npmjs.org/@excalidraw/excalidraw/0.18.1)
- **Measured:** isolated strict TypeScript **7.0.2** and Vite **8.3.1** production build passed with React **19.3.0**, without React Vite plugin, `define`, or `optimizeDeps`. Use `createElement`, so `.ts` needs no JSX transform. Add `vite/client` types for TS7's checked CSS side-effect import. Non-fatal Radix/Jotai `use client` and large-chunk warnings occurred. No browser smoke test was executed; this establishes compilation/bundling compatibility, not exhaustive runtime QA. Probe source/build/manifest remain under `/tmp/exca-research`.
- Do **not** copy legacy `process.env.IS_PREACT` configuration: it was specific to the old Preact build and is absent from the checked production code. No such replacement was required in the probe. [historical changelog](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/CHANGELOG.md), [current build](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/scripts/buildPackage.js)

## 2–3. Vanilla mounting, cleanup, lazy loading, input

The following two files were compiled in the isolated probe against the versions above. `initialData` accepts elements/appState/files and a promise or factory; `excalidrawAPI` is a callback rather than a ref. API readiness precedes complete scene initialization, so save from explicit user action after initialization, not blindly from the first callback. `onChange` exposes all three persistence inputs. `theme`, `langCode`, `viewModeEnabled`, `UIOptions` are current prop names. [props/types](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/types.ts), [props documentation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/)

```ts
// game entry: only this lazy import, no runtime React/Excalidraw imports
let loading: Promise<typeof import('./whiteboard')> | undefined;
export async function loadWhiteboard() {
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string })
    .EXCALIDRAW_ASSET_PATH = '/assets/excalidraw-0.18.1/';
  loading ??= import('./whiteboard').catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}
```

```ts
// whiteboard.ts: dependencies and CSS stay inside the lazy boundary
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI, ExcalidrawProps }
  from '@excalidraw/excalidraw/types';

export function mount(
  host: HTMLElement,
  initialData: ExcalidrawProps['initialData'],
  onChange: NonNullable<ExcalidrawProps['onChange']>,
) {
  let api: ExcalidrawImperativeAPI | undefined;
  const root = createRoot(host);
  root.render(h(Excalidraw, {
    initialData, onChange, excalidrawAPI: a => { api = a; },
    theme: 'light', langCode: 'en', viewModeEnabled: false,
    autoFocus: true, handleKeyboardGlobally: false,
    aiEnabled: false, validateEmbeddable: false,
    UIOptions: { canvasActions: {
      export: false, loadScene: false, saveToActiveFile: false,
      saveAsImage: false, toggleTheme: false,
    } },
  }, h(MainMenu, null), h(WelcomeScreen, null)));
  return {
    getAPI: () => api,
    unmount: () => { api = undefined; root.unmount(); },
  };
}
```

Provide a nonzero sized host, e.g. a fixed overlay with `inset: 24px; z-index: ...; pointer-events: auto`, and focus/restore focus around its lifecycle. Explicit empty `MainMenu`/`WelcomeScreen` replace default external-link content; `toggleTheme` is the action key (not `theme`), and `export` takes `false` or an options object, not `true`. [installation/dimensions](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation), [canvas action types](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/types.ts)

**Game-specific read-only finding:** `game/src/app.ts` binds window keydown/keyup; both `onKey`'s early guard and tick's `blocked` state need whiteboard-active. Call `Walker.release()` and `Walker.stop()` on opening: these cancel pending pointer-lock retries and clear held movement/run keys. A bubble handler on the overlay can stop key/pointer propagation *after* Excalidraw consumes them, but this alone cannot protect against window capture listeners or React portal events; the game guard is authoritative. Do not stop all keys in capture before React handles them. Scope `handleKeyboardGlobally: false`; do not infer that it suppresses every document listener. [Excalidraw input implementation](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx)

Esc is already used to finish/cancel editing, drawing, menus, crop/linear edit and tool operations. The reference handles Esc in window capture only if the API state is idle, then first deselects, then closes. Copy its `idle()` checks (editingTextElement/newElement/multiElement/selectionElement/editingLinearElement/isCropping/openMenu/openPopup/openDialog/contextMenu/hyperlink editor/active tool) and `deselect()` logic; do not close the host on every Esc. Include a visible close button, and remove listeners/timers/subscriptions, flush pending saves, then `root.unmount()`. Ignore a lazy-load result if the overlay closed meanwhile. [reference idle/Esc implementation](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard-app.ts), [reference overlay cleanup](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard.ts)

Vite follows the dynamic module boundary, then preloads its static dependencies/CSS only when the import executes; type-only imports do not bring React into the startup bundle. Vite8 uses Rolldown, so prefer its manifest and `build.rolldownOptions` rather than assume legacy Rollup configuration/plugins are equivalent. [Vite build docs](https://vite.dev/guide/build), [Vite8](https://vite.dev/blog/announcing-vite8)

**Probe measurements (not universal budgets):** initial entry 2.41 kB / 1.22 kB gzip; lazy editor including React 1,344.22 kB / **428.43 kB gzip**; CSS142.02 kB / **22.37 kB gzip**; shared runtime ~0.62 kB gzip; optional subset/WASM shared chunk1,821.03 kB / **744.22 kB gzip**. Mermaid diagram/language/pica/file-access chunks are additionally emitted but mostly lazy. Run `vite build --manifest` in implementation; traverse each entry's **static `imports` only**, excluding `dynamicImports`, to prove startup excludes editor. Inspect `dist/index.html` for unwanted preload links and network before first open. Probe manifest is `/tmp/exca-research/dist/.vite/manifest.json`; size output is reproducible from the probe, not a claimed source-document number.

## 4. All assets local, including CJK

Set asset path **before importing/mounting or exporting**; copy the complete package `dist/prod/fonts/` tree to `dist/assets/excalidraw-0.18.1/fonts/`, preserving names and subdirectories. Value is the parent of `fonts/`, with a trailing slash. A build-time `public/` preparation is sufficient and avoids a plugin:

```sh
# Implementation example; NOT executed in the repository during research
mkdir -p public/assets/excalidraw-0.18.1
cp -R node_modules/@excalidraw/excalidraw/dist/prod/fonts \
  public/assets/excalidraw-0.18.1/
```

A Vite plugin can emit all files recursively as assets, or static-copy can target the whole directory; never preserve only latin subsets or flatten hashes. `?url` is useful only if every generated runtime name is mapped consistently; raw full-tree copying is simpler. Assistant UI font references are relative URLs in the distributed CSS; Vite emitted their four local assets in the probe. These references cannot be redirected by the global asset path. [installation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation), [font URL fallback source](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/ExcalidrawFontFace.ts), [UI font source](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/fonts.css)

Measured package inventory: Assistant4, Cascadia1, ComicShanns4, Excalifont7, Liberation1, Lilita2, Nunito5, Virgil1, **Xiaolai209** WOFF2 files: total **234 files / 13,107,068 bytes**; Xiaolai alone12,667,492 bytes. Copying these adds disk assets, not a13MB startup font download: unicode-range selection loads needed subsets. Helvetica and Segoe UI Emoji are local/system families, not additional distributable files. [pinned font tree](https://github.com/excalidraw/excalidraw/tree/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts), [fallback metadata](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/FontMetadata.ts)

**Asset-path configuration does not remove CDN fallback.** Source always appends `https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/` after configured paths. Local missing fonts can fall back remotely; prevent that with complete assets plus same-origin `font-src` and `connect-src` CSP. Test cold-cache Latin/accented/Cyrillic/CJK and all font styles, PNG and optionally SVG export; intercept/report every non-loopback request, including esm.sh/unpkg/jsdelivr. A successful Latin-only test is insufficient. [fallback source](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/ExcalidrawFontFace.ts)

PNG `exportToBlob` calls canvas export, waits for scene fonts, and rasterizes; it does **not embed font programs** or use the SVG subset pipeline. It can fetch fonts if not already cached. SVG export fetches fonts, subsets them, and emits data-URL font CSS unless `skipInliningFonts: true`. [canvas font load](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/scene/export.ts), [export wrappers](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/utils/export.ts)

Embedded package does not establish collaboration by itself (`isCollaborating` is UI state); no host-provided collaboration implementation means no socket service. Tracking is compiled disabled. External surfaces still include library browse/publish, help/social links, embeddable iframes, text-to-diagram and external links. Use `aiEnabled:false`, `validateEmbeddable:false`, custom menus/welcome, and omit collaboration controls. There is **no `UIOptions.library:false` prop**. Replace/default-sidebar UI or hide version-pinned `.default-sidebar-trigger` and `.library-menu-browse-button`, and disallow library import/publication UI if it remains accessible through other routes; CSP is the final fetch/iframe boundary. `onLinkOpen` can `preventDefault()` for disallowed URLs. CSS hiding alone is not a network/security guarantee. [default sidebar](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/DefaultSidebar.tsx), [library browse](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/LibraryMenuBrowseButton.tsx), [default environment](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/.env.production), [tracking](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/analytics.ts)

## 5–6. Images, hash IDs, picker insertion

Paste, file drop and image tool are implemented out of the box; `onPaste` can veto default handling. Persist the third `onChange` argument or `api.getFiles()`, separately from scene image elements' `fileId`; restore with `initialData.files` or `api.addFiles`. Default IDs are SHA-1 (random fallback on digest failure); `generateIdForFile(file)` permits a promise/string SHA-256 override. There is **no `maxFileSize` prop**. Built-in insertion normalizes SVG, hashes **before** raster resizing/compression, tries1440px max dimension, then enforces **4 MiB**. Programmatic `addFiles` bypasses that insertion validation, so validate MIME/size and dimensions yourself. [image insertion source](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx), [limits](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/constants.ts), [default digest/data URL](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/blob.ts)

Thus a custom SHA-256 ID may hash original/normalized bytes while `BinaryFileData.dataURL` contains transformed bytes. If storage requires hash **of persisted bytes**, rehash decoded output when saving, remap every image's `fileId`, and store matching binary records; keep undo/history references consistent. Alternatively define original-byte IDs separately from stored-byte integrity hashes. Do not have the backend compare output bytes with a pre-resize digest and reject ordinary paste. [hash-before-resize implementation](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx)

Compiled picker example (helpers/imports go in the lazy module; validate supported MIME before its intentional branded casts):

```ts
export async function sha256(file: Blob): Promise<string> {const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');}
export async function pin(api:ExcalidrawImperativeAPI,url:string,x:number,y:number,width:number,height:number) {
 const response=await fetch(url);if(!response.ok) throw new Error(String(response.status));const blob=await response.blob();
 const dataURL=await new Promise<BinaryFileData['dataURL']>((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(r.error);r.onload=()=>resolve(r.result as BinaryFileData['dataURL']);r.readAsDataURL(blob);});
 const id=await sha256(blob) as FileId;
 api.addFiles([{id,dataURL,mimeType:blob.type as BinaryFileData['mimeType'],created:Date.now()}]);
 const elements=convertToExcalidrawElements([{type:'image',fileId:id,x,y,width,height}]);
 api.updateScene({elements:[...api.getSceneElementsIncludingDeleted(),...elements],captureUpdate:CaptureUpdateAction.IMMEDIATELY});
}
```

The preceding snippet uses `BinaryFileData`, `ExcalidrawImperativeAPI` from `.../types`, `FileId` from `.../element/types`, and `convertToExcalidrawElements`, `CaptureUpdateAction` from the package root. It preserves deleted elements so history is not accidentally truncated. Fetch from the helper's local URL; remote URLs require CORS and violate local-only runtime policy. Derive dimensions via image decoding rather than trust picker metadata. `captureUpdate: CaptureUpdateAction.IMMEDIATELY` creates an undoable insertion; `NEVER` is appropriate for remote merges. Old `commitToHistory` is not in this version's `SceneData`. [public element skeleton helper](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/data/transform.ts), [SceneData/API](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/types.ts)

```ts
// import { exportToBlob } from '@excalidraw/excalidraw';
async function png(api: ExcalidrawImperativeAPI) {
  return exportToBlob({
    elements: api.getSceneElements(), files: api.getFiles(),
    mimeType: 'image/png', maxWidthOrHeight: 2400,
    appState: {
      ...api.getAppState(), exportScale: 1, exportBackground: true,
      exportEmbedScene: false, exportWithDarkMode: false,
    },
  });
}
```

Force `exportScale:1`: otherwise a small drawing can use the saved2×/3× exportScale despite `maxWidthOrHeight`, exceeding2400px. Persist JSON/files/PNG as one coordinated save revision, upload files before referencing them, serialize concurrent saves, flush before unmount, and do not label a partially failed upload/export as saved. Empty drawings need a deliberate blank-preview policy. [export dimension implementation](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/utils/export.ts), [issue persistence/preview](https://github.com/JeffreyVdb/herdr-3d/issues/15)

## 7. What to copy from agent-office

Copy its cached/retryable dynamic import, asset path assigned before import, close-during-load guard, React island, initial scene restoration, `api.addFiles` hydration, files-upload-before-elements ordering, bounded preview export, delayed redraw and API-aware Esc/unmount. It uses Excalidraw's default hash rather than a SHA-256 override; files live in separate HTTP endpoints and element version updates travel over its socket. `renderPreview` returns a canvas via `exportToCanvas`, not a durable per-save PNG. [whiteboard-app.ts](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard-app.ts), [whiteboard.ts](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard.ts)

Avoid its **explicit Xiaolai exclusion** and resulting CDN fallback, its auto-load on room preview after1500ms if strict first-open laziness is required, unnecessary live collaboration complexity, and menu entries that re-enable export/help/theme flows. Its upload promise map caches failed HTTP responses as resolved false (only network rejection removes them), so copy retry/durability intent rather than that exact failure handling. [font plugin](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/vite.config.ts), [upload implementation](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard-app.ts)

## 8. CSP, workers and WASM

For PNG editing/export, likely minimum additions to the helper's existing policy are local script/style/font fetches, `font-src 'self'` (plus `data:` if SVG embedded-font rendering is supported), `connect-src 'self'` plus whatever loopback websocket the app needs, and `img-src 'self' data: blob:` for pasted images/previews. Excalidraw uses inline React style attributes, so restrictive styles need explicit testing/allowance. Keep `frame-src 'none'` when embeds are disabled. Do not claim a universal complete CSP without testing the existing game. [font source](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/ExcalidrawFontFace.ts), [distributed package](https://registry.npmjs.org/@excalidraw/excalidraw/-/excalidraw-0.18.1.tgz), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)

**Yes, SVG font export uses workers and WASM.** `subset-worker.chunk.js` is loaded dynamically, exposes its own `import.meta.url`, and `workers.ts` starts `new Worker(url,{type:'module'})`. `subset-shared.chunk.js` and shared `chunk-EIO257PC.js` contain WOFF2/HarfBuzz binaries imported as JS arrays; there are **no external `.wasm` files to copy**. Vite emitted these through the ordinary import graph in the probe. Preserve all built chunks and use `worker-src 'self'` for this worker. Worker failure falls back to the main thread; subset failure returns the whole font. [subset-main](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/subset/subset-main.ts), [worker chunk](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/subset/subset-worker.chunk.ts), [workers](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/workers.ts), [HarfBuzz loader](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/subset/harfbuzz/harfbuzz-loader.ts)

WASM compilation may need `'wasm-unsafe-eval'`. Additionally old WOFF2 bindings contain `new Function`, so this path may require ordinary `'unsafe-eval'` too; browser-test SVG under the chosen policy before broadening it. PNG-only required previews avoid that subset path. Image downscaling dependency pica can use blob workers/WASM depending on its selected features; exercise paste/drop under CSP and allow `worker-src blob:` only if necessary. Font assets are the only explicit full-tree copy requirement; ordinary JS worker chunks are emitted by Vite. [WOFF2 bindings](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/subset/woff2/woff2-bindings.ts), [MDN WASM/eval policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src), [pica 7.1.1 source](https://github.com/nodeca/pica/tree/4228a45898036ab7cf0232d1ee4a70e0c3579d28)

## 9. Licensing and font credits

Excalidraw is MIT: ship its copyright/license notice. **Bundled fonts are not all OFL.** Name-table metadata in the exact0.18.1 WOFF2 assets was decoded with FontTools in `/tmp/exca-research/fontvenv`, and source comments/upstream license were compared. [Excalidraw MIT](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/LICENSE), [exact npm asset tarball](https://registry.npmjs.org/@excalidraw/excalidraw/-/excalidraw-0.18.1.tgz)

| Font | License / notice to carry |
|---|---|
| Excalifont | OFL1.1; Copyright2024 Excalidraw; Virgil/Filípek/DizajnDesign authors in source metadata |
| Virgil | OFL1.1; Copyright2011 Your Own Font Foundry |
| Assistant | OFL1.1; Assistant Project2020, Source Sans Pro authors2010 and reserved Source name |
| Cascadia Code | OFL-based Microsoft license; preserve exact shipped metadata/current upstream full license |
| Nunito | OFL1.1;2014 Nunito Project Authors |
| Lilita One | OFL1.1;2011 Juan Montoreano, reserved Lilita One |
| Xiaolai | OFL1.1;2020 LXGW |
| Comic Shanns | **MIT**, with all named2018–2024 authors; full notice embedded in checked source |
| Liberation Sans | **Bundled version1.05**, not modern2.x: GPLv2 with font exception, metadata says2007Ascender. Do not mislabel OFL. |

Primary references: [Excalifont license metadata](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/Excalifont/index.ts), [Comic Shanns MIT](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/ComicShanns/index.ts), [Xiaolai license](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fonts/Xiaolai/index.ts), [Cascadia license](https://github.com/microsoft/cascadia-code/blob/main/LICENSE), [Liberation maintainer history explicitly differentiating older GPL and2.x OFL](https://github.com/liberationfonts/liberation-sans-narrow/blob/5462920fee502b688604472e65af49af951bdd56/README.rst), [older Liberation full license](https://github.com/liberationfonts/liberation-sans-narrow/blob/5462920fee502b688604472e65af49af951bdd56/License.txt), [OFL terms](https://openfontlicense.org/open-font-license-official-text/)

Add the bundled families to existing `game/src/ui/fontCredits.ts` and its downloadable concatenated `FONT_LICENSES.txt`, retaining full license and copyright text, not just an OFL link. Include notice for every distributed family even if currently hidden in the picker. Investigate old Liberation source-distribution requirements or deliberately replace it with a verified modern OFL font in a later implementation; that replacement needs rendering compatibility tests. Current font data/license facts are established, but full redistribution compliance review was not performed in this research.

## Pitfalls

- Complete self-hosting includes all209CJK chunks; configured asset path still retains CDN fallback.
- The original-image hash may not equal stored transformed-image hash.
- `addFiles` is not image validation; file records without matching scene IDs yield broken images.
- `UIOptions` is not a general permission system: hidden actions/links can have keyboard/context/library entry routes.
- Game input/tick guards and pointer-lock retry cancellation matter more than superficial DOM bubbling isolation.
- Never persist transient `AppState` wholesale without normalization: collaborators, selections, menus and file handles are session state; restore durable preferences safely and omit unserializable objects. [appState storage filtering](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/appState.ts)
- PNG2400limit also needs exportScale1; source has surprising small-scene upscale behavior.
- Editor chunks may be loaded by previews before the first open if preview rendering calls the same loader.
- Font licensing includes Comic Shanns MIT and old Liberation GPL/font-exception; do not copy a generic all-OFL credit.

## Sources and reproducibility

Every primary URL used is linked beside its finding above. Parallel search/extraction artifacts: `/tmp/exca-search.json`, `/tmp/exca-docs.json`, `/tmp/exca-licenses.json`, `/tmp/exca-liberation.json`, `/tmp/exca-csp.json`. Primary-source package/source and compilation probe: `/tmp/exca-research/`. Research used parallel skills first; they succeeded, so AlterLab/Tavily fallback was unnecessary; no context7 callable tools were available. No repository changes or repository build were performed. Browser interaction, offline network capture, and runtime CSP verification remain implementation acceptance tests, rather than falsely reported completed tests.
