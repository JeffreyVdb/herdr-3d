import { describe, expect, it } from 'vitest';
import { TranscriptDrafts } from './transcriptDrafts';

class Mem {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('TranscriptDrafts (#141)', () => {
  it('gives each worker one draft, writes its text and file chips on every change and clears the key when empty', () => {
    const s = new Mem();
    const t = new TranscriptDrafts({ storage: s });
    const a = t.get('a', 'Ada');
    expect(t.get('a', 'Ada')).toBe(a);
    expect(t.get('b', 'Bo')).not.toBe(a);
    a.insertParts(0, 0, ['hi ', { kind: 'file', path: 'x.ts', dir: false }]);
    expect(JSON.parse(s.getItem('h3d.draft.transcript.a') ?? 'null')).toEqual({ v: 1, text: 'hi ', segments: [{ kind: 'text', text: 'hi ' }, { kind: 'file', path: 'x.ts', dir: false }] });
    a.clear();
    expect(s.getItem('h3d.draft.transcript.a')).toBeNull();
  });

  it('reads an older text-only draft back as text', () => {
    const s = new Mem();
    s.setItem('h3d.draft.transcript.a', JSON.stringify({ v: 1, text: 'plain' }));
    expect(new TranscriptDrafts({ storage: s }).get('a', 'Ada').doc.text).toBe('plain');
  });

  it('holds a bounded number live: the least recently used goes (disposed) and comes back from storage', () => {
    const s = new Mem();
    const t = new TranscriptDrafts({ storage: s });
    const first = t.get('w0', 'w0');
    first.replace(0, 0, 'kept');
    for (let i = 1; i <= 30; i++) t.get(`w${i}`, `w${i}`);
    expect(first.disposed).toBe(true);
    expect(t.peek('w0')).toBeNull();
    const back = t.get('w0', 'w0');
    expect(back).not.toBe(first);
    expect(back.doc.text).toBe('kept');
  });

  it('keeps one send gate per worker, and does not let a draft go while its send is on its way', () => {
    const t = new TranscriptDrafts({ storage: new Mem() });
    const g = t.sending('w0');
    expect(t.sending('w0')).toBe(g);
    expect(t.sending('w1')).not.toBe(g);
    const first = t.get('w0', 'w0');
    g.set(true);
    for (let i = 1; i <= 30; i++) t.get(`w${i}`, `w${i}`);
    expect(first.disposed).toBe(false);
    expect(t.get('w0', 'w0')).toBe(first);
    expect(t.sending('w0')).toBe(g);
  });

  it('never lets the asked-for draft go: with every other one sending it holds more for now, and trims once a send is answered', async () => {
    const t = new TranscriptDrafts({ storage: null });
    const busy = Array.from({ length: 24 }, (_, i) => {
      const d = t.get(`w${i}`, `w${i}`);
      d.replace(0, 0, `p${i}`);
      t.sending(`w${i}`).set(true);
      return d;
    });
    const next = t.get('w24', 'w24');
    expect(next.disposed).toBe(false);
    expect(t.peek('w24')).toBe(next);
    next.replace(0, 0, 'go');
    expect(await next.resolve()).toMatchObject({ ok: true });
    expect(busy.some((d) => d.disposed)).toBe(false);
    const [oldest, ...rest] = busy;
    t.sending('w0').set(false);
    expect(oldest?.disposed).toBe(true);
    expect(t.peek('w0')).toBeNull();
    expect(next.disposed).toBe(false);
    expect(rest.some((d) => d.disposed)).toBe(false);
  });

  it('dispose lets every live draft go and keeps what storage has', () => {
    const s = new Mem();
    const t = new TranscriptDrafts({ storage: s });
    const a = t.get('a', 'Ada');
    a.replace(0, 0, 'x');
    t.dispose();
    expect(a.disposed).toBe(true);
    expect(s.getItem('h3d.draft.transcript.a')).not.toBeNull();
  });
});
