import { h, icon } from './dom';

/** M6 start: the tabs on an empty desk's dialog (ui/hire.ts, ui/startRun.ts, #93 ui/hirePresets.ts). */

/** A clipboard with a tick: the orchestrator's tab and the top bar's Run. */
export const RUN_ICON = '<path d="M9 4.5h6v2.5H9z"/><path d="M15 5.5h2a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V7A1.5 1.5 0 0 1 7 5.5h2"/><path d="m9 13.5 2.2 2.2 4-4.4"/>';
const WORKER_ICON = '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.6-3.7 3.1-5.8 6.5-5.8s5.9 2.1 6.5 5.8"/>';
/** #93: a recipe card with a folded corner: a saved prompt and its model, used again. */
export const PRESET_ICON = '<path d="M6.5 3.5h8l3 3v14h-11z"/><path d="M14.5 3.5v3h3"/><path d="M9 11h6M9 14h6M9 17h3.5"/>';

export type DeskTab = 'worker' | 'orch' | 'preset';

const TABS: ReadonlyArray<{ t: DeskTab; text: string; paths: string }> = [
  { t: 'worker', text: 'Hire worker', paths: WORKER_ICON },
  { t: 'orch', text: 'Hire orchestrator', paths: RUN_ICON },
  { t: 'preset', text: 'Hire preset', paths: PRESET_ICON },
];

/**
 * The tabs on an empty desk's dialog: a worker (M4), an orchestrator (a run) or (#93) a hire preset, a worker with a
 * saved prompt and model. ← → move between the tabs that can be picked, like any tab list; `orchOff` disables the
 * orchestrator tab with its reason (false: no such tab). `preset` false leaves the preset tab out (a host without hire
 * presets).
 */
export function deskTabs(active: DeskTab, pick: (t: DeskTab) => void, orchOff: string | null | false, preset = false): HTMLElement {
  const shown = TABS.filter((x) => (x.t !== 'preset' || preset) && (x.t !== 'orch' || orchOff !== false));
  const off = (t: DeskTab) => (t === 'orch' && orchOff !== false ? orchOff : null);
  const tab = ({ t, text, paths }: (typeof TABS)[number]) => {
    const on = t === active;
    const why = off(t);
    return h(
      'button',
      {
        class: 'dd-tab',
        role: 'tab',
        'data-key': `tab:${t}`,
        'aria-selected': on ? 'true' : 'false',
        'aria-disabled': why ? 'true' : null,
        title: why,
        tabindex: on ? 0 : -1,
        onclick: () => !on && !why && pick(t),
      },
      icon(paths),
      h('span', {}, text),
    );
  };
  const list = h('div', { class: 'dd-tabs', role: 'tablist', 'aria-label': 'Who sits here' }, ...shown.map(tab));
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const usable = shown.filter((x) => x.t === active || !off(x.t)).map((x) => x.t);
    const i = usable.indexOf(active);
    const next = usable[(i + (e.key === 'ArrowRight' ? 1 : usable.length - 1)) % usable.length];
    if (next && next !== active) pick(next);
  });
  return list;
}
