# Manual processes

## Command requests

A settled final agent reply may ask the user to run a shell command. The classifier gates an extraction that returns exact spans of the reply; the bridge validates those spans before showing a card. A card is a proposal for review, and never executes a command by itself. The host must be the bridge for a suggested command to run. A named absolute working directory is used; otherwise the worker's working directory is used. A reply is identified by worker and text hash, persisted across restarts, and closes when the transcript moves on, it is dismissed, or a run consumes it. `HERDR_WORLD_COMMAND_REQUESTS_ENABLED` can switch the feature off.

## Tailscale Serve

A supported simple `tailscale serve --bg` command offers an explicit foreground variant for review; it never silently changes the command. The adapter identifies the endpoint and prepares scoped cleanup by replacing its target with `off`, preserving the original flags. Conflict detection reads ServeConfig TCP, Web and foreground session entries. Background Serve persists beyond its launcher and needs explicit cleanup; global reset and stopping the daemon are outside this adapter. Other command effects are not automatically reversible.
