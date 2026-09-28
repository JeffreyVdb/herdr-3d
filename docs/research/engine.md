# Engine / rendering stack + dev/test loop (herdr-3d)

Researcher: GROUND (engine brief) · Date: 2026-09-28

## TL;DR

- **Pick: three.js (r186, `three/webgpu` WebGPURenderer with automatic WebGL2 fallback) + TypeScript + Vite, UI in plain HTML/CSS
  over the canvas, served from `devbox` and opened in Chrome (or Safari 26) on the Mac.** Chrome/Safari reach Metal
  through their WebGPU layer (Dawn in Chrome, WebKit in Safari). On the Mac, headless Chrome started over SSH got an
  `apple / metal-3` WebGPU adapter and rendered the test scene.
- **This is the only candidate where agents can close the whole loop on the Linux server, with no installs.** The server has no
  GPU (QEMU std-VGA), but Playwright's bundled Chromium 149 with SwiftShader rendered a shadowed three.js scene headless there, and
  a screenshot was taken. Final checks on real Metal run on the Mac, driven from the server over SSH: headless Chrome takes the
  screenshot and `scp` brings it back. No Claude Code instance is needed on the Mac.
- **Runner-up: Godot 4.7.2**, which has a native Metal 4 driver, text `.tscn` scenes, a CLI and good glTF import. It is the better
  pure *game engine* (lighting, AnimationTree, and navmesh for wandering workers). But on this server `--headless` uses a dummy
  renderer: I confirmed that viewport capture returns `null` and that a real renderer fails with "Unable to create DisplayServer".
  Seeing anything on the server would need `xwayland-run`/weston plus mesa installed. Godot also has no terminal widget, and its
  UI/menus take more work than HTML.
- **Rejected:**
  - **Unity 6.6 / Unreal 5.8:** GUI-editor-centric, heavy, poor fit for agents, and would need an editor on the Mac.
  - **SceneKit:** soft-deprecated at WWDC25.
  - **RealityKit:** Xcode-only, can't be tested on Linux, and has thinner training data.
  - **Bevy 0.19:** API churn every release, so model training data goes stale; slow Rust compiles; weak UI/text.
  - **raylib 6.0:** too low-level (no scene graph, UI or animation blending).
- The Mac already has almost everything needed: Chrome, Safari 26, node 26.7, pnpm, Rust, **Xcode 27.0 (license not yet
  accepted; CLT active)**, claude 2.1.237, codex 0.148.0 and herdr 0.9.0.
  - **`screencapture` over SSH fails** ("could not create image from display"; there is no Screen Recording permission for sshd).
  - Apps launched over SSH **can** open windows in Theo's GUI session and capture their own frames. Headless Chrome needs no
    permission at all.

## 1. Environment (verified 2026-09-28)

### Mac: `devmac`
Commands: `ssh devmac bash -s < probe.sh`. Theo's login shell is fish, so wrap commands in `bash -c`.

| Item | Value |
|---|---|
| OS | macOS 26.6.2 (25G83) |
| GPU | Apple M2 Max, 38 cores, **"Metal Support: Metal 4"**. `recommendedMaxWorkingSetSize` is about 26.8 GB (unified memory). |
| Display | Built-in XDR, 3024x1964, online. The user was active at the console during the probe. |
| Xcode | `/Applications/Xcode.app` **27.0 (27A266a)**, but `xcode-select -p` points to `/Library/Developer/CommandLineTools` (CLT 26.6). `xcodebuild` errors with *"You have not agreed to the Xcode license agreements"*, and the `metal` shader compiler is not reachable. |
| Swift | 6.3.3 (CLT) |
| Toolchains | brew; rustup/rustc 1.98.1 (target aarch64-apple-darwin only); node v26.7.0; pnpm; python 3.14; go; zig; `sdl3`, `llvm@21` (brew) |
| Agents | `claude` 2.1.237, `codex` 0.148.0, `herdr` 0.9.0. The Mac already runs `herdr --remote dev@devbox --session …` clients. |
| Apps | Google Chrome, Safari, Ghostty, iTerm, Xcode. **No** Godot, Unity Hub, Unreal or Blender. |

What works over SSH:

