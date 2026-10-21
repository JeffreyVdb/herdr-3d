# Terminal engine and transport options

Investigated 2026-10-21. This updates the upstream facts in
[the October 11 feasibility note](libghostty-terminal-feasibility.md). Sources below are upstream code,
package metadata and an isolated Herdr 0.9.1 experiment. Browser comparison results live with
[the runnable spike](terminal-experience-spike/).

## Recommendation

Use a complete browser terminal widget for the seated view, with a stable CSS font size and actual
PTY resizing. Keep the inexpensive screen observer for distant monitors. Compare xterm.js 6.0.0
with the pinned Ghostty web prerelease, but do not replace a parser and expect the existing canvas
and observer transport to gain mouse interaction or history automatically.

Herdr already provides a controller that fixes the most important transport gaps: actual PTY
resize, ordered input bytes and access to existing server history. Investigate that before building
a new raw PTY service. Its JSON CLI still omits mode updates and structured mouse input; completing
those is the remaining integration work for proper TUI mouse interaction. This recommendation is
an inference from the verified capabilities below.

## Versions actually inspected

| Component | Version / revision | Finding |
| --- | --- | --- |
| Official Ghostty | `67edd20a0292629da7e01b64973de19d356df487`, main on 2026-10-21 | `1.3.2-dev`; minimum Zig **0.17.0**, superseding the older report's 0.16.0. [Manifest](https://github.com/ghostty-org/ghostty/blob/67edd20a0292629da7e01b64973de19d356df487/build.zig.zon) |
| `ghostty-web`, stable | `0.4.0`; `9e4e126d89ac3537d2b2ebec075849851566de9f`; published 2025-12-09 | npm `latest`; prebuilt WASM measured **423,045 bytes** from the registry tarball. [Registry](https://registry.npmjs.org/ghostty-web), [release source](https://github.com/coder/ghostty-web/tree/9e4e126d89ac3537d2b2ebec075849851566de9f) |
| `ghostty-web`, prerelease | `0.4.0-next.20.g1858a59`; `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab`; published 2026-06-28 | npm `next`; includes terminal mouse reporting absent from stable. Both builds pin Ghostty submodule `5714ed07a1012573261b7b7e3ed2add9c1504496`. [Registry](https://registry.npmjs.org/ghostty-web), [input handler](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/input-handler.ts) |
| xterm.js | `@xterm/xterm` **6.0.0**, fit **0.11.0**, web-links **0.12.0** | Current npm stable versions; core already pinned by this app. All three publish revision `f447274f430fd22513f6adbf9862d19524471c04`. [Core registry](https://registry.npmjs.org/@xterm/xterm/latest), [fit registry](https://registry.npmjs.org/@xterm/addon-fit/latest), [links registry](https://registry.npmjs.org/@xterm/addon-web-links/latest) |
| Herdr | Installed CLI **0.9.1**; upstream tag commit `065ef9d6a531c49fb8bee7e818ef837065b21ee9` | Source inspection and throwaway session probe; existing user sessions were never attached, modified or stopped. [Source](https://github.com/herdrdev/herdr/tree/065ef9d6a531c49fb8bee7e818ef837065b21ee9) |

## Official libghostty-vt versus ghostty-web

Official **libghostty-vt** is the terminal core: VT parsing, screen/history state, reflow, render-state
extraction, keyboard and mouse encoding. Its C header still explicitly calls the API incomplete
and unstable. The build emits `ghostty-vt.wasm`; the WASM interface exposes memory allocations and
opaque handles, with fresh JS memory views needed after growth. It is not a ready-made browser
widget or the native Ghostty GPU renderer. A direct integration owns rendering, DOM input/focus,
selection, links, clipboard, scrolling, sizing, and the versioned WASM build.
[Public header](https://github.com/ghostty-org/ghostty/blob/67edd20a0292629da7e01b64973de19d356df487/include/ghostty/vt.h),
[WASM interface](https://github.com/ghostty-org/ghostty/blob/67edd20a0292629da7e01b64973de19d356df487/include/ghostty/vt/wasm.h),
[build](https://github.com/ghostty-org/ghostty/blob/67edd20a0292629da7e01b64973de19d356df487/src/build/GhosttyLibVt.zig).

**ghostty-web** is Coder's separate TypeScript browser widget, built around its own patched Ghostty
WASM build. It adds Canvas2D rendering, browser input, selection, built-in OSC 8 and URL providers,
scrollback, a scrollbar and a fit addon. Consumers can use the published WASM without installing
Zig. Its xterm API compatibility is an aim, not an assurance that arbitrary addons or options work;
the published option and event surfaces are smaller than xterm's. Its current published core is
not the October 2026 official libghostty-vt ABI.
[README](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/README.md),
[Terminal implementation](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts),
[interfaces](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/interfaces.ts),
[patched build](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/scripts/build-wasm.sh).

The version distinction matters for this request: **stable 0.4.0 has browser selection and links,
but lacks TUI mouse event reporting**. Its alternate-screen wheel handler emits arrow keys. The
pinned prerelease implements SGR/X10 click, release, drag/motion and wheel reports using terminal
mode state. Both widgets require the backing application to support mouse input, and a transport
that preserves the necessary state.
[Stable wheel/interaction handling](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts),
[prerelease mouse encoder](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/input-handler.ts).

Source presence is not proof of a working feature: the accompanying browser spike found that the
stable version's named OSC 8 link did not activate, while xterm and the Ghostty prerelease did.
Treat the tested prerelease, rather than npm `latest`, as the Ghostty candidate for this investigation.

For a Vite spike, explicitly resolve the bundled asset instead of depending on loader fallback paths:

```ts
import { Ghostty, Terminal, FitAddon } from 'ghostty-web';
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url';

const ghostty = await Ghostty.load(wasmUrl);
const terminal = new Terminal({ ghostty, fontSize: 14, scrollback: 10_000 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(host);
fit.fit();
fit.observeResize();
// Wire onData and onResize to the backing transport; release/dispose on leaving.
```

`init()` itself takes no URL argument; passing a loaded `Ghostty` instance is the supported explicit
path. Fit changes the grid to match measured font cells rather than stretching glyphs. Font readiness,
DPR, container resizing and bridge resize acknowledgement still need testing.
[Loader](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/ghostty.ts),
[initialization](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/index.ts),
[FitAddon](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/addons/fit.ts).

Link activation defaults to Ctrl/Cmd-click and `window.open`. The plain-URL provider is explicitly
single-line and excludes file paths. For production, route link activation through the app's existing
URL opener, including its scheme validation, and verify wrapped URLs; adding a provider alone does
not necessarily override built-in provider precedence.
[OSC 8 provider](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/providers/osc8-link-provider.ts),
[URL provider](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/providers/url-regex-provider.ts),
[provider ordering](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/link-detector.ts).

## xterm is a credible baseline

Opening the existing xterm dependency as a real browser widget supplies selectable text, keyboard
input, mouse protocol reporting, scroll APIs and configurable history. OSC 8 links use `linkHandler`;
plain URL detection comes from `@xterm/addon-web-links`. The fit addon computes rows/columns from
container and cell dimensions; the application must call it on resize and send the resulting size
to its backend. It also exposes `onBinary` for legacy non-UTF-8 mouse reports, which must not be
reencoded as ordinary UTF-8 text. These are capabilities of an opened browser widget, absent from
our parser-only usage.
[Pinned public API](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/typings/xterm.d.ts),
[fit implementation](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-fit/src/FitAddon.ts),
[links addon](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-web-links/src/WebLinksAddon.ts),
[current application](../../game/src/laptop/terminal.ts).

Both projects are MIT licensed; carry the required notices. No performance superiority is established
by this source investigation, and Ghostty's native rendering performance does not establish the
performance of a browser Canvas2D wrapper.
[Ghostty license](https://github.com/ghostty-org/ghostty/blob/67edd20a0292629da7e01b64973de19d356df487/LICENSE),
[ghostty-web license](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/LICENSE),
[xterm license](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/LICENSE).

## Herdr's controller is the useful next seam

The current app consumes `terminal session observe`: **reconstructed ANSI screen frames**, not the
original PTY output. Herdr's server renders the existing terminal into a buffer, attaches visible
OSC 8 URIs, then encodes screen diffs. Those frames preserve visible text, styling, cursor and
hyperlinks, but do not replay the original scroll operations, full history, alternate-screen
switches or application input-mode sequences. A second VT parser cannot recover absent information.
[Render source](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/server/headless/render.rs#L610),
[ANSI encoder](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/protocol/render_ansi.rs),
[existing protocol](../protocol.md#fullscreen-74).

The installed CLI offers:

```sh
herdr --session <session> terminal session control <pane> --cols 110 --rows 31
```

Its stdout has the same JSONL frame/closed records as observe; its stdin accepts:

```json
{"type":"terminal.input","text":"a"}
{"type":"terminal.input","bytes":"Gw=="}
{"type":"terminal.resize","cols":110,"rows":31,"cell_width_px":8,"cell_height_px":16}
{"type":"terminal.scroll","direction":"up","lines":12,"source":"wheel","column":2,"row":3,"modifiers":0}
{"type":"terminal.release"}
```

`text` and base64 `bytes` are mutually exclusive. Scroll coordinates are zero-based; optional
`source` is `wheel` or `page_key`. The server uses its actual terminal modes to choose host history,
application mouse-wheel reporting or alternate-scroll behavior. The controller acquires ownership
and directly resizes the underlying PTY, including when no TUI client is attached. Only one controller
may own a terminal; never add `--takeover` silently. Keep distant monitors as observers.
[CLI protocol](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/client/terminal_sessions.rs#L160),
[controller ownership and resize](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/server/headless.rs#L1796),
[scroll routing](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/server/pane_input.rs#L106),
[upstream CLI docs](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/docs/next/website/src/content/docs/cli-reference.mdx#direct-terminal-attach).

For this rendered-frame transport, browser wheel input must drive **Herdr history**, with browser
local history disabled or clearly separated. `pane get` exposes history offset, maximum offset and
viewport rows, which can drive a scrollbar. Making xterm/ghostty-web retain 10,000 lines alone will
not provide Herdr's history. `pane read --source recent` is another read capability, but snapshot
reads do not establish a continuous terminal history stream.
[Pane scroll metadata](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/api/schema/panes.rs#L527),
[CLI read and control implementation](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/client/terminal_sessions.rs).

The remaining mouse gap is concrete: the server already supports structured `AttachMouse`, and
sends `MouseCapture` and `DirectTerminalKeyboardProtocol` state. The JSONL controller discards these
non-frame messages, and its command enum has no mouse command. The ordinary socket API's
`pane.send_input` has only `text` and `keys`. A bounded upstream extension that exposes mode events
and structured `terminal.mouse` would let Herdr encode events from its authoritative terminal state.
Alternatively, a versioned adapter to Herdr's client IPC can use those existing messages. Blindly
forcing browser mouse mode and sending SGR sequences into every shell is not an equivalent fix.
[Server mode events](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/server/headless/render.rs#L36),
[CLI message filtering](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/client/terminal_sessions.rs#L122),
[IPC mouse schema](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/protocol/wire.rs#L601),
[socket input schema](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/api/schema/panes.rs#L346).

## Isolated controller verification

Run `python3 docs/research/terminal-experience-spike/herdr-probe.py`. The fixture uses a fresh random
session, isolated config/state/cache/runtime directories and a synthetic Python terminal program.
It never selects an existing session, never passes `--takeover`, and stops/deletes its own session
in `finally`. [Probe](terminal-experience-spike/herdr-probe.py), [recorded result](terminal-experience-spike/herdr-results.json).

| Check | Observed result on Herdr 0.9.1 |
| --- | --- |
| Observer dimensions versus PTY | Requested 60×12; fixture's actual PTY stayed **119×40**. |
| Controller attach | Fixture measured **80×24**, without any Herdr TUI client. |
| Live resize | `terminal.resize` changed the fixture's measured PTY to **110×31**. |
| Existing history | 79 lines available; `terminal.scroll` moved offset **0 → 12**. |
| OSC 8 | `https://example.com/herdr-probe` survived in emitted OSC 8 bytes. |
| Mouse modes | Fixture enabled DECSET 1000/1006; neither was forwarded, and stdout only emitted frame records. |
| Concurrent ownership | Second controller was refused; first retained ownership. |
| Cleanup | Server exited, session stopped and session deleted. |

The recorded run collected 7 controller frames / 7,536 ANSI bytes; those counts are diagnostic,
not performance measurements. This proves the backend building blocks, not a finished in-game
integration or complete compatibility with Claude/Codex TUIs. Acceptance should include visible
resize/reflow, keyboard questions, drag selection, links, history under new output, TUI wheel and
click handling, ownership conflicts and release/reconnect behavior.
