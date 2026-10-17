import type { BridgeBook, BridgeEntry } from '../net/bridges';
import { taskPreview } from '../world/hireReview';
import { bridgeList, bridgeRow, filterCommands, floorList, floorRow, floorsNeedingYou, heldList, needsFloorPick, otherBridges, parseQuery, type BridgeItem, type BridgeRow, type CommandMatch, type FloorItem, type FloorRow, type FloorSource, type HeldReview, type HeldRow, type PaletteCommand } from '../world/palette';
import { bridgeDot, bridgeStateText } from './bridgeState';
import { backdropPolicy } from './dismiss';
import { h } from './dom';
import { listKey, paintActiveRow, wrapIndex } from './listbox';
import './credits.css';
import './palette.css';

/**
 * #147: the command palette (⌘/Ctrl+P). A modal `<dialog>` with one text field and a listbox under it: plain text
 * searches the commands, a leading `@` lists the floors with their worker counts. The field keeps the keyboard and says
 * which row is active (`role=combobox`, `aria-activedescendant`), the way the composer's suggestion list does, and the
 * keys come from the same module (`listKey`): ↑ ↓ move and wrap, Enter picks, Esc closes. The chord again closes it
 * too (the game's capture-phase listener asks `close`). Esc, and a pick that opens nothing, put the keyboard back where
 * it was (the seat's input, a dialog's field, the canvas); a pick that runs something leaves it to what it opened.
 *
 * What is listed is `world/palette.ts`'s. The floor order is fixed when the list opens and when the query changes; the
 * counts on its rows are read again on `refresh` (the game's world events) and only they change, so a row never moves
 * under the cursor. A floor that goes drops out; one that appears waits for the next query. A floor-scoped command
 * chosen off an office floor ("Hire") turns the list into the floor list under the question it asks ("Hire on which
 * floor?"); the pick runs it there. Without a connection the floor rows are greyed and cannot be picked; commands run.
 *
 * #57: Switch bridge turns the list into the helper's other bridges ("Switch to which bridge?"), the text filtering them
 * by name. Their order is fixed like the floors' and their dots are read again whenever the list is (every two seconds
 * while it shows; the helper answers from what it last saw, so opening it never waits on ssh). Enter switches. With no
 * other bridge, one row says so and opens Settings → Bridges.
 *
 * #33: a dictated hire's review held after its background hire was refused or got no answer heads the commands, one row
 * each ("Review again: Desk 15 of pastry", the outcome, the task's first words), only while it is held; Enter opens it.
 */

export interface PaletteHost {
  /** The commands of the scopes live now. */
  commands(): PaletteCommand[];
  store: FloorSource;
  /** The floor id of the office floor you are on, else null. */
  here(): string | null;
  /** The bridge answers: floors can be reached. */
  online(): boolean;
  /** The palette is closed: run `command` (`floor`: the floor picked for it, or null for the one you are on). */
  run(command: PaletteCommand, floor: string | null): void;
  /** The palette is closed: take the user to another floor. */
  goTo(floor: string): void;
  /** #57: the helper's bridges (absent: no Switch bridge). */
  bridges?: PaletteBridges;
  /** #33: the held reviews of dictated hires (absent: none). */
  held?: PaletteHeld;
}

export interface PaletteHeld {
  list(): HeldReview[];
  /** The palette is closed: open held review `id` again. */
  review(id: string): void;
}

export interface PaletteBridges {
  book: BridgeBook;
  /** The palette is closed: switch to `b` (the game asks first when it is offline). */
  switchTo(b: BridgeEntry): void;
  /** The palette is closed: Settings → Bridges. */
  openSettings(): void;
}

type Row = { key: string; el: HTMLElement; enabled: boolean; act(): void };

