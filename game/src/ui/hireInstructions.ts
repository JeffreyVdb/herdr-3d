import './hirePresets.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, HirePresetCheckAck } from '../net/protocol';
import { h } from './dom';

/**
 * #117 / #127: the pieces a form with "Add herdr hiring instructions" and the classifier's question shares: the plain
 * Hire worker form (`ui/hire.ts`) and the schedule form (`ui/scheduleForm.ts`). The box, its hint and "What's added";
 * the question in the dialog by its buttons; the classifier's say (`hire_preset.check`).
 */

/** The hint of a form's box (one that is not a preset's): ticked, and not. */
export const INSTRUCTIONS_HINT_ON = 'Each agent this worker starts gets its own herdr workspace or tab, tagged with this floor.';
export const INSTRUCTIONS_HINT_OFF = 'Tick it if this task starts other agents: they get their own herdr workspace or tab on this floor.';

export interface InstructionsPanelOpts {
  /** The checkbox's id (its hint's is `${id}-hint`): unique in the document. */
  id: string;
  on: boolean;
  hint: string;
  /** "What's added" (shown while ticked): its intro, then the exact lines, or `missing` when they are not known now. */
  intro: string;
  lines: string | null;
  missing?: string;
  /** The byte count under the lines (the caller keeps it current while typing). */
  bytes?: HTMLElement | null;
  open: boolean;
  onChange(on: boolean): void;
  onToggle(open: boolean): void;
}

/** #95: the "Add herdr hiring instructions" box, its hint and, while ticked, the collapsed "What's added". */
export function instructionsPanel(o: InstructionsPanelOpts): HTMLElement {
  const box = h('input', { type: 'checkbox', id: o.id, 'data-key': 'instructions', 'aria-describedby': `${o.id}-hint` });
  box.checked = o.on;
  box.addEventListener('change', () => o.onChange(box.checked));
  const panel = h(
    'div',
    { class: 'dd-field dd-instructions', 'data-hook': 'instructions', 'data-on': o.on ? 'true' : 'false' },
    h('label', { class: 'dd-check', for: o.id }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Add herdr hiring instructions')),
    h('p', { class: 'field-hint dd-base', id: `${o.id}-hint` }, o.hint),
  );
  if (o.on) {
    const shown: Node[] =
      o.lines !== null
        ? [h('p', { class: 'field-hint dd-instructions-intro' }, o.intro), h('pre', {}, o.lines), ...(o.bytes ? [o.bytes] : [])]
        : [h('p', { class: 'field-hint dd-instructions-intro', 'data-hook': 'instructions-missing' }, o.missing ?? '')];
    const details = h('details', { class: 'dd-instructions-lines', 'data-hook': 'instructions-lines', open: o.open }, h('summary', { 'data-key': 'instructions-lines' }, 'What’s added'), ...shown);
    details.addEventListener('toggle', () => o.onToggle(details.open));
    panel.append(details);
  }
  return panel;
}

export interface AskCalloutOpts {
  /** Its `data-hook`. */
  hook: string;
  text: string;
  withText: string;
  withoutText: string;
  withoutTitle: string;
  answer(withLines: boolean): void;
}

/**
 * #117: the classifier's question, in the dialog by its buttons (with / without). The key held down since the press that
 * asked (Enter repeats) must not land on a button as an answer: only a fresh press does.
 */
export function askCallout(o: AskCalloutOpts): HTMLElement {
  const without = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'ask-without', title: o.withoutTitle, onclick: () => o.answer(false) }, o.withoutText);
  const withLines = h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': 'ask-with', onclick: () => o.answer(true) }, o.withText);
  for (const b of [without, withLines])
    b.addEventListener('keydown', (e) => {
      if (e.repeat) e.preventDefault();
    });
  return h('div', { class: 'dd-callout pp-confirm', role: 'alert', 'data-hook': o.hook }, h('p', {}, o.text), h('div', { class: 'pp-confirm-actions' }, without, withLines));
}

/**
 * #117: the classifier's say on a task (`classifierView` of the text the review saw): false for anything but a "yes" (a
 * refusal, a timeout, an older bridge's `unknown_command`). Never logged.
 */
export async function delegates(send: (t: 'hire_preset.check', args: CommandArgs['hire_preset.check']) => Promise<CommandResult>, prompt: string, secrets?: CommandArgs['hire_preset.check']['secrets']): Promise<boolean> {
  const r = await send('hire_preset.check', { prompt, ...(secrets ? { secrets } : {}) });
  return r.ok && (r.data as HirePresetCheckAck | undefined)?.delegates === true;
}
