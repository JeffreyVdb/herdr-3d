# Terminal experience: diagnosis and runnable spikes

Investigated 2026-10-21 at `ef04471`. This is an investigation and isolated spike, not a production migration. It follows [the earlier feasibility note](libghostty-terminal-feasibility.md) with executable evidence. Upstream versions, source links and transport details are in [terminal-engine-options.md](terminal-engine-options.md).

Follow-up tickets: [#175, automatic enlargement](https://github.com/JeffreyVdb/herdr-3d/issues/175), and [#176, full-screen seated workspace and terminal interaction](https://github.com/JeffreyVdb/herdr-3d/issues/176). After the spike, the user requested that the seated screen fill the app window like overview; the recommendation below incorporates that requirement. The [complete spike source, lockfile and recorded results](https://github.com/JeffreyVdb/herdr-3d/issues/176#issuecomment-6314145269) are also preserved in the ticket.

## Recommendation

Fix the automatic enlargement immediately, then give the seated workspace the full app window, with a complete browser terminal widget connected to Herdr's **controller** API. Keep the canvas texture for distant monitors. Start the production path with xterm 6, already a dependency, and keep Ghostty's browser widget as a candidate behind the same narrow adapter. The Ghostty prerelease passed this spike; the stable package did not cover the requested interactions. Replacing only the parser with official libghostty-vt would retain most of today's problems.

## Why the current terminal feels wrong

### Split panes are enlarged, even at 100%

[LaptopTerminal](../../game/src/laptop/terminal.ts) always passes `fitWidth: true` to [the painter](../../game/src/laptop/paint.ts). `widthFit` multiplies the ordinary fit by up to **2.5**, on top of the user's 70–200% zoom. The viewport then crops rows, following the cursor. This was intentional in [decision #74](../decisions.md#2026-10-01--a-laptop-of-a-split-pane-is-fullscreen-74); it explains why the size depends on the pane shape and why resetting to 100% does not restore the entire screen.

The [sizing probe](terminal-experience-spike/sizing-probe.mjs) imports the real production `viewport` function through Vite. With a 1200×600 canvas, 40 source rows and 100% zoom:

| Source columns | Automatic multiplier | Cell height | Rows visible | Rows without automatic width fit |
| --- | ---: | ---: | ---: | ---: |
| 120 | 1× | 13.5 px | 40 | 40 |
| 60 | 2.01× | 27.14 px | 19 | 40 |
| 40 | 2.5× | 33.75 px | 16 | 40 |

Run from the repository root after `make deps`:

```sh
node docs/research/terminal-experience-spike/sizing-probe.mjs
```

It repeatedly exits **1**, with `19 !== 40`: the deliberately unmet expectation is that 100% shows all 40 rows. This is the minimized reproduction of enlarged/cropped split panes, independent of Herdr, stored settings or camera state. Disabling only width-fit inside the experiment restores all rows. The pure reproducer establishes a frontend cause; it does not establish the backend state of every incident the user saw. The complete canvas renderer also scales fonts to its cell grid, so a fixed font size is a better long-term contract than fitting glyphs to arbitrary remote dimensions.

The other hypotheses remain distinct: the bridge currently follows Herdr's pane dimensions, and prior zoom work documents headless limits; saved zoom can compound enlargement. Sitting explicitly calls `setGlance(false)`, so the separate large-type distance view is not required to reproduce this failure. No live user pane was inspected or changed.

### Most terminal interaction is bypassed

`LaptopTerminal` constructs xterm with `scrollback: 0` and **never calls `Terminal.open`**. It reads the parsed cells and paints them into a Three.js texture. Consequently the normal browser renderer, selection, hyperlink hit testing and terminal mouse encoder are not attached to a DOM surface. The [controller's wheel listener](../../game/src/laptop/index.ts) only handles Ctrl+wheel for zoom. Ordinary wheel scrolling has no terminal path.

Every `full` frame writes RIS (`ESC c`) before repainting. Increasing xterm's history limit alone is therefore insufficient: full frames reset that history, and screen-diff frames are already rendered snapshots rather than the original PTY output. All three spike widgets lost their local history on RIS. Screen snapshots can also lose application modes needed to encode input. [The existing key transport](../../internal/herdr/term.go) allows named keys and control-free text; a new widget's arbitrary `onData` bytes cannot simply be passed as `worker.keys.text`.

## What the spikes proved

### Browser widgets over an isolated raw PTY

[Run the spike](terminal-experience-spike/README.md) to switch between xterm, Ghostty stable and Ghostty prerelease. Each connection runs a small Python TUI in a fresh PTY, with no shell or agent. Playwright uses actual pointer/keyboard/wheel events and a native Linux paste shortcut. [Recorded results](terminal-experience-spike/results.json) include the bytes received by the PTY; screenshots are generated under the ignored `artifacts/` directory.

| Observed capability | xterm 6.0.0 + addons | ghostty-web 0.4.0 | ghostty-web 0.4.0-next.20.g1858a59 |
| --- | --- | --- | --- |
| Split width changes columns, keeps font size | Pass | Pass | Pass |
| Actual PTY receives new dimensions | Pass | Pass | Pass |
| Drag text selection | Pass | Pass | Pass |
| Plain URL activation | Pass | Pass | Pass |
| Named OSC 8 hyperlink activation | Pass | **Fail** | Pass |
| Wheel scrollback of streamed output | Pass | Pass | Pass |
| Click selects a TUI menu option using SGR mouse reports | Pass | **Fail: no reports** | Pass |
| Keyboard selects a menu option | Pass | Pass | Pass |
| Multiline paste is bracketed, with no extra submit key | Pass | **Fail: unbracketed text** | Pass |

The xterm row uses its DOM renderer, FitAddon and WebLinksAddon. OSC 8's default confirmation is accepted by the browser probe. xterm normalizes pasted LF to CR **inside** the brackets; Ghostty prerelease retains LF. These are not failures to preserve multiline paste. The Ghostty packages use their built-in canvas renderer and FitAddon, with a bundled Wasm asset loaded by Vite. No Zig compiler or native app shell is needed for this consumer spike.

These are functionality results, **not performance benchmarks**. The two widgets have different measured cell heights at the same nominal font size. There is no basis here to promise Ghostty speed, battery or native-Ghostty visual parity. Ghostty stable also reports `buffer.active.viewportY` as zero while its own `terminal.viewportY` changes, illustrating why its xterm-like API should not be assumed identical.

### Herdr 0.9.1 controller, using a separate throwaway session

[herdr-probe.py](terminal-experience-spike/herdr-probe.py) creates isolated configuration/runtime directories, a uniquely named session and a synthetic terminal program. It stops and deletes that session afterward. [Recorded results](terminal-experience-spike/herdr-results.json):

- An observer requested at **60×12** left the actual PTY at **119×40**.
- `terminal session control ... --cols 80 --rows 24` changed the actual PTY to **80×24**. `terminal.resize` then changed it to **110×31**, confirmed from inside the child process.
- `terminal.scroll` moved the server's history offset from **0 to 12**, with 79 lines available.
- The output retained the named OSC 8 URL.
- Mouse DECSET modes emitted by the child did **not** reach the CLI's ANSI output or a separate metadata event.
- A concurrent controller was refused without takeover; cleanup stopped the server and deleted the session.

This supersedes the assumption that headless resize necessarily requires a native Herdr TUI: **the current observer/zoom integration** has that limitation, but Herdr's controller provides another path.

Controller output remains rendered screen diffs. The browser experiment's raw-PTY scrollback and mouse success must not be mistaken for a completed Herdr integration. The controller's server-side history should remain authoritative. Herdr already has structured attached mouse events internally, but its JSONL terminal CLI exposes input/resize/scroll/release and discards mouse/keyboard-mode metadata. An upstream CLI extension is the narrow next experiment; see the pinned source evidence in [the options report](terminal-engine-options.md).

## Suggested implementation sequence

1. **Restore predictable 100% sizing.** Remove the automatic width enlargement for the seated terminal; show the entire grid until a real resize succeeds. Update the existing tests that intentionally require width filling. Keep explicit user zoom. This is a small frontend fix independent of engine choice.
2. **Build the full-screen seated workspace with xterm.** Follow the overview's in-app overlay pattern (`position: fixed; inset: 0`), with compact controls and the remaining viewport available to the terminal or conversation. Retain terminal/conversation/images navigation, worker identity and a visible stand action; preserve draft and focus state when switching modes. Keep background input inert and restore it on exit. Avoid the browser Fullscreen API, which takes Esc for Chrome itself. Use a fixed font size and FitAddon-derived dimensions, distinct from the existing Herdr tab-zoom control also called “Fullscreen.” The distance monitors keep their existing texture. Add selection, copy, URL/OSC 8 activation and focus handling through the widget. Validate Ctrl/⌘ shortcuts and browser focus on the Mac.
3. **Add a scoped Herdr controller session to the bridge.** Bind it to the connection and worker; resize the PTY on fitted dimension changes; release on standing/disconnect/removal; handle busy ownership explicitly, with no automatic takeover. Keep backend history authoritative and translate ordinary wheel input to `terminal.scroll`. Handle full/diff synchronization and lost frames without fabricating browser history. Preserve the bridge's authentication, limits, ordering and audit behavior.
4. **Finish protocol-aware input.** Expose Herdr's existing structured mouse operation and mouse/keyboard/paste modes through its controller CLI, or another supported upstream interface. Map DOM coordinates to terminal cells. Do not enable mouse mode unconditionally or blindly forward terminal replies generated from snapshot replay. Test application-cursor keys, bracketed paste, alternate-screen wheel behavior, mode changes, reconnect and a controller conflict. Actual TUI clicks work only when the target app supports mouse input; text/link selection is a separate browser feature.
5. **Evaluate Ghostty behind the same adapter.** The pinned prerelease is viable enough for a pilot. Gate adoption on the above contracts plus Unicode/IME, Mac clipboard, DPR/zoom, accessibility, focus, scroll behavior and real Claude/Codex dialogs. Compare input latency and rendering cost with the same transport and font. A direct official libghostty-vt integration is more work than either widget and should be justified by a capability or measurement.

The first implementation ticket can deliver the sizing correction; the second can deliver the seated widget/controller path. Full mouse reporting has a concrete upstream protocol dependency. A staged rollout can retain the current observer as a read-only fallback if a controller is busy.

## Validation and limits

The current renderer reproduction is intentionally red. The browser capability experiment and isolated Herdr probe passed, with the stable Ghostty deficiencies recorded as findings. Repository lint, all Go tests and **4,113 Vitest tests** passed; the shell checks were rerun after selecting the already-installed shellcheck tool for this worktree. Product sources, production dependencies and live user sessions were not changed. No full game e2e suite was needed for this docs/tooling-only change.

Not established: native Mac Chrome behavior, actual Claude/Codex TUI interoperability, integrated controller reconnect/ownership restoration, accessibility parity, or comparative performance. The full-screen seated UI was requested after the spike and has not been built or measured. These are acceptance checks for the proposed implementation, not reasons to defer the confirmed sizing fix.