| Test | Result |
|---|---|
| `screencapture -x /tmp/x.png` | **Fails**: `could not create image from display`. `launchctl asuser 501 …` also fails: `Could not switch to audit session …: Operation not permitted`. sshd has no Screen Recording permission, and the TCC database is not readable. |
| Offscreen Metal from `swift script.swift` over SSH | **Works**. `MTLCreateSystemDefaultDevice()` returns `Apple M2 Max`. I rendered into a texture, read back pixels `255 153 204 255` and wrote a PNG. No window and no permission were needed. |
| AppKit window from a binary run directly over SSH, or through `open -W -n X.app` | **Works**. Because Theo is logged in at the console, the window appears on his screen. The app captured its own content view (`cacheDisplay`) to a PNG. Engines capturing *their own* framebuffer (Godot `get_viewport().get_texture().get_image()`, `canvas.toDataURL`, Playwright `page.screenshot`) avoid TCC completely. |
| Headless Chrome (installed `/Applications/Google Chrome.app`) + `playwright-core` 1.63 from /tmp | **Works**. The three.js r186 WebGPURenderer got a WebGPU adapter `{"vendor":"apple","arch":"metal-3"}`, reported `backend: webgpu`, and the screenshot rendered correctly. See `engine-img/three-mac-webgpu-metal.png`. |
| System `WKWebView` (Swift/AppKit probe over SSH, what Tauri uses) | **Works**: `adapter {"vendor":"apple","arch":"apple"} device true webgl2 true`. |
| Mac → server port over tailscale (`curl http://devbox:18799/`) | **Works**: 200 in 0.12 s. MagicDNS name and IP both work. firewalld's public zone only allows ssh/cockpit on `ens18`, but tailscale traffic gets through. |

### Server: `devbox`
| Item | Value |
|---|---|
| OS | AlmaLinux 10.2, kernel 6.12, 32 vCPU, 38 GB RAM (about 10 GB available) |
| GPU | **None**. `lspci`: `VGA … Device 1234:1111` (QEMU std VGA). |
| Installed | rust 1.98.1, node v24.18.0, python 3.12. **Playwright browsers already cached:** `~/.cache/ms-playwright/chromium-1228` (HeadlessChrome/149) and `chromium_headless_shell-1228`, which bundle **SwiftShader**. Of mesa, only `mesa-libgbm`; no mesa DRI or Vulkan drivers, and no X server. |
| Available via dnf (not installed) | `mesa-dri-drivers`, `mesa-vulkan-drivers` (llvmpipe/lavapipe), `vulkan-tools`, `xorg-x11-server-Xwayland`, `xwayland-run` (appstream), `weston` (EPEL). **There is no `xorg-x11-server-Xvfb` in EL10.** `xwayland-run` is the replacement. sudo works without a password. |

Server rendering probes:

