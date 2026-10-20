# Codex accounts: can shared workers use a global switch?

Date: 2026-10-20. Ticket: [#136](https://github.com/JeffreyVdb/herdr-3d/issues/136), part of [#135](https://github.com/JeffreyVdb/herdr-3d/issues/135). Application revision inspected: `fea809e6996c6195fb79373b912fe24b342d49b8`.

## Decision

**NO-GO for reliable simultaneous workers on different accounts using one globally switched `auth.json`.** Starting on B and immediately restoring personal account A works initially, but leaves B unable to recover from a later 401. A startup lock and `WaitReady` cannot fix that lifetime dependency. Installed Codex reproduced this with both synthetic and real account credentials, native account discovery and controlled local inference. This conclusion does not depend on measuring a real token's lifetime.

**Add the separate-home adapter ticket before implementing #139's multi-account acceptance.** Prefer an auth home per account shared by that account's workers over independently cloned credentials per worker: clones can diverge after refresh-token rotation. The adapter still needs research into shared sessions, SQLite, config writes, hooks, plugins and discovery paths. This note does not certify an overlay layout. Keep `Prepare`'s environment return value; #139 must use it in the actual pane launcher, wake and fallback paths.

**Two real accounts and real refresh-token rotation were verified.** The user added the work login in `~/.codex-work` through a wizard and SSH callback tunnel to their MacBook; that tunnel was then closed. A temporary published codex-auth binary switched both real accounts in a throwaway shared home. Native app-server calls verified identities and a successful work-token refresh; the rotated snapshot survived switching and its refresh token was subsequently accepted by the authority. Personal auth remained unchanged. **Multi-day natural refresh cadence and full-game hire/sleep/seat behavior remain unverified.** Model responses, including the forced 401, were local fixtures, not real-model inference.

Evidence labels throughout:

- **[R]** Installed binaries with generated accounts and loopback services; no real credentials.
- **[L]** Read-only local metadata or aggregate counts; no credential contents recorded.
- **[R-live]** Two real accounts: native account discovery/refresh, plus local model responses in a temporary shared home. Credentials and emails are not included in the evidence artifact.
- **[S]** Pinned primary source or this repository's implementation; not a live game observation.
- **[U]** Not established in this investigation.

## Versions, commands and reproduction

`codex --version` returned **`codex-cli 0.163.0`**. `command -v codex-auth` returned no executable. Codex source: tag `rust-v0.163.0`, peeled commit [`83086188ae0614bd882818ff1aa23f3194962012`](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012). Switcher source: [`05d50bc4b613d36e2799e381a2640050766b679e`](https://github.com/Loongphy/codex-auth/tree/05d50bc4b613d36e2799e381a2640050766b679e), version `0.3.2-alpha.1`. The tested npm Linux x64 binary reports the same version, SHA-256 `b5f939550b44ba43fb62a08902c580034bb9d3d71925162c1279e30828b61558`; it was not built from the checkout, so commit identity is unverified.

Commands run to obtain primary evidence:

```bash
gh issue view 136 --repo JeffreyVdb/herdr-3d --json title,body,comments,labels,url
gh issue view 135 --repo JeffreyVdb/herdr-3d --json body
gh issue view 139 --repo JeffreyVdb/herdr-3d --json title,body
codex --version
command -v codex-auth
git ls-remote https://github.com/openai/codex.git refs/tags/rust-v0.163.0 'refs/tags/rust-v0.163.0^{}'
curl -fsSL https://api.github.com/repos/openai/codex/tarball/83086188ae0614bd882818ff1aa23f3194962012 -o /tmp/herdr-136-codex.tar.gz
mkdir -p /tmp/herdr-136-codex
tar -xzf /tmp/herdr-136-codex.tar.gz -C /tmp/herdr-136-codex --strip-components=1
codex app-server generate-json-schema --out /tmp/herdr-136-schema
```

The checked-in [app-server probe](codex-accounts/app_server_probe.py) reproduces account caching, forced refresh, 401 failure, restart/resume, switch-back and refresh thresholds. It uses temporary `CODEX_HOME`, synthetic auth, the existing mock model catalog, a temporary TLS certificate and portlease. Inference, account discovery and OAuth refresh point to loopback. Child proxy settings deny ordinary external CONNECT requests; these are process-level guards, not network-namespace isolation. Raw server stderr is discarded and only account/read results, account headers, terminal errors and counts are printed. No model tools execute; no global login or running worker is switched.

```bash
portlease run --project herdr-3d --service codex-accounts-research --name http -- \
  python3 docs/research/codex-accounts/app_server_probe.py
```

The [switcher probe](codex-accounts/switcher_probe.py) uses its own temporary home, two generated ChatGPT accounts, a blocked curl executable and closed loopback proxies. It verifies JSON structure, exit codes and saving a changed synthetic credential generation without printing any credential values. Install only into a temporary directory:

```bash
npm view @loongphy/codex-auth-linux-x64@0.3.2-alpha.1 dist.tarball dist.integrity scripts --json
mkdir -p /tmp/herdr-136-codex-auth-runtime
npm install --prefix /tmp/herdr-136-codex-auth-runtime --ignore-scripts --no-audit --no-fund \
  @loongphy/codex-auth-linux-x64@0.3.2-alpha.1
python3 docs/research/codex-accounts/switcher_probe.py \
  /tmp/herdr-136-codex-auth-runtime/node_modules/@loongphy/codex-auth-linux-x64/bin/codex-auth
```

After the user completed work login, the [live probe](codex-accounts/live_probe.py) ran with the two explicit source homes. Its switcher commands all used `--skip-api` for list and the local targeted switch form. A blocked curl guard recorded zero switcher network attempts. Native `account/read` used OpenAI's backend; model responses used loopback. During the temporary-home phase OAuth refresh was blocked locally and never attempted. `--refresh-work` separately refreshed the authoritative work home before the test and again after verifying the restored snapshot, keeping that login current. Use that flag only when no other process is using the work login.

```bash
portlease run --project herdr-3d --service codex-accounts-live-research --name http -- \
  python3 docs/research/codex-accounts/live_probe.py \
  --personal-home "$HOME/.codex" --work-home "$HOME/.codex-work" \
  --switcher /tmp/herdr-136-codex-auth-runtime/node_modules/@loongphy/codex-auth-linux-x64/bin/codex-auth \
  --refresh-work
```

The final run's [sanitized results](codex-accounts/live-results.json) record booleans, native plan strings and timings. No account keys, IDs, emails, tokens, auth documents or raw child diagnostics are stored. Switching to work, starting its server, confirming identity and restoring personal took **0.840 seconds**; the next controlled 401 still failed. This is direct evidence against the switch-start-switch-back proposal.

## 1. When does an app-server read auth?

**[S]** `AuthManager` loads credentials into a process cache. Ordinary managed ChatGPT reads return that cache; they do not watch `auth.json`. Explicit reload paths include login/logout changes. Proactive refresh and 401 recovery use a **guarded disk reload**, comparing the account ID to the cached account before accepting credentials. A different account causes a permanent refresh error rather than silently adopting it. Same-account credentials changed on disk can be reused without another refresh request. The refresh semaphore is local to the manager, not an interprocess lock. Sources: [cache and auth reads](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L2035), [guarded reload](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L2486), [refresh](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L2849), [401 recovery](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L1977).

**[R]** Start server A, initialize, read account, start a thread, replace isolated disk auth with B. `account/read` still reports A; a normal inference turn completes and its `ChatGPT-Account-ID` header is A. It is process caching, not account isolation.

`account/read {"refreshToken":true}` also still reports A with a successful RPC response after the disk switch, while zero OAuth refresh requests occur. **It is not a refresh-success check**: the account handler consumes the refresh outcome before returning account data. Use the actual turn error to detect this failure. [Account handler](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs#L174), [refresh outcome handling](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor.rs#L1103).

**[R-live]** Both real account IDs matched their respective app-server replies internally. Personal stayed personal after switching disk to work; work stayed work after restoring personal. Explicit refresh requests made while the disk held the other account also returned successful account/read responses, masking the guarded-refresh failure. No refresh request reached the local guard during this phase.

## 2. Refresh cadence: the eight-day number is a fallback

**[S]** The proactive rule is checked when auth is requested, not by an eight-day background timer:

1. If the access token has a parseable JWT `exp`, refresh when it expires within **five minutes**, including an already expired token.
2. Otherwise, refresh when `last_refresh` is older than **eight days**.
3. A **401 can trigger recovery earlier**, irrespective of either threshold. An explicit refresh request is another trigger.

The expiry branch returns before the eight-day test. Therefore a recent `last_refresh` does not promise days of uninterrupted operation. Conversely, an old timestamp does not force a refresh if a parseable access-token expiry remains outside the window. Sources: [constants](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L203), [predicate](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L3001), [upstream expiry tests](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/tests/suite/auth_refresh.rs#L330).

**[R]** Startup plus a model turn produced:

| Synthetic input | Local OAuth refresh requests |
| --- | ---: |
| Access JWT expires in four minutes; recent `last_refresh` | 1 |
| Access JWT expires in six minutes; nine-day-old `last_refresh` | 0 |
| Opaque access token; nine-day-old `last_refresh` | 1 |

**[L]** One whitelisted metadata sample on 2026-10-20: `last_refresh = 2026-10-15T13:22:11.665424239Z`; file mtime `2026-10-15T13:22:11.664784+00:00`. No `CODEX_HOME` override was set. Only those fields, auth mode and a tokens-present boolean were emitted. A login also sets `last_refresh`, so this single five-day-old sample establishes neither a refresh interval nor an access-token lifetime.

**[U]** No historical multi-day samples exist in this investigation, and no claim of an observed hourly/daily refresh frequency is made. To collect them later, append only observation time and `last_refresh` at each sample; do not dump auth documents or enable credential logging. The demonstrated failure path already rules out a reliability guarantee.

**[R-live]** The new work login and deliberate refreshes advanced its `last_refresh` and rotated its refresh token. These are manual triggers, not observations of natural refresh cadence. Both source access tokens were outside the proactive window before live testing.

The personal snapshot still had its October 15 `last_refresh` when native account discovery accepted it on October 20, with no refresh during the temporary-home test. That demonstrates a usable five-day-old snapshot on this host; it does not establish a recurring interval or eliminate earlier 401 recovery.

Safe timestamp-only sampling (an explicit `CODEX_HOME` is honored):

```bash
python3 - <<'PY'
import json, os
from datetime import UTC, datetime
from pathlib import Path
home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
auth = json.loads((home / 'auth.json').read_text())
print(json.dumps({'observed_at': datetime.now(UTC).isoformat(), 'last_refresh': auth.get('last_refresh')}))
PY
```

## 3. Running worker after a switch; transcript and game behavior

**[R]** After starting on A and writing B, normal requests succeeded. Returning a local 401 on the next model request then produced an `error` notification and `turn/completed` with `status:"failed"`, `codexErrorInfo:"unauthorized"`, and the account-change/sign-in-again message. The process stayed alive, did not become B, and made **zero** OAuth refresh requests: mismatch was detected before contacting the refresh endpoint.

The generated rollout contained **no standalone `error`, `stream_error` or `warning` event**. It did contain `event_msg` → `task_complete` → `error`, including the same message and `codex_error_info:"unauthorized"`. The failure therefore survives in the file. Codex explicitly persists completion events while treating standalone error events as transient. [Persistence policy](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/rollout/src/policy.rs#L125), [completion error field](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/protocol.rs#L2266).

**[R-live]** The same controlled-401 failure occurred with real work credentials after restoring personal. A preceding local success turn completed normally. This verifies the auth recovery behavior with real identities, not a spontaneous production 401.

**[S] The game does not currently surface that reason reliably.** [The transcript parser](../../internal/transcript/codex.go) handles `task_complete` as “Turn done” or a duration, ignoring its nested error. Its standalone-error handling cannot help for the observed rollout shape. [The bridge notification handler](../../internal/server/codexquestions.go) clears the current turn on `turn/completed` but does not decode its status/error or handle the live `error` notification as an account failure. The watcher remains connected, so this is not an app-server disconnect or failed join. #139 must explicitly propagate the terminal failure and display the recovery action, including after transcript reload. **[U]** A real-account game hire and browser/TUI state transition were not exercised.

## 4. Sleep and wake

**[S]** [sleepShared](../../internal/server/codexfloor.go) quits the TUI and stops the worker's server; `resumeShared` calls `startSharedServer` before remotely resuming the stored thread. [The launcher](../../internal/codexapp/launch.go) inherits the pane environment and supplies no account-specific home. A thread ID does not select its original login. Wake therefore uses whichever account the new process loads, subject to that pane's environment/config. The embedded fallback has the same account-selection problem.

**[R]** Stopped A's isolated app-server, left B on disk, started a new server and resumed A's thread: `account/read` reported B before and after resume. This verifies the Codex restart/resume mechanism. It is not a full `Hub.resumeShared` game test.

**[R-live]** Restarted the work server while personal was active and resumed its work thread: account/read reported personal before and after resume. A stored thread does not pin a real account either.

For #139: resolve the stored account/home **before** server launch on every wake, confirm identity, then attach/resume the TUI. Account-preserving environment must reach embedded fallback too, or fallback must fail/report the mismatch explicitly. A missing account must follow the ticket's visible fallback policy.

## 5. Rotation and saving the outgoing account

**[S] Yes, codex-auth saves refreshes already written before a targeted switch.** Its JSON switch loads registry → synchronizes current auth into that account's saved snapshot → saves registry changes → activates target → saves registry. Sync compares/copies the complete credential snapshot, including rotated refresh tokens. [Switch ordering](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/workflows/switch.zig#L195), [snapshot sync](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/registry/account_ops.zig#L122).

**[R]** Replaced synthetic A with a second credential generation, switched A→B→A, and compared internally: the second generation was preserved. This tests copying, not real server-side refresh-token validity.

**[R-live]** Forced native work refresh in its authoritative home: `last_refresh` advanced and the refresh token changed. Seeded an isolated switcher with the prior snapshot, put the refreshed snapshot in its active auth, then switched away/back: the restored bytes exactly matched the refreshed source, and a new app-server authenticated with them. After closing the clones, a second native refresh spent that identical restored refresh token in the authoritative work home and succeeded, rotating it again. The latest work credentials remain saved there; no stale snapshot was copied over them. The final run made two native refreshes (an earlier pilot made one). Personal auth bytes remained unchanged throughout.

**[S] Concurrent refresh remains unsafe.** There is no interprocess transaction lock around switcher sync/activation/registry writes. Atomic registry replacement does not serialize that sequence with Codex. Codex's refresh persistence loads the current disk document and updates token fields after the HTTP exchange; a switch during that exchange can race with persistence. A hub lock cannot stop those unrelated processes. Sources: [switcher activation](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/registry/account_ops.zig#L522), [registry writer](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/registry/storage_write.zig#L17), [Codex persistence](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L1599). No deliberate race against real credentials was attempted.

## 6. Switch back within seconds of startup

**[R] Initially yes, durably no.** A server started on B still reported B after disk auth was restored to A, and its next successful model turn completed. A subsequent local 401 failed with the same account-mismatch error. Waiting for `WaitReady`, or even a completed B turn, does not remove this risk. The default personal account can remain active globally only if the B server has an independent auth store for its entire lifetime. Switching back is cleanup, not account pinning.

## 7. Linux JSON interface and account/read

**[R]** The temporary published Linux binary matched the [versioned JSON contract](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/docs/json-api.md). Initial synthetic samples:

| Command | Runs | Exit | Wall time | Observed result |
| --- | ---: | ---: | --- | --- |
| `list --skip-api --json` | 5 | 0 | 2.7–3.8 ms | Schema 1, two accounts after seeding |
| `switch <account_key> --json` | 3 | 0 | 3.0–3.2 ms | Requested account active; rotation snapshot retained |
| `switch does-not-exist --json` | 1 | 1 | 2.5 ms | Structured `account_not_found` |
| `switch <account_key> --skip-api --json` | 1 | 2 | 1.4 ms | Structured `usage`: flag rejected |
| `switch --json` | 1 | 2 | 1.2 ms | Structured `usage`: explicit selector required |

Stdout was one JSON document; stderr was empty. Top-level list fields: `schema_version`, `command`, `active_account_key`, `accounts`. Switch: `schema_version`, `command`, `switched_to`. Account fields: `number`, `account_key`, `email`, `alias`, `account_name`, `plan`, `auth_mode`, `active`, `created_at`, `last_used_at`, `usage`. Usage includes `source`, `updated_at`, windows/credits and a separate refresh result. Accept unknown fields, check schema/error codes, and prefer stable keys to row numbers.

**[R-live]** In the final two-real-account run, list took **10.697–13.581 ms** (2 calls), targeted switch **3.710–18.485 ms** (5 calls), missing selector **9.983 ms** (exit 1), and rejected targeted `--skip-api` **6.717 ms** (exit 2). Schema was 1 and stderr empty throughout. These are small local samples, not a latency guarantee. Real app-server plan strings were **`prolite`** for personal and **`team`** for work; do not substitute marketing plan names or assume the epic's anticipated names match current wire values.

**[S]** For ChatGPT accounts, targeted `switch KEY --json` is local by design and rejects `--skip-api`; use exactly that form. `switch - --json` is also rejected: capture the original stable key for restoration. `list --skip-api --json` still synchronizes local snapshots/registry, so serialize it with switches. [Parser](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/cli/commands/switch.zig#L71), [list flow](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/workflows/list.zig#L96).

There is an API-key exception: pre-sync calls `fetchMeForApiKey` before skip-api mode is applied, including on targeted switches. This epic excludes API-key accounts; do not claim the switcher is network-free for arbitrary active auth. No such request was made here. [API-key branch](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/registry/account_ops.zig#L147), [fetch implementation](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/src/registry/account_ops.zig#L226).

**[R]** Installed app-server `account/read {"refreshToken":false}` returned this shape, with synthetic identity:

```json
{
  "account": {"type":"chatgpt","email":"a@example.invalid","planType":"plus"},
  "requiresOpenaiAuth": true,
  "workspaceRouting": {
    "chatgptAccountId":"A",
    "backendOrigin":"https://127.0.0.1:<leased-port>",
    "accountRoutingOverride":"NO_CONSTRAINT"
  }
}
```

The `account` object itself has **no account ID**. The observed ID is `workspaceRouting.chatgptAccountId`, whose schema is marked experimental. Do not assume every supported Codex version exposes it or that email/plan distinguishes two workspaces for the same user. #139 needs a version/field-aware identity check that reports unavailable or ambiguous verification. Do not use the internal-only `chatgptAuthTokens` login interface to fill the gap. [Pinned account schema](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L544). **[R-live]** Both real app-server replies had email/plan and workspaceRouting identity; account IDs were compared internally and only matching booleans were retained.

## 8. Transcript limits fallback

**[S]** codex-auth's [README warning](https://github.com/Loongphy/codex-auth/blob/05d50bc4b613d36e2799e381a2640050766b679e/README.md#why-is-my-usage-limit-not-refreshing) about `token_count.rate_limits:null` describes a real weakness for [limits.fromTranscript](../../internal/limits/codex.go): it scans the last 1 MiB of up to 40 newest rollouts, skips null/empty readings, and returns an older usable reading if present. If all are null it returns none. [Poller.failed](../../internal/limits/poller.go) then retains a prior reading as stale, or exposes a probe failure with no windows. It never derives limits from token counts alone.

**[L]** Using the same newest-40/tail-1-MiB scope on this host found **920 token_count events, all non-null**, across 40 rollouts dated 2026-10-20; zero null or missing rate-limit fields. The warning was not reproduced in that sample. This aggregate scan emitted only dates/counts, no transcript text. Non-null today does not guarantee future coverage.

The current fallback has **no account attribution filter**. With mixed accounts sharing sessions it can show A's old windows after a failed probe for B; `Stale:true` is insufficient to identify that mismatch. #138/#139 must scope probes/cache/fallback to the selected account or report unknown, retaining timestamps and source labels. Do not promise fresh per-account limits from a shared rollout directory.

## Required changes to #139 and remaining acceptance work

1. **Separate auth homes first.** Update the global-switch assumption in #135/#139 and add the adapter ticket. Keep one account's refreshed credentials authoritative rather than periodically overwriting them from an old switcher snapshot. Validate shared config/session storage and per-account rotation before declaring that adapter safe.
2. **Lock provisioning transactions.** Serialize list/snapshot/switch/start/identity-confirm/restore across participating hubs, keyed by the affected home. `release` must run on every error/cancel path. This prevents bridge races; it cannot make global concurrent-account execution safe.
3. **Restore deliberately.** If provisioning still temporarily switches the user's global home, capture its original stable account key and restore it in cleanup only after the intended independent home/server identity is established. Report restoration failure; `WaitReady` alone is insufficient. Do not use `switch - --json` or an API-enabled list.
4. **Order wake and fallback.** Resolve saved account → prepare account home/env → launch server → confirm actual identity → resume/attach TUI → release transaction. Concurrent wakes need the same serialization as hires. Persisted identity and account-preserving env must cover embedded fallback, or visibly report/fail it.
5. **Report runtime failures.** Decode live error/failed-turn details and durable `task_complete.error`; persist/show the reason and the recovery action. A live process and successful `account/read` do not establish that refresh works. Keep account identity and limits attribution explicit.
6. **Remaining acceptance.** The two-account CLI contract/timing checks, native identity calls, restart/resume mechanism and real rotated-token validity passed. Full game hires, seat/TUI error display and `Hub.resumeShared` sleep/wake still need end-to-end validation; this report's game conclusions are source-based. Collect timestamp-only `last_refresh` samples over several days to measure natural cadence. No real-model inference was used.

No production code, personal auth, existing running worker or GitHub ticket state was changed. All switcher state and account swaps lived in temporary homes and were removed. The user's new work login persists in `~/.codex-work`, with the latest credentials saved by native refresh. The MacBook callback tunnel was closed after login.

## Verification

The synthetic app-server and switcher probes passed, including all 11 switcher cases. The two-real-account probe passed with native refresh and restored-refresh-token verification. `uvx ruff check` and `uvx ruff format --check` passed for the Python files; local Markdown links and `git diff --check` passed. All four Go package suites below passed. The initial `go test` command hit this host's unselected mise shim; the checks used the already installed Go 1.27.0 executable instead of changing global tool configuration:

```bash
/home/jeff/.local/share/mise/installs/go/1.27.0/bin/go test \
  ./internal/limits ./internal/transcript ./internal/codexapp ./internal/server
```
