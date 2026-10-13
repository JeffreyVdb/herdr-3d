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
    p.setTheme('transcript', 'ubuntu');
    p.setTheme('terminal', 'ubuntu');
    p.setZoom('transcript', 130);
    p.setZoom('terminal', 80);
    p.hideTools = true;
    expect(Object.fromEntries(st.map)).toEqual({
      'h3d.theme.transcript': 'ubuntu',
      'h3d.theme.terminal': 'ubuntu',
      'h3d.zoom.transcript': '130',
      'h3d.zoom.terminal': '80',
      'h3d.transcript.hideTools': '1',
    });
    const q = new ViewPrefs(st);
    expect(state(q)).toEqual(['ubuntu', 'ubuntu', 130, 80, true]);
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
    p.setTheme('terminal', 'ubuntu');
    p.setZoom('terminal', 200);
    expect(state(p)).toEqual(['quiet', 'ubuntu', 100, 200, false]);
    p.setZoom('transcript', 70);
    p.setTheme('transcript', 'ubuntu');
    p.setTheme('terminal', 'quiet');
    expect(state(p)).toEqual(['ubuntu', 'quiet', 70, 200, false]);
  });

  it('ignore a stored value that is not theirs, and clamp a stored zoom, per view', () => {
    const p = new ViewPrefs(memory({ 'h3d.theme.transcript': 'solarized', 'h3d.theme.terminal': 'ubuntu', 'h3d.zoom.transcript': '999', 'h3d.zoom.terminal': '12', 'h3d.transcript.hideTools': 'yes' }));
    expect(state(p)).toEqual(['quiet', 'ubuntu', 200, 70, false]);
    expect(new ViewPrefs(memory({ 'h3d.zoom.terminal': '144' })).zoom('terminal')).toBe(140);
    expect(new ViewPrefs(memory({ 'h3d.zoom.transcript': 'huge' })).zoom('transcript')).toBe(100);
    p.setZoom('terminal', 1000);
    expect(p.zoom('terminal')).toBe(200);
    p.setTheme('terminal', 'fourth' as never);
    expect(p.theme('terminal')).toBe('ubuntu');
    // The retired ids are not choosable either (they only migrate when read back from storage).
    p.setTheme('terminal', 'paper' as never);
    p.setTheme('transcript', 'terminal' as never);
    expect(state(p)).toEqual(['quiet', 'ubuntu', 200, 200, false]);
  });

  it('work without storage (missing, or throwing on every access): the choices hold for the page', () => {
    for (const st of [null, broken()]) {
      const p = new ViewPrefs(st);
      expect(state(p)).toEqual(['quiet', 'quiet', 100, 100, false]);
      p.setTheme('transcript', 'ubuntu');
      p.setTheme('terminal', 'ubuntu');
      p.setZoom('transcript', 80);
      p.setZoom('terminal', 150);
      p.hideTools = true;
      expect(state(p)).toEqual(['ubuntu', 'ubuntu', 80, 150, true]);
    }
  });

  it('tell listeners what changed, once per real change', () => {
    const p = new ViewPrefs(null);
    const seen: string[] = [];
    const off = p.onChange((w) => seen.push(w));
    p.setTheme('transcript', 'ubuntu');
    p.setTheme('transcript', 'ubuntu');
    p.setTheme('terminal', 'ubuntu');
    p.setZoom('transcript', 110);
    p.setZoom('transcript', 113);
    p.setZoom('terminal', 90);
    p.hideTools = true;
    off();
    p.setZoom('terminal', 150);
    expect(seen).toEqual(['transcriptTheme', 'terminalTheme', 'transcriptZoom', 'terminalZoom', 'hideTools']);
  });
});

describe('retired presets (#172)', () => {
  it('open as their successor in both views, and the stored value follows; zoom, Hide tools and fullscreen stay', () => {
    const st = memory({
      'h3d.theme.transcript': 'terminal',
      'h3d.theme.terminal': 'paper',
      'h3d.zoom.transcript': '130',
      'h3d.zoom.terminal': '80',
      'h3d.transcript.hideTools': '1',
      'h3d.term.fullscreen': '0',
    });
    const p = new ViewPrefs(st);
    expect(state(p)).toEqual(['ubuntu', 'quiet', 130, 80, true]);
    expect(p.fullscreen).toBe(false);
    // Rewritten once (Quiet is the default, so stored as nothing): the next load reads the new ids, the rest untouched.
    expect(Object.fromEntries(st.map)).toEqual({
      'h3d.theme.transcript': 'ubuntu',
      'h3d.zoom.transcript': '130',
      'h3d.zoom.terminal': '80',
      'h3d.transcript.hideTools': '1',
      'h3d.term.fullscreen': '0',
    });
    expect(state(new ViewPrefs(st))).toEqual(['ubuntu', 'quiet', 130, 80, true]);
  });

  it('migrate each key on its own, Terminal to Ubuntu and Paper to Quiet, in either view', () => {
    const a = new ViewPrefs(memory({ 'h3d.theme.transcript': 'paper', 'h3d.theme.terminal': 'terminal' }));
    expect([a.theme('transcript'), a.theme('terminal')]).toEqual(['quiet', 'ubuntu']);
    const b = new ViewPrefs(memory({ 'h3d.theme.terminal': 'terminal', 'h3d.theme.transcript': 'terminal' }));
    expect([b.theme('transcript'), b.theme('terminal')]).toEqual(['ubuntu', 'ubuntu']);
    // A near miss is not a retired id: it is junk, so Quiet.
    const c = new ViewPrefs(memory({ 'h3d.theme.transcript': 'Terminal', 'h3d.theme.terminal': 'paper ' }));
    expect([c.theme('transcript'), c.theme('terminal')]).toEqual(['quiet', 'quiet']);
  });

  it('migrate in memory when storage throws or is missing for the write, and never throw', () => {
    // Readable, but every write throws: the migrated choice holds for the page.
    const m = new Map([['h3d.theme.transcript', 'terminal'], ['h3d.theme.terminal', 'paper']]);
    const boom = () => {
      throw new Error('blocked');
    };
    const ro: Storage = { getItem: (k) => m.get(k) ?? null, setItem: boom, removeItem: boom, clear: boom, key: () => null, length: 0 };
    const p = new ViewPrefs(ro);
    expect([p.theme('transcript'), p.theme('terminal')]).toEqual(['ubuntu', 'quiet']);
    expect(() => p.setTheme('terminal', 'ubuntu')).not.toThrow();
    expect(p.theme('terminal')).toBe('ubuntu');
    expect(state(new ViewPrefs(broken()))).toEqual(['quiet', 'quiet', 100, 100, false]);
  });
});

