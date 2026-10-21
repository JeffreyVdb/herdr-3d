# wterm spike for terminal experience #176

Investigated 2026-10-21 at Herdr 3D `596dd49e3e6bdb9eafc2e8edfd10d30e5f186ec8`.
Tracking: [#176](https://github.com/JeffreyVdb/herdr-3d/issues/176). The ticket was
amended with these findings and an [11-file source/result appendix](https://github.com/JeffreyVdb/herdr-3d/issues/176#issuecomment-6315393012),
so reproduction does not require a pushed research branch.

## Decision

Keep xterm 6 as the implementation baseline for #176. **wterm with its optional
Ghostty core is a viable candidate, but the tested release does not satisfy all
requirements without additional work.** Its default lightweight core has Unicode
and color losses. Both variants have reproducible DOM scrolling and fitting bugs.
No production implementation or dependencies were changed.

wterm does have more recent release activity than Coder's ghostty-web: `0.5.4`
was published September 29, versus ghostty-web stable `0.4.0` on December 9, 2025,
and its last prerelease on June 28, 2026. The observed stars are 3,509 versus 2,981;
maintenance activity is the stronger reason to investigate. This does not establish
greater stability than xterm or guarantee ongoing support. See the pinned primary
sources in [the upstream assessment](wterm-upstream-assessment.md).

## Comparison with our existing integration

[LaptopTerminal](../../game/src/laptop/terminal.ts) uses xterm as an unopened VT
parser with zero local history, then [paint.ts](../../game/src/laptop/paint.ts)
draws cells into a Three.js canvas texture. The seated view therefore lacks the
browser widget's native interaction surface. Replacing that parser does not add
selection, clickable links, scrolling or mouse input.

wterm is a DOM widget, with a headless core API available separately. It has no
xterm-compatible buffer, parser or addon contract and no ready-made canvas for
`CanvasTexture`. The sensible candidate scope is the full-window seated workspace;
keep existing distant monitor textures. Mapping its headless cells to our painter
would be separate work with no demonstrated interaction benefit.

## Browser experiment

[wterm-spike/](wterm-spike/README.md) is isolated research code. It compares
`@xterm/xterm@6.0.0` plus fit `0.11.0` and web-links `0.12.0`,
`@wterm/dom@0.5.4` using its default core, and the same widget using
`@wterm/ghostty@0.5.4`. Source matches release
`cc067a20a616fe62f0893ec94005943c349bb492`. It uses Node 26.12.0,
pnpm 11.7.0, Vite 8.3.1, Playwright 1.61.1 / Chromium 149.0.7827.55 on Linux at 1280×900,
and the earlier spike's real Python PTY/canned TUI. No real agent was attached.
All widgets use 16px monospace. Wterm uses 20px rows, xterm measures 19px rows;
matching nominal font size does not imply identical cell geometry.

Observed results are in [results.json](wterm-spike/results.json).

| Check | Full xterm widget | wterm default core | wterm Ghostty core |
| --- | --- | --- | --- |
| Half-width pane, fixed font, actual PTY resize | Pass: 113×22 → 55×22 | Pass: 114×21 → 57×21 | Pass: 114×21 → 57×21 |
| Fresh drag selection and host clipboard readback | Pass | Pass | Pass |
| Native Ctrl+C in this Linux harness | Did not update clipboard | Pass | Pass |
| Plain URL click | Pass with addon | No automatic link | No automatic link |
| Named OSC 8 link click | Pass | Pass | Pass |
| Typing and keyboard menu answer | Pass | Pass | Pass |
| Multiline bracketed paste, no appended Enter | Pass | Pass | Pass |
| Wheel through streamed history | Pass | Pass | Pass |
| Fresh alternate-screen SGR mouse menu | Pass | Pass | Pass |
| Same mouse menu after deep history | Pass | Pass | Fails until explicit refocus |
| Exact RGB `12,123,234` | Preserved | Quantized to palette index 33 | Preserved |
| Combining `e` + acute | One cell | Two separate cells | One cell |
| Family ZWJ emoji | Split across multiple cells with baseline settings | Split across multiple cells | One two-column grapheme |
| Unwrapped cursor-line text after 20→10→20 resize | Tail absent in this case | Tail absent | All 18 characters retained |
| Clear focused deep history without blank viewport | Pass | Fail | Fail |

The resize case writes `ABCDEFGHIJKLMNOPQR` on the active cursor line before
narrowing; it is a specific cursor-line observation, not a general xterm reflow
failure. No Unicode addon was loaded in xterm. The probe records native Ctrl+C
separately from host copying with the browser Clipboard API; the full app's
keyboard/menu copying policy still needs integration testing. Links are intercepted
at activation, so the test does not navigate externally. Selection was tested on
a fresh mount; this does not establish preservation through every resize/reset.

### Reproduced defects

- [wterm #245](https://github.com/vercel-labs/wterm/issues/245): after writing 300
  lines, focusing and sending `ESC[3J ESC[H ESC[2J`, both wterm variants report
  zero history but remain scrolled thousands of pixels past the prompt. In the
  final run their offsets were 10,571 and 5,551px; xterm stayed at zero. The
  Ghostty variant also reproduced a blank alternate screen after history, so SGR
  menu clicks failed until `term.focus()` repositioned the input. Fresh menu
  clicks passed. This is a viewport failure, not absent Ghostty mouse support.
- [wterm #246](https://github.com/vercel-labs/wterm/issues/246): separate 800×400
  containers at scale 1 and .5 yielded 95×23 versus 95×47 grids, with row height
  17 versus 8.5px, for both cores. A transformed parent should not change the
  underlying CSS grid dimensions. This matters if a future DOM terminal is
  placed under a transform; it is avoidable with the untransformed full-window
  overlay in #176. Current monitor textures are not transformed DOM widgets.
- RIS differs by core: xterm and wterm Ghostty cleared local history; wterm
  default retained 257 rows. Retaining those rows does not recover Herdr history:
  they came from screen reconstruction, not authoritative original PTY output.

Frozen dependency install and a standalone **Vite production build passed**, with
CSS, the lazy built-in WASM chunk and Ghostty's hashed WASM asset emitted.
This validates bundling in the fixture, not the game's bundle budget. The Ghostty
WASM is 591,867 bytes; the often-advertised small built-in core is a different
feature set. No speed, memory or battery benchmark was run.

## Herdr transport experiment

Reran the existing isolated Herdr probe with CLI **0.9.1**; see
[herdr-results.json](wterm-spike/herdr-results.json). It creates/deletes only its
own session, never uses takeover, and verified cleanup.

- An observer requested 60×12 while the child PTY remained 119×40.
- Controller attachment changed the PTY to 80×24, then resize changed it to 110×31.
- Herdr history scrolling changed the authoritative offset from 0 to 12.
- OSC 8 targets survived, but DECSET mouse modes were not forwarded by the CLI.
- A competing controller was refused, preserving existing ownership.

As in the original spike, both observer and controller output reconstructed ANSI
screen frames. Neither supplies the browser with the original history operations
and input-mode negotiation. Any engine needs Herdr-owned scrollback, actual PTY
resize through the controller, and a completed mouse/keyboard/paste mode path.
`worker.keys.text` rejects controls; widget `onData` cannot simply feed it raw
escape sequences. Widget-generated terminal replies must not blindly become user
input while parsing screen snapshots.

## Integration work still required

Retain #176's full-window overlay, controller ownership/release/reconnect, history
transport, focus and shortcut rules. For wterm specifically, add plain URL detection
and host link routing; resolve #245; avoid transformed ancestors or resolve #246;
map theme/font preferences to CSS; deploy the WASM asset; and dispose supplied
Ghostty cores separately from `WTerm.destroy()`. The default history limit is
1,000 rows; Ghostty's `scrollbackLimit` is a **byte budget**, not a line count.

Paste must also preserve #38's insertion-before-Enter behavior and Herdr's existing
secret review, image uploads, prompt/question/approval paths and ordered input.
Raw terminal callbacks are not a replacement for those product behaviors.

The tests establish a conditional candidate, not “everything works.” Live Claude
and Codex editors, Mac Chrome app shortcuts/IME, accessibility, touch, wrapped URLs,
advanced mouse/keyboard modes, reconnect/ownership failure cases and performance
with the 3D scene remain unverified. Address the shared transport requirements
regardless of engine; reconsider wterm Ghostty after its reproduced bugs and link
gap are resolved, then run those end-to-end checks before selecting it.
