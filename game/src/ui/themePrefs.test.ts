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

describe('view prefs (#59)', () => {
  it('start as Quiet, tool calls shown, 100%; are remembered under their keys', () => {
    const st = memory();
    const p = new ViewPrefs(st);
    expect([p.theme, p.hideTools, p.zoom]).toEqual(['quiet', false, 100]);
    p.theme = 'paper';
    p.hideTools = true;
    p.zoom = 130;
    expect(Object.fromEntries(st.map)).toEqual({ 'h3d.theme': 'paper', 'h3d.transcript.hideTools': '1', 'h3d.zoom': '130' });
    const q = new ViewPrefs(st);
    expect([q.theme, q.hideTools, q.zoom]).toEqual(['paper', true, 130]);
    // Back to the defaults: nothing stored.
    q.theme = 'quiet';
    q.hideTools = false;
    q.zoom = 100;
    expect(st.map.size).toBe(0);
  });

  it('ignore a stored value that is not theirs, and clamp a stored zoom', () => {
    expect(new ViewPrefs(memory({ 'h3d.theme': 'solarized' })).theme).toBe('quiet');
    expect(new ViewPrefs(memory({ 'h3d.zoom': '999' })).zoom).toBe(200);
    expect(new ViewPrefs(memory({ 'h3d.zoom': '12' })).zoom).toBe(70);
    expect(new ViewPrefs(memory({ 'h3d.zoom': '144' })).zoom).toBe(140);
    expect(new ViewPrefs(memory({ 'h3d.zoom': 'huge' })).zoom).toBe(100);
    expect(new ViewPrefs(memory({ 'h3d.transcript.hideTools': 'yes' })).hideTools).toBe(false);
    const p = new ViewPrefs(memory());
    p.zoom = 1000;
    expect(p.zoom).toBe(200);
    p.theme = 'fourth' as never;
    expect(p.theme).toBe('quiet');
  });

  it('work without storage (missing, or throwing on every access): the choice holds for the page', () => {
    for (const st of [null, broken()]) {
      const p = new ViewPrefs(st);
      expect([p.theme, p.hideTools, p.zoom]).toEqual(['quiet', false, 100]);
      p.theme = 'terminal';
      p.hideTools = true;
      p.zoom = 80;
      expect([p.theme, p.hideTools, p.zoom]).toEqual(['terminal', true, 80]);
    }
  });

  it('tell listeners what changed, once per real change', () => {
    const p = new ViewPrefs(null);
    const seen: string[] = [];
    const off = p.onChange((w) => seen.push(w));
    p.theme = 'paper';
    p.theme = 'paper';
    p.zoom = 110;
    p.zoom = 113;
    p.hideTools = true;
    off();
    p.zoom = 150;
    expect(seen).toEqual(['theme', 'zoom', 'hideTools']);
  });
});