describe('fullscreen pref (#74)', () => {
  it('is on until turned off, stored only when off, and announced', () => {
    const st = memory();
    const p = new ViewPrefs(st);
    const seen: string[] = [];
    p.onChange((w) => seen.push(w));
    expect(p.fullscreen).toBe(true);
    p.fullscreen = true;
    expect(seen).toEqual([]);
    p.fullscreen = false;
    expect(Object.fromEntries(st.map)).toEqual({ 'h3d.term.fullscreen': '0' });
    expect(new ViewPrefs(st).fullscreen).toBe(false);
    p.fullscreen = true;
    expect(st.map.size).toBe(0);
    expect(seen).toEqual(['fullscreen', 'fullscreen']);
  });

  it('survives storage that throws, and ignores a stored value that is not ours', () => {
    const p = new ViewPrefs(broken());
    expect(p.fullscreen).toBe(true);
    p.fullscreen = false;
    expect(p.fullscreen).toBe(false);
    expect(new ViewPrefs(memory({ 'h3d.term.fullscreen': 'no' })).fullscreen).toBe(true);
  });

  it('#171: show code changes is on by default, stored only when off (as 0), says so, and is apart from hide tools', () => {
    const st = memory();
    const p = new ViewPrefs(st);
    expect(p.showChanges).toBe(true);
    const seen: string[] = [];
    p.onChange((w) => seen.push(w));
    p.showChanges = true; // no change: no event
    p.showChanges = false;
    expect(Object.fromEntries(st.map)).toEqual({ 'h3d.transcript.showChanges': '0' });
    p.hideTools = true;
    expect(new ViewPrefs(st).showChanges).toBe(false);
    expect(new ViewPrefs(st).hideTools).toBe(true);
    p.showChanges = true;
    expect(st.map.has('h3d.transcript.showChanges')).toBe(false);
    expect(seen).toEqual(['showChanges', 'hideTools', 'showChanges']);
    // Anything but '0' is on; storage that throws still works for the page.
    expect(new ViewPrefs(memory({ 'h3d.transcript.showChanges': 'off' })).showChanges).toBe(true);
    const b = new ViewPrefs(broken());
    expect(b.showChanges).toBe(true);
    b.showChanges = false;
    expect(b.showChanges).toBe(false);
  });
});

describe('UI theme pref (#216)', () => {
  it('is Quiet for a fresh browser and for one with only transcript or terminal picks; nothing is migrated from them', () => {
    expect(new ViewPrefs(memory()).uiTheme()).toBe('quiet');
    const st = memory({ 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' });
    const p = new ViewPrefs(st);
    expect(p.uiTheme()).toBe('quiet');
    expect(st.map.has('h3d.theme.ui')).toBe(false);
  });

  it('is remembered under h3d.theme.ui, independent of the two views, and Quiet stores nothing', () => {
    const st = memory();
    const p = new ViewPrefs(st);
    const seen: string[] = [];
    p.onChange((w) => seen.push(w));
    p.setUiTheme('ubuntu');
    expect(Object.fromEntries(st.map)).toEqual({ 'h3d.theme.ui': 'ubuntu' });
    expect(state(p)).toEqual(['quiet', 'quiet', 100, 100, false]);
    expect(new ViewPrefs(st).uiTheme()).toBe('ubuntu');
    p.setTheme('transcript', 'ubuntu');
    p.setUiTheme('quiet');
    expect(Object.fromEntries(st.map)).toEqual({ 'h3d.theme.transcript': 'ubuntu' });
    expect(seen).toEqual(['uiTheme', 'transcriptTheme', 'uiTheme']);
    // Setting what is already set tells nobody.
    p.setUiTheme('quiet');
    expect(seen).toHaveLength(3);
  });

  it('falls back to Quiet for a missing or invalid stored value', () => {
    for (const v of ['', 'solarized', 'Ubuntu', 'UBUNTU', 'terminal', ' ubuntu', 'null']) expect(new ViewPrefs(memory({ 'h3d.theme.ui': v })).uiTheme(), JSON.stringify(v)).toBe('quiet');
  });

  it('works in memory when storage is missing, blocked or throws, and tells listeners', () => {
    for (const st of [null, broken()]) {
      const p = new ViewPrefs(st);
      const seen: string[] = [];
      p.onChange((w) => seen.push(w));
      expect(p.uiTheme()).toBe('quiet');
      p.setUiTheme('ubuntu');
      expect(p.uiTheme()).toBe('ubuntu');
      expect(seen).toEqual(['uiTheme']);
    }
  });

  it('refuses a value that is not a UI theme', () => {
    const p = new ViewPrefs(null);
    p.setUiTheme('paper' as never);
    expect(p.uiTheme()).toBe('quiet');
  });
});
