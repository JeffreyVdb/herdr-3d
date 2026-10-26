# herdr-3d

A cute 3D "real world" management game that is a live front-end for [herdr](https://herdr.dev).

- **Building** = group of herdr sessions ("Personal", "Work")
- **Floor** = herdr session (project), or a virtual floor the user defines inside one (its workspaces live in that
  session)
- **Worker at a desk** = herdr workspace running an agent (claude-code / codex)
- **Freelancers** = workers an orchestrator hires to delegate work (write-code flow)

The game runs on the MacBook (three.js, WebGPU/Metal, Chrome app window); all data and work live on the herdr server,
reached through an SSH tunnel to a Go bridge daemon.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions by feature: [`docs/decisions/`](docs/decisions.md)
- Bridge protocol: [`docs/protocol.md`](docs/protocol.md)
- Dictated hiring (Ctrl/⌘+Shift+Space, Hire in background): [`docs/dictation.md`](docs/dictation.md)
- Keyboard shortcuts (press `?` in the game): [`docs/shortcuts.md`](docs/shortcuts.md), generated from `game/src/input/shortcuts.ts`
- Research: [`docs/research/`](docs/research/)
- Contributing / build & test: [`CONTRIBUTING.md`](CONTRIBUTING.md)
