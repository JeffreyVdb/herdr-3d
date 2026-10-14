import type { AiRoleState, CommandArgs, CommandName, HandoffLLMState, HandoffLLMTestAck } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { effortChoices, effortNote, usageText } from '../world/digestSettings';
import { HANDOFF_LLM_INPUT, HANDOFF_LLM_TOKENS, handoffLlmFailureText, sizeWord, type HandoffLLMBook } from '../world/handoffLlm';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the LLM handoffs section needs: the bridge's state, the commands, and the way to the AI section. */
export interface HandoffLlmSectionHost {
  book: HandoffLLMBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/**
 * What is sent and where, shown above the switch (#9): it is what the switch agrees to. The scrub is pattern-based; the
 * text says so rather than promising it catches every secret.
 */
export function handoffLlmPrivacy(categories: string[]): string {
  return (
    `With this on, choosing “Use configured LLM” in a handoff sends your configured LLM endpoint a reduced copy of that worker’s conversation: ${categories.join('; ')}. ` +
    'Full tool output, images, hidden reasoning and subagent transcripts are left out. Before sending, the bridge removes text that matches known secret patterns (API keys, tokens, private keys, passwords in URLs and assignments); a pattern list can miss a secret, so treat what you send as readable by that provider. Nothing is sent until you file a handoff this way.'
  );
}

/** Which calls the limits reach, and what the first call costs. */
export const HANDOFF_LLM_SCOPE =
  'These limits apply to LLM handoffs only. The model reads the reduced conversation cold (your worker’s prompt cache does not carry over to another model or account), so a handoff is billed as one full input plus its output.';

const ROLE_STATE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };

let serial = 0;

const figures = (n: number) => n.toLocaleString('en-US');

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * #9: the “LLM handoffs” section of the Settings window, after the floor overview summaries: the feature's own switch
 * (off by default), what it needs (the LLM ready, linking to the AI section), exactly what is sent and where above the
 * switch, the transcript and completion budgets, the reasoning effort, and Test, which has the LLM write a handoff of a
 * short synthetic session. The switch is off until a test passed with the LLM and limits in use; once on, changing
 * either leaves it waiting for a new test. The bridge's environment can set it, and then it is read-only here.
 */
