import { describe, expect, it } from 'vitest';
import { ViewPrefs } from './themePrefs';

const memory = (init: Record<string, string> = {}): Storage & { map: Map<string, string> } => {
  const m = new Map<string, string>(Object.entries(init));
  return { map: m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
};
const broken = (): Storage => {
  const boom = () => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
};
const state = (p: ViewPrefs) => [p.theme('transcript'), p.theme('terminal'), p.zoom('transcript'), p.zoom('terminal'), p.hideTools];

describe('view prefs (#59)', () => {
  it('start as Quiet at 100% for both views, tool calls shown; each view is remembered under its own keys', () => {
    const st = memory();
    const p = new ViewPrefs(st);
    expect(state(p)).toEqual(['quiet', 'quiet', 100, 100, false]);
    p.setTheme('transcript', 'paper');
    p.setTheme('terminal', 'terminal');
    p.setZoom('transcript', 130);
    p.setZoom('terminal', 80);
    p.hideTools = true;
    expect(Object.fromEntries(st.map)).toEqual({
      'h3d.theme.transcript': 'paper',
      'h3d.theme.terminal': 'terminal',
      'h3d.zoom.transcript': '130',
      'h3d.zoom.terminal': '80',
      'h3d.transcript.hideTools': '1',
    });
    const q = new ViewPrefs(st);
    expect(state(q)).toEqual(['paper', 'terminal', 130, 80, true]);
    // Back to the defaults: nothing stored.
    q.setTheme('transcript', 'quiet');
    q.setTheme('terminal', 'quiet');
    q.setZoom('transcript', 100);
    q.setZoom('terminal', 100);
    q.hideTools = false;
    expect(st.map.size).toBe(0);
  });

  it('keep the two views apart: one view’s preset or zoom never moves the other’s', () => {
    const p = new ViewPrefs(null);
    p.setTheme('terminal', 'paper');
    p.setZoom('terminal', 200);
    expect(state(p)).toEqual(['quiet', 'paper', 100, 200, false]);
    p.setZoom('transcript', 70);
    p.setTheme('transcript', 'terminal');
    expect(state(p)).toEqual(['terminal', 'paper', 70, 200, false]);
  });

  it('ignore a stored value that is not theirs, and clamp a stored zoom, per view', () => {
    const p = new ViewPrefs(memory({ 'h3d.theme.transcript': 'solarized', 'h3d.theme.terminal': 'paper', 'h3d.zoom.transcript': '999', 'h3d.zoom.terminal': '12', 'h3d.transcript.hideTools': 'yes' }));
    expect(state(p)).toEqual(['quiet', 'paper', 200, 70, false]);
    expect(new ViewPrefs(memory({ 'h3d.zoom.terminal': '144' })).zoom('terminal')).toBe(140);
    expect(new ViewPrefs(memory({ 'h3d.zoom.transcript': 'huge' })).zoom('transcript')).toBe(100);
    p.setZoom('terminal', 1000);
    expect(p.zoom('terminal')).toBe(200);
    p.setTheme('terminal', 'fourth' as never);
    expect(p.theme('terminal')).toBe('paper');
  });

  it('work without storage (missing, or throwing on every access): the choices hold for the page', () => {
    for (const st of [null, broken()]) {
      const p = new ViewPrefs(st);
      expect(state(p)).toEqual(['quiet', 'quiet', 100, 100, false]);
      p.setTheme('transcript', 'terminal');
      p.setTheme('terminal', 'paper');
      p.setZoom('transcript', 80);
      p.setZoom('terminal', 150);
      p.hideTools = true;
      expect(state(p)).toEqual(['terminal', 'paper', 80, 150, true]);
    }
  });

  it('tell listeners what changed, once per real change', () => {
    const p = new ViewPrefs(null);
    const seen: string[] = [];
    const off = p.onChange((w) => seen.push(w));
    p.setTheme('transcript', 'paper');
    p.setTheme('transcript', 'paper');
    p.setTheme('terminal', 'paper');
    p.setZoom('transcript', 110);
    p.setZoom('transcript', 113);
    p.setZoom('terminal', 90);
    p.hideTools = true;
    off();
    p.setZoom('terminal', 150);
    expect(seen).toEqual(['transcriptTheme', 'terminalTheme', 'transcriptZoom', 'terminalZoom', 'hideTools']);
  });
});