| Test | Result |
|---|---|
| Chromium headless + `--use-angle=swiftshader --enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader`, page on `http://localhost` | WebGL2 renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`. `navigator.gpu` exists and both adapter and device are created. (On `about:blank`, `navigator.gpu` is `false` because it needs a secure context. Use localhost.) |
| three.js r186 `WebGPURenderer({forceWebGL:true})`: 3 towers, shadows, 60 frames | Renders correctly: `{"backend":"webgl2","ms60":3748}`, about 62 ms/frame on CPU. Screenshot: `engine-img/three-server-webgl2-swiftshader.png`. |
| Same scene with the WebGPU backend on SwiftShader | Rendering reports success (`ms60` about 1.1–1.5 s), but **`page.screenshot` is all white**: the headless compositor doesn't present the WebGPU canvas, and there's an `Instance dropped in popErrorScope` warning. So server screenshots should use the WebGL2 backend (`?gl` / `forceWebGL`). Both backends run the same TSL node materials, so what they show is equivalent. |
| Godot 4.7.2 Linux binary (78 MB zip, 2 s download), `--headless --import` | Takes 7.3 s. The text `.tscn` + GDScript project ran, and `WebSocketPeer` is available. |
| Godot `--headless` → `get_viewport().get_texture().get_image()` | **null**: `ERROR: Parameter "t" is null … servers/rendering/dummy/storage/texture_storage.h`. Headless means the dummy renderer. |
| Godot without `--headless`, using SwiftShader's Vulkan ICD | `ERROR: Unable to create DisplayServer, all display drivers failed.` Rendering on the server would need `sudo dnf install mesa-dri-drivers mesa-vulkan-drivers xwayland-run weston`, plus `xwayland-run -- godot …`. Not tried (no installs). |

## 2. Candidates (versions as of 2026-09-28)

| Candidate | Version | Metal path | Notes |
|---|---|---|---|
| **three.js** | r186 (2026-09-24; npm `three@0.186.1`) | Browser WebGPU → Metal (Chrome Dawn; Safari 26 ships WebGPU). WebGL2 fallback goes through ANGLE → Metal. | Imported from `three/webgpu`, with TSL node materials. Fallback to WebGL2 is automatic. Huge amount of training data. |
| Babylon.js | 9.0 (2026-03-26) | Same (WebGPU since 5.0) | More batteries included (GUI, inspector, physics), but less training data than three. A fine alternative. |
| react-three-fiber | see §6 | three.js underneath | Declarative JSX scenes plus drei helpers (`<Html>`, `<Text>`, CameraControls). Optional layer; see recommendation. |
| **Godot** | 4.7.2 (2026-08-18); 4.7 on 2026-06-18 | **Native Metal driver** since 4.4 (experimental in 4.4/4.5). **Metal 4 on macOS 26** since 4.7, falling back to Metal 3. Supported by Forward+ and Mobile renderers. | `.tscn`/`.tres` text scenes, GDScript, `--headless`, `--export-release`, `--write-movie out.avi --fixed-fps 30`. Community MCP servers: Coding-Solo/godot-mcp, Fulviuus/godot-mcp (headless export and screenshots), hi-godot/godot-ai. |
| Bevy | 0.19.1 (2026-08-13), wgpu 29 | wgpu Metal backend (partial bindless) | Code-only ECS, which suits agents in principle, and has a `headless_renderer` example. But breaking changes every release (0.17 Sep 2025, 0.18 Jan 2026, 0.19 Jun 2026) mean agents write stale APIs. Compiles are slow. UI (`bevy_ui_widgets`, `bevy_feathers`) is still young. |
| Unity | 6.6 (2026-09-01); 6.3 LTS (2025-12-04) | Metal (mature) | Editor GUI plus binary-ish YAML scenes, Unity Hub, licensing. Batch-mode builds exist, but iteration and testing are editor-bound. Poor agent fit. |
| Unreal | 5.8 (2026-06-23, last UE5 major) | Metal SM6 | Massive, and Blueprint graphs are binary. Wrong tool for a cute management game. |
| SceneKit | macOS 26 SDK | Metal | **Soft-deprecated at WWDC25** (session 288). Apple points to RealityKit. |
| RealityKit | macOS 26 (WWDC26 added cloth, NavMesh) | Metal | Native Swift and fast, but only testable on the Mac (Xcode 27, license not accepted yet). Less agent training data, no Linux loop, and "cute stylized" means custom shaders/materials. |
| raylib | 6.0 (2026-04-23) | OpenGL → Metal (via Apple's GL layer or ANGLE) | Simple C API with glTF loading, but no scene graph, UI, or animation blending. Too low-level. |

## 3. Scoring against the criteria

Legend: ++ excellent, + good, 0 ok, − weak, −− blocker

| Criterion | three.js + TS | Godot 4.7 | Bevy 0.19 | RealityKit | Unity/Unreal |
|---|---|---|---|---|---|
| (a) Cute low-poly look, animated characters | + (toon/Lambert, AnimationMixer for glTF clips; you build the polish yourself) | ++ (lighting, AnimationTree, navmesh, particles in the editor) | + | + | ++ |
| (b) Metal performance on M2 Max | + (WebGPU/ANGLE overhead is irrelevant at this scene size, around 100s of meshes; use InstancedMesh for desks) | ++ | ++ | ++ | ++ |
| (c) AI-agent friendliness | **++** (all text TS, Vite HMR under 1 s, vitest, Playwright headless screenshots on the server *today*, largest training corpus) | + (text scenes, CLI; no render verification on the server without installs; GDScript 4 training data is decent but mixed with Godot 3) | − (API churn, compile times) | − (Mac-only builds) | −− |
| (d) Menus (hire dialog) + terminal text in-world | **++** (HTML/CSS overlay; **xterm.js** renders real ANSI terminal output as a DOM overlay, CSS3DRenderer, or CanvasTexture) | 0 (Control nodes are fine for menus; terminal means writing a VT parser or asking herdr for plain text) | − | 0 | + |
| (e) WebSocket to server bridge | ++ (native `WebSocket`, same origin as the Vite dev server) | + (`WebSocketPeer`) | 0 (crate) | + (URLSession) | + |
| (f) Camera zoom city → building → floor → desk | + (camera-controls / tweened `lookAt`; cutaway by hiding upper floors or clipping planes) | ++ (Tween + Camera3D) | + | + | ++ |
| (g) CC0 packs and glTF | ++ (`GLTFLoader`, Kenney/Quaternius/KayKit ship glTF/GLB) | ++ (native glTF import) | + | 0 (USDZ preferred; glTF needs conversion) | + |
| Dev/test loop on the Linux server | **++** (proven) | 0 (logic tests yes, pixels need installs) | 0 | −− | −− |
| Runs on the Mac with no install | **++** (it's a URL) | − (Godot app or exported .app needed) | − | − (Xcode license) | −− |

## 4. Dev/test loop

**Goal:** agents on the server iterate end to end, and the Mac is only for "does it look right on Metal", driven from the server.

### With three.js (recommended)
1. **Serve from the server.** Run `pnpm dev` (Vite, `server.host: true`, port e.g. 5173) and the herdr bridge (WebSocket, e.g. :7681,
   or proxied by Vite at `/ws`) together in a herdr pane. Theo opens `http://devbox:5173` in Chrome on the Mac, where HMR
   updates live while agents edit. Tailscale reachability is verified. Optionally use Chrome "Install as app" for a windowed,
   game-like shell.
