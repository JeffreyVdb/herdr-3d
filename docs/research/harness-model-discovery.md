# Harness model discovery

Checked 2026-09-29 using parallel-cli search/extract and the installed CLIs.

Codex exposes `model/list` through `codex app-server`. A client sends `initialize`, then the `initialized`
notification, before querying. The model-list response includes picker-visible model IDs, supported reasoning
efforts and `nextCursor`; clients should use the returned values instead of a fixed list.
Source: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

Claude Code's Agent SDK exposes `supportedModels()` and includes the same `models` array in its initialization
result. `ModelInfo.value` is the accepted model identifier; `resolvedModel` provides the canonical ID behind an
alias, and `supportedEffortLevels` provides model-specific capabilities. The bridge consumes that initialization
control response directly over stream-json stdin/stdout, without adding a Node/Python SDK runtime to the Go daemon.
Source: [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

Local probes with Codex 0.159.0 and Claude Code 2.1.284 returned `gpt-6.1-sol` and the current Claude catalog without
an inference request. Claude aliases `default` and `opus` both resolved to the same canonical ID; we deduplicate
canonical IDs to preserve existing stored choices. Older Claude versions without `resolvedModel` retain the
returned alias; provider-specific canonical IDs outside the launch bounds also retain a valid alias.
Missing Claude effort metadata falls back to the CLI's basic low/medium/high levels.
The requested model is also documented as `gpt-6.1-sol` in the
[official OpenAI model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

Implementation boundaries:

- Discover both catalogs at bridge startup, preserving harness order. Restart the bridge to refresh.
- Find executables on `PATH`, then in `~/.local/bin` for service environments. Explicit CLI paths are configurable.
- Keep the existing catalog only for a harness whose probe fails, times out, or returns no launchable entries.
- Encode effort capabilities using the existing `efforts` intersection and per-model `extra_efforts`, so current
  game pickers and all server command validators use the same catalog without a protocol version change.
- Probe in an isolated temporary working directory using the same cleaned environment as worker launches. No
  user turn is sent. Disable Claude hooks, tools, MCP connections and session persistence.
- Limit probes to 10 seconds, 8 MiB total output, 1 MiB per protocol line, and 100 Codex pages. Kill the probe's
  process group and reap it when finished or canceled. Ignore unrelated notifications; reject protocol errors.
- Keep each model's `displayName` (Codex `model/list` and Claude's initialize `models[]`) as the optional `model_labels`
  (#200), keyed by launch id and used by the UI instead of the slug. The Claude `default` alias is labelled "Default
  (recommended)" and resolves to the same id as a concrete alias (`sonnet` → "Sonnet 5.5"): its generic label is dropped
  and the id takes the first concrete name. Labels are bounded plain text; unusable ones are dropped.
- Filter model/effort strings to the existing `herdr.Control` argument bounds. Provider IDs outside those bounds
  still require a separate change to the launch surface.

Codex's app-server may return a bundled or cached catalog. A harness catalog is the appropriate source for this
app because the app launches that harness. It does not guarantee the newest account-specific API catalog; keeping
Codex updated remains necessary. The official account-token model listing guidance explicitly calls out this
cache distinction: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Model pricing remains a separate concern: the transcript usage reader already marks unfamiliar models as having
an estimated fallback price, and `--pricing` can supply an override. Discovery does not invent prices.

Search artifacts: `/tmp/herdr-codex-model-search.json`, `/tmp/herdr-claude-model-search.json`.
Extracted documentation: `/tmp/herdr-codex-model-docs.json`, `/tmp/herdr-harness-model-docs.json`.
