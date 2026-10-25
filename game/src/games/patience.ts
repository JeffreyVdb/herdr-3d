/** Draw-one Klondike. Card ids are suit × 13 + rank − 1; hearts and diamonds are red. */
export const SUITS = ['clubs', 'diamonds', 'spades', 'hearts'] as const;
export const suit = (card: number): number => Math.floor(card / 13);
export const rank = (card: number): number => card % 13 + 1;
export const red = (card: number): boolean => suit(card) % 2 === 1;
export const cardName = (card: number): string => `${({ 1: 'Ace', 11: 'Jack', 12: 'Queen', 13: 'King' } as Record<number, string>)[rank(card)] ?? rank(card)} of ${SUITS[suit(card)]}`;

export interface TableauCard { card: number; up: boolean }
export interface Patience {
  stock: number[];
  waste: number[];
  foundations: number[][];
  columns: TableauCard[][];
  moves: number;
}
export type Source = { pile: 'waste' } | { pile: 'column'; column: number; index: number } | { pile: 'foundation'; column: number };
export type Destination = { pile: 'column' | 'foundation'; column: number };

export function newPatience(random = Math.random): Patience {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const columns = Array.from({ length: 7 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => ({ card: deck.pop()!, up: j === i })));
  return { stock: deck, waste: [], foundations: [[], [], [], []], columns, moves: 0 };
}

export function drawCard(state: Patience): Patience {
  if (patienceWon(state) || (!state.stock.length && !state.waste.length)) return state;
  if (!state.stock.length) return { ...state, stock: [...state.waste].reverse(), waste: [], moves: state.moves + 1 };
  return { ...state, stock: state.stock.slice(0, -1), waste: [...state.waste, state.stock.at(-1)!], moves: state.moves + 1 };
}

export function sourceCards(state: Patience, from: Source): number[] {
  if (from.pile === 'waste') return state.waste.slice(-1);
  if (from.pile === 'foundation') return state.foundations[from.column]?.slice(-1) ?? [];
  const cards = state.columns[from.column]?.slice(from.index) ?? [];
  if (from.index < 0 || !cards.length || cards.some((c) => !c.up)) return [];
  if (cards.some((c, i) => i > 0 && (rank(cards[i - 1]!.card) !== rank(c.card) + 1 || red(cards[i - 1]!.card) === red(c.card)))) return [];
  return cards.map((c) => c.card);
}

/** Invalid moves return the same state, so the view can explain the rule without adding an undo entry. */
export function moveCards(state: Patience, from: Source, to: Destination): Patience {
  if (patienceWon(state) || (from.pile === to.pile && from.column === to.column)) return state;
  const cards = sourceCards(state, from);
  const first = cards[0];
  if (first === undefined) return state;
  if (to.pile === 'foundation') {
    const pile = state.foundations[to.column];
    if (!pile || cards.length !== 1 || suit(first) !== to.column || rank(first) !== pile.length + 1) return state;
  } else {
    const pile = state.columns[to.column];
    if (!pile) return state;
    const top = pile.at(-1);
    if (top ? !top.up || red(top.card) === red(first) || rank(top.card) !== rank(first) + 1 : rank(first) !== 13) return state;
  }
  const next: Patience = { ...state, waste: [...state.waste], foundations: state.foundations.map((p) => [...p]), columns: state.columns.map((p) => p.map((c) => ({ ...c }))), moves: state.moves + 1 };
  if (from.pile === 'waste') next.waste.pop();
  else if (from.pile === 'foundation') next.foundations[from.column]!.pop();
  else {
    next.columns[from.column]!.splice(from.index);
    const exposed = next.columns[from.column]!.at(-1);
    if (exposed) exposed.up = true;
  }
  if (to.pile === 'foundation') next.foundations[to.column]!.push(first);
  else next.columns[to.column]!.push(...cards.map((card) => ({ card, up: true })));
  return next;
}

export const patienceWon = (state: Patience): boolean => state.foundations.every((pile) => pile.length === 13);
