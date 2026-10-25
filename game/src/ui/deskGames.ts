import { cardName, drawCard, moveCards, newPatience, patienceWon, rank, red, sourceCards, SUITS, suit, type Destination, type Patience, type Source } from '../games/patience';
import { flagCell, MINES, newMinesweeper, revealCell, SIDE } from '../games/minesweeper';
import { h, icon, replaceKeepingFocus } from './dom';
import './deskGames.css';

const PIPS = ['♣', '♦', '♠', '♥'];
const FLAG = '<path d="M6 21V3m0 1h12l-3 4 3 4H6"/>';
const MINE = '<circle cx="12" cy="12" r="5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>';
type Game = 'patience' | 'minesweeper';

/** The personal desk's monitor. Both games live here for the page's lifetime, including while away from the desk. */
export class DeskGames {
  private readonly dialog = h('dialog', { class: 'desk-games', 'aria-labelledby': 'desk-games-title' });
  private readonly body = h('div', { class: 'desk-games-body' });
  private readonly status = h('p', { class: 'desk-games-status', role: 'status', 'aria-live': 'polite' });
  private readonly instructions = h('p', { class: 'desk-games-help', id: 'desk-games-help' });
  private readonly tabs = h('nav', { class: 'desk-games-tabs', 'aria-label': 'Choose a game' });
  private readonly undo = h('button', { class: 'btn', onclick: () => this.undoMove() }, 'Undo');
  private readonly flag = h('button', { class: 'btn', 'aria-pressed': 'false', onclick: () => { this.flagMode = !this.flagMode; this.render(); } }, icon(FLAG), 'Flag mode');
  private game: Game = 'patience';
  private patience = newPatience();
  private mines = newMinesweeper();
  private history: Patience[] = [];
  private selected: Source | null = null;
  private flagMode = false;
  private mineFocus = 0;
  private note = '';

  constructor(parent: HTMLElement, stand: () => void) {
    for (const [game, name] of [['patience', 'Patience'], ['minesweeper', 'Minesweeper']] as const) {
      this.tabs.append(h('button', { class: 'btn', 'data-game': game, onclick: () => { this.game = game; this.note = ''; this.render(); } }, name));
    }
    this.dialog.append(
      h('header', { class: 'desk-games-head' }, h('h2', { id: 'desk-games-title' }, 'Corner office games'),
        h('button', { class: 'btn', onclick: () => this.close(), title: 'Back to the office (Esc)' }, 'Back to office'),
        h('button', { class: 'btn', onclick: () => { this.close(); stand(); } }, 'Stand up')),
      h('div', { class: 'desk-games-toolbar' }, this.tabs,
        h('div', { class: 'desk-games-actions' }, this.undo, this.flag, h('button', { class: 'btn', onclick: () => this.restart() }, 'New game'))),
      this.status, this.body, this.instructions,
    );
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    parent.append(this.dialog);
  }

  get isOpen(): boolean { return this.dialog.open; }

  open(): void {
    if (this.isOpen) return;
    this.render();
    this.dialog.showModal();
    this.tabs.querySelector<HTMLButtonElement>(`[data-game="${this.game}"]`)?.focus();
  }

  close(): void { if (this.isOpen) this.dialog.close(); }

  private restart(): void {
    if (this.game === 'patience') { this.patience = newPatience(); this.history = []; this.selected = null; }
    else { this.mines = newMinesweeper(); this.mineFocus = 0; this.flagMode = false; }
    this.note = '';
    this.render();
  }

  private undoMove(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.patience = previous;
    this.selected = null;
    this.note = '';
    this.render();
  }

  private commit(next: Patience): void {
    if (next === this.patience) return;
    this.history.push(this.patience);
    if (this.history.length > 200) this.history.shift();
    this.patience = next;
    this.selected = null;
    this.note = '';
    this.render();
  }

