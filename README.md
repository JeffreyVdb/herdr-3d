# herdr-3d

A cute 3D "real world" management game that is a live front-end for [herdr](https://herdr.dev).

- **Building** = group of herdr sessions ("Personal", "Work")
- **Floor** = herdr session (project)
- **Worker at a desk** = herdr workspace running an agent (claude-code / codex)
- **Freelancers** = workers an orchestrator hires to delegate work (write-code flow)

The game runs on the MacBook (three.js, WebGPU/Metal, Chrome app window); all data and work live on the herdr server,
reached through an SSH tunnel to a Go bridge daemon.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions.md`](docs/decisions.md)
- Research: [`docs/research/`](docs/research/)
