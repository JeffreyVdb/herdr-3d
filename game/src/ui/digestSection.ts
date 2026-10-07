import type { AiRoleState, CommandArgs, CommandName, DigestState, DigestTestAck } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { DIGEST_CAP, DIGEST_TOKENS, digestFailureText, effortChoices, effortNote, usageText, type DigestBook } from '../world/digestSettings';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the floor overview summaries section needs: the bridge's state, the commands, and the way to the AI section. */
export interface DigestSectionHost {
  book: DigestBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/** What is sent and where, shown above the switch (#118 "Opt-in"): it is what the switch agrees to. */
export const DIGEST_PRIVACY =
  'With this on, the bridge sends your configured LLM endpoint, for the floors someone is viewing: the first prompt of each one-off worker, and the last 5 assistant turns of every worker (their text, and each tool call’s name and input summary), with the ticket title or task line as context. Tool output and thinking are never sent, and anything shaped like a key or token is scrubbed first. Prompts and turns can contain code, paths and internal details; a self-hosted OpenAI-compatible endpoint keeps them in-house.';

/** Which AI features the reasoning effort and the completion budget reach (#174): these summaries only. */
export const DIGEST_SCOPE =
  'These two settings apply to floor overview summaries only. The other AI features (follow-up questions, pack up, command classification) keep their own limits and send no reasoning effort.';

/** When the lines are written, and when a failed one is tried again (#174; the timing itself is unchanged). */
export const DIGEST_TIMING =
  'A task line is written once per prompt for each one-off worker. A now line is written after a turn ends and settles for 2 seconds, at most once a minute per worker. Both only for a floor someone is viewing. A task line that fails is tried again up to 4 times in all, 1, 5 and 15 minutes apart; “Retry failed” does it at once.';

const ROLE_STATE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };
/** Share of the cap from which the ledger's bar warns. */
const NEAR_CAP = 0.8;

let serial = 0;

const figures = (n: number) => n.toLocaleString('en-US');

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * #118: the “Floor overview summaries” section of the Settings window, after “Classify unknown commands” (the last of the features on the AI integration): the feature's own
 * switch (off by default), what it needs (the LLM ready, linking to the AI section), exactly what is sent and where
 * above the switch, today's calls against the daily cap, the cap, and Test, which has the LLM write a task line and a
 * now line from samples. The switch is off until a test passed with the LLM in use; the bridge's environment can set
 * it, and then it is read-only here.
 */
