import type { AiRole, AiRoleState, CommandArgs, CommandName, PackupState, PackupTestAck } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { packupFailureText, type PackupBook } from '../world/packup';
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

    const test = button('Test');
    const actions = el('div', 'settings-fu-actions');
    actions.append(test);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const result = el('div', 'settings-fu-result');
    result.hidden = true;

    const controls = el('div', 'settings-fu');
    controls.append(needs, privacy, toggle, toggleHint, thField, actions, status, result);
    body.append(lede, missing, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    let thDirty = false;
    /** The switch's position while its packup.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = (): PackupState | null => host.book.state;
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
      box.disabled = busy || locked() || (!s.enabled && (!s.tested || !allReady));
      toggleHint.textContent = locked()
        ? `Set by the bridge environment (HERDR_WORLD_PACKUP_ENABLED).${s.enabled && !allReady ? ' Paused until both models are ready.' : ''}`
        : s.enabled
          ? s.state === 'ready'
            ? 'On: each prompt is checked before it goes (at most 1.5 s).'
            : 'On, but paused: a model is not ready. Nothing is sent until both are.'
          : !allReady
            ? 'Set up both models first.'
            : s.tested
              ? 'The test passed: you can switch it on.'
              : 'Run the test below first: it has to pass with the models in use.';
      if (!thDirty && document.activeElement !== threshold) threshold.value = s.threshold.toFixed(2);
      threshold.disabled = busy;
      test.disabled = busy || !allReady;
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
        result.hidden = true;
        sync();
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
    const b = el('span', 'settings-badge', s.right ? (s.expect === 'match' ? 'Caught, as expected' : 'Left alone, as expected') : s.expect === 'match' ? 'Missed: wrong' : 'Caught: wrong');
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
  const all = el('details', 'settings-pk-all');
  const total = Number.isInteger(d.total) ? d.total : samples.length;
  const right = Number.isInteger(d.right) ? d.right : samples.filter((s) => s.right).length;
  all.append(el('summary', '', `${right} of ${total} sample prompts as expected at ${Number(d.threshold).toFixed(2)}`));
  const list = el('dl', 'settings-fu-samples');
  for (const s of samples) {
    const dd = el('dd');
    dd.append(score(s.score), verdict(s));
    list.append(el('dt', 'settings-pk-prompt', s.text), dd);
  }
  all.append(list);
  root.append(rows, all);
  root.hidden = false;
}