const CHIPS: ReadonlyArray<{ kind: 'needs_you' | 'working' | 'waiting' | 'idle' | 'done'; word: string; n(c: FloorRow['counts']): number }> = [
  { kind: 'needs_you', word: 'need you', n: (c) => c.needsYou },
  { kind: 'working', word: 'working', n: (c) => c.working },
  { kind: 'waiting', word: 'waiting', n: (c) => c.waiting },
  { kind: 'idle', word: 'idle', n: (c) => c.idle - c.done },
  { kind: 'done', word: 'done', n: (c) => c.done },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `text` with the characters at `hits` marked. */
function marked(cls: string, text: string, hits: readonly number[]): HTMLElement {
  const el = h('span', { class: cls });
  const at = new Set(hits);
  let run = '';
  let on = false;
  const flush = () => {
    if (run) el.append(on ? h('span', { class: 'pal-hit' }, run) : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (at.has(i) !== on) {
      flush();
      on = !on;
    }
    run += text[i];
  }
  flush();
  return el;
}

export class Palette {
  private readonly dialog = h('dialog', { class: 'credits palette', 'aria-label': 'Command palette' });
  private readonly title = h('p', { class: 'pal-title', hidden: true });
  private readonly input = h('input', {
    class: 'pal-input',
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'true',
    'aria-haspopup': 'listbox',
    'aria-controls': 'palette-list',
    'aria-label': 'Command palette',
    placeholder: 'Type a command, or @ for floors',
  });
  private readonly list = h('ul', { class: 'pal-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Commands' });
  private readonly status = h('p', { class: 'pal-status', hidden: true });
  private readonly note = h('p', { class: 'pal-note', hidden: true });
  private readonly hint = h('button', { class: 'pal-hint', tabindex: '-1', hidden: true, onclick: () => this.setText('@') });
  private readonly said = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  private opener: HTMLElement | null = null;
  private commands: PaletteCommand[] = [];
  private matches: CommandMatch[] = [];
  private floors: FloorItem[] = [];
  /** #33: the held reviews when it opened, and the ones the query matches. */
  private held: HeldReview[] = [];
  private heldRows: HeldRow[] = [];
  private pick: PaletteCommand | null = null;
  /** #57: listing bridges (after Switch bridge), their fixed order, and the poll that keeps their dots live. */
  private bridgeMode = false;
  private bridgeItems: BridgeItem[] = [];
  private stopBridges: (() => void) | null = null;
  private offBridges: (() => void) | null = null;
  private rows: Row[] = [];
  private active = '';
  private shown = '';
  private told = '';

  constructor(
    parent: HTMLElement,
    private readonly host: PaletteHost,
  ) {
    const foot = h(
      'footer',
      { class: 'pal-foot' },
      this.hint,
      h('span', { class: 'pal-keys', 'aria-hidden': 'true' }, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' choose · ', h('kbd', {}, 'Enter'), ' run · ', h('kbd', {}, 'Esc'), ' close'),
    );
    this.dialog.append(h('div', { class: 'pal-head' }, this.title, this.input), this.list, this.status, this.note, foot, this.said);
    this.input.addEventListener('input', () => this.query());
    this.input.addEventListener('keydown', (e) => this.key(e));
    // What is pressed here is the palette's: the game, the whiteboard and the dialog under it must not see it.
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    // A press on a row keeps the focus in the field.
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const i = this.rowAt(e.target);
      const row = this.rows[i];
      if (row?.enabled) row.act();
    });
    this.list.addEventListener('mousemove', (e) => {
      const row = this.rows[this.rowAt(e.target)];
      if (row?.enabled && row.key !== this.active) {
        this.active = row.key;
        this.paintActive();
      }
    });
    this.dialog.addEventListener('close', () => this.closed());
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opens it (`from`: where the keyboard goes back to). Open already: nothing. */
  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from;
    this.commands = this.host.commands();
    this.held = this.host.held?.list() ?? [];
    this.pick = null;
    this.bridgeMode = false;
    this.input.value = '';
    this.active = '';
    this.shown = '';
    this.told = '';
    this.dialog.showModal();
    this.query();
    this.input.focus();
  }

  /** Closes it; the keyboard goes back to where it was unless `restore` is false (something else is taking it). */
  close(restore = true): void {
    if (!this.dialog.open) return;
    if (!restore) this.opener = null;
    this.dialog.close();
  }

  dispose(): void {
    this.close(false);
    this.dialog.remove();
  }

  /** The world changed: the counts of the listed floors, and the hint, are read again. Order and rows stay. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (this.floorsMode()) this.draw(false);
    this.drawHint();
  }

  /** Types into the field, as the user would (the hint's click, and the tests). */
  setText(text: string): void {
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this.input.focus();
    this.query();
  }

  // ---- the list ------------------------------------------------------------------------------

  private floorsMode(): boolean {
    return this.q().mode === 'floors';
  }

  private q() {
    return parseQuery(this.input.value, this.bridgeMode);
  }

  /** The query changed (or the palette opened): the order is made again. */
  private query(): void {
    const q = this.q();
    if (q.mode === 'commands') {
      this.pick = null;
      this.matches = filterCommands(this.commands, q.query);
      this.heldRows = heldList(this.held, q.query);
    } else if (q.mode === 'bridges') this.bridgeItems = bridgeList(this.host.bridges?.book.list ?? null, q.query);
    else this.floors = floorList(this.host.store, q.query);
    this.draw(true);
    const question = q.mode === 'bridges' ? 'Switch to which bridge?' : (this.pick?.pick ?? '');
    this.input.placeholder = q.mode === 'bridges' ? 'Filter the bridges' : this.pick ? 'Filter the floors' : 'Type a command, or @ for floors';
    this.input.setAttribute('aria-label', question || 'Command palette');
    this.list.setAttribute('aria-label', q.mode === 'floors' ? 'Floors' : q.mode === 'bridges' ? 'Bridges' : 'Commands');
    this.title.hidden = !question;
    this.title.textContent = question;
    this.drawHint();
  }

  /** Rows from the listed order and the live counts. `fresh`: a new list (the active row restarts at the top). */
  private draw(fresh: boolean): void {
    const q = this.q();
    const rows: Row[] = [];
    let empty = '';
    let note = '';
    if (q.mode === 'commands') {
      for (const r of this.heldRows) rows.push(this.heldRow(r));
      for (const m of this.matches) rows.push(this.commandRow(m));
      if (rows.length === 0) empty = `No command matches “${q.query}”.`;
    } else if (q.mode === 'bridges') {
      const list = this.host.bridges?.book.list ?? null;
      for (const item of this.bridgeItems) {
        const b = bridgeRow(list, item);
        if (b) rows.push(this.bridgeRow(b));
      }
      if (rows.length === 0 && otherBridges(list) === 0) rows.push(this.noBridgesRow());
      else if (rows.length === 0) empty = `No bridge matches “${q.query}”.`;
    } else {
      const online = this.host.online();
      const here = this.host.here();
      for (const item of this.floors) {
        const f = floorRow(this.host.store, item, here);
        if (f) rows.push(this.floorRow(f, online));
      }
      if (rows.length === 0) empty = this.floors.length === 0 && q.query === '' ? 'No floors yet. Start herdr in a session and it shows up here.' : `No floor matches “${q.query}”.`;
      if (!online && rows.length > 0) note = 'Not connected to herdr-world: floors cannot be reached right now. Commands still run.';
    }
    // The same rows as before (a refresh with no change): leave the DOM alone.
    const sig = `${q.mode}|${this.pick?.id ?? ''}|${rows.map((r) => `${r.key}:${r.el.dataset.sig ?? ''}:${r.enabled}`).join(',')}|${empty}|${note}`;
    if (!fresh && sig === this.shown) return;
    this.shown = sig;
    const keep = !fresh && rows.some((r) => r.key === this.active);
    this.rows = rows;
    this.list.replaceChildren(...rows.map((r, i) => (r.el.id = `palette-opt-${i}`, r.el)));
    if (!keep) this.active = rows.find((r) => r.enabled)?.key ?? '';
    this.status.textContent = empty;
    this.status.hidden = empty === '';
    this.note.textContent = note;
    this.note.hidden = note === '';
    this.paintActive();
    if (fresh) this.announce(empty || plural(rows.length, q.mode === 'floors' ? 'floor' : q.mode === 'bridges' ? 'bridge' : 'command'));
  }

  private commandRow(m: CommandMatch): Row {
    const c = m.command;
    const caps = c.caps.length ? h('span', { class: 'pal-caps', 'aria-hidden': 'true' }, ...c.caps.flatMap((k, i) => [i ? h('span', { class: 'pal-plus' }, '+') : null, h('kbd', {}, k)])) : null;
    // A row that asks which floor first says so (it is the Enter after it).
    const asks = needsFloorPick(c, this.host.here()) ? h('span', { class: 'pal-asks' }, 'pick a floor') : null;
    const el = h('li', { class: 'pal-opt', role: 'option', 'aria-selected': 'false', 'data-kind': 'command' }, marked('pal-name', c.name, m.hits), asks, caps);
    el.dataset.sig = `${asks ? 1 : 0}`;
    return { key: `c:${c.id}`, el, enabled: true, act: () => this.runCommand(c) };
  }

  /** #33: a held review: where, how its hire ended, its task's first words; Enter opens it again. */
  private heldRow(r: HeldRow): Row {
    const failed = r.review.outcome === 'failed';
    const el = h(
      'li',
      { class: 'pal-opt pal-opt--held', role: 'option', 'aria-selected': 'false', 'data-kind': 'held', 'data-held': r.review.id },
      marked('pal-name', r.name, r.hits),
      h('span', { class: `pal-held-why${failed ? ' pal-held-why--failed' : ''}` }, failed ? 'Not hired' : 'No answer'),
      h('span', { class: 'pal-held-task' }, `“${taskPreview(r.review.task, 80)}”`),
    );
    el.dataset.sig = r.review.id;
    return {
      key: `h:${r.review.id}`,
      el,
      enabled: true,
      act: () => {
        this.close(false);
        this.host.held?.review(r.review.id);
      },
    };
  }

  private floorRow(f: FloorRow, online: boolean): Row {
    const chips = CHIPS.filter((x) => x.n(f.counts) > 0 && !f.asleep).map((x) => h('span', { class: `pal-chip pal-chip--${x.kind}` }, h('b', {}, String(x.n(f.counts))), ` ${x.word}`));
    const state = f.transition === 'waking' ? 'Waking up' : f.transition === 'sleeping' ? 'Going to sleep' : f.asleep ? 'Asleep' : '';
    const tags = [
      f.here ? h('span', { class: 'pal-here' }, 'You are here') : null,
      state ? h('span', { class: `tape tape--${f.asleep && !f.transition ? 'asleep' : (f.transition ?? 'asleep')}` }, state) : null,
      f.asleep && !f.transition ? h('span', { class: 'pal-asleep-n' }, plural(f.counts.total, 'worker')) : null,
    ];
    const el = h(
      'li',
      { class: 'pal-opt pal-opt--floor', role: 'option', 'aria-selected': 'false', 'aria-disabled': online ? null : 'true', 'aria-current': f.here ? 'location' : null, 'data-kind': 'floor', 'data-floor': f.floor },
      marked('pal-name', f.label, f.hits),
      h('span', { class: 'pal-meta' }, ...tags),
      chips.length ? h('span', { class: 'pal-chips' }, ...chips) : null,
    );
    el.dataset.sig = `${f.label}|${f.here}|${f.asleep}|${f.transition ?? ''}|${CHIPS.map((x) => x.n(f.counts)).join('.')}`;
    return { key: `f:${f.floor}`, el, enabled: online, act: () => this.goTo(f) };
  }

  /** #57: a bridge as it is now: its dot, name, address and state; Enter switches to it. */
  private bridgeRow(b: BridgeRow): Row {
    const st = bridgeStateText(b);
    const el = h(
      'li',
      { class: 'pal-opt pal-opt--bridge', role: 'option', 'aria-selected': 'false', 'data-kind': 'bridge', 'data-bridge': b.id, 'data-state': b.state },
      bridgeDot(b),
      marked('pal-name', b.name, b.hits),
      h('span', { class: 'pal-meta' }, h('span', { class: 'pal-br-addr' }, b.address), h('span', { class: `pal-br-state pal-br-state--${st.tone}` }, st.text)),
    );
    el.title = st.tone === 'up' || !b.lastError ? `${b.name}: ${st.text}` : `${b.name}: ${st.text}. ${b.lastError}`;
    el.dataset.sig = `${b.name}|${b.state}|${b.address}`;
    return {
      key: `b:${b.id}`,
      el,
      enabled: true,
      act: () => {
        const entry = this.host.bridges?.book.list?.bridges.find((x) => x.id === b.id);
        if (!entry) return;
        this.close(false);
        this.host.bridges?.switchTo(entry);
      },
    };
  }

  /** #57: the one row when the helper knows no other bridge: it opens Settings → Bridges. */
  private noBridgesRow(): Row {
    const el = h('li', { class: 'pal-opt pal-opt--empty', role: 'option', 'aria-selected': 'false', 'data-kind': 'no-bridges' }, h('span', { class: 'pal-name' }, 'No other bridges: add one in Settings'));
    el.dataset.sig = 'none';
    return {
      key: 'b:none',
      el,
      enabled: true,
      act: () => {
        this.close(false);
        this.host.bridges?.openSettings();
      },
    };
  }

  /** "2 floors need you, type @": under an empty list of commands, when it is news. */
  private drawHint(): void {
    const n = this.floorsMode() || this.bridgeMode || this.input.value !== '' ? 0 : floorsNeedingYou(this.host.store);
    this.hint.hidden = n === 0;
    if (n === 0) return;
    this.hint.replaceChildren(h('b', {}, String(n)), ` ${n === 1 ? 'floor needs' : 'floors need'} you · type `, h('kbd', {}, '@'));
  }

  private paintActive(): void {
    const i = this.rows.findIndex((r) => r.key === this.active);
    const row = paintActiveRow(this.list, i);
    if (row) this.input.setAttribute('aria-activedescendant', row.id);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private rowAt(t: EventTarget | null): number {
    const li = (t as Element | null)?.closest?.('li.pal-opt');
    return li ? [...this.list.children].indexOf(li) : -1;
  }

  private announce(text: string): void {
    if (text === this.told) return;
    this.told = text;
    this.said.textContent = text;
  }

  // ---- keys and actions ----------------------------------------------------------------------

  private key(e: KeyboardEvent): void {
    // An IME composing a word: Enter and the arrows are its.
    if (e.isComposing || e.key === 'Process') return;
    const ix = this.rows.findIndex((r) => r.key === this.active);
    const k = listKey(e, { rows: this.rows.some((r) => r.enabled), can: ix >= 0 && !!this.rows[ix]?.enabled });
    if (e.key === 'Tab') {
      // The field is the only stop: Tab does not wander off to the page behind (it is inert) or the browser.
      e.preventDefault();
      return;
    }
    if (!k) return;
    e.preventDefault();
    if (k === 'next' || k === 'prev') {
      // Over the rows that can be picked, wrapping.
      const live = this.rows.filter((r) => r.enabled);
      const at = live.findIndex((r) => r.key === this.active);
      const to = live[wrapIndex(at, live.length, k === 'next' ? 1 : -1)];
      if (to) {
        this.active = to.key;
        this.paintActive();
      }
    } else if (k === 'pick') this.rows[ix]?.act();
    else if (k === 'close') this.close();
  }

  private runCommand(c: PaletteCommand): void {
    if (c.id === 'bridge.switch' && this.host.bridges) return this.listBridges(this.host.bridges);
    if (needsFloorPick(c, this.host.here())) {
      this.pick = c;
      this.setText('@');
      return;
    }
    this.close(false);
    this.host.run(c, null);
  }

  /** #57: the list becomes the bridges: what the game knows now, read again while it shows. */
  private listBridges(b: PaletteBridges): void {
    this.bridgeMode = true;
    this.pick = null;
    this.offBridges ??= b.book.onChange(() => {
      if (this.dialog.open && this.bridgeMode) this.draw(false);
    });
    this.stopBridges ??= b.book.watch();
    this.setText('');
  }

  private goTo(f: FloorRow): void {
    const pick = this.pick;
    // The floor you are on: nothing to run it for or travel to; the palette just closes.
    if (f.here && !pick) return this.close();
    this.close(false);
    if (pick) this.host.run(pick, f.here ? null : f.floor);
    else this.host.goTo(f.floor);
  }

  private closed(): void {
    const back = this.opener;
    this.opener = null;
    this.pick = null;
    this.bridgeMode = false;
    this.stopBridges?.();
    this.offBridges?.();
    this.stopBridges = this.offBridges = null;
    this.rows = [];
    this.list.replaceChildren();
    // Back to where the keyboard was (the seat's input, a dialog's field, the canvas); gone: the page.
    const now = document.activeElement;
    if (back?.isConnected && (!now || now === document.body || this.dialog.contains(now))) back.focus();
  }
}
