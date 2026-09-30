import { describe, expect, it } from 'vitest';
import { BackdropPress, outsideBox, type Box } from './dismiss';

const box: Box = { left: 100, top: 50, right: 500, bottom: 350 };
const onBackdrop = { onDialog: true, x: 20, y: 20, box };
const inPadding = { onDialog: true, x: 300, y: 60, box };
const inside = { onDialog: false, x: 300, y: 200, box };

describe('outsideBox', () => {
  it('is true beyond every edge, false on and inside them', () => {
    expect(outsideBox(box, 99, 100)).toBe(true);
    expect(outsideBox(box, 500, 100)).toBe(true);
    expect(outsideBox(box, 200, 49)).toBe(true);
    expect(outsideBox(box, 200, 350)).toBe(true);
    expect(outsideBox(box, 100, 50)).toBe(false);
    expect(outsideBox(box, 499, 349)).toBe(false);
  });
});

describe('BackdropPress', () => {
  it('closes on a press and a click that both landed on the backdrop', () => {
    const p = new BackdropPress();
    p.down({ ...onBackdrop, primary: true });
    expect(p.click(onBackdrop)).toBe(true);
  });

  it('never closes for a press inside released on the backdrop (the #51 drag)', () => {
    const p = new BackdropPress();
    p.down({ ...inside, primary: true });
    expect(p.click(onBackdrop)).toBe(false);
  });

  it('ignores a click with no qualifying press before it', () => {
    expect(new BackdropPress().click(onBackdrop)).toBe(false);
  });

  it('treats the dialog’s own padding as inside, not backdrop', () => {
    const p = new BackdropPress();
    p.down({ ...inPadding, primary: true });
    expect(p.click(inPadding)).toBe(false);
    p.down({ ...onBackdrop, primary: true });
    expect(p.click(inPadding)).toBe(false);
  });

  it('needs the primary button', () => {
    const p = new BackdropPress();
    p.down({ ...onBackdrop, primary: false });
    expect(p.click(onBackdrop)).toBe(false);
  });

  it('is spent by the click, so a second click needs a second press', () => {
    const p = new BackdropPress();
    p.down({ ...onBackdrop, primary: true });
    expect(p.click(onBackdrop)).toBe(true);
    expect(p.click(onBackdrop)).toBe(false);
  });

  it('is disarmed by a later press inside, a cancel or a reset', () => {
    const p = new BackdropPress();
    p.down({ ...onBackdrop, primary: true });
    p.down({ ...inside, primary: true });
    expect(p.click(onBackdrop)).toBe(false);
    p.down({ ...onBackdrop, primary: true });
    p.reset();
    expect(p.click(onBackdrop)).toBe(false);
  });
});
