# Dictated hiring

Hire a worker by saying what you want. The game has a command bar that takes text from dictation software (Wispr Flow,
or anything that types or pastes into a text field), reads it with the LLM you set up, and opens a review of the hire.
Nothing is hired until you press **Hire** in that review. (#209; the decisions are in [`decisions.md`](decisions.md),
#210 to #214.)

## Before you start

Set up an LLM in **Settings → AI integration** (Base URL, API key, model, Test, Save). Without one the bar says
"No AI model is ready to read commands. Set up the LLM in Settings (AI integration), then press Enter again."

## Open the bar

- **Ctrl+Shift+Space** (**⌘+Shift+Space** on a Mac), from every view: the city, a floor, a text field, a dialog (the hire
  review included), and seated at a laptop (the terminal never gets the chord). The same chord again, or **Esc**, closes it.
- Or with the mouse: **Menu → Dictate a command…**.

Dictate, type or paste into it, then press **Enter**. **Shift+Enter** adds a line; a pasted text keeps its line breaks.
Enter while an answer is on its way does nothing more (one request at a time). If the provider fails or is slow, the bar
says so, keeps your text, and Enter tries again.

## What it understands

Only hiring, for now. These are examples, not a grammar:

- "Spawn an agent."
- "Hire an agent."
- "Let an agent research this for me."
- "Hire a worker."
- "Spawn a worker."

A complete request names the harness or model, the effort and the task:

> Hire an agent running Claude Code on Haiku 5.5 with high effort. Task: investigate the login redirect loop and add a
> regression test.

Model names and readable labels both work ("Opus 5.5", "GPT-6-Sol", `claude-opus-5-5`), checked against the models your
harnesses offer right now. The task is kept exactly as you said it, punctuation and later sentences included.

Anything else gets one of two answers, and nothing opens or is hired:

- **"Not supported yet."**: a clear request for something other than one hire ("Open Settings.", "Fire the idle agent
  at desk three.", "Tell Sprout to fix the tests.", two workers or two actions at once).
- **"Your intent is unclear."**: not a request to hire ("Do not hire an agent…", a quote, a question, "What if I hired…",
  "Yesterday I hired…", a bare "high" with no review open).

## The review

Every clear hire opens the review first, even one that says everything. Its sections are **Harness and model**,
**Effort**, **Task** and **Location and options**. A section whose value is settled starts folded with the value in its
header; one that is missing or not valid starts open. Each says where its value came from (Dictated, Resolved by the
interpreter, Default, Your choice). Change anything before you hire; pressing Enter in a field, folding a section or
answering a question never hires.

**Effort is always stated or chosen, never defaulted.** When you did not say one, the Effort section opens and asks
"What effort level should this agent use?" with the model's levels, none selected, and Hire stays off. Pick one, or
open the bar over the review and dictate the answer ("high"): it fills that review and hires nothing. An effort word
inside the task ("make the high effort setting visible") does not count. If you change the model and it does not offer
the chosen effort, the effort is cleared and asked again; it is never replaced with another level.

A missing model or task is asked for the same way. The hire goes to the floor you are on, at its first free desk; from
the city the bar asks "Hire on which floor?".

**Cancel** (or Esc) drops the whole request.

## Hire in background

**Settings → Display → Hire in background**, right after "Go to a new hire after hiring". **Off by default**; the
choice is kept in this browser. It applies to the Hire dialog and to the dictated review alike.

- **Off:** after Hire the dialog waits while the worker starts, says "Hired … Here they come.", and (with "Go to a new
  hire after hiring" on) sits you at the new worker's laptop.
- **On:** Hire closes the dialog at once and you keep playing (walk, hire another). When the worker is up you get
  exactly **"Agent spawned successfully."** and one short beep (under the master mute and volume), never an inbox item
  or a desktop notification, and never a trip to the laptop, whatever "Go to a new hire after hiring" says.
  A failure is one error toast that names the desk. If the connection drops or herdr-world does not answer in time, the
  toast says the hire may still have gone through: look at the desk before you hire again. It is never sent twice by
  itself.
