import { h, icon } from './dom';

/** M6 start: the tabs on an empty desk's dialog (ui/hire.ts, ui/startRun.ts, #93 ui/hirePresets.ts). */

/** A clipboard with a tick: the orchestrator's tab and the top bar's Run. */
export const RUN_ICON = '<path d="M9 4.5h6v2.5H9z"/><path d="M15 5.5h2a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V7A1.5 1.5 0 0 1 7 5.5h2"/><path d="m9 13.5 2.2 2.2 4-4.4"/>';
const WORKER_ICON = '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.6-3.7 3.1-5.8 6.5-5.8s5.9 2.1 6.5 5.8"/>';
/** #93: a recipe card with a folded corner: a saved prompt and its model, used again. */
export const PRESET_ICON = '<path d="M6.5 3.5h8l3 3v14h-11z"/><path d="M14.5 3.5v3h3"/><path d="M9 11h6M9 14h6M9 17h3.5"/>';
/** A push pin: a hire preset pinned to the desk dialogs' tab bar. */
export const PIN_ICON = '<path d="M9 3.5h6l-1 6 3.5 3.5v1.5h-11V13L10 9.5z"/><path d="M12 14.5v6"/>';

/** A desk tab; `pin:<id>` is a hire preset pinned to the tab bar (ui/hirePins.ts). */
export type DeskTab = 'worker' | 'orch' | 'preset' | `pin:${string}`;

/** A pinned preset's tab. */
export const pinTab = (id: string): DeskTab => `pin:${id}`;
/** The preset id of a pinned preset's tab (null: a fixed tab). */
export const pinIdOf = (t: DeskTab): string | null => (t.startsWith('pin:') ? t.slice('pin:'.length) : null);

/** A pinned hire preset as its tab shows it: `title` its tooltip (the choice it hires with). */
export interface PinnedTab {
  id: string;
  name: string;
  title: string;
}

/** The pinned presets a tab bar shows, in order; `move` (absent: fixed order) puts one at place `to` among them. */
export interface DeskPins {
  list: readonly PinnedTab[];
  move?(id: string, to: number): void;
}

const TABS: ReadonlyArray<{ t: DeskTab; text: string; paths: string }> = [
  { t: 'worker', text: 'Hire worker', paths: WORKER_ICON },
  { t: 'orch', text: 'Hire orchestrator', paths: RUN_ICON },
  { t: 'preset', text: 'Hire preset', paths: PRESET_ICON },
];

/**
 * The tabs on an empty desk's dialog: a worker (M4), an orchestrator (a run) or (#93) a hire preset, a worker with a
 * saved prompt and model. ← → move between the tabs that can be picked, like any tab list; `orchOff` disables the
 * orchestrator tab with its reason (false: no such tab). `preset` false leaves the preset tab out (a host without hire
 * presets), and the pins with it. `pins`: the presets pinned to the bar, after the fixed tabs; picking one hires with it.
 * With `pins.move`, a pin is dragged to another place among them, or moved by Shift+← / Shift+→ while focused (focus
 * follows it into the redrawn bar).
 */
