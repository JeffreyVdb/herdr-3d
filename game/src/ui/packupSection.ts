import type { AiRole, AiRoleState, CommandArgs, CommandName, PackupTestAck } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { packupFailureText, type PackupBook } from '../world/packup';
import { DIGEST_TOKENS, effortChoices, effortNote, usageText } from '../world/digestSettings';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the pack-up section needs: the bridge's state, the commands, and the way to the AI section. */
export interface PackupSectionHost {
  book: PackupBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/** The privacy note, shown above the toggle. */
export const PACKUP_PRIVACY =
  'With pack up on request on, every prompt you send a Claude or Codex worker from the game goes to TypeSafe (the classification model) before it is sent, and to your chosen LLM endpoint when the classifier says it asks the worker to leave. Prompts can contain code, paths and internal details. Images in a prompt are never sent, only a placeholder. A self-hosted OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM) keeps the extraction step in-house.';

const ROLE_STATE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };

let serial = 0;

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * #110: the “Pack up on request” section of the Settings window, next to “Follow-up questions”: the feature's own
 * switch (off by default), the threshold, what it needs (both models ready, linking to the AI section), the privacy
 * note above the switch, and Test, which runs the labelled sample prompts through the classifier and cuts the core
 * ones with the LLM. The switch is off until a test passed with the models in use; the bridge's environment can set
 * it, and then it is read-only here.
 */
