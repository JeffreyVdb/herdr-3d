# Capture API, app windows, lifecycle and privacy research (2026-10-01)

## Versions and limits

Checked **three.js 0.186.1** (npm `latest`, git head `9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8`), matching the repo's dependency; the latest GitHub release is r186 (published September 24, 2026). Checked code at that npm commit, not unpinned development code. [npm registry](https://registry.npmjs.org/three/latest), [r186 release](https://github.com/mrdoob/three.js/releases/tag/r186).

The September 29 official desktop stable release identifies **Chrome 154.0.8037.92/.93 for Mac and Windows**; this was verified in the official page's `og:description` HTML after extraction omitted the body. September 30 also has an Early Stable announcement, which is not evidence that all stable users received a newer release. Current MDN/spec docs were retrieved; pinned Chrome 154 capture implementation was not fully available, and no macOS Chrome app-window runtime was available here. Therefore the version is identified, but this is documentation/source research, not a claim of runtime validation on Chrome 154. [Stable release](https://chromereleases.googleblog.com/2026/09/stable-channel-update-for-desktop_01807488085.html), [Early Stable](https://chromereleases.googleblog.com/2026/09/early-stable-update-for-desktop_01356833751.html), [Screen Capture spec](https://www.w3.org/TR/screen-capture).

Read issue #15 and local package/config/contributor instructions without building or editing the repo. The reference whiteboard lazily imports its editor and manages image files separately; its imported editor brings React/Excalidraw. That is whiteboard architecture, not a requirement for screen capture: the TV can stay vanilla TypeScript, using locally bundled three.js and browser APIs. [Ticket](https://github.com/JeffreyVdb/herdr-3d/issues/15), [reference whiteboard at a8fa16f](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard.ts), [imported editor at a8fa16f](https://github.com/AgentSystemLabs/agent-office/blob/a8fa16f/src/client/ui/whiteboard-app.ts).

## Meet-like picker

