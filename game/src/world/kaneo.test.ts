import { describe, expect, it } from 'vitest';
import { kaneoFailureText, kaneoStateOf, kaneoStatusText, LatestOnly } from './kaneo';

describe('Kaneo connection state (#184)', () => {
  it('keeps only the known fields: a stray key is never kept', () => {
    const s = kaneoStateOf({ state: 'ready', available: true, url: 'https://k.test', api_base: 'https://k.test/api', web_origin: 'https://k.test', key_set: true, key: 'secret', generation: 3, default_workspace: { id: 'w', name: 'Studio', x: 1 } });
    expect(s).toEqual({ state: 'ready', available: true, url: 'https://k.test', api_base: 'https://k.test/api', web_origin: 'https://k.test', key_set: true, default_workspace: { id: 'w', name: 'Studio' }, generation: 3 });
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(kaneoStateOf({ state: 'ready' })).toBeNull();
  });

  it('words a pause and the 401 as maybe a quota', () => {
    expect(kaneoStatusText(kaneoStateOf({ state: 'paused', key_set: true, web_origin: 'https://k.test', paused_until: 2_000 }), 1_000)).toContain('Paused');
    expect(kaneoFailureText('unauthorized', '')).toContain('quota');
    expect(kaneoFailureText('forbidden', '')).toContain('access');
  });

  it('LatestOnly lets only the newest answer land', () => {
    const l = new LatestOnly();
    const a = l.next();
    const b = l.next();
    expect(l.current(a)).toBe(false);
    expect(l.current(b)).toBe(true);
    l.cancel();
    expect(l.current(b)).toBe(false);
  });
});
