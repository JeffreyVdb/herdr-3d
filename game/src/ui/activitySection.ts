import type { ActivityFeatureState, ActivityState, AiRoleState, CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { ACTIVITY_LIMITS, activityFailureText, type ActivitySettingsBook } from '../world/activitySettings';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Classify unknown commands” section needs: the bridge's state, the commands, and the way to the AI section. */
export interface ActivitySectionHost {
  book: ActivitySettingsBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Brings the AI integration section into view. */
  showAi(): void;
}

/** The privacy note, shown above the switch (#98 "Privacy note"). */
export const ACTIVITY_PRIVACY =
  'The rules run on the bridge and send nothing. With this on, the text of shell commands the rules can’t place goes to TypeSafe (the classification model). It is normalised and scrubbed of keys first, but can still contain paths, hostnames or script names. Tool output is never sent, and setting up the AI integration alone sends nothing.';

/** The classifier's state, as the AI section's tag says it, in a sentence. */
const ROLE_STATE: Record<AiRoleState, string> = { ready: 'ready', off: 'not set up', incomplete: 'unfinished', invalid: 'paused' };
const STATE_TAG: Record<ActivityFeatureState, string> = { off: 'Off', incomplete: 'Waiting', ready: 'Ready', capped: 'Capped' };
/** The tag's colour, in the AI section's badge states. */
const STATE_TONE: Record<ActivityFeatureState, string> = { off: 'off', incomplete: 'incomplete', ready: 'ready', capped: 'invalid' };
/** Share of the cap from which the ledger's bar warns. */
const NEAR_CAP = 0.8;

type NumberField = 'threshold' | 'margin' | 'daily_cap';

const NAME: Record<NumberField, string> = { threshold: 'Threshold', margin: 'Margin', daily_cap: 'Daily cap' };

let serial = 0;

const figures = (n: number) => n.toLocaleString('en-US');
const shown = (f: NumberField, v: number) => (f === 'daily_cap' ? String(Math.round(v)) : v.toFixed(2));

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * #98: the “Classify unknown commands” section of the Settings window, under “AI integration” and “Follow-up
 * questions”. The desk monitors say what each agent is doing from rules on the bridge; this switch (off by default:
 * setting up the models does not turn it on) lets the classification model name the commands the rules can't place.
 * The privacy note sits above the switch; under it the feature's state (with the way to the AI section while the
 * classifier is not ready), today's calls against the cap and the commands remembered, then the threshold, the
 * margin and the daily cap. The bridge's environment can set the switch, and then it is read-only here. A bridge
 * without the feature has no section at all.
 */
