// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { reveal, revealBy } from './askStack';

// The pinned cards' reveal: a focus with preventScroll is brought into view by scrolling the box that scrolls on the
// card (its body; on a very short screen the card itself, under a sticky top line and over a sticky foot), never the
// transcript or the page.

type Rect = { top: number; bottom: number };

function lay(el: HTMLElement, r: Rect, box?: { scroll: number; client: number }): void {
  el.getBoundingClientRect = () => ({ top: r.top, bottom: r.bottom, left: 0, right: 300, x: 0, y: r.top, width: 300, height: r.bottom - r.top, toJSON: () => ({}) }) as DOMRect;
  if (box) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.scroll });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.client });
  }
}

function card(short: boolean) {
  const top = document.createElement('div');
  const body = document.createElement('div');
  const field = document.createElement('textarea');
  const foot = document.createElement('div');
  const c = document.createElement('section');
  c.className = 'tx-aq';
  top.className = 'tx-ask-top';
  body.className = 'tx-ask-body';
  foot.className = 'tx-ask-foot';
  body.append(field);
  c.append(top, body, foot);
  document.body.replaceChildren(c);
  if (short) {
    // The card scrolls as one; its top line and foot stick.
    c.style.overflowY = 'auto';
    body.style.overflowY = 'visible';
    top.style.position = 'sticky';
    top.style.top = '0px';
    foot.style.position = 'sticky';
    foot.style.bottom = '0px';
  } else {
    c.style.overflowY = 'hidden';
    body.style.overflowY = 'auto';
  }
  return { c, top, body, field, foot };
}

describe('reveal', () => {
  it('scrolls a very short screen’s card itself so the field clears its sticky foot', () => {
    // The phone the review measured: the card 333–475, its top line to 360, its foot from 439; the field 462–505.
    const { c, top, body, field, foot } = card(true);
    lay(c, { top: 333, bottom: 475 }, { scroll: 260, client: 142 });
    lay(top, { top: 333, bottom: 360 });
    lay(foot, { top: 439, bottom: 475 });
    lay(body, { top: 360, bottom: 520 }, { scroll: 160, client: 160 });
    lay(field, { top: 462, bottom: 505 });
    reveal(field);
    expect(body.scrollTop).toBe(0);
    expect(c.scrollTop).toBe(505 - 439 + 4);
  });

  it('scrolls back down to a field hidden under the sticky top line', () => {
    const { c, top, field, foot } = card(true);
    lay(c, { top: 333, bottom: 475 }, { scroll: 260, client: 142 });
    c.scrollTop = 80;
    lay(top, { top: 333, bottom: 360 });
    lay(foot, { top: 439, bottom: 475 });
    lay(field, { top: 340, bottom: 383 });
    reveal(field);
    expect(c.scrollTop).toBe(80 - (360 - 340) - 4);
  });

  it('scrolls only the body elsewhere (its top line and foot are outside it)', () => {
    const { c, top, body, field, foot } = card(false);
    lay(c, { top: 100, bottom: 400 }, { scroll: 300, client: 300 });
    lay(top, { top: 100, bottom: 130 });
    lay(foot, { top: 360, bottom: 400 });
    lay(body, { top: 130, bottom: 360 }, { scroll: 400, client: 230 });
    lay(field, { top: 370, bottom: 410 });
    reveal(field);
    expect(c.scrollTop).toBe(0);
    expect(body.scrollTop).toBe(410 - 360 + 4);
  });

  it('leaves a field in view alone, and never scrolls past the card', () => {
    const { c, top, body, field, foot } = card(true);
    lay(c, { top: 333, bottom: 475 }, { scroll: 142, client: 142 }); // nothing to scroll
    lay(top, { top: 333, bottom: 360 });
    lay(foot, { top: 439, bottom: 475 });
    lay(body, { top: 360, bottom: 439 }, { scroll: 79, client: 79 });
    lay(field, { top: 462, bottom: 505 });
    document.body.style.overflowY = 'auto';
    lay(document.body, { top: 0, bottom: 800 }, { scroll: 2000, client: 800 });
    reveal(field);
    expect(c.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    document.body.removeAttribute('style');
  });
});

describe('revealBy', () => {
  const band = { top: 100, bottom: 200 };
  it('is 0 inside, up above, down below', () => {
    expect(revealBy(band, { top: 120, bottom: 180 })).toBe(0);
    expect(revealBy(band, { top: 90, bottom: 130 })).toBe(-14);
    expect(revealBy(band, { top: 180, bottom: 220 })).toBe(24);
  });
  it('shows a box taller than the band from its top', () => {
    expect(revealBy(band, { top: 150, bottom: 400 })).toBe(46);
  });
});