  private pick(from: Source | null, to?: Destination): void {
    if (this.selected && to) {
      const next = moveCards(this.patience, this.selected, to);
      if (next !== this.patience) { this.commit(next); return; }
    }
    if (from && sourceCards(this.patience, from).length) {
      this.selected = JSON.stringify(from) === JSON.stringify(this.selected) ? null : from;
      this.note = this.selected ? `${cardName(sourceCards(this.patience, from)[0]!)} selected. Choose a column or foundation.` : '';
    } else this.note = to?.pile === 'foundation' ? 'Build each suit from Ace to King.' : 'Only a King can start an empty column.';
    this.render();
  }

  private card(card: number, from: Source, key: string, to?: Destination): HTMLButtonElement {
    const selected = this.selected?.pile === 'column' && from.pile === 'column'
      ? this.selected.column === from.column && from.index >= this.selected.index
      : JSON.stringify(this.selected) === JSON.stringify(from);
    return h('button', {
      class: 'dg-card', 'data-red': String(red(card)), 'data-key': key, 'aria-label': cardName(card),
      'aria-pressed': String(selected), onclick: () => this.pick(from, to),
    }, h('span', { class: 'dg-card-corner', 'aria-hidden': 'true' }, `${({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[rank(card)] ?? rank(card)}${PIPS[suit(card)]}`),
    h('span', { class: 'dg-card-pip', 'aria-hidden': 'true' }, PIPS[suit(card)]));
  }

  private renderPatience(): HTMLElement {
    const state = this.patience;
    const board = h('div', { class: 'dg-patience', role: 'group', 'aria-label': 'Patience board', 'aria-describedby': 'desk-games-help' });
    const stock = h('button', {
      class: `dg-card dg-stock${state.stock.length ? ' dg-back' : ' dg-slot'}`, 'data-key': 'stock',
      'aria-label': state.stock.length ? `Draw a card (${state.stock.length} in stock)` : 'Recycle waste',
      disabled: !state.stock.length && !state.waste.length, onclick: () => this.commit(drawCard(state)),
    }, h('span', {}, state.stock.length ? 'Draw' : 'Recycle'), h('small', {}, String(state.stock.length)));
    const waste = state.waste.at(-1);
    const top = h('div', { class: 'dg-patience-row' }, stock,
      waste === undefined ? h('div', { class: 'dg-card dg-slot' }, 'Waste') : this.card(waste, { pile: 'waste' }, 'waste'),
      h('div', { 'aria-hidden': 'true' }));
    state.foundations.forEach((pile, column) => {
      const card = pile.at(-1);
      const to: Destination = { pile: 'foundation', column };
      const control = card === undefined
        ? h('button', { class: 'dg-card dg-slot dg-foundation', 'data-key': `foundation-${column}`, 'aria-label': `${SUITS[column]} foundation, start with Ace`, onclick: () => this.pick(null, to) }, h('span', { 'aria-hidden': 'true' }, PIPS[column]), h('small', {}, 'Ace'))
        : this.card(card, { pile: 'foundation', column }, `foundation-${column}`, to);
      top.append(h('div', { role: 'group', 'aria-label': `${SUITS[column]} foundation` }, control));
    });
    const columns = h('div', { class: 'dg-patience-row dg-tableau' });
    state.columns.forEach((pile, column) => {
      const stack = h('div', { class: 'dg-column', role: 'group', 'aria-label': `Column ${column + 1}` });
      const to: Destination = { pile: 'column', column };
      if (!pile.length) stack.append(h('button', { class: 'dg-card dg-slot', 'data-key': `column-${column}`, 'aria-label': `Empty column ${column + 1}, King only`, onclick: () => this.pick(null, to) }, 'King'));
      pile.forEach(({ card, up }, index) => {
        const control = up ? this.card(card, { pile: 'column', column, index }, `card-${card}`, to) : h('div', { class: 'dg-card dg-back', 'aria-label': 'Face-down card' });
        stack.append(control);
      });
      columns.append(stack);
    });
    board.append(top, columns);
    return board;
  }

  private mineAction(index: number, flag = this.flagMode): void {
    this.mineFocus = index;
    this.mines = flag ? flagCell(this.mines, index) : revealCell(this.mines, index);
    this.render();
  }

