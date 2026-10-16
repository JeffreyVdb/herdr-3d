Exploring codebase in background (bridge/server split, classifier, spawn path, office displays). Questions that hang on those facts wait. Round 1 — fact-independent decisions:

❓ **Q1** - **What fires**: When schedule triggers, what happens?
- (a) Send follow-up prompt into **same agent session** that wrote summary (has full context: PR #228, hosts, backups).
- (b) **Spawn fresh agent** with prompt + attached context (summary text / handoff).
- (c) (a) if session still alive, else fall back to (b).

➡️ (c). Soak example needs original context; laptop restarts kill sessions, so fallback needed. Fresh spawn seeded with summary as handoff.

❓ **Q2** - **One-shot vs recurring**: Support cron-style recurring schedules ("every Monday 9:00"), or one-shot only ("at T" / "in 24h")?

➡️ One-shot only for this epic. Fits 4–5 ticket budget. Recurring = later epic, data model leaves room (nullable `recurrence` field not built).

❓ **Q3** - **Detection → creation flow**: When classifier flags a time-deferred step, what UX?
- (a) Suggestion chip under message (next to Handoff): "⏰ Schedule follow-up ~10:45 UTC tomorrow", click opens prefilled form (time, prompt, missed-window policy), user confirms.
- (b) Auto-create schedule in "proposed" state, user approves/dismisses in schedule display.
- (c) Auto-create, active immediately.

➡️ (a). Never schedule without explicit confirm — agent runs unattended against real infra (soak = prod-ish hosts). Dismissed suggestion stays dismissed.

❓ **Q4** - **Prompt content of suggestion**: Classifier extracts time only, or time + drafted prompt? Summary has multiple steps (log rotation check, restart, sink-outage test, cleanup backups after soak, merge). One schedule per message, or one per time-bound step?

➡️ One schedule per message. Classifier returns `{due_at, confidence, draft_prompt}` where draft_prompt = "Soak window ended. Do the post-soak steps from your earlier summary: …". User edits in form. Multiple schedules from one message = manual.

❓ **Q5** - **Missed-window policy shape**: Per-schedule choice between "run when bridge returns" and "skip". Add anything?
- Expiry horizon on "run on return" (e.g. run late only if < N hours late, else skip)?
- Default policy?
- What user sees on miss: skipped schedule shown as "missed" in display + notification; late-run labeled "ran late (+3h)"?

➡️ Per-schedule policy `on_miss: run_late | skip`, default `run_late`, optional `max_lateness` (default none). Missed/skipped items stay visible with status. Late runs inject note into prompt ("scheduled for X, running at Y, Z late") so agent can reason about stale assumptions.

❓ **Q6** - **Time input & tz**: Store absolute UTC instant; form accepts absolute datetime or relative ("in 24h"); display in local tz with UTC hint (summary used UTC).

➡️ Yes as stated. Relative resolved to absolute at creation; no "relative to bridge return" semantics.

❓ **Q7** - **Edit/cancel lifecycle**: States `scheduled → running → done | failed | missed | cancelled`. Allow edit time/prompt/policy while `scheduled`; cancel anytime before running; "run now" button?

➡️ Yes, including "run now" (cheap, useful for soak early-abort).

Answer these; storage/ownership + classifier integration + office display questions come next round once exploration lands.