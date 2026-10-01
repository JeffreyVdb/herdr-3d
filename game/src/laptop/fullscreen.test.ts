import { describe, expect, it } from 'vitest';
import { fullscreenChip } from './fullscreen';

const size = { cols: 60, rows: 40 };

describe('fullscreenChip (#74)', () => {
  it('says nothing without zoom info (an older bridge) or in a single-pane tab', () => {
    expect(fullscreenChip(null, size)).toBeNull();
    expect(fullscreenChip(undefined, size)).toBeNull();
    expect(fullscreenChip({ state: 'single', applied: false }, size)).toBeNull();
  });

  it('a zoomed pane is a pressed Fullscreen that goes back on a click', () => {
    expect(fullscreenChip({ state: 'zoomed', applied: true }, { cols: 131, rows: 47 })).toMatchObject({
      label: 'Fullscreen',
      pressed: true,
      disabled: false,
      action: 'unzoom',
    });
    // A tab the human zoomed is the same chip: pressing it unzooms (an explicit act).
    expect(fullscreenChip({ state: 'zoomed', applied: false }, size)?.pressed).toBe(true);
  });

  it('a split pane states its size as a fact and offers Fullscreen', () => {
    const c = fullscreenChip({ state: 'split', applied: false }, size);
    expect(c).toMatchObject({ label: 'Split pane 60×40', pressed: false, disabled: false, action: 'zoom' });
    expect(c?.aria).toBe('Fullscreen, off. Split pane 60 by 40');
    expect(fullscreenChip({ state: 'split', applied: false }, null)?.label).toBe('Split pane');
  });

  it('a zoom that did not widen a headless pane is unavailable, and does nothing', () => {
    const c = fullscreenChip({ state: 'zoomed', applied: true, headless: true }, { cols: 120, rows: 40 });
    expect(c).toMatchObject({ label: 'Fullscreen unavailable', pressed: false, disabled: true, action: null });
    expect(c?.title).toMatch(/no herdr screen/);
  });
});