export function deskTabs(active: DeskTab, pick: (t: DeskTab) => void, orchOff: string | null | false, preset = false, pins?: DeskPins): HTMLElement {
  const fixed = TABS.filter((x) => (x.t !== 'preset' || preset) && (x.t !== 'orch' || orchOff !== false));
  const pinned = preset ? (pins?.list ?? []) : [];
  const shown: DeskTab[] = [...fixed.map((x) => x.t), ...pinned.map((p) => pinTab(p.id))];
  const off = (t: DeskTab) => (t === 'orch' && orchOff !== false ? orchOff : null);
  const tab = (t: DeskTab, text: string, paths: string, title: string | null, cls = 'dd-tab') => {
    const on = t === active;
    const why = off(t);
    return h(
      'button',
      {
        class: cls,
        role: 'tab',
        'data-key': `tab:${t}`,
        'aria-selected': on ? 'true' : 'false',
        'aria-disabled': why ? 'true' : null,
        title: why ?? title,
        tabindex: on ? 0 : -1,
        onclick: () => !on && !why && pick(t),
      },
      icon(paths),
      h('span', {}, text),
    );
  };
  const list = h(
    'div',
    { class: 'dd-tabs', role: 'tablist', 'aria-label': 'Who sits here' },
    ...fixed.map((x) => tab(x.t, x.text, x.paths, null)),
    // Between the fixed tabs and the pins: a divider, or on a phone the start of the pins' own row.
    pinned.length ? h('span', { class: 'dd-tabs-break', role: 'presentation' }) : null,
    ...pinned.map((p) => tab(pinTab(p.id), p.name, PIN_ICON, p.title, 'dd-tab dd-tab--pin')),
  );
  const ids = pinned.map((p) => p.id);
  const pinOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>('[data-key^="tab:pin:"]') : null);
  const idOf = (el: HTMLElement) => pinIdOf((el.dataset.key ?? '').slice('tab:'.length) as DeskTab) ?? '';
  if (pins?.move && ids.length > 1) dragPins(list, ids, pinOf, idOf, pins.move);
  // Nothing selected yet (a pinned preset's tab, then unpinned): the first tab is the one Tab reaches.
  if (!shown.includes(active)) list.querySelector<HTMLElement>('[role="tab"]')?.setAttribute('tabindex', '0');
  list.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) {
      const at = pinOf(e.target);
      if (!at || !pins?.move) return;
      e.preventDefault();
      const key = at.dataset.key ?? '';
      // The bar is redrawn by the move: focus goes to the same tab in the new one.
      const scope: ParentNode = list.closest('dialog') ?? list.ownerDocument;
      const id = idOf(at);
      pins.move(id, ids.indexOf(id) + dir);
      (scope.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? at).focus();
      return;
    }
    e.preventDefault();
    const usable = shown.filter((t) => t === active || !off(t));
    const i = usable.indexOf(active);
    const next = i < 0 ? usable[dir > 0 ? 0 : usable.length - 1] : usable[(i + dir + usable.length) % usable.length];
    if (next && next !== active) pick(next);
  });
  return list;
}

/**
 * Dragging a pin to another place among the pins: the tab under the pointer shows where it lands (`data-drop` before or
 * after it, by the pointer's side of its middle), and the drop calls `move` with the place counted without the dragged
 * one. Only pins take part: the fixed tabs stay where they are.
 */
function dragPins(list: HTMLElement, ids: readonly string[], pinOf: (el: EventTarget | null) => HTMLElement | null, idOf: (el: HTMLElement) => string, move: (id: string, to: number) => void): void {
  let dragged: string | null = null;
  const clear = () => list.querySelectorAll('[data-drop]').forEach((el) => el.removeAttribute('data-drop'));
  /** The place `dragged` lands at for the pointer over `over`, null when none (itself, or not a pin). */
  const landing = (e: MouseEvent, over: HTMLElement): { side: 'before' | 'after'; to: number } | null => {
    const from = dragged === null ? -1 : ids.indexOf(dragged);
    const at = ids.indexOf(idOf(over));
    if (from < 0 || at < 0 || at === from) return null;
    const r = over.getBoundingClientRect();
    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
    const ins = at + (side === 'after' ? 1 : 0);
    return { side, to: ins > from ? ins - 1 : ins };
  };
  for (const el of list.querySelectorAll<HTMLElement>('[data-key^="tab:pin:"]')) el.draggable = true;
  list.addEventListener('dragstart', (e) => {
    const at = pinOf(e.target);
    if (!at) return;
    dragged = idOf(at);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', at.textContent ?? '');
    }
  });
  list.addEventListener('dragover', (e) => {
    const over = pinOf(e.target);
    const l = over && landing(e, over);
    clear();
    if (!over || !l) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    over.dataset.drop = l.side;
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget as Node | null)) clear();
  });
  list.addEventListener('drop', (e) => {
    const over = pinOf(e.target);
    const l = over && landing(e, over);
    const id = dragged;
    clear();
    dragged = null;
    if (!l || id === null) return;
    e.preventDefault();
    move(id, l.to);
  });
  list.addEventListener('dragend', () => {
    dragged = null;
    clear();
  });
}
