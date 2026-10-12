# Engine follow-up: MacBook performance, WKWebView/Tauri, and worker art style

Researcher: GROUND (engine brief, follow-up) · Date: 2026-09-28 · Builds on [engine.md](engine.md) and the verifier's
[engine.verify.md](engine.verify.md), incorporating its corrections. Decisions context: [../decisions.md](../decisions.md).

## TL;DR

- **Performance is not a reason to leave the browser engine.** On the M2 Max I ran a game-shaped stress scene with three.js r186:
  - 5 buildings / 30 floors, 240 desks with laptops and chairs, 240 animated workers, shadows, at **3024x1890** (full Retina).
  - **Instanced rigid "goggle-blob" workers** (no skinning): about 2.6 ms per frame with the GPU wait included, and **1.2 ms/frame
    pipelined** (Chrome WebGPU). GPU time was 1.8 ms (timestamp query).
  - **600** of the same workers: 3.1 ms/frame. That leaves a lot of room inside the 8.33 ms budget for **120 Hz**.
  - **Kenney skinned characters** (240): 4.9 ms/frame and 2–3x the CPU/energy of rigid. At 600 they cost 14 ms, so they don't scale.
  - **What actually hurts is non-instanced meshes**: 240 workers built from separate meshes take 17–25 ms/frame (draw-call bound,
    three.js issue #30560). Rule: **everything repeated must be instanced.**
- **WKWebView (Tauri's engine) works and is fast enough, with one catch.** WebGPU works in the system WKWebView (`apple/apple`
  adapter) and CPU/GPU cost is within about 0–30% of Chrome.
  - **The catch:** it caps `requestAnimationFrame` at **60 Hz** by default. I measured 16.67 ms intervals on the 120 Hz ProMotion
    panel, while Chrome 153 delivers 8.33 ms.
  - Turning off the private WebKit feature `PreferPageRenderingUpdatesNear60FPSEnabled` (what `tauri-plugin-macos-fps` does) gives
    a measured **120 Hz** (8.33 ms intervals, 119.8–120 fps sustained over 40 s).
- **Art direction: procedural rigid-part workers (capsule body, goggle strap/rim, tiny arms and legs) are the cheaper and more
  on-style choice.**
  - Measured cost: +26 energy points at 120 fps, against +67 for Kenney skinned (Chrome). Only 10 instanced draw calls cover every
    worker.
  - Animation is plain code (typing arms, bob, sway), which suits agent-written code.
  - Kenney Mini Characters are CC0 and nice, but blocky humans, not round goofy blobs.
- **Recommendation (restated):**
  - **Stack:** three.js r186 (WebGPURenderer, WebGL2 fallback) + TypeScript, packaged as a **Tauri 2 app** with the 120 Hz unlock.
  - **Why Tauri:** the shell is needed anyway for the SSH tunnel and for launching Ghostty.
  - **During development:** Chrome at `http://localhost:<port>` through an SSH `-L` forward.
  - **Godot 4.7 is still the runner-up.** Nothing I measured shows a performance gap that justifies giving up the server-side agent
    loop. I didn't benchmark Godot on the Mac (it would need an install), so the Godot-side numbers are from docs, not measured.
- **Mesa on the server:** installed (approved). It's **useful for speed, not for WebGPU**. Chromium's WebGL2 through ANGLE→Vulkan→
  **llvmpipe** runs the stress scene in about 174 ms/frame, against about 630 ms with SwiftShader (3.6x). Chrome's WebGPU (Dawn)
  still picks SwiftShader and still gives blank page screenshots, so server screenshots stay WebGL2.
- **Incident:** during cleanup I killed an SSH ControlMaster process on the Mac. See §7. The four `herdr --remote` clients were not
  affected.

## 1. Stress benchmark on the Mac (hard evidence)

### Setup
- **Scene**: [`engine-bench/index.html`](engine-bench/index.html), built with three.js r186 (`three@0.186.1`) and `WebGPURenderer`
  (`forceWebGL` for the WebGL2 rows).
  - 5 buildings with [8,6,7,4,5] = **30 floors**, open-front cutaway boxes. Slabs and walls are instanced.
  - **240 desks, chairs and laptops** from the Kenney Furniture Kit (CC0), instanced per sub-mesh.
  - One shadow-casting directional light, 2048² PCF shadow map, toon materials.
  - The camera orbits the whole city, so everything is visible. That's the worst case, because nothing is culled.
- **Worker variants** (`kind=`):
  - `rigid`: an original procedural character made of 10 parts (capsule body tinted in 4 colours, overalls, goggle strap, goggle
    rim, eye, pupil, 2 arms, 2 legs). **One `InstancedMesh` per part**, animated on the CPU each frame (typing arms, bob, sway,
    wandering pupil). No skinning.
  - `rigidmesh`: the same character, but every part is its own `Mesh`. This shows what forgetting to instance costs.
  - `skinned`: **Kenney Mini Characters** (CC0 GLB, 7-joint skeleton, body + head meshes, about 1.26k vertices), cloned with
    `SkeletonUtils`. Each has its own `AnimationMixer` playing `sit` or `interact-right`.
  - `none`: buildings and furniture only.
- **Serving**, following the verifier's correction (a): the scene was served from **server 127.0.0.1:18770**. The Mac reached it
  through a Mac-initiated **`ssh -L 18770:127.0.0.1:18770 dev@devbox`**, so the page origin is `http://127.0.0.1`, a
  secure context. That matches the SSH-only access decision. Every result asserts `secure`, `backend` and `adapter`.
  - **Negative control (verifier HIGH, confirmed):** I opened the same page at `http://devbox:18771` (tailnet, plain
    HTTP). Chrome returned `"secure":false,"hasGPU":false,"backend":"webgl2"`, a **silent fallback**, so the game must assert the
    backend itself.
- **Timing**, following verifier correction (b): the timing is my own, not `renderer.info`.
  - `frameMs` is `performance.now()` around update + `render()` + **waiting for GPU completion**. On WebGPU that wait is
    `device.queue.onSubmittedWorkDone()`; on WebGL2 it's a 1-pixel `readPixels`. This is the per-frame cost including the GPU,
    run serially, so it's pessimistic.
  - `pipelinedMs` is 300 frames with a sync every 4 frames. That's throughput, close to how a real rAF loop overlaps CPU and GPU.
  - `gpu` comes from three's `trackTimestamp` + `resolveTimestampsAsync('render')`, i.e. WebGPU **timestamp queries**. They are
    consistent with the wall-clock numbers (e.g. 1.82 ms GPU against 2.6 ms serialized). On WebGL2 they are unavailable: Chrome on
    the Mac exposes no disjoint timer query.
  - rAF cadence and sustained fps were measured separately in **visible windows**; see §2.
- Chrome 153.0 (installed `/Applications/Google Chrome.app`), headless via `playwright-core` 1.63.0 in `~/h3d-tools` (approved).
  WKWebView ran through a small Swift harness ([`engine-bench/wkbench.swift`](engine-bench/wkbench.swift)).
  - WKWebView rounds `performance.now()` to 1 ms, so its medians are integers.
  - The Mac was **on battery** (85% → 82%) with normal desktop apps open, so some background noise is included.
  - Raw JSONL: [`engine-bench/results/`](engine-bench/results/).

### Results: 3024x1890 (DPR 2, full Retina), shadows on unless noted

| Engine | Backend | Workers | n | Frame ms, med / p95 (incl. GPU wait) | Pipelined ms/frame | JS submit ms | GPU ms (timestamp) |
|---|---|---|---|---|---|---|---|
| Chrome 153 | WebGPU | buildings only | 0 | 1.7 / 1.9 | 0.62 | 0.2 | 0.72 |
| Chrome 153 | WebGPU | **rigid instanced** | 240 | **2.6 / 3.0** | **1.21** | 0.3 | 1.82 |
| Chrome 153 | WebGPU | rigid instanced | 300 | 2.7 / 3.1 | 1.45 | 0.3 | 1.91 |
| Chrome 153 | WebGPU | rigid instanced | 600 | 3.1 / 4.4 | 1.56 | 0.3 | 2.36 |
| Chrome 153 | WebGPU | rigid instanced, shadows off | 240 | 2.4 / 2.6 | 0.99 | 0.2 | 1.35 |
| Chrome 153 | WebGPU | rigid **non-instanced** | 240 | 16.8 / 19.4 | 8.91 | 11.0 | 1.56 |
| Chrome 153 | WebGPU | **Kenney skinned** | 240 | **4.9 / 7.4** | **2.77** | 1.9 | 1.99 |
| Chrome 153 | WebGPU | Kenney skinned | 300 | 6.1 / 8.7 | 3.39 | 2.6 | 2.23 |
| Chrome 153 | WebGPU | Kenney skinned | 600 | 14.1 / 16.2 | 7.25 | 9.5 | 2.24 |
| Chrome 153 | WebGPU | Kenney skinned, shadows off | 240 | 4.5 / 5.1 | 2.53 | 1.8 | 1.65 |
| Chrome 153 | WebGL2 (ANGLE→Metal) | buildings only | 0 | 2.3 / 2.5 | 1.87 | 0.1 | n/a |
| Chrome 153 | WebGL2 | rigid instanced | 240 | 2.8 / 3.4 | 2.16 | 0.2 | n/a |
| Chrome 153 | WebGL2 | rigid instanced | 600 | 3.8 / 4.0 | 2.61 | 0.2 | n/a |
| Chrome 153 | WebGL2 | rigid non-instanced | 240 | 12.9 / 15.6 | 10.7 | 7.2 | n/a |
| Chrome 153 | WebGL2 | Kenney skinned | 240 | 5.4 / 6.6 | 3.29 | 2.0 | n/a |
| Chrome 153 | WebGL2 | Kenney skinned | 600 | 9.7 / 11.3 | 7.07 | 5.3 | n/a |
| WKWebView (macOS 26.6.2) | WebGPU | buildings only | 0 | 1 / 1 | 0.47 | 0 | 0.63 |
| WKWebView | WebGPU | **rigid instanced** | 240 | **3 / 4** | **1.43** | 0 | 1.30 |
| WKWebView | WebGPU | rigid instanced | 300 | 3 / 4 | 1.50 | 0 | 1.99 |
| WKWebView | WebGPU | rigid instanced | 600 | 4 / 6 | 2.92 | 0 | 1.79 |
| WKWebView | WebGPU | rigid non-instanced | 240 | 25 / 28 | 12.82 | 16 | 2.60 |
| WKWebView | WebGPU | **Kenney skinned** | 240 | **5 / 8** | **3.60** | 3 | 2.19 |
| WKWebView | WebGPU | Kenney skinned | 300 | 7 / 10 | 4.36 | 4 | 2.46 |
| WKWebView | WebGPU | Kenney skinned | 600 | 18 / 19 | 9.60 | 13 | 3.94 |
| WKWebView | WebGL2 | rigid instanced | 240 | 4 / 4 | 2.92 | 0 | n/a |
| WKWebView | WebGL2 | Kenney skinned | 240 | 6 / 7 | 4.60 | 3 | n/a |
| WKWebView | WebGL2 | rigid non-instanced | 240 | 19 / 20 | 15.34 | 9 | n/a |

Scene size: rigid 240 = 578k triangles per frame; Kenney skinned 240 = 389k triangles per main pass. Draw calls in the main pass
(three's counter, which isn't reliable across backends): rigid instanced 25; skinned about 495; non-instanced about 2.4k.

What this shows:
1. **The GPU is not the bottleneck.** GPU time stays at 1.3–4 ms even at 600 workers and full Retina with shadows. The costs that
   grow are **CPU per draw call and per skinned object** ("JS submit"). WebGPURenderer's per-object overhead is the known open
   issue [three.js #30560](https://github.com/mrdoob/three.js/issues/30560) (one UBO per object, high priority, still open
   2026-09-15). It's why `rigidmesh` is 6–8x slower than `rigid` even though its GPU time is similar.
2. **WebGPU vs WebGL2 is a wash at this scale.** WebGPU pipelines better (1.2 vs 2.2 ms/frame for rigid in Chrome). WebGL2 is
   slightly better with many draws/skins (skinned 600: 9.7 vs 14.1 ms), matching #30560. Keep `WebGPURenderer` (auto) and don't
   depend on WebGPU-only features. The WebGL2 fallback path runs about as fast.
3. **WKWebView per-frame cost is close to Chrome's.** It's within about 0–25% for instanced scenes. Heavy draw-call scenes are
   about 50% slower (non-instanced 25 vs 17 ms; skinned 600 18 vs 14 ms).
4. **Budget at 120 Hz is 8.33 ms.** Instanced rigid workers use about 15–35% of it even at 600 workers, which leaves room for UI,
   the xterm.js overlay, particles and post-FX. 240–300 skinned characters fit too, but a larger crowd would need a baked or
   instanced skinning technique (§5).

### Sustained runs in a visible window (rAF-driven, 1920x1200 canvas, 40 s each) plus energy
Energy was sampled with `top -stats cpu,power` (macOS "energy impact", no sudo), averaged over 5 samples of 4 s. It's the sum over
Chrome/WebKit/harness processes, and **includes any other open Chrome/Safari tabs**; the idle baseline is 25–26. GPU watts were
**not** measured: `powermetrics` needs root, which the unattended probe did not have.

| Run | Sustained fps | Energy (idle baseline ≈ 25) | Δ vs idle | WindowServer energy |
|---|---|---|---|---|
| idle | — | 24.6 / 26.3 | 0 | 20–29 |
| Chrome WebGPU, rigid 240 | **120.0** (4801 frames/40 s) | 51.7 | **+26** | 50 |
| Chrome WebGL2, rigid 240 | 120.0 | 70.8 | +45 | 50 |
| Chrome WebGPU, Kenney skinned 240 | 120.0 | 92.3 | **+67** | 46 |
| WKWebView WebGPU (default), rigid 240 | **60.0** (capped) | 45.3 | +20 | 29 |
| WKWebView WebGPU (default), skinned 240 | 60.0 (capped) | 97.8 | +72 | 41 |
| WKWebView WebGPU **120 Hz unlocked**, rigid 240 | 120.0 (first attempt 62.8; see caveat) | 56.0 | +30 | 50 |
| WKWebView WebGPU **120 Hz unlocked**, skinned 240 | 119.8 | 137.6 | +112 | 48 |

Takeaways for battery:
- **Rigid instanced workers cost 2.5–4x less energy than skinned** at the same frame rate.
- WebGPU used less energy than WebGL2 in Chrome (+26 vs +45).
- The single biggest energy lever is frame rate. **The game should not render at 120 fps all the time.** It should:
  - drop to 30–60 fps when idle,
  - render on demand when nothing animates,
  - pause entirely when the window is hidden (Tauri `backgroundThrottling`, §2),
  - offer a "battery saver" 60 Hz cap.
- Caveat: the first unlocked rigid run held only 62.8 fps. A re-run gave 120. Most likely the window wasn't frontmost or visible
  (other windows were on top, and one bench window was closed by accident). WebKit throttles rAF for occluded windows. That's
  expected behaviour, but a benchmark in a visible window needs the window in front.

## 2. WKWebView / Safari WebGPU vs Chrome on macOS 26: gaps and caveats

**Measured here:**

| Aspect | Chrome 153 | System WKWebView (macOS 26.6.2) |
|---|---|---|
| WebGPU available on a secure origin | yes (`apple/metal-3`) | yes (`apple/apple`) |
| WebGPU on plain-HTTP tailnet origin | **no**, silent fallback to WebGL2 | same rule (secure context) |
| rAF on the 120 Hz ProMotion panel, visible window, no mouse movement, on battery | **8.33 ms (120 Hz)** | **16.67 ms (60 Hz)** by default; **8.33 ms** after the private feature toggle |
| `performance.now()` resolution | fine (sub-ms) | **1 ms** (coarsened) |
| GPU timestamp queries via three | yes | yes (`gpu` column populated) |
| Per-frame cost, instanced scene | baseline | about +0–25% |
| Per-frame cost, draw-heavy scene | baseline | about +30–50% |

The 120 Hz unlock in the harness is a private API (Swift):
```swift
// same approach as tauri-plugin-macos-fps
let feats = WKPreferences.perform(NSSelectorFromString("_features")).takeUnretainedValue() as! [NSObject]
let f = feats.first { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" }!
// call -[WKPreferences _setEnabled:forFeature:] with a real BOOL (perform(with:false) passes an object = YES)
typealias Fn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
let sel = NSSelectorFromString("_setEnabled:forFeature:")
unsafeBitCast(cfg.preferences.method(for: sel), to: Fn.self)(cfg.preferences, sel, false, f)
```
A trap I hit: calling `perform(_:with:false,with:)` passes an NSNumber pointer, which is read as `YES`, so nothing changes.
Private API is fine for a personal, non-App-Store app, but it can break with a WebKit update. The game should detect the rAF rate
at startup and log it.

**From docs/issues** (not re-measured):
- **Tauri's `backgroundThrottling`** (window config, Tauri ≥ 2.3, macOS 14+) accepts `disabled`, `throttle` or `suspend`, and
  defaults to `suspend`. When the window is hidden or minimised, it throttles timers and can suspend the page. That's good for
  battery, but the **bridge WebSocket/heartbeat must survive it**: reconnect on resume, and keep the SSH tunnel in native (Rust)
  code rather than JS. Sources: [Tauri config](https://v2.tauri.app/reference/config/),
  [wry #1246](https://github.com/tauri-apps/wry/issues/1246).
- **Don't use a transparent Tauri window.** `transparent: true` recomposites the whole window every frame. At 120 Hz that measured
  about 620 mW of GPU power against about 75 mW when opaque ([tauri #15471](https://github.com/tauri-apps/tauri/issues/15471),
  open, Jun 2026).
- **120 Hz plugin:** [`tauri-plugin-macos-fps`](https://docs.rs/tauri-plugin-macos-fps) toggles the same feature I toggled. It
  isn't tested inside Tauri here.
- **Feature gaps in Safari/WebKit WebGPU:**
  - **No `subgroups`** up to Safari 27.1 TP, while Chrome has had them since 144 ([caniuse](https://caniuse.com/wf-webgpu-subgroups)).
  - timestamp-query is reported on 93% of Safari clients against 99.5% of Chrome ([web3dsurvey](https://web3dsurvey.com/webgpu/features/timestamp-query));
    it works on this Mac.
  - **Neither gap matters here**: three's default materials don't need them.
- **Bugs:**
  - A WebKit GPU-process memory leak on 26.x is marked fixed ([WebKit 303203](https://bugs.webkit.org/show_bug.cgi?id=303203)).
  - An ImGui "device lost" in 26.1 is still open ([imgui #9103](https://github.com/ocornut/imgui/issues/9103)).
  - One report of judder inside Tauri on an M2 Pro, while the same scene was smooth in Safari and Chrome
    ([Babylon forum, Oct 2025](https://forum.babylonjs.com/t/performance-between-safari-and-wkwebview-tauri/60811)). That's
    plausibly the 60 Hz cap.
- **Memory:** WKWebView has no fixed or raisable limit; the web process can be killed under memory pressure
  ([Apple forum 133449](https://developer.apple.com/forums/thread/133449)). This scene is tiny (a few MB of GLB). Handle
  `webViewWebContentProcessDidTerminate` by reloading.
- **Chrome caveat:** Chromium 147/148 betas capped rAF at 60 Hz on Macs unless the mouse was moving
  ([crbug 496616814](https://issues.chromium.org/issues/496616814)). **Chrome 153 stable on this Mac gives 120 Hz without mouse
  movement** (headed Playwright window, on battery), so the cap didn't ship or was reverted. Re-check after Chrome updates.

## 3. Re-evaluation: three.js + Tauri vs Godot 4.7 (native Metal) for MacBook performance and battery

| Factor | three.js r186 + Tauri 2 (WKWebView) | Godot 4.7.2 native Metal 4 |
|---|---|---|
| Frame time for this game's scene | **Measured**: 1.4–3 ms/frame at 3024x1890 for 240–300 instanced workers; 5–7 ms skinned | **Not measured** (no install). Likely lower CPU per draw: MultiMesh instancing, native Metal 4 driver, GPU skinning. The docs call the Metal driver "significantly faster, particularly in CPU-bound scenarios" ([4.7 docs](https://docs.godotengine.org/en/4.7/engine_details/architecture/internal_rendering_architecture.html)). |
| 120 Hz ProMotion | Yes with the private toggle (measured), or natively in Chrome | Probably, with V-Sync, but an older issue reported a cap around 90 fps on M1 Pro ([godot #64474](https://github.com/godotengine/godot/issues/64474)). Not verified. |
| Battery | Measured deltas above; frame-rate policy and instancing dominate | Low Processor Mode (render only on change) is built in and tunable. The idle *editor* had battery drain issues fixed in 2026 ([#116845](https://github.com/godotengine/godot/issues/116845)). No browser/WindowServer compositing layer, but WindowServer cost was similar in my runs (about 50 at 120 Hz for both Chrome and WKWebView). |
| Headroom for more workers | Instanced rigid: 600 workers at 3–4 ms. Skinned beyond about 300 needs a technique (§5). | Probably higher for skinned crowds. |
| SSH tunnel + launching Ghostty | Tauri Rust side (`std::process::Command`, `open -a Ghostty`) | `OS.execute` / `OS.create_process`. Equivalent. |
| Agent dev loop on the Linux server | **Works now** (WebGL2 screenshots, faster with mesa) | Headless has no pixels; needs Xwayland/weston + mesa, which is untested |

**Verdict:** for *this* game (a few hundred small low-poly workers, cutaway floors, UI-heavy), the browser stack measured well
inside a 120 Hz budget on the M2 Max, with energy dominated by frame rate and instancing choices. Godot would probably be somewhat
more efficient per draw, but its advantage only shows at skinned-crowd scales we don't plan for. It would cost the server-side
agent loop and the HTML/xterm.js UI. **Recommendation unchanged, sharpened:**

1. **Primary: three.js r186 + TypeScript, `WebGPURenderer` (auto WebGL2 fallback), packaged as a Tauri 2 app** (2.12.0,
   2026-09-26):
   - Opaque window.
   - 120 Hz unlock with a startup assertion of the rAF rate.
   - `backgroundThrottling` left at `suspend`.
   - The Rust side owns the SSH tunnel (`ssh -N -L` with **`-o ControlMaster=no -o ControlPath=none`**, see §7) and the Ghostty
     launcher.
   - Frontend is served by Tauri (`tauri://localhost`, a secure context). *To verify:* WebGPU under Tauri's real origin was not
     tested; only the raw WKWebView was.
   - Frame-rate policy: 120 when animating or interacting, 60 or 30 idle, on-demand when nothing moves, a battery-saver toggle.
   - **Instance everything repeated.** Workers are rigid-part `InstancedMesh`es.
2. **Dev loop:** Vite on server `127.0.0.1:5173`. The user and agents use `ssh -L 5173:127.0.0.1:5173` and open
   `http://localhost:5173` in Chrome, which is secure, so WebGPU works. The loopback name means there's no `allowedHosts` problem
   either (verifier c). Assert `isSecureContext`, the backend and the adapter in `window.__info`, and **fail Mac-shot checks if
   the backend isn't `webgpu` with vendor `apple`**.
3. **Runner-up: Godot 4.7.2**, if later needs shift to thousands of skinned characters or heavy VFX. A one-hour Godot MultiMesh
   port of this benchmark would settle the per-draw question if numbers are wanted (needs approval to download Godot.app on the
   Mac).
4. **Babylon.js 9** (verifier e): same browser loop, and it has crowd tools three.js lacks out of the box. Neither changes the
   pick for our workload:
   - Baked texture (vertex) animations with thin instances
     ([docs](https://doc.babylonjs.com/features/featuresDeepDive/animation/baked_texture_animations)).
   - **WebGPU snapshot rendering**, i.e. render-bundle replay that cuts per-draw CPU, the exact cost that dominates our
     `rigidmesh` and skinned rows ([docs](https://doc.babylonjs.com/setup/support/webGPU/webGPUOptimization/webGPUSnapshotRendering)).
   - With rigid instanced workers we're already at 25 draw calls, so snapshot rendering would save about 0.3 ms. It would matter
     only if we went skinned or non-instanced at scale.

## 4. Mesa on the server: useful? (approved "if useful")

I installed `mesa-vulkan-drivers vulkan-loader vulkan-tools` (AlmaLinux appstream 25.2.7 / 1.4.328). `vulkaninfo` shows
`llvmpipe (LLVM 21.1.8, 256 bits)`, Vulkan 1.4.318.

| Server render path (Playwright Chromium 149 headless, stress scene rigid 240, 1512x945) | ms/frame | Screenshot |
|---|---|---|
| WebGL2 via ANGLE→SwiftShader (no mesa) | about 630 | OK |
| **WebGL2 via ANGLE→Vulkan→llvmpipe** (`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json --use-vulkan=native --use-angle=vulkan`) | **about 174** | OK |
| WebGPU (Dawn) with the same flags | about 700–740 | Adapter is still `google/swiftshader`: Dawn doesn't pick lavapipe. **Page screenshot still blank.** |
| WebGPU, pixels read back in-page via `readRenderTargetPixelsAsync` | — | Geometry is right, but the format/stride of my quick decoder was wrong (stripes). Needs work, not proven. |
| WebGPU on SwiftShader, full stress scene, without mesa flags | — | Intermittent `OperationError: A valid external Instance reference no longer exists.` |

**Verdict:** mesa is **useful**. It makes server screenshot tests about 3.6x faster, and its WebGL2 path goes through the same
three.js node materials. It does **not** give WebGPU-backend screenshots on the server. Keep WebGPU verification on the Mac
(`scripts/mac-shot` asserting `webgpu` + `apple`). I left mesa installed. Remove it with
`sudo dnf remove mesa-vulkan-drivers vulkan-tools` if unwanted.

## 5. Art style: Minions-like but original, round goofy workers

**What the benchmark says:** the procedural rigid-part worker (screenshot below) is:
- **Cheapest:** 10 draw calls total for all workers, and +26 energy at 120 fps against +67 for skinned.
- **Most scalable:** 600 workers at 3.1 ms.
- **Best matched to the brief:** a capsule body, one big goggle, a strap, tiny arms and dangling legs read as "small round goofy
  worker" with no Illumination IP (single-colour pastel bodies, blue overalls; no yellow-plus-denim-plus-two-goggles combination
  required).
- **Agent-friendly:** animations are ~20 lines of code (typing, bob, sway, pupil look). Extra states are just more code paths and
  cost nothing extra:
  - sleeping zZz: slump + sprite,
  - fired: walk-off along a path, carrying a box mesh,
  - blocked: "?" bubble.

(These are benchmark placements: workers face away from their laptops and one laptop row floats. Visuals weren't tuned.)

**Recommendation:**
- **Procedural rigid-part workers as the main cast.** Build them in code (or as one small hand-made GLB per *part*, e.g. from
  Blender later) and render them with one `InstancedMesh` per part, with per-instance colour (and, later, per-instance accessory
  masks: hats, headsets, hair tufts).
- Use skinned characters only for rare hero moments, if at all.
- If per-joint deformation is ever needed at crowd scale, the options are:
  - vertex-animation textures (VAT) on `InstancedMesh` (DIY in three; built into Babylon),
  - three's WebGPU-only per-instance skinning (`InstancedSkinnedMesh`, PR [#33644](https://github.com/mrdoob/three.js/pull/33644)).
    *Flag:* this class is **not** in the published `three@0.186.1` package (grep found nothing), so treat it as not yet
    available.

**CC0 / CC-BY assets matching this style** (verify licence per pack at download time):

| Asset | Licence | Format | Fit |
|---|---|---|---|
| [Quaternius Cute Animated Monsters](https://quaternius.com/packs/cutemonsters.html) | **CC0** (page still says CC0) | FBX/OBJ/Blend/**glTF**, rigged + animated, 21 models | Closest ready-made "round goofy creature"; good reference or base for goggles |
| [Quaternius Animated Platformer Character](https://poly.pizza/m/kKtL4zvS3n) | CC0 (per Poly Pizza) | FBX/glTF, animated | Cute round hero |
| [Kenney Mini Characters](https://kenney.nl/assets/mini-characters) | CC0 | GLB, skinned, 32 clips (verified in the downloaded GLB: idle, walk, sit, interact-left/right, emote-yes/no, …) | Measured above: fine at ≤300, but blocky humans, not blobs |
| [Kenney Blocky Characters v2](https://kenney.nl/assets/blocky-characters) | CC0 | animated | Blocky, off-style |
| [KayKit Adventurers](https://kaylousberg.itch.io/kaykit-adventurers) | CC0 | FBX + glTF, rigged | Chunky, cute, but humanoid |
| [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) / [KayKit Furniture Bits](https://kaylousberg.itch.io/furniture-bits) | CC0 | GLB / glTF | Desks, chairs, laptops (used in the benchmark) |
| [Poly Pizza "blob" search](https://poly.pizza/search/blob), [Sketchfab CC0 filter](https://sketchfab.com/search?features=downloadable&licenses=7c23a1ba438d4306920229c12afcb5f9&type=models) | mixed CC0 / **CC-BY** per model | glTF | Hunting ground. CC-BY needs attribution in the credits. |

**Quaternius licence change** (verifier d), from the [QAL licence page](https://quaternius.com/license.html), updated
**2026-08-28**:
- Commercial and personal games are allowed, with no credit required.
- It forbids redistributing the assets "as a standalone asset … regardless of how much the Assets have been modified".
- It isn't retroactive, and so far only the newest pack (Bestiary – Dungeon Monsters) is labelled QAL; older packs still say
  CC0.
- A Poly Pizza listing of Quaternius' "Animated Base Character" says **CC-BY**, so check each item.
- **Policy:** record per-pack licences in `public/assets/LICENSES.md`. Don't commit QAL assets to a public repo; fetch them with a
  script instead. The procedural cast avoids the question altogether.

## 6. Verifier corrections: how this follow-up handles them

| Verifier item | Handling |
|---|---|
| (a) HIGH: WebGPU needs a secure context | Benchmark served via Mac-initiated `ssh -L` to `127.0.0.1`. Every result records `secure`/`hasGPU`/`backend`/`adapter`. The negative control on `http://devbox:18771` confirmed a silent WebGL2 fallback. |
| (b) `renderer.info` is not a timer | Own `performance.now()` + GPU-completion sync, a pipelined throughput loop, three's WebGPU timestamp queries (plausible against wall clock), and rAF-cadence and sustained-fps runs in visible windows. |
| (c) Vite `allowedHosts` | Moot with the loopback tunnel (`localhost` is allowed by default). Never `allowedHosts: true`. |
| (d) Quaternius licence | §5: QAL 2026-08-28 terms, per-pack check, don't commit QAL files. |
| (e) Babylon.js 9 | §3 point 4: same loop; VAT + snapshot rendering would help only skinned or non-instanced crowds. |
| `mac-shot.sh` `$1` quoting bug | Build the URL locally and pass it as a quoted argument, e.g. `ssh mac "cd ~/h3d-tools && BASE=http://127.0.0.1:5173 node run.mjs … $(printf %q "$query")"`. Fail on a backend mismatch. |

## 7. Incident + cleanup

- **Incident:** a typical Mac ssh config with `Host * ControlMaster auto, ControlPath ~/.ssh/sockets/%r@%h:%p, ControlPersist 10m`
  means an `ssh -f -N -L 18770:… dev@devbox` **becomes the shared ControlMaster** for `dev@devbox:22`.
  - During cleanup that PID was killed (it held the 18770 listener).
  - Any *plain* `ssh devbox` sessions opened meanwhile would have been multiplexed through it and **dropped**.
  - The `herdr --remote` clients use their own `-F`/`-S` control sockets and were checked afterwards: all still running.
  - **Design consequence:** the game's native tunnel must use `ssh -o ControlMaster=no -o ControlPath=none -N -L …` (or a private
    `-S` socket, as herdr does), so it never becomes or joins the user's shared master. Killing the game's tunnel must not affect
    other SSH sessions.
- **Cleanup done:**
  - Mac: tunnel closed; `/tmp/h3d-*` and bench screenshots removed; `~/h3d-tools` kept (approved install: `playwright-core`
    1.63.0, `run.mjs`, `soak.sh`, `wkbench` + source).
  - Server: bench HTTP servers on 18770/18771 stopped. Mesa Vulkan packages left installed (approved).
  - Bench windows on the Mac were visible for about 40 s each (they close themselves). One was closed by accident, and that run
    was redone.
  - No herdr session, workspace or pane was touched.
- The harness and raw results are kept for reproducibility in [`engine-bench/`](engine-bench/). Assets and three aren't committed.

## 8. Open questions

1. OK to rely on a **private WebKit feature toggle** for 120 Hz in the Tauri shell? Fine outside the App Store, but it may break
   on a macOS update. The fallback is 60 Hz.
2. **Frame-rate policy:** 120 Hz while interacting, dropping to 30–60 idle and paused when hidden, plus a manual battery-saver
   toggle. Agreed?
3. Want a **Godot MultiMesh port** of this benchmark to close the "measured vs docs" gap? It needs Godot 4.7.2 downloaded on the
   Mac, about 150 MB, to `/Applications` or `~/Applications`.
4. For GPU watts: run `sudo powermetrics --samplers gpu_power,cpu_power -i 1000 -n 30` on the Mac while a soak runs. The
   unattended probe had no root there.
5. Worker design: go procedural (capsule + goggle + tiny limbs), or commission a single hand-modelled base mesh per part in Blender
   later for extra charm? Both render the same way.
