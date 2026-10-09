# write-code orchestrator flow → herdr-3d game mechanics

Researcher: GROUND|write-code (claude, herdr-3d session, w3) — 2026-09-28
Sources: `~/.claude/skills/write-code/` (symlink → `~/.agents/skills/write-code/`, also linked from `~/.codex/skills/`),
`~/.agents/skills/implement/SKILL.md`, `herdr --skill` (v0.9.0), `portlease` 0.1.0, Claude Code 2.1.283, codex-cli 0.158.0,
live herdr sessions (read-only), past run directories in `/tmp/claude-1000/*/scratchpad/run/`, and a throwaway probe session
`h3d-probe-writecode` (created, used, stopped and deleted).

## TL;DR

- **Flow**: one long-lived **orchestrator** (`ORCH|…`) spawns short-lived workers in fresh workspaces: **researchers**
  (`GROUND|<topic>`), **coders** (`CODE|<descr>|<ticket>|r<N>`), **reviewers** (`REVIEW|…|r<N>`) and **UX reviewers**
  (`UX|…|r<N>`, run beside a REVIEW on the same revision). Each worker gets a brief and a **unique report path**. It
  publishes a JSON report by atomic rename. The orchestrator blocks on `scripts/wait_for_results.py`, which returns
  on the first report or on a 10‑minute progress checkpoint. The fix loop allows at most **3 review passes** (initial + 2
  follow-ups), then a PR. Workers are cleaned up. Only the orchestrator is closed by the user.
- **Game mapping**: orchestrator = permanent **employee** (a desk on the floor). GROUND/CODE/REVIEW/UX = **freelancers**
  who arrive by door or elevator, read the brief, work, hand in a report, and leave when the orchestrator closes their workspace.
  Hand-started workspaces with plain labels are permanent employees too.
- **Detection today** works through heuristics only. The role comes from parsing the label prefix. There is **no
  explicit parent link** in herdr. A child's session can be tied to its orchestrator in only two ways: by session
  membership, or through the report path, which contains the orchestrator's Claude session UUID
  (`/tmp/claude-1000/<proj>/<orch-uuid>/scratchpad/run/code-x-r1.json`). That UUID equals the orchestrator pane's
  `agent_session.value`. This is **Claude-orchestrator only**. Report and ledger paths aren't exposed anywhere the game can read.
- **Key discovery**: herdr 0.9.0 has **`herdr workspace report-metadata <ws> --source ID --token k=v [--ttl-ms] [--seq]`**.
  Tokens show up in `workspace get`, `workspace list` and `api snapshot` as `"tokens":{…}` (I verified this in the probe
  session). That makes the tokens a ready-made, backwards-compatible metadata channel. **Proposal**: the skill adds about 3 lines
  so that every spawn reports `h3d_role`, `h3d_parent`, `h3d_ticket`, `h3d_round`, `h3d_report`, and the orchestrator reports
  `h3d_phase`/`h3d_pass`. Optionally, each run keeps a `run.json` registry next to the reports.
- **Hire menu**: I verified the flags live. `herdr agent start <name> --kind claude --pane <p> -- --model <opus|fable|claude-opus-5-5|claude-fable-5-1> --effort <low|medium|high|xhigh|max> --permission-mode bypassPermissions [--name <label>]`
  and `--kind codex -- -m <gpt-6-sol|gpt-6-luna|gpt-6-astra> -c model_reasoning_effort=<low…max|ultra> --dangerously-bypass-approvals-and-sandbox`.
  The codex aliases (`sol`, `luna`, `astra`) exist only in the skill. The game must map them to slugs.
- **Game-triggered write-code: yes.** Hiring an orchestrator is a normal hire with `-- … ` plus a first prompt of
  `/write-code <ticket>` (claude) or `$write-code <ticket>` (codex). The skill asks the user to choose worker models, so the
  game should pass those choices in the prompt. Otherwise the orchestrator blocks and asks (a "blocked" worker in the game).