export function activitySection(host: ActivitySectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-act-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'Desk monitors say what each agent is doing (Testing, Writing, Investigating…) from rules that run on the bridge. A command the rules can’t place reads Working; with this on, the classification model names it.',
    );

    const privacy = el('p', 'settings-act-privacy', ACTIVITY_PRIVACY);
    privacy.id = `${id}-privacy`;

    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint ${id}-state`);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Classify unknown commands'));
    const toggleHint = el('p', 'settings-field-hint');
    toggleHint.id = `${id}-on-hint`;

    // The feature's state: a tag, what it means, and the way to the AI section while the classifier is not ready.
    const stateRow = el('div', 'settings-act-state');
    stateRow.id = `${id}-state`;
    const tag = el('span', 'settings-badge');
    const stateText = el('p', 'settings-act-state-text');
    const toAi = button('Set up in AI integration', 'btn btn--sm settings-act-link');
    toAi.addEventListener('click', () => host.showAi());
    stateRow.append(tag, stateText, toAi);

    // Today's calls against the cap (a bar that warns near it) and the commands remembered.
    const ledger = el('dl', 'settings-act-ledger');
    const callsTerm = el('dt', '', 'Calls today');
    const callsValue = el('dd', 'settings-act-figure');
    const bar = el('div', 'settings-act-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'settings-act-fill');
    bar.append(fill);
    const cacheTerm = el('dt', '', 'Commands remembered');
    const cacheValue = el('dd', 'settings-act-figure');
    ledger.append(callsTerm, callsValue, bar, cacheTerm, cacheValue);

    // The three numbers, side by side; one hint says what they do together.
    const tuneHint = el(
      'p',
      'settings-field-hint',
      'The model’s word is used only when its score reaches the threshold and beats the runner-up by the margin; otherwise the monitor says Working. Over the daily cap, rules only until tomorrow. Defaults 0.60, 0.20 and 2,000.',
    );
    tuneHint.id = `${id}-tune-hint`;
    const tune = el('div', 'settings-act-tune');
    const inputs = {} as Record<NumberField, HTMLInputElement>;
    const dirty: Record<NumberField, boolean> = { threshold: false, margin: false, daily_cap: false };
    for (const f of ['threshold', 'margin', 'daily_cap'] as const) {
      const lim = ACTIVITY_LIMITS[f];
      const input = el('input');
      input.type = 'number';
      input.id = `${id}-${f}`;
      input.min = String(lim.min);
      input.max = String(lim.max);
      input.step = f === 'daily_cap' ? '100' : '0.05';
      input.inputMode = f === 'daily_cap' ? 'numeric' : 'decimal';
      const range = el('p', 'settings-field-hint', f === 'daily_cap' ? 'calls a day' : `${lim.min.toFixed(2)}–${lim.max.toFixed(2)}`);
      range.id = `${id}-${f}-hint`;
      input.setAttribute('aria-describedby', `${range.id} ${tuneHint.id}`);
      const label = el('label', 'settings-field-label', NAME[f]);
      label.htmlFor = input.id;
      const field = el('div', 'settings-field');
      field.append(label, input, range);
      tune.append(field);
      inputs[f] = input;
    }

    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const controls = el('div', 'settings-act');
    controls.append(privacy, toggle, toggleHint, stateRow, ledger, tune, tuneHint, status);
    body.append(lede, controls);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    /** The switch's position while its activity.set is on its way (null: the bridge's). */
    let wanted: boolean | null = null;

    const st = (): ActivityState | null => host.book.state;
    /** A field the bridge's environment sets (the switch: HERDR_WORLD_ACTIVITY_MODEL) is read-only here. */
    const locked = (f: 'model_enabled' | NumberField) => st()?.env.includes(f) ?? false;

    const say = (text: string, error = false) => {
      note = text ? { text, error } : null;
      sync();
    };

    function sync(): void {
      const s = st();
      section.setHidden(!s);
      if (!s) return;
      box.checked = wanted ?? s.model_enabled;
      box.disabled = busy || locked('model_enabled');
      toggleHint.hidden = !locked('model_enabled');
      toggleHint.textContent = locked('model_enabled') ? 'Set by the bridge environment (HERDR_WORLD_ACTIVITY_MODEL): read-only here.' : '';

      tag.textContent = STATE_TAG[s.state];
      tag.dataset.state = STATE_TONE[s.state];
      stateRow.dataset.state = s.state;
      const waiting = s.state === 'incomplete';
      stateText.textContent = waiting
        ? `Needs the classification model, which is ${ROLE_STATE[s.classifier]}. Nothing is sent until it is ready.`
        : s.state === 'ready'
          ? 'Commands the rules can’t place are classified, each one once.'
          : s.state === 'capped'
            ? 'Daily cap reached, rules only today.'
            : 'Rules only. Nothing is sent.';
      stateRow.dataset.classifier = s.classifier;
      toAi.hidden = !waiting;

      callsValue.textContent = `${figures(s.calls_today)} of ${figures(s.daily_cap)}`;
      const share = s.daily_cap > 0 ? Math.min(1, s.calls_today / s.daily_cap) : 0;
      fill.style.transform = `scaleX(${share.toFixed(3)})`;
      bar.dataset.level = s.state === 'capped' || share >= 1 ? 'full' : share >= NEAR_CAP ? 'near' : 'ok';
      cacheValue.textContent = figures(s.cache_size);

      for (const f of ['threshold', 'margin', 'daily_cap'] as const) {
        const input = inputs[f];
        if (!dirty[f] && document.activeElement !== input) input.value = shown(f, s[f]);
        input.disabled = busy || locked(f);
      }
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
      void run(() => host.send('activity.set', { model_enabled: on })).then((r) => {
        wanted = null;
        if (!r.ok) return say(activityFailureText(r.code, r.message), true);
        const s = st();
        say(!on ? 'Off. Nothing is sent.' : s?.state === 'incomplete' ? 'On. Nothing is sent until the classification model is ready.' : 'On. Unknown commands are classified from now on.');
      });
    });

    const commit = (f: NumberField) => {
      if (!dirty[f]) return;
      const input = inputs[f];
      const lim = ACTIVITY_LIMITS[f];
      const raw = input.value.trim();
      const v = Number(raw);
      const ok = raw !== '' && Number.isFinite(v) && v >= lim.min && v <= lim.max && (f !== 'daily_cap' || Number.isInteger(v));
      if (!ok) {
        input.setAttribute('aria-invalid', 'true');
        return say(
          f === 'daily_cap'
            ? `The daily cap must be a whole number of calls from ${figures(lim.min)} to ${figures(lim.max)}.`
            : `The ${NAME[f].toLowerCase()} must be between ${lim.min.toFixed(2)} and ${lim.max.toFixed(2)}.`,
          true,
        );
      }
      input.setAttribute('aria-invalid', 'false');
      const value = f === 'daily_cap' ? v : Math.round(v * 100) / 100;
      // Sent once: the change event after an Enter finds nothing to send.
      dirty[f] = false;
      void run(() => host.send('activity.set', { [f]: value })).then((r) => {
        if (!r.ok) return say(activityFailureText(r.code, r.message), true);
        say(`${NAME[f]} saved: ${f === 'daily_cap' ? figures(value) : value.toFixed(2)}.`);
      });
    };
    for (const f of ['threshold', 'margin', 'daily_cap'] as const) {
      const input = inputs[f];
      input.addEventListener('input', () => (dirty[f] = true));
      input.addEventListener('change', () => commit(f));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(f);
        }
      });
    }

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        for (const f of ['threshold', 'margin', 'daily_cap'] as const) {
          dirty[f] = false;
          inputs[f].removeAttribute('aria-invalid');
        }
        sync();
        // The calls and the cache move without telling: read them again as the window opens.
        if (st()) void host.send('activity.get', {}).then((r) => r.ok && host.book.upsert(r.data));
      },
      dispose: off,
    };
  };
}