export function handoffLlmSection(host: HandoffLlmSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-hl-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'A handoff’s third way to file: the LLM you set up writes it from the worker’s conversation, without prompting the worker. The result is checked for its title and sections and filed in the floor’s cabinet, marked as written by the LLM.',
    );
    const missing = el('p', 'settings-field-hint', 'This bridge has no LLM handoffs. Update it to use this.');

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

    const privacy = el('p', 'settings-fu-privacy');
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'LLM handoffs'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    const numberField = (key: string, label: string, min: number, max: number, step: number) => {
      const input = el('input');
      input.type = 'number';
      input.id = `${id}-${key}`;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.inputMode = 'numeric';
      const hint = el('p', 'settings-field-hint');
      hint.id = `${id}-${key}-hint`;
      input.setAttribute('aria-describedby', hint.id);
      const field = el('div', 'settings-field settings-field--short');
      const l = el('label', 'settings-field-label', label);
      l.htmlFor = input.id;
      field.append(l, input, hint);
      return { input, hint, field };
    };
    // The transcript budget is shown and typed in KB; the bridge keeps bytes.
    const kb = numberField('input', 'Transcript budget (KB)', HANDOFF_LLM_INPUT.min / 1024, HANDOFF_LLM_INPUT.max / 1024, 16);
    const tk = numberField('tokens', 'Completion budget (tokens)', HANDOFF_LLM_TOKENS.min, HANDOFF_LLM_TOKENS.max, 256);

    const effort = el('select');
    effort.id = `${id}-effort`;
    const effortHint = el('p', 'settings-field-hint');
    effortHint.id = `${id}-effort-hint`;
    effort.setAttribute('aria-describedby', effortHint.id);
    const effortField = el('div', 'settings-field');
    const effortLabel = el('label', 'settings-field-label', 'Reasoning effort');
    effortLabel.htmlFor = effort.id;
    effortField.append(effortLabel, effort, effortHint);

    const scope = el('p', 'settings-field-hint settings-dg-scope', HANDOFF_LLM_SCOPE);
    const test = button('Test');
    const actions = el('div', 'settings-fu-actions');
    actions.append(test);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const result = el('div', 'settings-fu-result');
    result.hidden = true;

    const controls = el('div', 'settings-fu');
    controls.append(needs, privacy, toggle, toggleHint, kb.field, tk.field, effortField, scope, actions, status, result);
    body.append(lede, missing, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    let kbDirty = false;
    let tkDirty = false;
    let wanted: boolean | null = null;

    const st = (): HandoffLLMState | null => host.book.state;
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
      privacy.textContent = handoffLlmPrivacy(s.categories);
      box.checked = wanted ?? s.enabled;
      // Switching on needs a passing test; switching off never does. A passing test while on binds it to the config again.
      box.disabled = busy || locked() || (!s.enabled && (!s.tested || !ready));
      toggleHint.textContent = locked()
        ? `Set by the bridge environment (HERDR_WORLD_HANDOFF_LLM_ENABLED).${s.enabled && !ready ? ' Paused until the LLM is ready.' : ''}`
        : s.state === 'ready'
          ? 'On: “Use configured LLM” can be chosen in the handoff dialog.'
          : s.state === 'incomplete'
            ? 'On, but paused: the LLM is not ready. Nothing is sent until it is.'
            : s.state === 'untested'
              ? 'On, but waiting: the LLM or the limits changed since the test. Nothing is sent until the test passes again.'
              : !ready
                ? 'Set up the LLM first.'
                : s.tested
                  ? 'The test passed: you can switch it on.'
                  : 'Run the test below first: it has to pass with the LLM and the limits in use.';
      if (!kbDirty && document.activeElement !== kb.input) kb.input.value = String(Math.round(s.input_bytes / 1024));
      kb.input.disabled = busy;
      kb.hint.textContent = `In use: ${sizeWord(s.input_bytes)} of reduced conversation, about ${figures(Math.ceil(s.input_bytes / 3))} tokens at most. The first goal, your corrections and the final reply always go; older detail is left out first, and the dialog says what was. ${HANDOFF_LLM_INPUT.default / 1024} KB by default.`;
      if (!tkDirty && document.activeElement !== tk.input) tk.input.value = String(s.max_tokens);
      tk.input.disabled = busy;
      tk.hint.textContent = `In use: ${figures(s.max_tokens)}. The most the model may write for one handoff, its reasoning included. An answer cut off at it is refused, never filed short. ${figures(HANDOFF_LLM_TOKENS.default)} by default.`;
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
      test.disabled = busy || !ready;
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
      void run(() => host.send('handoff_llm.set', { enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(handoffLlmFailureText(r.code, r.message), true);
        say(on ? 'On. “Use configured LLM” can be chosen when you file a handoff.' : 'Off. Nothing is sent; a handoff that was being written is stopped.');
      });
    });

    const commitNumber = (dirty: () => boolean, clear: () => void, input: HTMLInputElement, min: number, max: number, send: (v: number) => CommandArgs['handoff_llm.set'], what: string, unit: string) => {
      if (!dirty()) return;
      const raw = input.value.trim();
      const v = Number(raw);
      if (raw === '' || !Number.isInteger(v) || v < min || v > max) {
        input.setAttribute('aria-invalid', 'true');
        return say(`The ${what} must be a whole number from ${figures(min)} to ${figures(max)} ${unit}.`, true);
      }
      input.setAttribute('aria-invalid', 'false');
      clear();
      void run(() => host.send('handoff_llm.set', send(v))).then((r) => {
        if (!r.ok) return say(handoffLlmFailureText(r.code, r.message), true);
        say(`${what.charAt(0).toUpperCase()}${what.slice(1)} saved: ${figures(v)} ${unit}.${st()?.enabled && what !== 'transcript budget' ? ' Run the test again: the switch waits for it.' : ''}`);
      });
    };
    const wire = (input: HTMLInputElement, setDirty: () => void, commit: () => void) => {
      input.addEventListener('input', setDirty);
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      });
    };
    const commitKb = () =>
      commitNumber(() => kbDirty, () => (kbDirty = false), kb.input, HANDOFF_LLM_INPUT.min / 1024, HANDOFF_LLM_INPUT.max / 1024, (v) => ({ input_bytes: v * 1024 }), 'transcript budget', 'KB');
    const commitTk = () => commitNumber(() => tkDirty, () => (tkDirty = false), tk.input, HANDOFF_LLM_TOKENS.min, HANDOFF_LLM_TOKENS.max, (v) => ({ max_tokens: v }), 'completion budget', 'tokens');
    wire(kb.input, () => (kbDirty = true), commitKb);
    wire(tk.input, () => (tkDirty = true), commitTk);

    effort.addEventListener('change', () => {
      const v = effort.value;
      void run(() => host.send('handoff_llm.set', { reasoning_effort: v })).then((r) => {
        if (!r.ok) return say(handoffLlmFailureText(r.code, r.message), true);
        say(v ? 'Reasoning effort saved. Run the test again before using it.' : 'Reasoning effort: the provider’s default. Nothing is sent for it.');
      });
    });

    test.addEventListener('click', () => {
      note = { text: 'Testing: the LLM writes a handoff of a short sample session (no real transcript)…', error: false };
      result.hidden = true;
      void run(() => host.send('handoff_llm.test', {})).then((r) => {
        if (!r.ok) return say(handoffLlmFailureText(r.code, r.message), true);
        const d = r.data as HandoffLLMTestAck;
        paintResult(result, d, st()?.max_tokens ?? HANDOFF_LLM_TOKENS.default);
        say(d.ok ? (st()?.enabled ? 'Test passed: LLM handoffs use this LLM and these limits.' : 'Test passed. You can switch it on.') : `Test failed: ${d.reason ?? 'the handoff was not of the agreed shape'}.`, !d.ok);
      });
    });

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        kbDirty = tkDirty = false;
        kb.input.removeAttribute('aria-invalid');
        tk.input.removeAttribute('aria-invalid');
        result.hidden = true;
        sync();
        if (st()) void host.send('handoff_llm.get', {}).then((r) => r.ok && host.book.upsert(r.data));
      },
      dispose: off,
    };
  };
}

/** The test's outcome: the sample handoff's title, its size and time, what it spent. */
function paintResult(root: HTMLElement, d: HandoffLLMTestAck, budget: number): void {
  root.replaceChildren();
  const rows = el('dl', 'settings-fu-samples');
  const b = el('span', 'settings-badge', d.ok ? 'Valid' : 'Refused');
  b.dataset.state = d.ok ? 'ready' : 'invalid';
  const dd = el('dd');
  dd.append(b);
  rows.append(el('dt', '', 'Sample handoff'), dd);
  const line = el('dd', 'settings-fu-extracted');
  line.append(d.ok && d.title ? el('span', '', `“${d.title}”`) : el('span', 'settings-field-hint', d.reason ?? 'no answer'));
  rows.append(line);
  const facts = [`${sizeWord(d.bytes)}`, `${(d.latency_ms / 1000).toFixed(1)} s`, usageText(d.diag, budget)].filter(Boolean).join(' · ');
  rows.append(el('dd', 'settings-field-hint settings-dg-usage', facts));
  root.append(rows);
  root.hidden = false;
}
