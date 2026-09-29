import { h, icon } from './dom';

/** M6 start: the tabs on an empty desk's dialog (ui/hire.ts, ui/startRun.ts). */

/** A clipboard with a tick: the orchestrator's tab and the top bar's Run. */
export const RUN_ICON = '<path d="M9 4.5h6v2.5H9z"/><path d="M15 5.5h2a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V7A1.5 1.5 0 0 1 7 5.5h2"/><path d="m9 13.5 2.2 2.2 4-4.4"/>';
const WORKER_ICON = '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.6-3.7 3.1-5.8 6.5-5.8s5.9 2.1 6.5 5.8"/>';
/**
 * The two tabs on an empty desk's dialog: a worker (M4) or an orchestrator
 * (a run). ← → move between them, like any tab list; `orchOff` disables the
 * orchestrator tab with its reason.
 */
export function deskTabs(active: 'worker' | 'orch', pick: (t: 'worker' | 'orch') => void, orchOff: string | null): HTMLElement {
  const tab = (t: 'worker' | 'orch', text: string, paths: string, off: string | null) => {
    const on = t === active;
    const b = h(
      'button',
      {
        class: 'dd-tab',
        role: 'tab',
        'data-key': `tab:${t}`,
        'aria-selected': on ? 'true' : 'false',
        'aria-disabled': off ? 'true' : null,
        title: off,
        tabindex: on ? 0 : -1,
        onclick: () => !on && !off && pick(t),
      },
      icon(paths),
      h('span', {}, text),
    );
    return b;
  };
  const list = h('div', { class: 'dd-tabs', role: 'tablist', 'aria-label': 'Who sits here' }, tab('worker', 'Hire worker', WORKER_ICON, null), tab('orch', 'Hire orchestrator', RUN_ICON, orchOff));
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const other = active === 'worker' ? 'orch' : 'worker';
    if (other === 'orch' && orchOff) return;
    pick(other);
  });
  return list;
}

