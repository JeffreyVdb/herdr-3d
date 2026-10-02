import '../test/fakeCanvas';
import { describe, expect, it } from 'vitest';
import { type CardFace } from '../world/activity';
import { floorLayout } from '../world/layout';
import { letterbox, MonitorCards, UPLOAD_MS } from './monitorCards';
import { spriteRow } from './mascotArt';

// #98: the cards of every desk animate with no canvas drawn per frame: the mascots flip frames in the shader, the text
// cells are drawn when what they say changes, the counters are glyph indexes written once a second.

const face = (over: Partial<CardFace> = {}): CardFace => ({ mascot: 'crab', pose: 'testing', tone: 'testing', word: 'Testing', detail: 'pytest -n auto', badge: null, since: 1_000, ...over });
const bitmap = (w: number, h: number) => {
  let closed = 0;
  return { width: w, height: h, close: () => void closed++, closed: () => closed } as unknown as ImageBitmap & { closed(): number };
};

describe('MonitorCards', () => {
  const L = floorLayout(60);

  it('animates a whole floor of cards for a minute without drawing a canvas or uploading a texture', () => {
    const cards = new MonitorCards(L.slots);
    const n = L.slots.length;
    for (let d = 0; d < n; d++) cards.set(d, face({ mascot: d % 2 ? 'cloud' : 'crab', pose: d % 3 ? 'testing' : 'thinking' }), d * 0.37, 5_000);
    expect(cards.ledger.cells).toBe(n);
    cards.frame(0);
    expect(cards.ledger.uploads).toBe(1);
    const versions = cards.textureVersions();
    const writes = cards.ledger.timerWrites;
    // 60 s at 60 fps, the counter ticking each second: the only writes are its glyph attributes.
    for (let f = 1; f <= 3600; f++) {
      const t = f * (1000 / 60);
      cards.frame(t);
      if (f % 60 === 0) cards.tick(5_000 + t);
      // The plan runs every 250 ms with the same faces: nothing to draw.
      if (f % 15 === 0) for (let d = 0; d < n; d++) cards.set(d, face({ mascot: d % 2 ? 'cloud' : 'crab', pose: d % 3 ? 'testing' : 'thinking' }), d * 0.37, 5_000 + t);
    }
    expect(cards.ledger.cells).toBe(n);
    expect(cards.ledger.uploads).toBe(1);
    expect(cards.textureVersions()).toEqual(versions);
    // A counter changes once a second: at most one write per card and second.
    expect(cards.ledger.timerWrites - writes).toBeLessThanOrEqual(n * 60);
    expect(cards.ledger.timerWrites - writes).toBeGreaterThanOrEqual(n * 59);
    expect(cards.timerText(0)).toBe('1:04');
    cards.dispose();
  });

  it('draws a cell again only when its face changes, and uploads at most every UPLOAD_MS', () => {
    const cards = new MonitorCards(L.slots);
    cards.set(3, face(), 0, 2_000);
    cards.frame(0);
    expect(cards.ledger).toMatchObject({ cells: 1, uploads: 1 });
    // A new label start (since) is no new face.
    cards.set(3, face({ since: 1_500 }), 0, 2_000);
    expect(cards.ledger.cells).toBe(1);
    expect(cards.timerText(3)).toBe('0:00');
    cards.set(3, face({ detail: 'go test ./...' }), 0, 2_000);
    cards.set(4, face({ pose: 'writing', tone: 'writing', word: 'Writing', detail: 'store.ts' }), 0, 2_000);
    expect(cards.ledger.cells).toBe(3);
    cards.frame(UPLOAD_MS - 1);
    expect(cards.ledger.uploads).toBe(1);
    cards.frame(UPLOAD_MS);
    expect(cards.ledger.uploads).toBe(2);
    cards.frame(UPLOAD_MS * 3);
    expect(cards.ledger.uploads).toBe(2);
    expect(cards.sprite(4)?.row).toBe(spriteRow('crab', 'writing'));
    cards.set(4, null, 0, 2_000);
    expect(cards.has(4)).toBe(false);
    expect(cards.sprite(4)).toBeNull();
    cards.dispose();
  });

  it('holds frame 0 under reduced motion', () => {
    const cards = new MonitorCards(L.slots);
    expect(cards.motion).toBe(true);
    cards.setMotion(false);
    expect(cards.motion).toBe(false);
    cards.dispose();
  });

  it('shows an image instead of the card, and disposes everything of it', () => {
    const cards = new MonitorCards(L.slots);
    cards.set(5, face({ pose: 'image', tone: 'image', word: 'Looking at an image', detail: 'shot.png' }), 0, 0);
    const b = bitmap(1600, 1000);
    cards.setImage(5, 'a'.repeat(64), b, 'shot.png');
    expect(cards.has(5)).toBe(false);
    expect(cards.imageOf(5)).toEqual({ hash: 'a'.repeat(64), aspect: 1.6 });
    expect(cards.texturesAlive).toBe(2);
    // Another image replaces it.
    cards.setImage(5, 'b'.repeat(64), bitmap(500, 500), 'b.png');
    expect(b.closed()).toBe(1);
    expect(cards.texturesAlive).toBe(2);
    cards.clearImage(5);
    expect(cards.has(5)).toBe(true);
    expect(cards.ledger).toMatchObject({ created: 4, disposed: 4, closed: 2 });
    cards.setImage(6, 'c'.repeat(64), bitmap(10, 10), 'c.png');
    cards.dispose();
    expect(cards.texturesAlive).toBe(0);
  });
});

describe('letterbox', () => {
  const box = { u0: 0, v0: 0, u1: 1, v1: 1 };
  it('fills the height of a wide box, centred', () => {
    // The area is 2.4 wide for 1 tall: a 16:10 image is as tall as it, centred across.
    const r = letterbox(1.6, box, 2.4);
    expect(r.v0).toBeCloseTo(0);
    expect(r.v1).toBeCloseTo(1);
    expect((r.u1 - r.u0) * 2.4).toBeCloseTo(1.6);
    expect((r.u0 + r.u1) / 2).toBeCloseTo(0.5);
  });
  it('fills the width of a very wide image', () => {
    const r = letterbox(5, box, 2.4);
    expect(r.u0).toBeCloseTo(0);
    expect(r.u1).toBeCloseTo(1);
    expect(r.v1 - r.v0).toBeCloseTo(2.4 / 5);
  });
  it('survives an image with no size', () => {
    const r = letterbox(Number.NaN, box, 2.4);
    expect(r).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });
});
