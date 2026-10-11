# libghostty feasibility for laptop terminals

Investigated 2026-10-11 using Alterlab MCP search and scraping of upstream documentation and source. Repository inspected at `8951f0ff6c1704dc3d448b7dbd5cb7cb73b0421a`; upstream `main` and tip documentation can change. This is a documentation and architecture investigation; no build, migration, or comparative benchmark was performed.

## Recommendation

Fix terminal clipboard delivery independently. Consider a separate, bounded performance experiment with **libghostty-vt compiled to WebAssembly**, preserving the existing browser canvas and 3D texture presentation. A major speed improvement has not been demonstrated. Native Ghostty's Metal/OpenGL renderer is a different integration project.

The repository already declares a Cmd/Ctrl+V paste entry point in [laptop/index.ts](../../game/src/laptop/index.ts); clipboard capture and input delivery should be investigated as an existing-path defect. A terminal engine replacement does not itself supply browser focus, clipboard events, or application routing.

## Current terminal architecture

[LaptopTerminal](../../game/src/laptop/terminal.ts) uses `@xterm/xterm` 6.0.0 as an ANSI/VT parser and buffer. It never calls `Terminal.open`, so xterm's DOM renderer and its usual editable input surface are absent. Full frames reset the parser; diff frames update it. [paint.ts](../../game/src/laptop/paint.ts) reads the buffer into a custom Canvas2D painter, including fonts, colours, zoom, cursor and the distant-monitor glance view. The canvas becomes a Three.js `CanvasTexture`, uploaded after a paint.

The app runs in a Chrome `--app` window; Tauri is only a future option. [Server terminal watches](../../internal/server/term.go) run Herdr observers and forward ANSI frames over WebSocket, with a default 4 fps watch and a 30 fps maximum. [The laptop controller](../../game/src/laptop/index.ts) also limits painting by configured fps. These stages remain relevant even if parsing becomes faster. See [architecture](../architecture.md).

## What exists upstream now

| Capability | Evidence and consequence |
| --- | --- |
| Public C and Zig terminal core | libghostty-vt parses VT sequences, maintains terminal state and encodes input. Current API documentation still warns that it is under development and breaking changes are expected. Pin a revision and isolate the adapter. [API overview](https://libghostty.tip.ghostty.org/) |
| Rendering state, without a drawing engine | Ghostling, the upstream example, supplies Raylib windowing and 2D drawing itself. libghostty-vt supplies no drawing or windowing code. The consumer must retain or replace our Canvas2D painter. [Ghostling](https://github.com/ghostty-org/ghostling) |
| Incremental render data | The render-state API captures viewport cells, styles, cursor and dirty rows. Consumers clean dirty tracking after drawing. It can support partial repainting, but that optimisation must be implemented and measured in our renderer. [Render-state API](https://libghostty.tip.ghostty.org/group__render.html), [C example](https://github.com/ghostty-org/ghostty/tree/main/example/c-vt-render) |
| Browser WebAssembly | The build supports a `ghostty-vt.wasm` artifact. The WASM API documents allocations, opaque handles and JavaScript access. JS views must be refreshed after memory growth. This makes a browser adapter plausible without introducing a native app shell. [Build source](https://github.com/ghostty-org/ghostty/blob/main/src/build/GhosttyLibVt.zig), [WASM API](https://libghostty.tip.ghostty.org/group__wasm.html) |
| Native platform packaging | The build contains shared/static libraries, Windows handling and Apple XCFramework packaging for macOS and iOS. Those are terminal-core artifacts, not a ready-made native view for the Chrome app. [Build source](https://github.com/ghostty-org/ghostty/blob/main/src/build/GhosttyLibVt.zig) |
| Build toolchain and distribution | Current upstream declares a minimum Zig version of 0.16.0. Vendoring would add a pinned Zig/WASM build and release artifact to our TypeScript/Vite workflow; users could consume the prebuilt asset. [Manifest](https://github.com/ghostty-org/ghostty/blob/main/build.zig.zon) |
| License | Ghostty is MIT licensed. Include its copyright and permission notice in distributed copies or substantial portions. [License](https://github.com/ghostty-org/ghostty/blob/main/LICENSE) |

The older author announcement describes the C API as forthcoming; that status is superseded by the current C header, documentation and examples. Its distinction remains useful: the internal full-app embedding header was designed for the macOS application, while libghostty-vt is the broadly consumable terminal core. The announcement describes GPU rendering libraries and full terminal widgets as longer-term work. [Author roadmap](https://mitchellh.com/writing/libghostty-is-coming), [current header](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h).

## Performance experiment worth doing

Ghostty's native app combines SIMD parsing, separate I/O/render threads and Metal/OpenGL drawing. Those architectural advantages do not automatically transfer when only its VT engine is embedded in this browser application. [Upstream architecture](https://github.com/ghostty-org/ghostty#competitive-performance).

Our proposed experiment should first time base64 decoding, parsing, buffer extraction, Canvas2D painting, texture upload and observed input-to-display latency separately. Replay the same captured full/diff frames through xterm and a pinned libghostty-vt WASM adapter, with matching dimensions and screenshot/text checks. Include resize, full reset, cursor visibility, Unicode/wide characters, styles, glance mode and several watched monitors.

Keep WASM calls coarse: extracting every cell through many C/JS calls could offset parser savings. Measure bundle/download size, initialisation time, memory and sustained frame times as well as parser throughput. Row dirtiness can reduce canvas work; the current texture update still requires its own measurement. A GPU glyph renderer would be additional work regardless of parser choice.

The ticket should accept a measured result, including no worthwhile improvement, and retain xterm until end-to-end gains and visual compatibility justify replacing it. Clipboard repair can ship without this experiment.
