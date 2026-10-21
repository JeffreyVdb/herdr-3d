# wterm upstream assessment

Investigated 2026-10-21 for [Herdr 3D #176](https://github.com/JeffreyVdb/herdr-3d/issues/176).
This note records upstream source/package inspection. It distinguishes source-supported capabilities,
upstream bug reports, and conclusions inferred for Herdr. It does not claim that advertised features
were all exercised in a browser or connected to a live Herdr session. No production integration was
changed.

Executed browser and Herdr follow-up observations, including reproductions of the
reported viewport and transform bugs, are in [wterm-assessment.md](wterm-assessment.md).

## Assessment

**wterm merits comparison, specifically `@wterm/dom` with `@wterm/ghostty`, but is not a drop-in
replacement and does not establish that everything would work.** Its default lightweight core has
concrete compatibility losses: approximated RGB colors, missing grapheme clustering, and destructive
horizontal narrowing. The Ghostty option addresses those core limitations while retaining wterm's DOM
renderer and input layer. Its current release also has reported DOM sizing/scrolling bugs relevant to
Herdr's transformed views and terminal history. These conclusions follow from the source and reports
below; the executable spike must determine which reproduce in our browser and presentation.

## Versions and maintenance evidence

| Project | Inspected revision / package | Observed activity on 2026-10-21 |
| --- | --- | --- |
| wterm | Release `v0.5.4`: `cc067a20a616fe62f0893ec94005943c349bb492`; `@wterm/core`, `@wterm/dom`, `@wterm/ghostty` npm `latest` are all `0.5.4` | Latest release and package publication **2026-09-29**. Default-branch tip `488e9a7344e812e35a951f803618d7767cc4be5b` is a **2026-10-06 documentation change**. `packages/` and `src/` have no diff between that tip and the release. [Release](https://github.com/vercel-labs/wterm/releases/tag/v0.5.4), [commits](https://api.github.com/repos/vercel-labs/wterm/commits?per_page=10), [core registry](https://registry.npmjs.org/@wterm/core), [DOM registry](https://registry.npmjs.org/@wterm/dom), [Ghostty registry](https://registry.npmjs.org/@wterm/ghostty) |
| ghostty-web | npm `latest` `0.4.0`, revision `9e4e126d89ac3537d2b2ebec075849851566de9f`; npm `next` `0.4.0-next.20.g1858a59`, revision `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` | Stable published **2025-12-09**; prerelease and last default-branch commit **2026-06-28**. Repository `pushed_at` is newer, which does not mean the default branch or published package changed. [Registry](https://registry.npmjs.org/ghostty-web), [commits](https://api.github.com/repos/coder/ghostty-web/commits?per_page=10), [repository metadata](https://api.github.com/repos/coder/ghostty-web) |

The GitHub API returned **3,509 stars / 165 forks for wterm** and **2,981 stars / 188 forks for
ghostty-web**. That is a modest star lead, not evidence of a substantially larger maintenance team.
The contributors endpoints list five contributors for wterm, with 157 of 189 attributed commits from
`ctate`, versus twenty for ghostty-web, with 87 of 119 from `sreya`. These are GitHub commit
attributions, not staffing, support guarantees, or an accounting of all coauthors.
[wterm metadata](https://api.github.com/repos/vercel-labs/wterm),
[ghostty-web metadata](https://api.github.com/repos/coder/ghostty-web),
[wterm contributors](https://api.github.com/repos/vercel-labs/wterm/contributors),
[ghostty-web contributors](https://api.github.com/repos/coder/ghostty-web/contributors).

wterm has more recent releases and functional development in this snapshot. Its CI defines real-PTY
and recorded Neovim/tmux checks, plus rendering, sustained-output, keyboard latency and history-search
workloads across Chromium, Firefox and WebKit. The latest inspected PR CI run completed successfully
on October 17. The project identifies itself as a Vercel Labs experiment; frequent releases and
extensive tests are encouraging maintenance evidence, not a stability promise or a measured win over
xterm. Neither project is archived.
[CI definition](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/.github/workflows/ci.yml),
[PTY harness](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/e2e/harness/README.md),
[successful CI run](https://github.com/vercel-labs/wterm/actions/runs/38985975052),
[project README](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/README.md).

## Two different cores under the same widget

| Area | Default `@wterm/core` / `WasmBridge` | Optional `@wterm/ghostty` / `GhosttyCore` |
| --- | --- | --- |
| VT engine | wterm's own Zig implementation | Patched Ghostty **v1.3.1**, compiled by wterm; separate from Coder's `ghostty-web` |
| Unicode | Single codepoints and wide-cell tracking; no complete multi-codepoint grapheme string | `CellData.chars` preserves combining marks and ZWJ sequences |
| RGB | `38;2` / `48;2` converted to nearest indexed color | Exact `fgRgb` / `bgRgb` fields |
| Narrow resize | Clears cells beyond new width | Reflows retained text through Ghostty |
| History budget | Compile-time **1,000 rows** | `scrollbackLimit` is **bytes**, default **10,000**, with retained row count dependent on width/page allocation |
| Soft wraps | No native wrap metadata in the bridge | Native row metadata supports copy/search across wraps and tracked positions through reflow |
| Graphics | Consumes unsupported Kitty payloads without decoding images | Bounded direct Kitty PNG/RGB/RGBA overlay; excludes Sixel, iTerm2 images, animation and external media |

Source evidence: [built-in cell extraction](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/core/src/wasm-bridge.ts),
[RGB conversion and resize implementation](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/src/terminal.zig),
[fixed built-in history capacity](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/src/scrollback.zig),
[Ghostty API contract](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/README.md),
[pinned Ghostty dependency](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/zig/build.zig.zon).

The RGB, grapheme and resize limitations are also reported upstream with small reproductions:
[#235](https://github.com/vercel-labs/wterm/issues/235),
[#236](https://github.com/vercel-labs/wterm/issues/236),
[#237](https://github.com/vercel-labs/wterm/issues/237). Source inspection supports the limitations;
those issue bodies are reports rather than independent runtime verification in this note. Treat the
README's generic RGB/history wording carefully: the lightweight and Ghostty cores are not equivalent.

The built-in core's RIS (`ESC c`) path calls `fullReset()` then `reset()` without clearing its
scrollback object; `CSI 3 J` does explicitly reset that history. This matters when an observer feeds
authoritative full-screen snapshots preceded by RIS: the browser's old local history can survive
while the screen is replaced. The source establishes this difference; the replay spike should check
what it displays in Herdr's frame-reset pattern.
[reset and erase paths](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/src/terminal.zig).

wterm's shipped Ghostty adapter uses internal Zig types and its own WASM exports. It is not yet a
consumer of the new public libghostty-vt C API. Its separate public-API experiment explicitly retains
the shipped adapter because of graphics, history, hyperlink identity and resource-reporting gaps.
Consumers receive prebuilt WASM and need no Zig installation; rebuilding the shipped Ghostty artifact
uses Zig **0.15.2**, while rebuilding wterm's built-in core uses **0.16.0**.
[Ghostty build/patch contract](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/README.md),
[public-API experiment](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/experiments/libghostty/README.md).

## Browser integration and supported surface

The vanilla API is `new WTerm(element, options)` followed by `await term.init()`. The optional core is
a preloaded instance from `await GhosttyCore.load(options)`, passed as `{ core }`. There is no xterm
`Terminal.open`, `buffer.active` or addon compatibility contract. The headless `TerminalCore` exposes
`init`, `writeString` / `writeRaw`, `getCell`, cursor/mode/history methods and dirty-row access, so a
custom painter is possible, but requires an adapter.
[WTerm options and lifecycle](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/wterm.ts),
[headless interface](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/core/src/terminal-core.ts),
[Ghostty usage](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/README.md).

| Capability | Source-supported behavior and boundary |
| --- | --- |
| Rendering | DOM rows with dirty-row updates and a virtualized history window. Text selection/accessibility applies to mounted rows; browser Find alone does not search unmounted history. No ready-made canvas for a Three.js `CanvasTexture`. |
| Input | Native textarea, browser paste and IME composition; `onData(string)` includes keyboard input **and terminal responses**. Escape followed by Tab exits the terminal. Browser-reserved shortcuts can remain unavailable. |
| Paste | Mode 2004 controls bracketed-paste wrapping. ESC bytes inside bracketed paste are stripped. The actual Herdr transport must preserve the necessary mode state and input semantics. |
| Advanced keyboard | DOM layer includes negotiated Kitty encoding, legacy modified navigation/function keys and AltGr handling. Protocol support does not cause mode negotiation missing from the server stream to reappear. |
| Mouse | Tracking 1000/1002/1003; X10, UTF-8, SGR, urxvt and pixel encoding; focus reporting. `onBinary(Uint8Array)` preserves raw legacy bytes. Shift allows selection; wheel gestures on retained history remain local. |
| Copy and selection | Native selection plus full-history Select All, words/lines and rectangles. Ghostty wrap/grapheme metadata improves logical text semantics. These features need DOM mounting and input ownership. |
| Search | Built-in asynchronous **plain-text** search over retained history, including unmounted rows; case sensitivity, counts, highlights and next/previous navigation. A host supplies its search controls. This is not an xterm SearchAddon API or regex-search contract. |
| Read output | `readText()` captures retained output; pending capture can abort under writes/resizes and is size-bounded. It does not retrieve server history absent from the stream. |
| Resize | `fit()` and `autoResize` measure the host/font; `onResize(cols, rows)` reports applied grid size. A host must still resize the underlying PTY. |
| Hidden panes | `setRenderingPaused()` stops painting while parsing/replies continue; hidden browser documents also pause painting. Each terminal still has its own state/memory. |
| Lifecycle | `WTerm.destroy()` releases its browser layer but **does not dispose a caller-supplied Ghostty core**. Its owner must call `core.dispose()`. |

Sources: [DOM package API](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/README.md),
[input implementation](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/input.ts),
[renderer](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/renderer.ts),
[search implementation](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/search.ts),
[core lifetime](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/README.md).

### Hyperlinks need a separate decision

wterm creates native HTTP(S) anchors from **OSC 8 cell metadata**. It preserves explicit identity and
supports Ctrl-click on Linux/Windows or Cmd-click on macOS. The renderer rejects other URI schemes.
No plain-text URL detection provider or public `onLink` callback was found in the inspected DOM API:
an unadorned `https://example.com` is not converted to a link by this renderer. Herdr would need to
keep/add detection and intercept activation if links must use its existing opener.
[anchor construction and scheme filter](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/renderer.ts),
[activation behavior](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/wterm.ts),
[platform modifier](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/src/hyperlink.ts).

Coder's ghostty-web contains an OSC 8 provider **and** a plain-URL regex provider, although the latter
is explicitly single-line and does not include file paths. xterm uses `linkHandler` for OSC 8 and the
web-links addon for plain URLs. Feature presence in source is distinct from successful activation in
the executable spike.
[ghostty-web URL provider](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/providers/url-regex-provider.ts),
[ghostty-web OSC 8 provider](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/providers/osc8-link-provider.ts),
[xterm API](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/typings/xterm.d.ts),
[xterm web-links addon](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-web-links/src/WebLinksAddon.ts).

## Packaging and measured artifacts

The npm packages are ESM with TypeScript declarations. `@wterm/dom` depends on/re-exports
`@wterm/core`; `@wterm/ghostty` also depends on `@wterm/core`. CSS is an explicit
`import '@wterm/dom/css'`. The built-in WASM lives in a lazy JavaScript chunk by default; custom WASM
URLs and the Ghostty option avoid requesting that embedded chunk. Compiled modules are cached while
terminal memories remain independent. Ghostty normally fetches a separate WASM asset; Vite URL
imports are supported, and the final app must deploy the emitted asset/chunks.
[DOM package](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/dom/package.json),
[built-in loader](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/core/src/wasm-loading.ts),
[Ghostty bundler contract](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/packages/@wterm/ghostty/README.md).

Measured by downloading npm registry tarballs and reading their WASM members. Gzip uses Python
`gzip.compress` defaults; compressed bytes are illustrative, not production transfer measurements.

| Artifact | Raw bytes | Gzip bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `@wterm/core@0.5.4` `wterm.wasm` | 27,643 | 10,944 | `7cc866dd25a9d9d96077aae80403130d1277f9ea248c4e976d3f4e50e1351e7d` |
| `@wterm/ghostty@0.5.4` `ghostty-vt.wasm` | 591,867 | 194,700 | `da382d54a9d1115e994802c90411e754fc1f7d090e3a28b34b465b187f41be6d` |
| `ghostty-web@0.4.0` `ghostty-vt.wasm` | 423,045 | 123,975 | `d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a` |

Source distributions: [wterm core](https://registry.npmjs.org/@wterm/core/-/core-0.5.4.tgz),
[wterm Ghostty](https://registry.npmjs.org/@wterm/ghostty/-/ghostty-0.5.4.tgz),
[ghostty-web](https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0.tgz).
These are WASM-only sizes with different feature sets. They do not compare total application bundles,
runtime memory or rendering speed. The small default binary is not the full-featured Ghostty option.

wterm's code is Apache-2.0; its embedded Ghostty dependency is MIT. Coder's ghostty-web is MIT. A
redistributed build must retain the applicable notices.
[wterm license](https://github.com/vercel-labs/wterm/blob/cc067a20a616fe62f0893ec94005943c349bb492/LICENSE),
[Ghostty license](https://github.com/ghostty-org/ghostty/blob/v1.3.1/LICENSE),
[ghostty-web license](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/LICENSE).

## Known reports to reproduce before choosing

| Report | Why it matters | Evidence status in this upstream note |
| --- | --- | --- |
| [#246: cell measurements under ancestor CSS transforms](https://github.com/vercel-labs/wterm/issues/246) | Reported `transform: scale(.5)` halves measured cells and gives the wrong fitted row count. Relevant to scaled terminal previews and transformed DOM presentations. | Reported October 19 against `@wterm/dom@0.5.4` with Ghostty in Chrome; source measurement uses transformed `getBoundingClientRect()`. Runtime reproduction belongs in the spike. |
| [#245: blank viewport after clear with focused deep history](https://github.com/vercel-labs/wterm/issues/245) | Reported textarea position retains old scroll height after `ESC[3J`, leaving the prompt offscreen until refocus. | Reported October 19 against the same packages/browser. Runtime reproduction belongs in the spike. |
| [#235](https://github.com/vercel-labs/wterm/issues/235), [#236](https://github.com/vercel-labs/wterm/issues/236), [#237](https://github.com/vercel-labs/wterm/issues/237) | Built-in RGB, Unicode and resize losses prevent treating the default core as xterm-equivalent. | Supported by source inspection; browser/core fixtures should quantify the exact impact. |

The absence of a report is not a compatibility guarantee. In particular, terminal replay fixtures
cannot establish full live Codex/Claude interaction, our clipboard/shortcut routing, PTY resize,
history transport, CSS3D focus/hit testing or safe release/reconnect behavior. Parser/rendering
performance claims also require measurements in Herdr's own path; Ghostty's native renderer and
wterm's DOM renderer are different systems.