---

## 1. The flow, precisely

### 1.1 Roles

| Role | Label (skill spec) | Spawned by | Lifetime | Starts with | Report schema |
|---|---|---|---|---|---|
| Orchestrator | `ORCH|<descr≤10>` | user (manual) | whole ticket; **only user closes it** | `/write-code …` (`allow_implicit_invocation: false` in `agents/openai.yaml` → must be invoked explicitly) | — (reports to user; PR) |
| Researcher | `GROUND|<topic>` | orchestrator | until report consumed | brief incl. web-tool order (parallel → alterlab → tavily, context7 for docs) | `{summary, input_required}` (+ usually `doc_path` by convention) |
| Coder | `CODE|<descr>|<ticket>|r<N>` | orchestrator | one round; **fresh workspace every round** | `/implement …` (claude) / `$implement …` (codex). `implement` has `disable-model-invocation: true`, so it must be a literal slash command | `{input_required, summary, crucial_bits[≤3]}` |
| Code reviewer | `REVIEW|<descr>|<ticket>|r<N>` | orchestrator | one pass; fresh workspace | initial: `/mattpocock-skills:code-review` / `$code-review`; follow-ups: scoped fix review (no general skill) | `{verdict: PASS|CHANGES_REQUIRED|INCOMPLETE, input_required, issues_found[{id, priority BLOCKER|medium|low|nit, explanation, evidence, impact}]}` |
| UX reviewer | `UX|<descr>|<ticket>|r<N>` | orchestrator, **in parallel** with REVIEW when UI changed | one pass | initial: `/impeccable audit` + `agent-browser`; follow-ups scoped | same as reviewer |
| Dev servers | (tab/split panes **inside the ORCH workspace**) | orchestrator | until user closes ORCH | `portlease`-allocated ports, exposed over tailscale | — |

Ticket number is omitted if there is no ticket (`CODE|title|r1`).

### 1.2 Lifecycle (state machine of one run)

```
ORCH created ──▶ name workspace ORCH|x ──▶ ask user for models (never default) ──▶ ticket → Doing
   │
   ├─▶ [optional] GROUND|topic × k (parallel) ──report──▶ context for briefs
   │
   ├─▶ CODE|x|T|r1 ──report(input_required? → answer, fresh report path)──▶ head SHA
   │
   ├─▶ pass 1: REVIEW|x|T|r1 (+ UX|x|T|r1 in parallel)   — base/head SHAs + policy + AC
   │        verdicts ─▶ ledger (IDs, ACCEPTED / DISMISSED_WITH_EVIDENCE / ADVISORY / RESOLVED, reviewed SHA, pass#)
   │        all PASS ─────────────────────────────────────────────────────────────▶ PR + ticket → QA
   │        accepted BLOCKERs ─▶ CODE|x|T|r2 (fix only) ─▶ pass 2 REVIEW r2 (+UX r2) on prev..cur diff
   │                                       ─▶ CODE r3 ─▶ pass 3 ─▶ still blockers? STOP, ask user (never mark passed)
   └─▶ close worker workspaces after their info is collected; ORCH stays for the user
```

