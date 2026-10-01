import { describe, expect, it } from 'vitest';
import { ago, cleanAppState, fitInto, isIdle, pinsText, statusText } from './model';

describe('whiteboard model', () => {
  it('keeps only the board appState keys, checked', () => {
    expect(cleanAppState({ viewBackgroundColor: '#fff8e7', gridSize: 40, gridStep: 2, gridModeEnabled: true, zoom: { value: 3 }, selectedElementIds: { a: true } })).toEqual({
      viewBackgroundColor: '#fff8e7',
      gridSize: 40,
      gridStep: 2,
      gridModeEnabled: true,
    });
    expect(cleanAppState({ viewBackgroundColor: 'url(javascript:1)', gridSize: -1, gridStep: 1.5 })).toEqual({ viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, gridModeEnabled: false });
    expect(cleanAppState(null).viewBackgroundColor).toBe('#ffffff');
  });

  it('says when the user is in the middle of something', () => {
    expect(isIdle({})).toBe(true);
    expect(isIdle({ newElement: {} })).toBe(false);
    expect(isIdle({ editingTextElement: {} })).toBe(false);
    expect(isIdle({ cursorButton: 'down' })).toBe(false);
    // A menu or popup keeps Esc for Excalidraw, not a save.
    expect(isIdle({ openMenu: 'canvas' })).toBe(true);
    expect(isIdle({ openMenu: 'canvas' }, true)).toBe(false);
    expect(isIdle({ openDialog: { name: 'help' } }, true)).toBe(false);
    expect(isIdle({ showHyperlinkPopup: 'editor' }, true)).toBe(false);
    expect(isIdle({ showHyperlinkPopup: false, openSidebar: null }, true)).toBe(true);
  });

  it('fits a picture without enlarging it', () => {
    expect(fitInto(1280, 720, 640, 480)).toEqual({ w: 640, h: 360 });
    expect(fitInto(100, 50, 640, 480)).toEqual({ w: 100, h: 50 });
    expect(fitInto(300, 3000, 640, 480)).toEqual({ w: 48, h: 480 });
  });

  it('words the status and the pins', () => {
    expect(statusText({ kind: 'saved', version: 3 })).toBe('Saved · version 3');
    expect(statusText({ kind: 'saved', version: 0 })).toBe('Nothing drawn yet');
    expect(statusText({ kind: 'error', message: 'offline' })).toBe('Not saved: offline');
    expect(pinsText({ stale_pins: [{ id: 'a', kind: 'note', author: 'Nibble', note: 'Look', version: 2, at: 0 }, { id: 'b', kind: 'image', author: 'Crumpet', version: 3, at: 0 }] })).toEqual(['Nibble pinned “Look”', 'Crumpet pinned an image']);
    expect(ago(1_000_000 - 30_000, 1_000_000)).toBe('just now');
    expect(ago(0, 3 * 3600_000)).toBe('3 h ago');
  });
});