Recommended request (optional `displaySurface` hint; the compiling example below omits it to leave picker ordering to Chrome): video `{displaySurface:'browser', width:{ideal:1920,max:1920}, height:{ideal:1080,max:1080}, frameRate:{ideal:15,max:30}}`, `audio:false`, `preferCurrentTab:false`, `selfBrowserSurface:'exclude'`, `surfaceSwitching:'include'`, `monitorTypeSurfaces:'include'`, `systemAudio:'exclude'`, `windowAudio:'exclude'`. DisplaySurface only preselects a pane, preserving Tab / Window / Entire Screen choices; include monitors to preserve entire-screen sharing. Exclude current tab explicitly. Surface switching requests Chrome’s native “Share this tab instead” UX, rather than restarting capture. Audio false is the product recommendation for a visual TV/frame-grab use case, not a Meet implementation fact. [Chrome controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

`video:false`, `min`/`exact` constraints, monitorTypeSurfaces exclude with displaySurface monitor, and preferCurrentTab true with selfBrowserSurface exclude are invalid combinations. Width/height/frameRate are post-selection processing preferences, not a means to preselect or filter a particular source. Cursor is specified as never/always/motion; feature-detect `navigator.mediaDevices.getSupportedConstraints().cursor` and inspect returned settings/capabilities instead of assuming Chrome honors it. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [W3C](https://www.w3.org/TR/screen-capture).

WindowAudio has exclude/window/system hints. Chromium issue documents M141 window fallback to system and M143+ unavailable window-only capture falling back to exclude. Do not promise per-window audio on macOS. `surfaceControl` is not a DisplayMediaStreamOptions member in the retrieved Screen Capture spec/MDN; Captured Surface Control instead uses a CaptureController and methods forwardWheel/increaseZoomLevel/decreaseZoomLevel/resetZoomLevel, with a separate permission prompt. It is unnecessary for this feature. [Chromium issue](https://issues.chromium.org/issues/457269071), [Controller docs](https://developer.chrome.com/docs/web-platform/captured-surface-control), [W3C](https://www.w3.org/TR/screen-capture).

Meet documentation confirms users can choose a tab, window or entire screen and change tabs. It does **not** publish the exact getDisplayMedia argument object; report that exact Meet internals were not verified. [Meet help](https://support.google.com/meet/answer/9308856?hl=en&co=GENIE.Platform%3DDesktop).

## App-window and focus

Chrome’s documentation explicitly defines selfBrowserSurface exclude as hiding the **current tab**, not its native window and not monitors containing it. There is no standard selector excluding an arbitrary native window while preserving Window and Entire Screen panes. App-window rendering via --app does not provide a spec guarantee of which Chrome tabs appear. The expected other-tabs list is an inference, subject to same browser/profile availability; acceptance-test real macOS --app with a normal Chrome window in the same launched profile. Do not assert selfBrowserSurface excludes the native --app window. [Chrome controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls), [W3C](https://www.w3.org/TR/screen-capture).

Create a fresh controller per capture, feature-detect it and set `controller.setFocusBehavior('no-focus-change')` **before** calling getDisplayMedia; this avoids deadline issues. Alternative: immediately after its promise resolves, inspect displaySurface browser/window and set it in the same microtask, before any extra await/timer. Calling after promise-resolution microtask throws; a delay of >1 second is ineffective; setting after resolution for a monitor capture throws. It controls initial tab/window focus, not ongoing focus policies. Conditional Focus shipped Chrome 109. [Chrome Conditional Focus](https://developer.chrome.com/docs/web-platform/conditional-focus).

## macOS and errors

Apple’s current settings path is **System Settings → Privacy & Security → Screen & System Audio Recording**, older macOS calls it Screen Recording. Enable Google Chrome; follow any OS request to relaunch. Google Meet’s help explicitly points to Chrome permission here. Tab sharing vs native window/monitor permission behavior must be checked on the target Mac. [Apple](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac), [Meet](https://support.google.com/meet/answer/9308856?hl=en&co=GENIE.Platform%3DDesktop).

Start directly from a click handler before unrelated asynchronous work; fully active/focused browsing context and transient activation required, otherwise InvalidStateError. Permission cannot be permanently granted for reuse. NotAllowedError means denied/disallowed (includes cancel or policy denial), NotFoundError means no sources, NotReadableError means selected source inaccessible due to OS/hardware lockout, AbortError is uncategorized start failure. There is **no standardized reliably distinct error for user cancel vs macOS permission denial**. Do not parse localized message strings or tell every NotAllowedError that OS permission is absent. Show neutral “Screen sharing wasn’t started”; offer retry and contextual Mac settings help; log name/message diagnostically. [MDN errors](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [W3C](https://www.w3.org/TR/screen-capture).

## Lifecycle / privacy

Attach videoTrack.addEventListener('ended', cleanup) for browser Stop sharing/source closed. Explicit Stop must run cleanup itself and stop **all** tracks, since track.stop() changes readyState to ended but does not dispatch ended. Make cleanup idempotent to handle races. [Track ended](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event), [Track stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop).

Listen to mute/unmute and track.muted to mark capture temporarily unavailable. W3C mandates mute for temporarily inaccessible surfaces, but explicitly leaves whether minimization makes a surface inaccessible to the UA; do not claim all minimized windows emit mute. Persistent inaccessible sources end. Frozen/stale frames are possible: mute plus frame freshness guards are safer than black-pixel heuristics. Listen to video resize and use videoWidth/videoHeight to refresh letterboxing and frame dimensions; re-read track.getSettings().displaySurface for browser/window/monitor label after changes. [W3C closed/minimized](https://www.w3.org/TR/screen-capture), [Video resize](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/resize_event).

Product recommendation: visible LIVE badge, source kind, paused/unavailable state and one-click Stop alongside Chrome's required sharing indicator. Make clear that live rendering stays local and a JPEG is sent only on demand; this is a proposed design, not a browser guarantee. The page cannot robustly identify a self-containing native window/monitor. For cooperative **tab** capture, setCaptureHandleConfig with a per-session random handle and own permitted origin, then feature-detect track.getCaptureHandle and capturehandlechange; compare handle to detect own tab even after switch. Capture Handle is optional and not a universal window/monitor identity API. [Chrome Capture Handle](https://developer.chrome.com/docs/web-platform/capture-handle), [W3C privacy indicators](https://www.w3.org/TR/screen-capture).

## three.js TV, performance and disposal

Use a muted inline autoplay `<video>` with `srcObject = stream`, await successful `play()`, then use `VideoTexture` from `three/webgpu`. Set `colorSpace = SRGBColorSpace`; three.js explicitly requires an sRGB transfer for video textures with WebGPURenderer, and its shipped WebGPU video example uses this configuration. A white, unlit `MeshBasicMaterial` with `toneMapped:false` is the proposed TV material so office lighting/tone mapping does not alter screen readability. Use the same texture/material approach with the renderer's WebGL2 fallback. [VideoTexture at 0.186.1](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoTexture.js), [WebGPU example at 0.186.1](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/examples/webgpu_materials_video.html), [WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html).

Letterbox by centering the content plane over a black backing and scaling to `min(tvWidth/videoWidth, tvHeight/videoHeight)`; no image cropping or stretching. On the video `resize` event, refit and replace/dispose the texture: three.js documents texture dimensions as immutable after initial use, so updating only mesh scale risks an obsolete GPU allocation. Pause/remove source and stop every track on cleanup; dispose texture, geometry and material and remove listeners. `VideoTexture.dispose()` at the checked commit cancels its own pending video-frame callback. [Pinned VideoTexture](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoTexture.js), [video resize](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/resize_event).

`VideoTexture` already uses `requestVideoFrameCallback` to mark updates when video frames arrive; do not force `needsUpdate` on every game tick. WebGPU texture upload code calls `copyExternalImageToTexture`; avoid assuming a zero-copy display pipeline. As an illustrative RGBA pixel-volume calculation, 1920×1080×4 is 8.3 MB/frame, 3840×2160×4 is 33.2 MB/frame, and 5120×2880×4 is 59 MB/frame (these are arithmetic estimates, not measured bus traffic). Recommend 1920×1080 bounds, 15 fps ideal / 30 max initially, then profile on the Mac. A portrait/tall source will be limited by both bounds, preserving its aspect. [Pinned VideoTexture](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoTexture.js), [pinned WebGPU upload](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/renderers/webgpu/utils/WebGPUTextureUtils.js).

`VideoFrameTexture` exists in 0.186.1 and takes frames explicitly through `setFrame`; its typical use is WebCodecs decoding. It is unnecessary for a live HTMLVideoElement and does not establish a universal fix for WebGPU bugs. The checked r186 release notes do not identify an outstanding live-screen VideoTexture blocker; that is not proof that none exist. Older r182 WebGPU context failures were reported on Mac/Linux, a general context issue rather than evidence to replace this feature's texture type. Test both actual Mac WebGPU and WebGL2, especially surface changes and repeated stop/start. [Pinned VideoFrameTexture](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoFrameTexture.js), [release notes](https://github.com/mrdoob/three.js/releases/tag/r186), [upstream issue #32563](https://github.com/mrdoob/three.js/issues/32563).

## On-demand JPEG and the 2-second budget

Prefer `drawImage(video)` into a fresh small canvas, keeping aspect and capping width at 1920 without upscaling, then `toBlob(callback,'image/jpeg',0.8)`. `toBlob` can return null, and unsupported formats fall back to PNG; check both result and MIME. `OffscreenCanvas.convertToBlob({type:'image/jpeg',quality:0.8})` is a promise alternative, not automatically a worker-based/off-main-thread pipeline. `ImageCapture.grabFrame()` returns an ImageBitmap but requires a live video track; `new VideoFrame(video)` snapshots the current frame and adds explicit frame ownership/`close()` obligations. Neither is needed when the TV video already exists. [Canvas encoding](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob), [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob), [grabFrame](https://developer.mozilla.org/en-US/docs/Web/API/ImageCapture/grabFrame), [VideoFrame constructor](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/VideoFrame).

Reject when sharing is off, track ended/muted/disabled, playback has no current data or dimensions are zero; recheck after encoding and before sending. Track session generation and req_id outside the snippet so a Stop/restart cannot upload the previous session's frame. Use video frame callbacks to track observed presentation and recovery after unmute, but do not require a new frame after every request: a static screen may legitimately produce no new frame. A black-pixel heuristic cannot distinguish an intentionally black surface from a minimized/unavailable one; never claim it can. Prefer an unavailable status over returning stale imagery when mute is known. [Track mute semantics](https://www.w3.org/TR/screen-capture), [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).

There is no documented universal canvas/JPEG latency guarantee. Proposed budget: capture/readiness <250 ms when already playing, draw+encode <500 ms, transport+bridge response <1 s, leaving margin; measure p50/p95 end-to-end on the Mac under game load. These are engineering targets, **not measurements**. Do not wait indefinitely for the next video callback. Bound requests, serialize/limit concurrent encodes, enforce a bridge timeout, check sharing/session again before send, and avoid continuous uploads. If jpeg is JSON base64, budget about 4/3 encoded-byte overhead and enforce a message-size limit. The <2 s requirement, grab toast/audit and TTL come from the ticket. [Ticket #15](https://github.com/JeffreyVdb/herdr-3d/issues/15), [toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob).

## Compiling implementation sketch

This is browser-side TypeScript, checked outside the repo with **TypeScript 7.0.2, three 0.186.1, @types/three 0.186.0**, strict mode, ES2022/DOM and bundler module resolution. Chrome extension options/controller are structurally typed locally because DOM library definitions may lag; these declarations are not runtime feature detection. The sketch covers capture/video/TV/encode lifecycle; the app must add a session generation, bounded request handling, live badge/toast/audit and protocol integration. API basis: [getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [Conditional Focus](https://developer.chrome.com/docs/web-platform/conditional-focus), [pinned three VideoTexture](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoTexture.js).

```ts
import { VideoTexture, SRGBColorSpace, MeshBasicMaterial, Mesh, PlaneGeometry } from 'three/webgpu';

interface FocusController { setFocusBehavior(value: 'no-focus-change'): void }
type CaptureWindow = Window & typeof globalThis & {
  CaptureController?: new () => FocusController;
};
type ChromeDisplayOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
  controller?: FocusController;
};

// Invoke synchronously from the Share button's click handler.
export function requestScreen(): Promise<MediaStream> {
  const Controller = (window as CaptureWindow).CaptureController;
  const controller = Controller ? new Controller() : undefined;
  // Before getDisplayMedia is legal, and avoids missing the focus-decision window.
  controller?.setFocusBehavior('no-focus-change');
  const options: ChromeDisplayOptions = {
    video: { width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 15, max: 30 } },
    audio: false, preferCurrentTab: false, selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
    systemAudio: 'exclude', windowAudio: 'exclude',
    ...(controller ? { controller } : {}),
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}

// A 1x1 content plane centered in front of a separate black TV backing.
export async function createTV(stream: MediaStream, tvW: number, tvH: number,
  unavailable: (value: boolean) => void, stopped: () => void) {
  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach(t => t.stop()); throw new Error('No video track'); }
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.srcObject = stream;
  let texture: VideoTexture | undefined;
  const material = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const geometry = new PlaneGeometry(1, 1);
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  let closed = false;
  const resize = () => {
    const w = video.videoWidth, h = video.videoHeight;
    if (closed || !w || !h) return;
    const old = texture;
    texture = new VideoTexture(video); texture.colorSpace = SRGBColorSpace;
    material.map = texture; material.needsUpdate = true; old?.dispose();
    const fit = Math.min(tvW / w, tvH / h);
    mesh.scale.set(w * fit, h * fit, 1); mesh.visible = !track.muted;
  };
  const onMute = () => { mesh.visible = false; unavailable(true); };
  const onUnmute = () => { mesh.visible = true; unavailable(false); };
  const stop = () => {
    if (closed) return;
    closed = true;
    video.removeEventListener('resize', resize);
    track.removeEventListener('ended', stop);
    track.removeEventListener('mute', onMute);
    track.removeEventListener('unmute', onUnmute);
    stream.getTracks().forEach(t => t.stop());
    video.pause(); video.srcObject = null;
    texture?.dispose(); material.dispose(); geometry.dispose(); mesh.removeFromParent();
    stopped();
  };
  video.addEventListener('resize', resize);
  track.addEventListener('ended', stop);
  track.addEventListener('mute', onMute);
  track.addEventListener('unmute', onUnmute);
  try { await video.play(); if (closed) throw new Error('Sharing stopped'); resize(); }
  catch (error) { stop(); throw error; }
  return { video, track, mesh, stop };
}

export async function grabJPEG(video: HTMLVideoElement, track: MediaStreamTrack): Promise<Blob> {
  const available = () => track.readyState === 'live' && !track.muted && track.enabled &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
  if (!available()) throw new Error('Screen frame unavailable');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1920 / video.videoWidth);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('JPEG encoding failed')), 'image/jpeg', 0.8);
  });
  if (!available()) throw new Error('Sharing stopped or muted during frame grab');
  if (blob.type !== 'image/jpeg') throw new Error('JPEG encoder unavailable');
  return blob;
}
```

## Testing

Use the repo's cached Playwright Chromium/WebGL2 path for deterministic integration coverage. Its `game/playwright.config.ts` uses headless Chromium with ANGLE/Vulkan and contributor instructions require cached browsers, `?backend=webgl2`, portlease and the host-wide e2e lock. Do not download/change the production browser or run repository builds during this research. Repo context: [Playwright config](https://github.com/JeffreyVdb/herdr-3d/blob/main/game/playwright.config.ts), [CONTRIBUTING](https://github.com/JeffreyVdb/herdr-3d/blob/main/CONTRIBUTING.md); observations were made from this worktree's files rather than assuming main matches exactly.

Preferred CI method: `page.addInitScript` before navigation replaces `getDisplayMedia` with an animated canvas stream; it exercises real video playback, texture updates, JPEG encoding and stop cleanup while bypassing picker/OS permission. This cannot prove picker options, real track mute, surface-switch UI or macOS permission behavior. The following snippet also passed strict TypeScript checking with **@playwright/test 1.61.1**. [Playwright addInitScript](https://playwright.dev/docs/api/class-page#page-add-init-script), [canvas captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream).

```ts
import type { Page } from '@playwright/test';
export async function installScreenMock(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context');
    let frame = 0;
    const paint = () => {
      context.fillStyle = '#164b9b'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff'; context.font = '48px sans-serif';
      context.fillText(`Shared test frame ${frame++}`, 30, 80);
    };
    paint();
    const timer = window.setInterval(paint, 100);
    const stream = canvas.captureStream(10);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true, value: async () => stream,
    });
    window.addEventListener('pagehide', () => {
      window.clearInterval(timer); stream.getTracks().forEach(t => t.stop());
    });
  });
}
```

Create a fresh mock stream per capture for restart tests (the minimal fixture above supplies one). Cover: success/LIVE/stop; rejected promise (NotAllowedError and InvalidStateError); JPEG signature/MIME/width/aspect; unavailable/ended/no-client cases; request correlation/timeouts; Stop during encode; source resize and texture replacement; repeated start/stop; no uploads absent a request. To emulate Chrome Stop, `track.stop()` alone is insufficient to emit ended: stop and explicitly dispatch an `ended` event in the test, or end the source; synthetic events test handler wiring, not platform behavior. Muted-state logic should also have a controlled injected state fixture. [ended event](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event), [track.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop).

Native capture flags are test-only and depend on Chromium version/display infrastructure. The chrome switches citation is a pinned upstream development snapshot, not a verified stable-154 implementation; the media/content switch files were also checked at the 154.0.8037.92 tag. `--use-fake-device-for-media-stream` substitutes camera/mic devices, so it is not alone a guarantee of a display-capture fixture; `--use-fake-ui-for-media-stream` affects media UI and interacts with screen/tab capture. `--auto-select-desktop-capture-source=<title substring>` auto-selects a matching source but can select a window instead of a tab with the same title; prefer a tab-specific title flag for a dedicated smoke test. `--auto-accept-this-tab-capture` concerns current-tab capture, so a separate smoke request should permit self capture/prefer current tab; it should not be combined blindly with the production self-exclusion request. Avoid a recipe promising arbitrary OS window capture in display-less Linux; use a headed/Xvfb smoke setup where necessary. [Chromium switches pinned at b3ee17bfdb58e9a90d3762b8a844a3130f05024c](https://github.com/chromium/chromium/blob/b3ee17bfdb58e9a90d3762b8a844a3130f05024c/chrome/common/chrome_switches.cc), [Chrome 154 content switches](https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/content/public/common/content_switches.cc), [Chrome 154 media switches](https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/media/base/media_switches.cc).

Manual Mac acceptance matrix: launch the actual helper's `--app` window in the intended profile; keep another regular Chrome window open with two tabs; verify all three picker panes, other-tab visibility, current-tab exclusion versus native-window visibility, tab switch button, no-focus-change behavior, Chrome Stop, app Stop, minimize/restore, window resize, portrait/Retina screens, OS permission denied then enabled, and WebGPU/WebGL2 color/aspect. Record actual Chrome version and macOS version. These tests remain unperformed here, so app-window behavior is explicitly a verification item, not an unresolved request for orchestrator input. Browser behavior basis: [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls), [Conditional Focus](https://developer.chrome.com/docs/web-platform/conditional-focus), [Screen Capture spec](https://www.w3.org/TR/screen-capture).

## Pitfalls

- No API combination guarantees exclusion of the game's native window while retaining all Window/Entire Screen choices. Warn about self-containing monitors and prefer tab/window sharing. [Chrome controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).
- Picker hints are not source constraints; `min`/`exact`, contradictory hints and missing activation can reject before a picker appears. [getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
- Cancel, policy denial and OS lockout cannot be classified reliably by a localized exception message. Use neutral failure UX plus Mac permission help. [MDN errors](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
- Minimize does not universally emit mute; black/frozen content is not definitive proof of unavailability. [Screen Capture spec](https://www.w3.org/TR/screen-capture).
- Explicit `stop()` emits no ended event; cleanup must run directly and be idempotent. [track.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop).
- Resize may require recreating the texture, not just adjusting letterboxing; do not leak callbacks/materials or assign a video before it has usable dimensions. [Pinned VideoTexture](https://github.com/mrdoob/three.js/blob/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8/src/textures/VideoTexture.js).
- A native screen share can expose the LIVE toast itself; a local video stays private only if uploads remain exclusively tied to authorized on-demand requests. This is the ticket's product requirement, not a getDisplayMedia transport restriction. [Ticket #15](https://github.com/JeffreyVdb/herdr-3d/issues/15).

## Sources and saved evidence

Primary URLs are cited inline throughout. Research payloads: `/tmp/screen-three-search.json`, `/tmp/screen-extract.json`, `/tmp/screen-testing-search.json`, `/tmp/screen-frame-docs.json`, `/tmp/screen-flags.json`, `/tmp/chrome-release.html`, `/tmp/three-latest.json`, `/tmp/three-release.json`, plus capture researcher payloads listed in `/tmp/screen-capture-notes.md`. Compile-only artifacts are in `/tmp/screen-research-check`; no repo build/test was run and no repo file was written.