Rules worth modelling:
- A worker is **never interrupted** without asking the user. A non-interrupting message ("steering", consumed on the
  worker's next turn) is allowed.
- **Pass cap** = 3 review passes; code + UX of the same revision count as one pass. Fresh workspaces never reset the count.
  *In the wild the cap is exceeded*: `code-review` session has `CODE|learnpref|100|r1..r4` and `REVIEW|…|r1..r4`,
  and depot-manager run `43c0263e…/run/review-status-r4.json` exists. The user presumably approved these extra passes.
- Advisory findings never trigger a coder round.

### 1.3 Reporting and waiting (the "watcher")

- Each dispatch gets a **unique, initially absent** report path in an existing temp dir. The worker writes `<path>.tmp`
  and then runs `mv` to publish it atomically.
- The orchestrator runs `python3 scripts/wait_for_results.py <paths…> [--progress-at T | --progress-after 600] [--interval 0.25]`
  (stdlib only). It polls every 250 ms and prints **one** JSON line:
  - `{"event":"results","ready":[…],"errors":[{path,error}],"progress_at":T}`: a report appeared (exit 1 if any
    file is invalid JSON or not an object).
  - `{"event":"progress_due","pending":[…],"progress_at":T}`: the 10‑minute checkpoint arrived. The orchestrator then
    inspects each pending worker (`agent get` + ≤40 recent lines) and may steer.
  - After a partial completion the orchestrator restarts the watcher with the **same** `--progress-at` for the
    remaining paths, so the cadence is kept (covered by `test_deadline_is_reused_across_partial_completions`).
- `input_required` (a string) = the worker is blocked on the user or orchestrator. After answering, the orchestrator
  assigns a **fresh** report path. The game shows it as a **report request** (kept whole up to 8 KiB; an optional
  `"input_for": "orchestrator" | "user"` says who must decide, else it is the orchestrator when there is one).
- **Accepting a request without resuming the worker** (#215): the report file stays as it is, so the orchestrator marks
  the request resolved with a sidecar, `<stem>.resolved.json` next to `<stem>.json`, atomically:
  `printf '{"report":"coder-r1.json","resolved_by":"orchestrator","note":"accepted as AC4 evidence"}' > run/coder-r1.resolved.json.tmp && mv run/coder-r1.resolved.json.tmp run/coder-r1.resolved.json`
  (`report` is required and must equal the report's file name, `resolved_by` and `note` are optional strings; names ending `.resolved.json` are reserved and cannot be report names; the file must be newer than or as new as the report, so a rewritten report asks again).
  Do this when the ledger says "accepted" and the run goes on (e.g. reviewer dispatch) without resuming the coder;
  without it the freelancer stays NEEDS YOU in herdr-3d. To answer and resume, assign a fresh report path instead.

Observed real layout (Claude orchestrators, e.g. `/tmp/claude-1000/-home-dev-devel-fomra-depot-manager/43c0263e-…/scratchpad/`):

```
run/brief-status.md        ← contains "Report path: …/run/code-status-r1.json", ports, worktree
run/code-status-r1.json    {"input_required":null,"summary":"…head 821f4b3f…","crucial_bits":[…]}
run/review-status-r1.json  {"verdict":"CHANGES_REQUIRED",…}   (+ review-status-r1.md long form)
run/ux-status-r1.json      {"verdict":"PASS","input_required":null,"issues_found":[]}
run/policy.md, common.md   shared brief parts
ledger.md | run/ledger-02.json   ← ledger format is NOT standardized (markdown table vs JSON)
pr-status.md
```

File name patterns seen: `{code|coder|review|ux}-<slug-or-ticket>-r<N>[b].json`. They are similar across runs but not
guaranteed.

### 1.4 Naming in the wild (read-only survey, 2026-09-28)

| Session | Workspaces (label → agent) |
|---|---|
| code-review | `ORCH|learnpref` (codex), `CODE|learnpref|100|r1..r4` (claude, agent names `code_learnpref_100_rN`), `REVIEW|learnpref|100|r1..r4` (codex, `review_learnpref_100_rN`), `ORCH|ocrbudget`, `ORCH|checkrun`, `ORCH|pref100`, plus plain `github-code-review` |
| depot-manager | 7× `ORCH|…` (workers already cleaned up); ORCH workspaces have 3–11 panes / 2–7 tabs (dev servers) |
| herdr-3d | `ORCH|herdr-3d`, `GROUND|herdr`, `GROUND|write-code`, `GROUND|server`, `GROUND|engine` (agent names `r-herdr`, `r-writecode`, …) |
| livesub, bnb-prototype, claudia | one `ORCH|…` each plus free-form labels (`bancontact enable`, `booking.com research`, `psycholoog-claudia-conte`) |
| common, games, gta, sched | only free-form labels (`research`, `admin`, `gta-deepseek`) |

Takeaways: label prefixes are applied consistently for write-code runs. **Agent names follow no convention**
(`code_learnpref_100_r1` vs `r-writecode` vs none). Some workers live in a split pane of another workspace
(`bnb-prototype` wF:p2 codex `bancontact`), which the skill doesn't prescribe. Worktrees are visible through
`workspace get … .worktree` (`is_linked_worktree`, `checkout_path`, `repo_name`).

---

## 2. Mapping to the game

### 2.1 Employees vs freelancers

| Kind | Who | Visual |
|---|---|---|
| **Employee** (permanent desk on the floor) | `ORCH|*` and every workspace with a non-role label (hand-started projects) | Own desk and nameplate. Stays until the user fires them (closes the workspace). |
| **Freelancer** | `GROUND|*`, `CODE|*`, `REVIEW|*`, `UX|*` | Arrives, gets a temporary hot-desk *near its orchestrator*, leaves when its workspace closes. Different outfit per role. |
| **Machines / props** | Extra panes/tabs in an ORCH workspace running dev servers (non-agent panes) | Server rack or kiosk next to the orchestrator desk. Glows when a portlease port is bound. Clicking it opens the tailscale URL. |

Role costumes (suggestion): GROUND = explorer with a magnifier and books; CODE = hoodie and laptop; REVIEW = glasses and
clipboard; UX = beret, tablet and paint palette; ORCH = headset, clipboard wall, kanban board.

### 2.2 Visible states per lifecycle phase

| Phase | Observable signal | Animation / UI |
|---|---|---|
| **Hired** | workspace appears with a role label; pane has no agent yet (`agent_status: unknown`) | Freelancer walks out of the elevator with a box |
| **Onboarding** | `agent start` done, status `idle` → first `working`; brief file exists | Sits down, reads a paper scroll ("brief"), coffee |
| **Startup blocked** | `agent start` returns `agent_not_ready`; agent `blocked` + `launch_pending: true` (e.g. Claude folder-trust dialog, which I saw in the probe with cwd `/tmp`) | Stands at the door with a "?" badge; click → shows the dialog text and asks the user |
| **Working** | `agent_status: working` | Typing, screen glow, steam puffs; progress ring = elapsed time vs the 10‑min checkpoint |
| **Blocked / needs input** | `agent_status: blocked` **or** report JSON with non-null `input_required` | Raises hand, red "!" bubble, the string shown as a speech bubble. The orchestrator desk also flashes |
| **Idle-without-report** | `idle`/`done` and report file still missing | Leans back, "zzz?" (possible stall; the orchestrator checks at the progress checkpoint) |
| **Reporting** | report file appears (atomic rename) | Walks a folder over to the orchestrator's desk (paper-plane / envelope fly) |
| **Reviewed PASS** | reviewer report `verdict: PASS` | Green stamp "APPROVED" on the coder's work; confetti on the orchestrator's kanban |
| **CHANGES_REQUIRED** | `verdict: CHANGES_REQUIRED`, BLOCKER count | Red stamp; N red sticky notes (one per blocker) carried to the next CODE freelancer |
| **INCOMPLETE** | `verdict: INCOMPLETE` | Grey stamp and a shrug |
| **Pass cap reached** | ORCH pass = 3 and blockers remain (needs ledger/metadata) | The orchestrator's phone rings for the user; floor alarm light |
| **PR opened** | ORCH phase `pr` (needs metadata) or a `gh pr` URL in the ORCH summary | Package shipped via a pneumatic tube or a truck leaving the building |
| **Leaving** | workspace closed (disappears from `workspace list`) | Freelancer packs its box, waves, walks to the elevator |

A floor-level "project board" per ORCH can show: ticket → Doing, research ✓, r1 code ✓, pass 1 (REVIEW ✗ 2 blockers, UX ✓), r2…, PR.

---

## 3. Detecting roles, relations and progress from observable state

### 3.1 Available today (no skill changes)

| Need | Source | Reliability |
|---|---|---|
| Role, descr, ticket, round | regex on `workspace.label`: `^(ORCH|CODE|REVIEW|UX|GROUND)\|([^|]*)(?:\|([^|]*))?(?:\|r(\d+))?$` (ticket optional → a 3rd field starting with `r\d+` is the round) | Good for write-code runs. Hand-renamed labels break it |
| Status | `agent list` / `api snapshot` per session: `agent_status` idle/working/blocked/done/unknown, `launch_pending`, `interactive_ready` | Good |
| Harness | `agent` field (`claude`/`codex`) | Good |
| Model / effort | **not exposed** by herdr. Only on screen (status line "Opus 5.5 with low effort", "GPT-6-Luna low") | Screen-scrape only |
| Parent (ORCH) | Same herdr session plus heuristics. In multi-ORCH sessions (code-review has 4 ORCHs) match `descr`: `CODE|learnpref|…` ↔ `ORCH|learnpref`. Weak: descr often differs (ORCH `herdr-3d` vs `GROUND|herdr`) | Weak |
| Parent via report path (Claude ORCH only) | report paths live under `/tmp/claude-1000/<project-slug>/<orch-claude-session-uuid>/scratchpad/…`, and `<uuid>` == ORCH pane `agent_session.value`. For example, this ORCH's pane `w1:p1` has `agent_session.value = 2f2eb2a1-…`, the same as its scratchpad dir. But the child→path link is only inside the brief text sent to the worker | Strong once the path is known, but the path isn't observable |
| Report arrival | scan `/tmp/claude-1000/*/<uuid>/scratchpad/**/{code,coder,review,ux}-*-r*.json` for the known ORCH UUIDs; parse `brief-*.md` for `Report path:` | Heuristic; naming isn't standardized |
| Ledger / pass count | `ledger.md` or `ledger-*.json` (format varies) | Poor |
| Worktree / branch | `workspace get` → `.worktree{checkout_path, repo_name, is_linked_worktree}` | Good |
| Dev-server ports | `portlease list` (leases carry `--agent`, `--project`, `--worktree`, `--label`). Leases are short-lived (TTL, released after bind) | Transient |
| Title / what it's doing | `terminal_title_stripped` (Claude auto-titles, e.g. "Review issue #100 implementation"). Claude `--name <x>` pins the title (probe: title became `REVIEW|probe|r1`) | Nice flavour text |

### 3.2 Gaps

1. No explicit parent→child link, and no link across sessions.
2. Report path, brief path and ledger are invisible to herdr.
3. Model/effort isn't in herdr state.
4. ORCH phase (research/coding/review pass N/PR/waiting-for-user) isn't observable at all.
5. For codex orchestrators, run files live elsewhere (no Claude scratchpad UUID). I haven't verified where.

### 3.3 Proposed minimal conventions (backwards-compatible)

**A. Workspace metadata tokens (primary, zero new infra).** herdr 0.9.0 `workspace report-metadata`. Behaviour I verified
in the probe session:

```
$ herdr workspace report-metadata w1 --source h3d --token role=code --token parent=ORCH-w1 --token report=/tmp/x.json
$ herdr workspace get w1
{"…","label":"CODE|probe|r1",…,"tokens":{"parent":"ORCH-w1","report":"/tmp/x.json","role":"code"},"workspace_id":"w1"}
```
- Also shown in `workspace list` and `herdr api snapshot`.
- Tokens from different `--source`s **merge into one flat map** (a name collision overwrites), so prefix the names with `h3d_`.
- Re-reporting one token keeps the others. `--seq` rejects stale updates. `--ttl-ms` makes a token expire (I verified a 3 s TTL
  vanished). Without a TTL, tokens persisted during the probe. **Unverified**: whether they survive a server restart. Assume not.
- They can be shown in the herdr sidebar via `$name` in `[ui.sidebar.spaces] rows` (bonus for TUI users).

The skill adds one step after each `workspace create` (orchestrator side):

```bash
herdr workspace report-metadata "$WS" --source write-code \
  --token h3d_role=code --token h3d_parent="$HERDR_SESSION/$HERDR_WORKSPACE_ID" \
  --token h3d_ticket=100 --token h3d_round=2 --token h3d_pass=2 \
  --token h3d_report=/abs/run/code-x-r2.json --token h3d_brief=/abs/run/brief-x-r2.md \
  --token h3d_harness=claude --token h3d_model=claude-opus-5-5 --token h3d_effort=medium
```
and on its own workspace, at phase changes:
```bash
herdr workspace report-metadata "$HERDR_WORKSPACE_ID" --source write-code \
  --token h3d_role=orch --token h3d_phase=review --token h3d_pass=2 --token h3d_run=/abs/run \
  --token h3d_ticket=100 [--token h3d_pr=https://github.com/…]
```
`h3d_phase ∈ {setup, research, coding, review, fixing, waiting_user, pr, done}`.

Also recommended: pass the same values as `--env H3D_ROLE=… --env H3D_PARENT=…` on `workspace create` (I verified that
env reaches the pane shell and therefore the agent). Workers can then self-report `h3d_state=reporting` via
`$HERDR_WORKSPACE_ID` without knowing their parent.

**B. Run registry file (secondary, survives restarts, gives history).** `<run-dir>/run.json`, written by the ORCH with
the tmp+rename pattern the skill already uses:
```json
{"schema":"write-code/run/v1","orch":{"session":"herdr-3d","workspace":"w1","agent_session":"2f2eb2a1-…"},
 "ticket":"100","phase":"review","pass":2,"max_passes":3,"pr":null,
 "workers":[{"workspace":"w1Q","role":"code","round":1,"harness":"claude","model":"claude-opus-5-5","effort":"medium",
             "report":"/abs/run/code-x-r1.json","brief":"/abs/run/brief-x-r1.md","state":"reported","closed":true}],
 "ledger":[{"id":"R1","priority":"BLOCKER","disposition":"ACCEPTED","reviewed_sha":"…","pass":1}]}
```
The bridge finds runs through `h3d_run` tokens, or by globbing `~/.local/state/write-code/runs/*.json` if the skill also
drops a symlink there. The registry standardizes the ledger (today it's markdown or JSON, ad hoc).

**C. Agent names.** Standardize `<role>_<descr>_<ticket>_r<N>` (lowercase, `[a-z][a-z0-9_-]{0,31}`), as the learnpref run
already did. Also pass `--name '<label>'` to claude so the terminal title shows the role.

Everything above is optional. A bridge that finds no tokens falls back to the label regex in §3.1.

---

## 4. The hire menu

### 4.1 Values from the skill vs verified CLIs

| Harness | herdr `--kind` | Models (skill) | CLI-accepted | Effort values | Permission flag |
|---|---|---|---|---|---|
| claude-code (`claude` 2.1.283) | `claude` | `claude-opus-5-5` (alias `opus`), `claude-fable-5-1` (alias `fable`) | `--model` takes full names or aliases (`fable`, `opus`, `sonnet`, per `claude --help`). **Probe**: `--model opus --effort low` → "Opus 5.5 with low effort"; `--model claude-fable-5-1 --effort max` → "Fable 5.1 with max effort" | `--effort low\|medium\|high\|xhigh\|max` | `--permission-mode bypassPermissions` (also `--dangerously-skip-permissions`) |
| codex (`codex-cli` 0.158.0) | `codex` | `gpt-6-sol` (`gpt-sol`, `sol`), `gpt-6-luna` (`gpt-luna`, `luna`), `gpt-6-astra` (`astra`) | `-m <slug>`. **The aliases are skill-only; use the slugs.** `~/.codex/models_cache.json` (fetched 2026-09-28) lists: gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 (+ hidden gpt-reserve, codex-auto-review). **Probe**: `-m gpt-6-luna -c model_reasoning_effort=low` → "GPT-6-Luna low"; `-m gpt-6-sol -c model_reasoning_effort=ultra` → "GPT-6-Sol ultra" | per model from cache: astra/sol `low…max, ultra`; luna `low…max` (no ultra) | `--dangerously-bypass-approvals-and-sandbox` |

Defaults: effort **medium** unless the user says otherwise (skill). Codex config default: `model="gpt-6-sol"`,
`model_reasoning_effort="medium"`. Skill inconsistency: the Research section recommends `gpt-5.6-luna` (xhigh|max) and
`gpt-5.6-sol` (low), while the model list uses `gpt-6-*`. Both exist in the models cache. **Flag for Theo**: which one is intended?

The researcher recommendation from the skill: cheaper codex model (luna on xhigh/max, or sol on low for long context).

### 4.2 Exact commands

Hire (every combination is the same shape):

```bash
S=herdr-3d                                   # target session (floor)
OUT=$(herdr --session $S workspace create --cwd "$REPO" --label 'CODE|feat|123|r1' \
      --env H3D_ROLE=code --env H3D_PARENT=$S/w1 --no-focus)
WS=$(jq -r .result.workspace.workspace_id <<<"$OUT"); PANE=$(jq -r .result.root_pane.pane_id <<<"$OUT")
herdr --session $S agent start code_feat_123_r1 --kind <KIND> --pane "$PANE" --timeout 60000 -- <ARGS>
herdr --session $S agent prompt code_feat_123_r1 "/implement …brief…" --wait   # or $implement for codex
```

`<KIND> -- <ARGS>` per combination (effort ∈ low|medium|high|xhigh|max; `ultra` extra for sol/astra):

| Harness | Model | Command tail |
|---|---|---|
| claude | Opus 5.5 | `--kind claude -- --model claude-opus-5-5 --effort <e> --permission-mode bypassPermissions --name '<label>'` |
| claude | Fable 5.1 | `--kind claude -- --model claude-fable-5-1 --effort <e> --permission-mode bypassPermissions --name '<label>'` |
| codex | GPT-6 Sol | `--kind codex -- -m gpt-6-sol -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` |
| codex | GPT-6 Luna | `--kind codex -- -m gpt-6-luna -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` |
| codex | GPT-6 Astra | `--kind codex -- -m gpt-6-astra -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` |

Prefer the full model names over aliases in the game. `opus`/`fable` float to "latest", which can silently change what
the menu label means.

### 4.3 Launch gotchas (verified)

- `agent start` **types the command into the pane's shell**. The response includes `"argv":["claude","--model",…]` and the
  pane shows `[dev@devbox tmp]$ claude --model opus …`. So shell functions apply. On this server, `claude`/`codex` are
  **bash and fish functions** (`~/.bashrc.d/parallel-agent-auth.sh`, `~/.config/fish/functions/{claude,codex}.fish`) that
  inject `PARALLEL_API_KEY` (needed by the parallel web skills). A bridge that `exec`s the binary directly would lose that.
  Always go through a herdr shell pane.
- **Folder trust**: Claude in an untrusted cwd (`/tmp`) shows "Quick safety check… trust this folder". `agent start`
  returns `{"error":{"code":"agent_not_ready",…}}`, and `agent get` shows `agent_status: blocked, launch_pending: true`.
  Codex behaves the same way in untrusted projects (`[projects."…"] trust_level` in `~/.codex/config.toml`). The game
  needs a "worker waiting at the door" state and a user-confirmed "trust folder" action. It must not auto-accept.
- Claude `--name <label>` sets the terminal title (`terminal_title_stripped: "REVIEW|probe|r1"`). Codex has no equivalent.
- The start response carries `agent_session.value` (the Claude session UUID). Claude also accepts `--session-id <uuid>`, so
  the bridge can pre-pick the UUID and know the worker's scratchpad path in advance.
- Codex exposes no session id in the `agent start` response (it appears later in `agent list`).

---

## 5. Should the game trigger write-code? Yes. Sketch

**UX**: drag a ticket (or type a task) onto an employee → "Promote to project lead" dialog:
1. Orchestrator harness/model/effort (hire menu).
2. **Worker defaults**: coder, reviewer, UX reviewer and researcher harness/model/effort. The skill says it must *never*
   default and must ask the user, so the game collects these up front and includes them in the prompt. That avoids a
   blocked orchestrator.
3. Repo/cwd, ticket id/URL, a short descr (≤10 chars) for labels, and toggles (UI work → UX reviewer; research first).

**Bridge actions** (server side, all existing herdr commands):
```bash
PANE=$(herdr --session $S workspace create --cwd "$REPO" --label "ORCH|$DESCR" --no-focus | jq -r .result.root_pane.pane_id)
herdr --session $S agent start "orch_$DESCR" --kind claude --pane "$PANE" -- --model claude-opus-5-5 --effort medium \
      --permission-mode bypassPermissions --name "ORCH|$DESCR"
herdr --session $S agent prompt "orch_$DESCR" "/write-code Ticket: $TICKET
Coders: codex gpt-6-sol medium. Reviewers: claude claude-fable-5-1 high. UX: claude opus medium. Research: codex gpt-6-luna xhigh.
Game integration: report h3d_* workspace metadata as described in the skill." --wait
```
(For a codex orchestrator: `$write-code …`.) The existing worker then "moves to the corner office". The game renders
freelancers as they appear.

**User-in-the-loop hooks the game must surface**: orchestrator `blocked`/asking (model choice, pass cap reached,
interrupt approval), worker `input_required`, folder-trust at startup, PR ready (link). The game must **not** answer these
automatically. It shows them and lets Theo reply (`agent prompt` for text answers, `agent send-keys` for dialogs, after
confirmation).

**Guardrails**: the game only closes workspaces it (or an ORCH) created, and only after the report was consumed. The
orchestrator does its own cleanup. The game never closes an ORCH (the skill says only the user does that).

---

## Recommendation

1. The bridge detects roles **today** by regex on the label, plus `agent_status`, `worktree` and session membership. That's
   good enough for a first playable version.
2. Adopt **convention A (workspace metadata tokens, `h3d_*` names)** in the write-code skill. It's a small edit (1 command
   after each spawn, plus a few ORCH phase reports), fully backwards-compatible, and uses a documented herdr 0.9.0 feature.
   It unlocks parent links, report paths, model/effort, ORCH phase and pass count.
3. Add **convention B (`run.json` registry)** when history/replay or restart-survival matters. It also standardizes the ledger.
4. The hire menu uses full model slugs with per-model effort lists (from `~/.codex/models_cache.json` for codex; the fixed list
   `low…max` for claude). It launches via `herdr agent start` in a shell pane (keeps the parallel-key wrapper), and handles
   `agent_not_ready`/trust.
5. Build "promote to orchestrator" as a first-class action. The prompt must carry the worker model choices.

## Open questions for Theo

1. Research models: the skill text says `gpt-5.6-luna`/`gpt-5.6-sol`, but the model list says `gpt-6-*`. Which is intended?
2. OK to edit the write-code skill to emit `h3d_*` metadata tokens (and optionally `run.json`)? Should the game work
   without that change?
3. Freelancers and parent linkage: should a freelancer render on the ORCH's floor (same session, the current behaviour), or
   could an ORCH spawn workers in other sessions?
4. The pass cap was exceeded in past runs (r4). Is that expected (user-approved), and should the game show "overtime" passes?
5. Should the game offer only the models in the skill, or also the others the CLIs accept (claude `sonnet`, codex
   `gpt-5.6-*`, `gpt-5.5`)?
6. Where do codex orchestrators keep their run dirs? I didn't verify this. Convention A/B would make it irrelevant.
7. Should the game be allowed to accept folder-trust dialogs on Theo's click, or only show them?
