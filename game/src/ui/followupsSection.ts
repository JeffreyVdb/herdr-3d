import type { AiRole, AiRoleState, CommandArgs, CommandName, FollowupsState, FollowupsTestAck, FollowupsTestSample } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { followupFailureText, type FollowupsBook } from '../world/followup';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the follow-up questions section needs: the bridge's state, the commands, and the way to the AI section. */
export interface FollowupsSectionHost {
  book: FollowupsBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/** The privacy note, shown above the toggle (#90 "Privacy note"). */
export const FOLLOWUPS_PRIVACY =
  'With follow-up questions on, every agent’s final message goes to TypeSafe (the classification model), and to your chosen LLM endpoint when the classifier says yes. Those messages can contain code, paths and internal details. Only the final assistant message is sent, never the full transcript or tool output. A self-hosted OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM) keeps the extraction step in-house.';

const ROLE_STATE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };
const SAMPLE_NAME: Record<FollowupsTestSample['name'], string> = { questions: 'Message with questions', grill: 'Grill round (10 questions)', done: 'Message without questions' };
const KIND_NAME: Record<string, string> = { yes_no: 'yes / no', choice: 'choice', open: 'open' };

let serial = 0;

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * #90: the “Follow-up questions” section of the Settings window, under “AI integration”: the feature's own switch
 * (off by default: setting up the models does not turn it on), the threshold, what it needs (both models ready,
 * linking to the AI section), the privacy note above the switch, and Test, which runs the sample messages (#60: a grill round too)
 * through the whole pipeline. The switch is off until a test passed with the models in use; the bridge's
 * environment can set it, and then it is read-only here.
 */
export function followupsSection(host: FollowupsSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-fu-${++serial}`;
    const lede = el('p', 'settings-lede', 'When an agent ends its turn with questions for you in its message (not in a question dialog), its desk says it needs you and its transcript view offers the questions to answer.');
    const missing = el('p', 'settings-field-hint', 'This bridge has no follow-up questions. Update it to use this.');

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

    const privacy = el('p', 'settings-fu-privacy', FOLLOWUPS_PRIVACY);
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Detect follow-up questions'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    const threshold = el('input');
    threshold.type = 'number';
    threshold.min = '0.05';
    threshold.max = '0.99';
    threshold.step = '0.05';
    threshold.inputMode = 'decimal';
    threshold.id = `${id}-th`;
    const thHint = el('p', 'settings-field-hint', 'How sure the classification model must be that the agent asks you something (0.05–0.99). Default 0.70.');
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
    /** The switch's position while its followups.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = (): FollowupsState | null => host.book.state;
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
        ? `Set by the bridge environment (HERDR_WORLD_FOLLOWUPS_ENABLED).${s.enabled && !allReady ? ' Paused until both models are ready.' : ''}`
        : s.enabled
          ? s.state === 'ready'
            ? 'On: each agent’s final message is checked when its turn ends.'
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
      void run(() => host.send('followups.set', { enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(followupFailureText(r.code, r.message), true);
        say(on ? 'On. Agents’ final messages are checked from now on.' : 'Off. Nothing is sent.');
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
      void run(() => host.send('followups.set', { threshold: Math.round(v * 100) / 100 })).then((r) => {
        thDirty = false;
        if (!r.ok) return say(followupFailureText(r.code, r.message), true);
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
      note = { text: 'Testing with the three sample messages…', error: false };
      result.hidden = true;
      void run(() => host.send('followups.test', {})).then((r) => {
        if (!r.ok) return say(followupFailureText(r.code, r.message), true);
        const d = r.data as FollowupsTestAck;
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

/** The test's outcome: each sample's score and whether it came out as expected, and the questions extracted. */
function paintResult(root: HTMLElement, d: FollowupsTestAck): void {
  root.replaceChildren();
  const rows = el('dl', 'settings-fu-samples');
  for (const s of Array.isArray(d.samples) ? d.samples : []) {
    const expected = s.expect === 'flag' ? s.flagged && s.source === 'model' : !s.flagged;
    const dt = el('dt', '', SAMPLE_NAME[s.name] ?? s.name);
    const dd = el('dd');
    const score = el('span', 'settings-fu-score', Number.isFinite(s.score) ? s.score.toFixed(2) : '–');
    const verdict = el('span', 'settings-badge', expected ? (s.flagged ? 'Flagged, as expected' : 'Not flagged, as expected') : s.flagged ? 'Flagged: wrong' : 'Not flagged: wrong');
    verdict.dataset.state = expected ? 'ready' : 'invalid';
    dd.append(score, verdict);
    rows.append(dt, dd);
    if (s.name === 'grill' && s.flagged) {
      // #60: ten questions are too many to list here; what counts is that all came back with their recommendations.
      const n = s.questions?.length ?? 0;
      const recs = s.questions?.filter((q) => q.recommendation?.text).length ?? 0;
      const text = s.source === 'fallback' ? `The LLM did not read it (${s.error ?? 'no answer'}).` : `The LLM listed ${n} of its 10 questions, ${recs} with the agent’s recommendation.`;
      rows.append(el('dd', 'settings-fu-extracted settings-field-hint settings-fu-grill', text));
      continue;
    }
    if (s.questions?.length) {
      const list = el('ol', 'settings-fu-questions');
      for (const q of s.questions) {
        const li = el('li', '', q.question);
        li.append(el('span', 'settings-fu-kind', q.kind === 'choice' && q.options?.length ? `choice: ${q.options.join(' / ')}` : (KIND_NAME[q.kind] ?? q.kind)));
        list.append(li);
      }
      const qd = el('dd', 'settings-fu-extracted');
      qd.append(el('span', 'settings-field-hint', s.source === 'fallback' ? `The LLM did not list them (${s.error ?? 'no answer'}): one open item stands in.` : 'The LLM extracted:'), list);
      rows.append(qd);
    }
  }
  root.append(rows);
  root.hidden = false;
}
