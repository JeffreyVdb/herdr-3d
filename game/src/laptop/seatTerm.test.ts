import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { swallowReplies } from './seatTerm';

const write = (t: Terminal, s: string) => new Promise<void>((resolve) => t.write(s, resolve));

// The queries a pane's screen may carry, each of which xterm answers through onData.
const QUERIES = ['\x1b[c', '\x1b[>c', '\x1b[5n', '\x1b[6n', '\x1b[?6n', '\x1b[4$p', '\x1b[?25$p', '\x1bP$qm\x1b\\', '\x1b]10;?\x07', '\x1b]11;?\x07', '\x1b]4;1;?\x07'];

describe('the seated terminal never answers a frame (#176)', () => {
  it('xterm answers these queries by itself (so the guard below means something)', async () => {
    const t = new Terminal({ allowProposedApi: true });
    const out: string[] = [];
    t.onData((d) => out.push(d));
    for (const q of QUERIES) await write(t, q);
    expect(out.length).toBeGreaterThanOrEqual(6);
    t.dispose();
  });

  it('with the swallow handlers no byte reaches onData, and colour sets still apply', async () => {
    const t = new Terminal({ allowProposedApi: true });
    swallowReplies(t);
    const out: string[] = [];
    t.onData((d) => out.push(d));
    t.onBinary((d) => out.push(d));
    for (const q of QUERIES) await write(t, q);
    await write(t, 'plain text\r\n');
    expect(out).toEqual([]);
    // A set is not swallowed: xterm still handles it (no throw, no reply).
    await write(t, '\x1b]11;#102030\x07');
    expect(out).toEqual([]);
    t.dispose();
  });
});