export function packupSection(host: PackupSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-pk-${++serial}`;
    const lede = el('p', 'settings-lede', 'When a prompt you send also tells the worker to leave (“make a PR, then go home”), the game shows what it would cut and offers to send only the task, then send the worker home once it reports done.');
    const missing = el('p', 'settings-field-hint', 'This bridge has no pack up on request. Update it to use this.');

    // What it needs: both models, each with its state.
    const needs = el('div', 'settings-fu-needs');
    const needsText = el('p', 'settings-fu-needs-text', 'Needs the classification model and the LLM:');
    const pills = el('ul', 'settings-fu-roles');
    const pill = (role: AiRole) => {
      const li = el('li', 'settings-fu-role');
      const badge = el('span', 'settings-badge');
      li.append(el('span', '', AI_ROLE_NAME[role]), badge);
      pills.append(li);
      return badge;
    };
    const badges: Record<AiRole, HTMLElement> = { classifier: pill('classifier'), llm: pill('llm') };
    const toAi = button('Set up in AI integration', 'btn btn--sm settings-fu-link');
    toAi.addEventListener('click', () => host.showAi());
    needs.append(needsText, pills, toAi);

    const privacy = el('p', 'settings-fu-privacy', PACKUP_PRIVACY);
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Pack up on request'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    const threshold = el('input');
    threshold.type = 'number';
    threshold.min = '0.05';
    threshold.max = '0.99';
    threshold.step = '0.05';
    threshold.inputMode = 'decimal';
    threshold.id = `${id}-th`;
    const thHint = el('p', 'settings-field-hint', 'How sure the classification model must be that the prompt asks the worker to leave (0.05–0.99). Default 0.85: a miss only means the prompt goes as written.');
    thHint.id = `${id}-th-hint`;
    threshold.setAttribute('aria-describedby', thHint.id);
    const thField = el('div', 'settings-field settings-field--short');
    const thLabel = el('label', 'settings-field-label', 'Threshold');
    thLabel.htmlFor = threshold.id;
    thField.append(thLabel, threshold, thHint);

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

    const timing = el('p', 'settings-field-hint', 'The classifier decides whether to check; the LLM identifies exact text to remove. Each check has 1.2 seconds including the shared call queue. Higher reasoning may miss this deadline: Test reports that without changing your choice. A failed or late check sends the original prompt.');
    const scope = el('p', 'settings-field-hint', 'These controls apply only to pack up. The completion budget includes reasoning and overrides the endpoint’s token budget. Provider default keeps the endpoint’s reasoning configuration.');
    const test = button('Test');
    const actions = el('div', 'settings-fu-actions');
    actions.append(test);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const result = el('div', 'settings-fu-result');
    result.hidden = true;

    const controls = el('div', 'settings-fu');
    controls.append(needs, privacy, toggle, toggleHint, thField, effortField, tokensField, scope, timing, actions, status, result);
    body.append(lede, missing, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    let thDirty = false;
    let tokensDirty = false;
    /** The switch's position while its packup.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = () => host.book.state;
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
      for (const r of ['classifier', 'llm'] as const) {
        badges[r].dataset.state = s.roles[r];
        badges[r].textContent = ROLE_STATE[s.roles[r]];
      }
      const allReady = !s.missing?.length;
      toAi.hidden = allReady;
      needs.dataset.ready = String(allReady);
      box.checked = wanted ?? s.enabled;
      // Switching on needs a passing test; switching off never does. The environment's switch is not ours.
      box.disabled = busy || locked() || (!s.enabled && (!s.tested || !allReady || s.effort_stale));
      toggleHint.textContent = locked()
        ? `Set by the bridge environment (HERDR_WORLD_PACKUP_ENABLED).${s.enabled && !allReady ? ' Paused until both models are ready.' : ''}`
        : s.enabled
          ? s.state === 'ready'
            ? 'On: each prompt is checked before it goes (at most 1.5 s).'
            : 'On, but paused: check the models and saved reasoning effort below.'
          : !allReady
            ? 'Set up both models first.'
            : s.tested
              ? 'The test passed: you can switch it on.'
              : 'Run the test below first: it has to pass with the models in use.';
      if (!thDirty && document.activeElement !== threshold) threshold.value = s.threshold.toFixed(2);
      threshold.disabled = busy;
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
      effort.disabled = busy || (s.reasoning.efforts.length === 0 && !s.effort_stale);
      effortHint.textContent = effortNote(s);
      effortHint.classList.toggle('settings-field-error', s.effort_stale);
      if (!tokensDirty && document.activeElement !== tokens) tokens.value = String(s.max_tokens);
      tokens.disabled = busy;
      tokensHint.textContent = `In use: ${s.max_tokens} tokens, including reasoning. Default 600; ${DIGEST_TOKENS.min}–${DIGEST_TOKENS.max}. Exhausting the budget rejects the extraction.`;
      timing.textContent = `The classifier decides whether to check; the LLM identifies exact text to remove. Each check has ${s.timeout_ms / 1000} seconds including the shared call queue. Higher reasoning may miss this deadline: Test reports that without changing your choice. A failed or late check sends the original prompt.`;
      if (s.effort_stale) effortHint.textContent = 'The saved effort is unsupported by this model. Checks are paused until you choose another effort or Provider default.';
      test.disabled = busy || !allReady || s.effort_stale;
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
      void run(() => host.send('packup.set', { enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(packupFailureText(r.code, r.message), true);
        say(on ? 'On. Prompts are checked from now on.' : 'Off. Nothing is sent.');
      });
    });

    const commitThreshold = () => {
      if (!thDirty) return;
      const v = Number(threshold.value);
      if (!Number.isFinite(v) || v < 0.05 || v > 0.99) {
        threshold.setAttribute('aria-invalid', 'true');
        return say('The threshold must be between 0.05 and 0.99.', true);
      }
      threshold.setAttribute('aria-invalid', 'false');
      void run(() => host.send('packup.set', { threshold: Math.round(v * 100) / 100 })).then((r) => {
        thDirty = false;
        if (!r.ok) return say(packupFailureText(r.code, r.message), true);
        say(`Threshold saved: ${(Math.round(v * 100) / 100).toFixed(2)}.`);
      });
    };
    threshold.addEventListener('input', () => (thDirty = true));
    threshold.addEventListener('change', commitThreshold);
    threshold.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitThreshold();
      }
    });

    effort.addEventListener('change', () => {
      const v = effort.value;
      void run(() => host.send('packup.set', { reasoning_effort: v })).then((r) => {
        if (!r.ok) return say(packupFailureText(r.code, r.message), true);
        say(v ? 'Reasoning effort saved. Run the test again before switching on.' : 'Reasoning effort: the provider’s default. The endpoint’s reasoning configuration is preserved.');
      });
    });

    const commitTokens = () => {
      if (!tokensDirty) return;
      const raw = tokens.value.trim();
      const v = Number(raw);
      if (raw === '' || !Number.isInteger(v) || v < DIGEST_TOKENS.min || v > DIGEST_TOKENS.max) {
        tokens.setAttribute('aria-invalid', 'true');
        return say(`The completion budget must be a whole number of tokens from ${String(DIGEST_TOKENS.min)} to ${String(DIGEST_TOKENS.max)}.`, true);
      }
      tokens.setAttribute('aria-invalid', 'false');
      tokensDirty = false;
      void run(() => host.send('packup.set', { max_tokens: v })).then((r) => {
        if (!r.ok) return say(packupFailureText(r.code, r.message), true);
        say(`Completion budget saved: ${String(v)} tokens.`);
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

    test.addEventListener('click', () => {
      note = { text: 'Testing with the sample prompts…', error: false };
      result.hidden = true;
      void run(() => host.send('packup.test', {})).then((r) => {
        if (!r.ok) return say(packupFailureText(r.code, r.message), true);
        const d = r.data as PackupTestAck;
        paintResult(result, d);
        say(d.ok ? 'Test passed. You can switch it on.' : `Test failed: ${d.reason ?? 'the samples did not come out as expected'}.`, !d.ok);
      });
    });

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        thDirty = false;
        tokensDirty = false;
        result.hidden = true;
        sync();
        if (st()) void host.send('packup.get', {}).then((r) => r.ok && host.book.upsert(r.data));
      },
      dispose: off,
    };
  };
}

/** The test's outcome: the core prompts (score, whether they came out as expected, the task they were cut to), then how
 * many of all the labelled prompts came out as expected at this threshold, each listed under a disclosure. */
function paintResult(root: HTMLElement, d: PackupTestAck): void {
  root.replaceChildren();
  const samples = Array.isArray(d.samples) ? d.samples : [];
  const rows = el('dl', 'settings-fu-samples');
  const verdict = (s: PackupTestAck['samples'][number]) => {
    const checked = s.extraction_tested ?? (s.core && s.expect === 'match');
    const label = checked
      ? (s.right ? 'Extraction verified' : `Failed: ${s.stage ?? 'extraction'}`)
      : (s.right ? 'Gate correct · extraction not tested' : 'Gate missed · extraction not tested');
    const b = el('span', 'settings-badge', label);
    b.dataset.state = s.right ? 'ready' : 'invalid';
    return b;
  };
  const score = (v: number) => el('span', 'settings-fu-score', Number.isFinite(v) ? v.toFixed(2) : '–');
  for (const s of samples.filter((x) => x.core)) {
    const dd = el('dd');
    dd.append(score(s.score), verdict(s));
    rows.append(el('dt', 'settings-pk-prompt', `“${s.text}”`), dd);
    if (s.expect === 'match') {
      const cut = el('dd', 'settings-fu-extracted');
      cut.append(el('span', 'settings-field-hint', s.matched ? `Sent as: “${s.task ?? ''}”` : `The LLM did not cut it (${s.error ?? 'no answer'}).`));
      rows.append(cut);
    }
  }
  const diagnostics = (s: PackupTestAck['samples'][number]) => {
    const used = usageText(s.diag, s.diag?.max_tokens ?? d.max_tokens ?? 600);
    const finish = s.diag?.finish_reason;
    return el('dd', 'settings-field-hint', `Classifier ${s.classifier_ms ?? 0} ms · extraction ${s.extraction_ms ?? 0} ms${finish ? ` · finish: ${finish}` : ''}${used ? ` · ${used}` : ''}${s.diag?.reasoning_effort ? ` · effort: ${s.diag.reasoning_effort}` : ''}${s.code ? ` · ${s.code}` : ''}`);
  };
  const all = el('details', 'settings-pk-all');
  const total = Number.isInteger(d.total) ? d.total : samples.length;
  const right = Number.isInteger(d.right) ? d.right : samples.filter((s) => s.right).length;
  all.append(el('summary', '', `${d.gate_right ?? right} of ${total} classifier scores as expected at ${Number(d.threshold).toFixed(2)}`));
  const list = el('dl', 'settings-fu-samples');
  for (const s of samples) {
    const dd = el('dd');
    dd.append(score(s.score), verdict(s));
    list.append(el('dt', 'settings-pk-prompt', s.text), dd, diagnostics(s));
    if (s.want_task !== undefined) list.append(el('dd', 'settings-field-hint', `Expected task: “${s.want_task}”`));
    if (s.error) list.append(el('dd', 'settings-field-hint', s.error));
  }
  all.append(list);
  const info = el('p', 'settings-field-hint', `Model: ${d.model ?? 'configured LLM'} · effort: ${d.reasoning_effort || 'endpoint / provider default'} · budget: ${d.max_tokens ?? 600} tokens · deadline: ${(d.timeout_ms ?? 1200) / 1000} s`);
  const counts = el('p', 'settings-field-hint', `${d.verified ?? samples.filter((s) => s.matched && s.right).length} of ${d.extractions ?? samples.filter((s) => s.extraction_tested ?? (s.core && s.expect === 'match')).length} attempted extractions verified. The four core samples must pass before enabling; other samples help calibration.`);
  root.append(info, counts, rows, all);
  root.hidden = false;
}