export function digestSection(host: DigestSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-dg-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'The floor overview says what each worker was asked to do and what it is doing now. Without this it shows Claude’s own title, the first sentence of the prompt, a recap or the terminal title; with it, the LLM writes those lines, marked AI on the page.',
    );
    const missing = el('p', 'settings-field-hint', 'This bridge has no floor overview summaries. Update it to use this.');

    // What it needs: the LLM, with its state.
    const needs = el('div', 'settings-fu-needs');
    const needsText = el('p', 'settings-fu-needs-text', 'Needs the LLM:');
    const pills = el('ul', 'settings-fu-roles');
    const li = el('li', 'settings-fu-role');
    const badge = el('span', 'settings-badge');
    li.append(el('span', '', AI_ROLE_NAME.llm), badge);
    pills.append(li);
    const toAi = button('Set up in AI integration', 'btn btn--sm settings-fu-link');
    toAi.addEventListener('click', () => host.showAi());
    needs.append(needsText, pills, toAi);

    const privacy = el('p', 'settings-fu-privacy', DIGEST_PRIVACY);
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Floor overview summaries'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    // Today's calls against the cap, a hairline of it that warns near it.
    const ledger = el('dl', 'settings-act-ledger');
    const callsValue = el('dd', 'settings-act-figure');
    const bar = el('div', 'settings-act-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'settings-act-fill');
    bar.append(fill);
    const callsNote = el('dd', 'settings-field-hint settings-act-note', 'A failed call counts like any other; the same input again reuses its line without a call.');
    ledger.append(el('dt', '', 'Summaries today'), callsValue, bar, callsNote);

    const cap = el('input');
    cap.type = 'number';
    cap.id = `${id}-cap`;
    cap.min = String(DIGEST_CAP.min);
    cap.max = String(DIGEST_CAP.max);
    cap.step = '50';
    cap.inputMode = 'numeric';
    const capHint = el('p', 'settings-field-hint', 'Most LLM calls a day; past it no new calls until tomorrow, and the lines already written stay. Default 300.');
    capHint.id = `${id}-cap-hint`;
    cap.setAttribute('aria-describedby', capHint.id);
    const capField = el('div', 'settings-field settings-field--short');
    const capLabel = el('label', 'settings-field-label', 'Daily cap');
    capLabel.htmlFor = cap.id;
    capField.append(capLabel, cap, capHint);

    // #174: the reasoning effort (the model's own list) and the completion budget (reasoning included).
    const effort = el('select');
    effort.id = `${id}-effort`;
    const effortHint = el('p', 'settings-field-hint');
    effortHint.id = `${id}-effort-hint`;
    effort.setAttribute('aria-describedby', effortHint.id);
    const effortField = el('div', 'settings-field');
    const effortLabel = el('label', 'settings-field-label', 'Reasoning effort');
    effortLabel.htmlFor = effort.id;
    effortField.append(effortLabel, effort, effortHint);

    const tokens = el('input');
    tokens.type = 'number';
    tokens.id = `${id}-tokens`;
    tokens.min = String(DIGEST_TOKENS.min);
    tokens.max = String(DIGEST_TOKENS.max);
    tokens.step = '64';
    tokens.inputMode = 'numeric';
    const tokensHint = el('p', 'settings-field-hint');
    tokensHint.id = `${id}-tokens-hint`;
    tokens.setAttribute('aria-describedby', tokensHint.id);
    const tokensField = el('div', 'settings-field settings-field--short');
    const tokensLabel = el('label', 'settings-field-label', 'Completion budget (tokens)');
    tokensLabel.htmlFor = tokens.id;
    tokensField.append(tokensLabel, tokens, tokensHint);

    const scope = el('p', 'settings-field-hint settings-dg-scope', DIGEST_SCOPE);
    const timing = el('p', 'settings-field-hint settings-dg-timing', DIGEST_TIMING);

    const test = button('Test');
    const retry = button('Retry failed');
    retry.title = 'Ask again for every line whose summary failed';
    const actions = el('div', 'settings-fu-actions');
    actions.append(test, retry);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const result = el('div', 'settings-fu-result');
    result.hidden = true;

    const controls = el('div', 'settings-fu');
    controls.append(needs, privacy, toggle, toggleHint, ledger, timing, capField, effortField, tokensField, scope, actions, status, result);
    body.append(lede, missing, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    let capDirty = false;
    let tokensDirty = false;
    /** The switch's position while its digest.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = (): DigestState | null => host.book.state;
    const locked = () => st()?.env.includes('enabled') ?? false;

    const say = (text: string, error = false) => {
      note = text ? { text, error } : null;
      sync();
    };

    function sync(): void {
      const s = st();
      missing.hidden = host.book.known;
      controls.hidden = !s;
      if (!s) return;
      badge.dataset.state = s.roles.llm;
      badge.textContent = ROLE_STATE[s.roles.llm];
      const ready = s.roles.llm === 'ready';
      toAi.hidden = ready;
      needs.dataset.ready = String(ready);
      box.checked = wanted ?? s.enabled;
      // Switching on needs a passing test; switching off never does. The environment's switch is not ours.
      box.disabled = busy || locked() || (!s.enabled && (!s.tested || !ready));
      const capped = s.calls_today >= s.daily_cap;
      toggleHint.textContent = locked()
        ? `Set by the bridge environment (HERDR_WORLD_DIGEST_ENABLED).${s.enabled && !ready ? ' Paused until the LLM is ready.' : ''}`
        : s.enabled
          ? s.state !== 'ready'
            ? 'On, but paused: the LLM is not ready. Nothing is sent until it is.'
            : capped
              ? 'On, but today’s cap is reached: no new calls until tomorrow. The lines already written stay, and an input seen before reuses its line.'
              : 'On: lines are written for the floors someone is viewing.'
          : !ready
            ? 'Set up the LLM first.'
            : s.tested
              ? 'The test passed: you can switch it on.'
              : 'Run the test below first: it has to pass with the LLM in use.';

      callsValue.textContent = `${figures(s.calls_today)} of ${figures(s.daily_cap)}`;
      const share = s.daily_cap > 0 ? Math.min(1, s.calls_today / s.daily_cap) : 0;
      fill.style.transform = `scaleX(${share.toFixed(3)})`;
      bar.dataset.level = share >= 1 ? 'full' : share >= NEAR_CAP ? 'near' : 'ok';

      if (!capDirty && document.activeElement !== cap) cap.value = String(s.daily_cap);
      cap.disabled = busy;

      // The effort: exactly what the model's catalog lists; a saved one it does not take stays visible, marked.
      const choices = effortChoices(s);
      const sig = JSON.stringify(choices);
      if (effort.dataset.sig !== sig) {
        effort.dataset.sig = sig;
        effort.replaceChildren(
          ...choices.map((c) => {
            const o = el('option', '', c.label);
            o.value = c.value;
            o.disabled = !!c.stale;
            return o;
          }),
        );
      }
      effort.value = s.reasoning_effort;
      effort.disabled = busy || (s.reasoning.support === 'unsupported' && !s.effort_stale);
      effortHint.textContent = effortNote(s);
      effortHint.classList.toggle('settings-field-error', s.effort_stale);
      if (!tokensDirty && document.activeElement !== tokens) tokens.value = String(s.max_tokens);
      tokens.disabled = busy;
      tokensHint.textContent = `In use: ${figures(s.max_tokens)}. The most the model may generate for one line, its reasoning included; not the line's length (task lines stay within 80 characters, now lines within 100). ${figures(DIGEST_TOKENS.default)} by default, ${figures(DIGEST_TOKENS.min)} to ${figures(DIGEST_TOKENS.max)}. A reasoning model that spends it all thinking writes no line.`;
      test.disabled = busy || !ready;
      retry.disabled = busy || s.state !== 'ready';
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
    }

    const run = async <T>(work: () => Promise<T>): Promise<T> => {
      busy = true;
      sync();
      try {
        return await work();
      } finally {
        busy = false;
      }
    };

    box.addEventListener('change', () => {
      const on = box.checked;
      wanted = on;
      note = { text: on ? 'Switching on…' : 'Switching off…', error: false };
      void run(() => host.send('digest.set', { enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        say(on ? 'On. The overview’s lines come from the LLM from now on.' : 'Off. Nothing is sent; the overview shows its own lines.');
      });
    });

    const commitCap = () => {
      if (!capDirty) return;
      const raw = cap.value.trim();
      const v = Number(raw);
      if (raw === '' || !Number.isInteger(v) || v < DIGEST_CAP.min || v > DIGEST_CAP.max) {
        cap.setAttribute('aria-invalid', 'true');
        return say(`The daily cap must be a whole number of calls from ${figures(DIGEST_CAP.min)} to ${figures(DIGEST_CAP.max)}.`, true);
      }
      cap.setAttribute('aria-invalid', 'false');
      capDirty = false; // sent once: the change event after an Enter finds nothing to send
      void run(() => host.send('digest.set', { daily_cap: v })).then((r) => {
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        say(`Daily cap saved: ${figures(v)}.`);
      });
    };
    cap.addEventListener('input', () => (capDirty = true));
    cap.addEventListener('change', commitCap);
    cap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitCap();
      }
    });

    effort.addEventListener('change', () => {
      const v = effort.value;
      void run(() => host.send('digest.set', { reasoning_effort: v })).then((r) => {
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        say(v ? 'Reasoning effort saved. Run the test again before switching on.' : 'Reasoning effort: the provider’s default. Nothing is sent.');
      });
    });

    const commitTokens = () => {
      if (!tokensDirty) return;
      const raw = tokens.value.trim();
      const v = Number(raw);
      if (raw === '' || !Number.isInteger(v) || v < DIGEST_TOKENS.min || v > DIGEST_TOKENS.max) {
        tokens.setAttribute('aria-invalid', 'true');
        return say(`The completion budget must be a whole number of tokens from ${figures(DIGEST_TOKENS.min)} to ${figures(DIGEST_TOKENS.max)}.`, true);
      }
      tokens.setAttribute('aria-invalid', 'false');
      tokensDirty = false;
      void run(() => host.send('digest.set', { max_tokens: v })).then((r) => {
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        say(`Completion budget saved: ${figures(v)} tokens.`);
      });
    };
    tokens.addEventListener('input', () => (tokensDirty = true));
    tokens.addEventListener('change', commitTokens);
    tokens.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTokens();
      }
    });

    retry.addEventListener('click', () => {
      void run(() => host.send('digest.retry', {})).then((r) => {
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        const n = (r.data as { retried?: number } | undefined)?.retried ?? 0;
        say(n ? `Trying ${n} failed ${n === 1 ? 'line' : 'lines'} again.` : 'No summary has failed: nothing to retry.');
      });
    });

    test.addEventListener('click', () => {
      note = { text: 'Testing: the LLM writes a task line and a now line from samples…', error: false };
      result.hidden = true;
      void run(() => host.send('digest.test', {})).then((r) => {
        if (!r.ok) return say(digestFailureText(r.code, r.message), true);
        const d = r.data as DigestTestAck;
        paintResult(result, d, st()?.max_tokens ?? DIGEST_TOKENS.default);
        say(d.ok ? 'Test passed. You can switch it on.' : `Test failed: ${d.reason ?? 'a line came back empty'}.`, !d.ok);
      });
    });

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        capDirty = false;
        tokensDirty = false;
        cap.removeAttribute('aria-invalid');
        tokens.removeAttribute('aria-invalid');
        result.hidden = true;
        sync();
        // The day's count moves without telling: read it again as the window opens.
        if (st()) void host.send('digest.get', {}).then((r) => r.ok && host.book.upsert(r.data));
      },
      dispose: off,
    };
  };
}

const KIND_NAME = { task: 'Task line', now: 'Now line' } as const;

/** The test's outcome: each sample line as the overview would show it, or why it came back empty. */
function paintResult(root: HTMLElement, d: DigestTestAck, budget: number): void {
  root.replaceChildren();
  const rows = el('dl', 'settings-fu-samples');
  for (const s of Array.isArray(d.samples) ? d.samples : []) {
    const ok = typeof s.line === 'string' && s.line !== '';
    const b = el('span', 'settings-badge', ok ? 'Written' : 'Empty');
    b.dataset.state = ok ? 'ready' : 'invalid';
    const dd = el('dd');
    dd.append(b);
    rows.append(el('dt', '', KIND_NAME[s.kind] ?? s.kind), dd);
    const line = el('dd', 'settings-fu-extracted');
    line.append(ok ? el('span', '', `“${s.line}”`) : el('span', 'settings-field-hint', s.error ?? 'no answer'));
    rows.append(line);
    const used = usageText(s.diag, budget);
    if (used) rows.append(el('dd', 'settings-field-hint settings-dg-usage', `Spent ${used}`));
  }
  root.append(rows);
  root.hidden = false;
}