2. **Agent inner loop on the server (no Mac):**
   - `pnpm typecheck && pnpm test` (vitest): scene-model and state logic, meaning herdr JSON → buildings/floors/workers, with no
     rendering.
   - `pnpm shot` (Playwright + cached Chromium 149 + SwiftShader, forced WebGL2 via `?gl`): loads deterministic fixture states
     (`?fixture=city-3-buildings&cam=floor:2`), waits for `window.__ready`, and writes PNGs. The agent reads the PNGs with its image
     tool. Optionally compare against golden images with `toHaveScreenshot` and a tolerance. Expect about 60 ms/frame on CPU, which
     is fine for stills. Disable animation or use a fixed clock in test mode.
3. **Mac verification (driven over SSH, no Claude Code on the Mac):** a `scripts/mac-shot.sh` does roughly this:
   ```bash
   ssh devmac 'cd ~/h3d-tools && node shot.mjs "http://devbox:5173/?fixture=$1" /tmp/h3d.png' \
     && scp devmac:/tmp/h3d.png out/mac-$1.png
   ```
   `shot.mjs` launches `/Applications/Google Chrome.app` headless with `--enable-unsafe-webgpu`, asserts that
   `backend === 'webgpu'` and the adapter vendor is `apple`, and collects console errors plus a small perf probe (frame time via
   `renderer.info`, or the timestamp-query feature). The Mac only needs `playwright-core` in some folder (`~/h3d-tools`). That's a
   one-time `npm i`, which I have *not* done without asking. Nothing is copied to the Mac, because Chrome loads the app from the
   server URL.
   - Headed runs (a real window on Theo's screen, to check vsync/fps) are also possible over SSH (`headless:false`). Only do this
     when Theo agrees, since it pops up on his display.
   - `screencapture` stays unavailable unless Theo grants Screen Recording to `sshd-keygen-wrapper`/Terminal. It isn't needed,
     because pages capture themselves.
4. **Safari check** (occasional, manual): Theo opens the same URL in Safari 26 to confirm WebGPU works on WebKit.

### If Godot were chosen instead
- Server: `godot --headless --path . -s res://tests/run.gd` (or GUT/gdUnit4) for logic, and `--headless --export-release "macOS"`
  for builds; the macOS export templates run on Linux. The server can't produce pixels until mesa plus `xwayland-run`/weston are
  installed, and even then it's llvmpipe on Vulkan/GL, not Metal.
- Mac: needs the Godot 4.7.2 app (or rsync of an exported `.app`). An agent on the server could `rsync` the project, then run
  `ssh mac '/Applications/Godot.app/Contents/MacOS/Godot --path ~/h3d -- --screenshot=/tmp/s.png --quit-after 120'`. The game
  saves its own viewport PNG, which works over SSH as the AppKit probe showed. Every visual iteration involves the Mac, so this
  loop is slower than the web one.

### Does a Claude Code instance need to run on the Mac?
**No** for three.js. Everything is driven from the server over SSH. Claude Code, codex and herdr are already installed on the Mac
if Theo ever wants a local agent (e.g. Safari/WebKit-specific debugging with `agent-browser`), but the plan doesn't depend on
one.

## 5. Recommendation

**Primary: three.js r186 + TypeScript + Vite, `WebGPURenderer` (auto WebGL2 fallback), with HTML/CSS UI and xterm.js for in-world
screens, served from the server and run in Chrome on the Mac.**
- Why:
  - It's the only stack I verified end to end today. It renders headless on this GPU-less server with no installs, and headless
    over SSH on the Mac through real Metal WebGPU.
  - It has the strongest agent ergonomics: all text, HMR, and the most training data.
  - It's the best fit for the menu-heavy and terminal-text parts, the cheapest deployment (it's a URL), and WebSocket is native.
