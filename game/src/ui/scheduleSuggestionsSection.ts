import type { AiRole, AiRoleState, CommandArgs, CommandName, ScheduleSuggestionsState } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { AI_ROLE_NAME } from '../world/ai';
import { scheduleSuggestFailureText, type ScheduleSuggestionsBook } from '../world/scheduleSuggest';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the schedule suggestions section needs: the bridge's state, the commands, and the way to the AI section. */
export interface ScheduleSuggestionsSectionHost {
  book: ScheduleSuggestionsBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/** The privacy note, shown above the toggle. */
export const SCHEDULE_SUGGESTIONS_PRIVACY =
  'With schedule suggestions on, every agent’s final message goes to TypeSafe (the classification model), and to your chosen LLM endpoint when the classifier says a step has to wait, with the current time and your time zone. Only the final assistant message is sent, never the full transcript or tool output.';

const ROLE_STATE: Record<AiRoleState, string> = { ready: 'Ready', off: 'Not set up', incomplete: 'Unfinished', invalid: 'Paused' };

let serial = 0;

/**
 * #66: the “Schedule suggestions” section of the Settings window, under “AI integration” beside the follow-up
 * questions: its own switch (off by default), the threshold, what it needs (both models ready, each with why not,
 * linking to the AI section), the privacy note above the switch, and the zone the bridge reads clock times in. No test
 * gates the switch (docs/decisions.md); the bridge's environment can set it, and then it is read-only here.
 */
export function scheduleSuggestionsSection(host: ScheduleSuggestionsSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-ss-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'When an agent’s final message says a step has to wait (“24h soak, until 10:45 UTC tomorrow”), its reply offers to schedule a fresh agent for it. Nothing is scheduled until you save the schedule form.',
    );
    const missing = el('p', 'settings-field-hint', 'This bridge has no schedule suggestions. Update it to use this.');

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
    const toAi = el('button', 'btn btn--sm settings-fu-link', 'Set up in AI integration');
    toAi.type = 'button';
    toAi.addEventListener('click', () => host.showAi());
    needs.append(needsText, pills, toAi);

    const privacy = el('p', 'settings-fu-privacy', SCHEDULE_SUGGESTIONS_PRIVACY);
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Suggest schedules'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    const threshold = el('input');
    threshold.type = 'number';
    threshold.min = '0.05';
    threshold.max = '0.99';
    threshold.step = '0.05';
    threshold.inputMode = 'decimal';
    threshold.id = `${id}-th`;
    const thHint = el('p', 'settings-field-hint', 'How sure the classification model must be that a step has to wait (0.05–0.99). Default 0.70.');
    thHint.id = `${id}-th-hint`;
    threshold.setAttribute('aria-describedby', thHint.id);
    const thField = el('div', 'settings-field settings-field--short');
    const thLabel = el('label', 'settings-field-label', 'Threshold');
    thLabel.htmlFor = threshold.id;
    thField.append(thLabel, threshold, thHint);

    const zone = el('p', 'settings-field-hint settings-ss-zone');
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const controls = el('div', 'settings-fu');
    controls.append(needs, privacy, toggle, toggleHint, thField, zone, status);
    body.append(lede, missing, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    let thDirty = false;
    /** The switch's position while its schedule_suggestions.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = (): ScheduleSuggestionsState | null => host.book.state;
    const locked = () => st()?.env.includes('enabled') ?? false;

    const say = (text: string, error = false) => {
      note = text ? { text, error } : null;
      sync();
    };

    /** Why the switch cannot go on: the models that are not ready, each with its state. */
    const why = (s: ScheduleSuggestionsState): string => {
      const out = (s.missing ?? []).map((r) => `${AI_ROLE_NAME[r]}: ${ROLE_STATE[s.roles[r]].toLowerCase()}`);
      return `Unavailable until both models are ready (${out.join('; ')}). Set them up under AI integration.`;
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
      // Switching on needs both models; switching off never does. The environment's switch is not ours.
      box.disabled = busy || locked() || (!s.enabled && !allReady);
      toggleHint.textContent = locked()
        ? `Set by the bridge environment (HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED).${s.enabled && !allReady ? ` ${why(s)}` : ''}`
        : s.enabled
          ? s.state === 'ready'
            ? 'On: each agent’s final message is checked for a step that has to wait when its turn ends.'
            : `On, but paused: nothing is sent. ${why(s)}`
          : !allReady
            ? why(s)
            : 'Off: nothing is sent.';
      zone.textContent = s.zone ? `Times the agent gives without a zone are read in ${s.zone} (the zone a browser sent last).` : 'No time zone yet: times the agent gives without a zone are read as UTC.';
      if (!thDirty && document.activeElement !== threshold) threshold.value = s.threshold.toFixed(2);
      threshold.disabled = busy;
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
      void run(() => host.send('schedule_suggestions.set', { enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(scheduleSuggestFailureText(r.code, r.message), true);
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
      void run(() => host.send('schedule_suggestions.set', { threshold: Math.round(v * 100) / 100 })).then((r) => {
        thDirty = false;
        if (!r.ok) return say(scheduleSuggestFailureText(r.code, r.message), true);
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

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        thDirty = false;
        sync();
      },
      dispose: off,
    };
  };
}
