# Terminal experience spike — research only

Question: can a complete browser terminal keep text size stable and support selection, links, scrollback, keyboard input and terminal mouse input? Compare xterm 6.0.0 with ghostty-web 0.4.0 and its pinned prerelease, using a real local PTY and a canned TUI. Separately reproduce the current game renderer's enlargement and probe Herdr's actual controller capabilities.

This directory is independent of the game build. It is disposable experimental code, not a production terminal or a general shell gateway. Findings and the suggested implementation are in [terminal-experience.md](../terminal-experience.md); upstream evidence is in [terminal-engine-options.md](../terminal-engine-options.md).

Implementation tracking: [#175, automatic enlargement](https://github.com/JeffreyVdb/herdr-3d/issues/175), and [#176, full-screen seated workspace and terminal interaction](https://github.com/JeffreyVdb/herdr-3d/issues/176). The full-screen in-game layout is a follow-up requirement, not part of this fixture.

## Run the browser comparison

From the repository root, with its Node/pnpm pins selected:

```sh
pnpm -C docs/research/terminal-experience-spike install --frozen-lockfile
pnpm -C docs/research/terminal-experience-spike dev
```

Requires `python3` (Unix PTY support) and `portlease`. Open the printed localhost URL. Choose an engine, toggle split width, drag to select text, Ctrl/⌘-click the links, and write history to scroll with the wheel. Open the mouse menu and click option 1 or press 1/2. Press q to return. Linux paste is Ctrl+Shift+V. Stop with Ctrl+C.

Every browser connection starts an isolated Python test program inside a PTY. There is no shell and no connection to an existing Herdr session. Resize messages use `TIOCSWINSZ`, and the status shows the PTY size read back using `TIOCGWINSZ`. Raw `onData` input goes to this fixture only.

## Reproduce the findings

```sh
# Real pointer, keyboard, clipboard and wheel actions in headless Chromium.
# Uses the Playwright browser already installed for this repository.
pnpm -C docs/research/terminal-experience-spike probe

# Current production renderer: EXPECTED exit 1, showing 19 visible rows instead of 40.
make deps
node docs/research/terminal-experience-spike/sizing-probe.mjs

# Requires Herdr; creates and deletes its own isolated session/config/runtime.
python3 docs/research/terminal-experience-spike/herdr-probe.py \
  --out docs/research/terminal-experience-spike/herdr-results.json
```

The browser probe writes [results.json](results.json) and screenshots under ignored `artifacts/`. It checks the full interaction set for xterm and Ghostty prerelease; stable Ghostty's missing mouse reporting, named links and bracketed paste are recorded. Screenshots show history and menu selection. Links are intercepted in the probe so it opens no external site; the interactive demo uses the widgets' normal link handling.

The sizing probe loads the actual production `paint.ts` using the game's installed Vite. It was red when the spike ran (the automatic width fit cropped rows at 100%) and is green since #175 removed that fit: all three cases show their 40 rows at 100%.

[herdr-results.json](herdr-results.json) records observed versus actual PTY sizes, history scrolling, OSC 8 retention, absent mouse-mode events, refusal of a competing controller and cleanup. The probe was run with Herdr 0.9.1. It uses no `--takeover` and never targets an existing session. A future Herdr version that fixes mode forwarding may deliberately fail its current expected-gap assertion.

## Scope

The browser fixture streams **raw PTY output**; Herdr's observer and controller stream **rendered ANSI screen frames**. Success in the first does not prove that forwarding the second into a browser widget supplies history or terminal modes. Use Herdr's history API and complete its input/mode protocol for the actual integration. The [report](../terminal-experience.md) keeps these two experiments separate.

The Ghostty browser packages are Coder's browser wrapper/fork, not a test of the current official libghostty-vt C/Wasm API or Ghostty's native renderer. Package versions and integrity hashes are pinned in this directory's lockfile. No performance claim is made.