- Trade-offs:
  - You build the game-engine polish yourself (lighting look, animation state machines, pathing for wandering workers).
  - Browser tab ergonomics: it's less of a "real app" unless wrapped. A later Tauri 2 wrapper is viable, since the system WKWebView exposes WebGPU on this Mac (tested, §6).
  - Performance is below native, but that doesn't matter at this scale.
- Keep render code isolated behind a small `view/` layer, so the herdr state model (`model/`) can be tested without WebGL.
- **Framework choice inside the pick:** vanilla three.js plus a thin ECS-lite (plain TS classes) and Preact or plain DOM for
  menus. The alternative is react-three-fiber plus drei. R3F gives declarative scenes that agents write well and easy `<Html>`
  overlays, but it adds a reconciler layer, and first-class WebGPU only arrives in R3F v10, which is still alpha. Either works. Vanilla is the lower-risk default.

**Runner-up: Godot 4.7.2 (Forward+ or Mobile renderer on native Metal 4).** Choose it if a polished native look and feel matters
more than agent iteration speed.
- Trade-offs:
  - Needs server installs (mesa, xwayland-run/weston) for any pixel tests, and the Godot app on the Mac.
  - Terminal text in-world is DIY.
  - Menus are fine but more work than HTML.
  - Community MCP servers help agents drive the editor.

### "hello city" layout (three.js pick)
```
herdr-3d/
  package.json            # scripts: dev, build, typecheck, test, shot, mac-shot
  vite.config.ts          # server.host=true, port 5173, proxy /ws -> bridge
  tsconfig.json
  index.html              # <canvas id="world"> + <div id="ui"> overlay
  public/assets/          # CC0 GLB: kenney/, kaykit/, quaternius/  (+ LICENSES.md)
  src/
    main.ts               # boot: renderer (WebGPURenderer, ?gl → forceWebGL), loop, fixture/live switch
    model/                # pure TS, no three: City, Building, Floor(session), Worker(workspace), Freelancer
      types.ts            #   mirrors herdr JSON (session/workspace/pane/agent status)
      reduce.ts           #   bridge events -> model (unit-tested)
    net/bridge.ts         # WebSocket client, reconnect, typed messages
    view/
      world.ts            # scene, lights, ground, fog, toon materials
      building.ts         # stacks floors; grows when a session is added
      floor.ts            # cutaway interior, desk grid (InstancedMesh)
      worker.ts           # GLB character + AnimationMixer (idle/typing/blocked/done)
      camera.ts           # city → building → floor → desk transitions (camera-controls/tweens)
      screen.ts           # xterm.js per selected worker (DOM overlay / CSS3D)
    ui/hire-dialog.ts     # harness (claude-code/codex), model, effort → bridge "hire" message
    test/fixtures/*.json  # canned herdr states for deterministic shots
  tests/
    model.test.ts         # vitest
    shots.spec.ts         # Playwright: fixture → PNG (SwiftShader, WebGL2)
  scripts/
    shot.mjs              # server headless screenshot (chromium-1228 cache)
    mac-shot.sh           # ssh mac: headless Chrome (Metal WebGPU) against http://devbox:5173 → scp PNG back
  bridge/                 # server-side herdr↔WebSocket bridge (separate brief; any language)
```
Test hooks the page should expose: `window.__ready` (assets loaded and first frame rendered), `window.__info` (backend, adapter,
frame time), and URL params `?fixture=…&cam=…&gl&frozen`.

## 6. Supporting facts (web)
- Godot 4.7.2: https://godotengine.org/article/maintenance-release-godot-4-7-2/ · 4.7 release notes: https://godotengine.org/releases/4.7/
  · Metal driver/Metal 4: https://docs.godotengine.org/en/latest/engine_details/architecture/internal_rendering_architecture.html
  · Movie maker: https://docs.godotengine.org/en/latest/tutorials/animation/creating_movies.html · Wayland not default:
  https://docs.godotengine.org/en/stable/tutorials/platform/linux/wayland_x11.html
