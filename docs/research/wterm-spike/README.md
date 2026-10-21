# wterm comparison spike

Research for [#176](https://github.com/JeffreyVdb/herdr-3d/issues/176), run on 2026-10-21.
No production code or dependencies changed. Findings: [wterm-assessment.md](../wterm-assessment.md).
Upstream sources: [wterm-upstream-assessment.md](../wterm-upstream-assessment.md).

This standalone Vite fixture compares xterm 6.0.0, wterm 0.5.4 with its default core,
and wterm 0.5.4 with its Ghostty core. It reuses the earlier terminal experience
spike's Python PTY and WebSocket server, each connection running only a canned TUI.
It never opens a shell or attaches to an existing worker. All servers bind localhost;
ports are leased with `portlease`.

From the repository root, using Node 26.12.0 and pnpm 11.7.0:

```sh
pnpm -C docs/research/wterm-spike install --frozen-lockfile
pnpm -C docs/research/wterm-spike probe
pnpm -C docs/research/wterm-spike build
# Optional interactive fixture; stop with Ctrl+C:
pnpm -C docs/research/wterm-spike dev
```

Requires Python 3, `portlease` and the repo's installed Playwright Chromium.
Select `?engine=xterm`, `?engine=wterm` or `?engine=wterm-ghostty`.
The probe records known shortcomings rather than asserting all engines pass;
assertion success means the investigation executed, not feature parity.
`results.json` contains the observations; ignored `artifacts/` contains clear-screen screenshots.
Link activation is intercepted, so the automated probe visits no external link.
Clipboard writes use disposable test text. The result separates native Ctrl+C
from explicit host clipboard copying of the selected text.

`herdr-results.json` records a separate rerun of the existing Herdr 0.9.1 controller probe:

```sh
python3 docs/research/terminal-experience-spike/herdr-probe.py \
  --out docs/research/wterm-spike/herdr-results.json
```

The two experiments have different evidence boundaries: browser interactions use
raw PTY output, while real Herdr produces reconstructed screen snapshots.
Neither is an end-to-end test of real Claude/Codex prompt and approval editors or
the Mac Chrome app. Full-history search, screen readers, real IME, touch,
performance and reconnect/load behavior remain untested here.

The build validates Vite ESM/CSS/WASM asset emission for this fixture only;
it does not measure the game's bundle budget or integrate a new engine.