  private renderMines(): HTMLElement {
    const board = h('div', { class: 'dg-mines', role: 'group', 'aria-label': 'Minesweeper board', 'aria-describedby': 'desk-games-help' });
    const ended = this.mines.status === 'won' || this.mines.status === 'lost';
    this.mines.cells.forEach((cell, index) => {
      const showMine = ended && cell.mine;
      const wrong = ended && cell.flagged && !cell.mine;
      const label = showMine ? 'mine' : wrong ? 'incorrect flag' : cell.flagged ? 'flagged' : cell.revealed ? `${cell.nearby} adjacent mines` : 'covered';
      const button = h('button', {
        class: 'dg-cell', 'data-key': `cell-${index}`, 'data-revealed': String(cell.revealed), 'data-number': cell.nearby,
        'data-exploded': String(this.mines.exploded === index), 'aria-label': `Row ${Math.floor(index / SIDE) + 1}, column ${index % SIDE + 1}: ${label}`,
        'aria-disabled': String(ended), tabindex: index === this.mineFocus ? 0 : -1,
        onclick: () => this.mineAction(index),
        onfocus: () => {
          this.mineFocus = index;
          for (const b of board.querySelectorAll<HTMLButtonElement>('button')) b.tabIndex = b === button ? 0 : -1;
        },
        oncontextmenu: (e) => { e.preventDefault(); this.mineAction(index, true); },
      }, showMine ? icon(MINE) : cell.flagged ? icon(FLAG) : cell.revealed && cell.nearby ? String(cell.nearby) : '');
      if (wrong) button.append(h('span', { class: 'dg-wrong', 'aria-hidden': 'true' }, '×'));
      button.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); this.mineAction(index, true); return; }
        const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -SIDE, ArrowDown: SIDE } as Record<string, number>)[e.key];
        if (offset === undefined) return;
        e.preventDefault();
        const next = index + offset;
        if (next < 0 || next >= SIDE * SIDE || (Math.abs(offset) === 1 && Math.floor(next / SIDE) !== Math.floor(index / SIDE))) return;
        board.querySelector<HTMLButtonElement>(`[data-key="cell-${next}"]`)?.focus();
      });
      board.append(button);
    });
    return board;
  }

  private render(): void {
    for (const tab of this.tabs.querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab.dataset.game === this.game));
    const patience = this.game === 'patience';
    this.undo.hidden = !patience;
    this.undo.disabled = !this.history.length;
    this.flag.hidden = patience;
    this.flag.setAttribute('aria-pressed', String(this.flagMode));
    if (patience) {
      const home = this.patience.foundations.reduce((n, p) => n + p.length, 0);
      this.status.textContent = patienceWon(this.patience) ? 'You won! All 52 cards are home.' : this.note || `${home} of 52 cards home · ${this.patience.moves} ${this.patience.moves === 1 ? 'move' : 'moves'} · Draw one`;
      this.instructions.textContent = 'Select a card or a face-up stack, then its destination. Build columns down in alternating colors; only Kings fill empty columns. Build foundations up by suit, Ace to King. Draw to turn a card; recycle when the stock is empty.';
    } else {
      const flags = this.mines.cells.filter((c) => c.flagged).length;
      const remaining = SIDE * SIDE - MINES - this.mines.cells.filter((c) => c.revealed && !c.mine).length;
      this.status.textContent = this.mines.status === 'won' ? 'You won! Every safe square is clear.' : this.mines.status === 'lost' ? 'You hit a mine. Start a new game to try again.' : `${MINES - flags} mines unflagged · ${remaining} safe squares left${this.mines.status === 'ready' ? ' · Your first reveal is safe' : ''}`;
      this.instructions.textContent = 'Reveal every safe square. Numbers count the mines in neighboring squares. Right-click or press F to flag; use Flag mode on touch. Arrow keys move, Enter reveals. Reveal a number again to clear its neighbors when its flags match.';
    }
    replaceKeepingFocus(this.body, [patience ? this.renderPatience() : this.renderMines()], patience ? 'stock' : `cell-${this.mineFocus}`, { keepScroll: true });
  }
}