- Bevy 0.19.1: https://github.com/bevyengine/bevy/releases/tag/v0.19.1 · https://bevy.org/news/bevy-0-19 · headless renderer example:
  https://github.com/bevyengine/bevy/blob/main/examples/app/headless_renderer.rs
- Unity 6.6: https://discussions.unity.com/t/unity-6-6-is-now-available/1735357 · UE 5.8: https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available
- SceneKit soft deprecation: https://developer.apple.com/videos/play/wwdc2025/288 · RealityKit WWDC26: https://developer.apple.com/videos/play/wwdc2026/279/
- Safari 26 WebGPU: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- three.js releases: https://github.com/mrdoob/three.js/releases · WebGPURenderer: https://threejs.org/manual/en/webgpurenderer
- Babylon 9: https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0 · raylib 6.0: https://github.com/raysan5/raylib/discussions/5783
- **WKWebView WebGPU (tested):** I compiled a Swift/AppKit probe on the Mac, ran it over SSH, and loaded a page in the
  *system* `WKWebView` (baseURL `https://localhost/`). It returned `adapter {"vendor":"apple","arch":"apple"} device true webgl2 true`
  on macOS 26.6.2. So a **Tauri 2.12.0** (latest, 2026-09-26) or a hand-written WKWebView wrapper should get WebGPU on this Mac.
  - Tauri has no WebGPU flag of its own ([tauri#6381](https://github.com/tauri-apps/tauri/issues/6381)); support comes from the
    OS WebKit.
  - A May 2026 report that `navigator.gpu` is undefined in Tauri
    ([kaya-go spec](https://github.com/kaya-go/kaya/blob/main/specs/2026-05-03-webgpu-unavailable-in-tauri-webview.md)) was likely
    on macOS 15. Not re-tested inside an actual Tauri app.
- xterm.js: `@xterm/xterm` 6.0.0 (2025-12-22). `@xterm/addon-webgl` is available for GPU text.
- react-three-fiber: stable **9.8.1** (2026-09-24). First-class WebGPU is **v10, still alpha** (`10.0.0-alpha.5`,
  https://r3f.docs.pmnd.rs/next/webgpu/overview). That's a further reason to default to vanilla three.js.
- CC0 assets:
  - Characters: **Kenney Mini Characters** has 12 characters as GLB. `character-male-a.glb` has a skin and **32 clips**,
    including idle, walk, sit and interact (https://kenney.nl/assets/mini-characters).
  - Furniture: **Kenney Furniture Kit** (about 141 GLB) and **KayKit Furniture Bits** (glTF, one gradient atlas).
  - Other packs: **KayKit Adventurers** (glTF, rigged). Quaternius Ultimate Animated Character is FBX/OBJ/Blend only and would
    need Blender conversion. Quaternius RPG Character Pack has glTF.
  - Mini Characters plus a furniture kit covers "cute worker at desk" with zero conversion.

## 7. Uncertainties / flags
- Headless WebGPU canvas screenshots on SwiftShader come out blank. For server shots, use WebGL2. A fix via `readRenderTargetPixelsAsync` is possible but not tried.
- Headless Chrome on the Mac throttles rAF (60 frames took about 1.5 s), so real fps must be measured headed or with GPU timestamp queries.
- Godot rendering on the server via xwayland-run + llvmpipe is untested (it needs installs).
- Godot on the Mac is untested (not installed). The AppKit probe suggests a Godot app launched over SSH will render and self-capture fine.

## 8. Open questions for Theo
1. OK to use **Chrome on the Mac (browser tab / "Install as app")** as the game shell, rather than a native .app? If a native window is wanted later, a Tauri 2 wrapper is acceptable? (WKWebView WebGPU works on this Mac.)
2. OK to run a one-time `npm i playwright-core` in e.g. `~/h3d-tools` on the Mac, so agents can take Metal screenshots over SSH (headless, nothing pops up)? Also OK for agents to occasionally open a *headed* window on your screen?
3. Should agents be able to install `mesa-dri-drivers mesa-vulkan-drivers` on the server (for faster, GPU-API-complete software rendering), and `xwayland-run weston` only if we ever go the Godot route?
4. Xcode 27 license isn't accepted (`sudo xcodebuild -license`). That's only relevant if a native Swift/Tauri wrapper is wanted later.
5. Art direction preference: Kenney Mini Characters + Furniture Kit (GLB, 32 anim clips; my default), KayKit (chunky cute), or Quaternius (needs FBX→glTF conversion)?
