// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskGames } from './deskGames';

let games: DeskGames;
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.desk-games button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const status = () => document.querySelector('[role="status"]')!.textContent;

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  games = new DeskGames(document.body, () => {});
  games.open();
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('personal monitor controls', () => {
  it('moves a selected Ace to its foundation through the visible controls', () => {
    button('Ace of clubs').click();
    expect(button('Ace of clubs').getAttribute('aria-pressed')).toBe('true');
    button('clubs foundation, start with Ace').click();
    expect(status()).toContain('1 of 52 cards home · 1 move');
    expect(document.querySelector('[aria-label="clubs foundation"]')!.textContent).toContain('A♣');
    expect(button('Empty column 1, King only')).toBeTruthy();
  });

  it('moves cards between columns, turns up a hidden card, and undo restores the previous position', () => {
    button('Queen of hearts').click();
    button('King of spades').click();
    expect(document.querySelector('[aria-label="Column 5"]')!.textContent).toContain('Q♥');
    expect(button('King of hearts')).toBeTruthy();
    expect(status()).toContain('1 move');
    button('Undo').click();
    expect(document.querySelector('[aria-label="Column 2"]')!.textContent).toContain('Q♥');
    expect(document.querySelector('button[aria-label="King of hearts"]')).toBeNull();
    expect(status()).toContain('0 moves');
    expect(button('Undo').disabled).toBe(true);
  });

  it('keeps both games when closed and reopened, and a new game resets only the chosen game', () => {
    button('Draw a card (24 in stock)').click();
    button('Minesweeper').click();
    button('Flag mode').click();
    button('Row 1, column 1: covered').click();
    games.close();
    games.open();
    expect(button('Row 1, column 1: flagged')).toBeTruthy();
    button('New game').click();
    expect(button('Row 1, column 1: covered')).toBeTruthy();
    button('Patience').click();
    expect(status()).toContain('1 move');
    expect(button('Draw a card (23 in stock)')).toBeTruthy();
  });
});
