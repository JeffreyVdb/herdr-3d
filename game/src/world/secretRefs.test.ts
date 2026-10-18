import { describe, expect, it } from 'vitest';
import { hasSecretRef, secretRefs } from './secretRefs';

// #108 round 4: the bridge's own references to protected files, found exactly (docs/decisions.md #108 row 6).

const DIR = '/run/user/1000/herdr-world/secrets';
const OWNER = 'PUKNXUKGN2LDLHO5W4FFT6Z6TW';
const FILE = 'MZEWFPEUANUI7A3AAWZIDF6AXG';
const path = (d = DIR, o = OWNER, f = FILE) => `${d}/${o}/${f}`;
const ref = (p = path()) => `[secret in file ${p}]`;

describe('secretRefs (#108)', () => {
  it('finds an exact reference with the bridge’s directory, its range in UTF-16 code units and its path', () => {
    const text = `Deploy with TOKEN=${ref()} now`;
    expect(secretRefs(text, DIR)).toEqual([{ start: 18, end: 18 + ref().length, path: path() }]);
    expect(hasSecretRef(text, DIR)).toBe(true);
  });

  it('with the directory known, a reference to any other directory stays text', () => {
    for (const d of ['/run/user/1001/herdr-world/secrets', '/run/user/1000/herdr-world', '/run/user/1000/herdr-world/secrets/x', '/tmp']) {
      expect(secretRefs(`a ${ref(path(d))} b`, DIR), d).toEqual([]);
    }
  });

  it('without the directory (an older bridge), any absolute directory of the bridge’s characters', () => {
    expect(secretRefs(ref(), null).map((r) => r.path)).toEqual([path()]);
    expect(secretRefs(ref(path('/var/lib/x_y.z-1')), undefined).map((r) => r.path)).toEqual([path('/var/lib/x_y.z-1')]);
  });

  it('names are 26 to 64 of A-Z and 2-7, exactly two of them after the directory', () => {
    const at = (o: string, f: string) => secretRefs(ref(path(DIR, o, f)), null).length;
    expect(at(OWNER, FILE)).toBe(1);
    expect(at('A'.repeat(64), '2'.repeat(26))).toBe(1);
    for (const [o, f] of [
      ['A'.repeat(25), FILE],
      [OWNER, 'B'.repeat(65)],
      [OWNER.toLowerCase(), FILE],
      [OWNER, `${FILE.slice(1)}1`],
      [OWNER, `${FILE.slice(1)}8`],
      [OWNER, `${FILE}.txt`],
    ] as const) {
      expect(at(o, f), `${o}/${f}`).toBe(0);
    }
    // Only the file after an owner: no owner directory.
    expect(secretRefs(`[secret in file ${DIR}/${FILE}]`, DIR)).toEqual([]);
  });

  it('look-alikes stay text', () => {
    const looks = [
      '[secret in file /tmp/x]',
      `[secret in file ${path()}`, // no closing bracket
      `secret in file ${path()}]`, // no opening one
      `[secret in file  ${path()}]`, // two spaces
      `[Secret in file ${path()}]`,
      `[secret in file ${path()} ]`,
      `[secret in file relative/${OWNER}/${FILE}]`,
      `[secret in file /run/../x/${OWNER}/${FILE}]`,
      `[secret in file /run/./x/${OWNER}/${FILE}]`,
      `[secret in file /a b/${OWNER}/${FILE}]`,
      `[secret in file //${OWNER}/${FILE}]`,
      `@${ref()}`, // a mention of it is not the bridge's reference
    ];
    for (const t of looks) {
      expect(secretRefs(t, null), t).toEqual([]);
      expect(secretRefs(t, DIR), t).toEqual([]);
      expect(hasSecretRef(t, null), t).toBe(false);
    }
  });

  it('several in a row, touching, beside punctuation, CRLF and astral characters', () => {
    const a = ref(path(DIR, OWNER, FILE));
    const b = ref(path(DIR, OWNER, 'Q'.repeat(26)));
    const text = `😀${a}${b}\r\n"${a}",(${b}).`;
    const found = secretRefs(text, DIR);
    expect(found.map((r) => text.slice(r.start, r.end))).toEqual([a, b, a, b]);
    expect(found[0]?.start).toBe(2);
    expect(found.map((r) => r.path)).toEqual([path(), path(DIR, OWNER, 'Q'.repeat(26)), path(), path(DIR, OWNER, 'Q'.repeat(26))]);
  });

  it('a reference inside another bracket is still found; an exact one beside a fake one too', () => {
    const text = `[${ref()}] [secret in file /tmp/x]${ref()}`;
    expect(secretRefs(text, DIR).map((r) => text.slice(r.start, r.end))).toEqual([ref(), ref()]);
  });

  it('every range it gives is exactly a reference, and the text between holds none (random texts)', () => {
    let seed = 108;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = [ref(), ref(path('/srv/s')), '[secret in file /tmp/x]', `[secret in file ${DIR}/${OWNER}]`, 'text ', '😀', '\r\n', '@', '[', ']', ' ', OWNER, `${DIR}/`];
    for (let run = 0; run < 400; run++) {
      let text = '';
      const n = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < n; i++) text += pieces[Math.floor(rand() * pieces.length)];
      for (const dir of [DIR, null]) {
        const found = secretRefs(text, dir);
        let at = 0;
        for (const r of found) {
          expect(r.start, text).toBeGreaterThanOrEqual(at);
          expect(text.slice(r.start, r.end), text).toBe(`[secret in file ${r.path}]`);
          if (dir) expect(r.path.startsWith(`${dir}/`), text).toBe(true);
          at = r.end;
        }
      }
    }
  });

  it('a long text that only starts like one is answered quickly', () => {
    const text = `[secret in file ${'/a'.repeat(20_000)}`;
    const t0 = performance.now();
    expect(secretRefs(text, null)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
