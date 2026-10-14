// M16: the transcript view's commands, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules,
// like herdr-world's (docs/protocol.md "Laptops: transcript"):
// - `transcript.watch {id, limit?}` (limit 1-500, 0/absent: 200) acks the worker's timeline (the demo one below: every
//   item kind, in the bridge's shape) as `{harness, session, version, cursor, has_more, pending: false, items}`; at
//   most 4 per connection (`capacity`); a worker on a sleeping floor is `invalid_state`, an unknown one
//   `unknown_worker`. A re-watch of the same worker replaces the watch.
// - `transcript.unwatch {id}`: always acked.
// - `transcript.page {id, before, limit?, agent?}` and `transcript.item {id, item, agent?}` answer only for a watched
//   worker (`invalid_state` otherwise). With `agent`, the subagent's own timeline: the bridge's items for its
//   fixture (fixtures/transcript/claude-subagent.json) for the demo's Agent call, `not_found` for any other id.
//   Without `agent`, `before` must be a cursor (`c:<seq>`): the demo is one page, so older pages are empty.
// - World events end the watches they concern: `worker.removed` → `transcript.closed {worker_removed}`, the floor
//   falling asleep → `{asleep}`.
// - `sim.transcript {id, items?, updates?, close?}` (the simulator's own): pushes `transcript.items` to the worker's
//   watch, or closes it with `close` as the reason. `sim.transcripts {}` answers `{watches, ids}`.
// - Images (phase 2): `transcript.image {id, hash, size, agent?}` answers only a hash the watch was sent (items shown
//   by watch/page/item, pushes, `transcript.images`), as the decoded PNG (thumb: at most 480 px on its longest side)
//   in base64; a hash made with `too_large` refuses `full` with `too_large`. `transcript.images {id}` lists every
//   image of the session (the demo has some older than any window). `sim.image {w?, h?, seed?, origin?, kind?,
//   too_large?, unavailable?, reason?, path?}` makes an image (PNG bytes kept) and answers its ImageRef, to push in
//   `sim.transcript` items. Every image is a real PNG, so screenshots show pictures.
// - #98: a worker's current activity image (`activityHash`, tools/fixture-activity.ts) is served without a watch.
// - `simfail=no_m16` plays a bridge before M16: every transcript command is `unknown_command`.
// - #171: `simtx=<name>` (default: the fixture's name) picks another timeline for every watch, when there is one by that
//   name: `demo-h171` is code changes in every shape and state (`h171Timeline`), and `transcript.item` answers its cut
//   change in full; `demo-h206` puts the diff highlighter's worst cases before it (`h206Timeline`).
// - #21: `demo-h21` is Codex's code changes in every source and state (`h21Timeline`), half of them older than a watch's
//   window: "Jump to message" from its screenshot pages them in.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Floor, ImageRef, TranscriptItem, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export const SIM_MAX_TRANSCRIPT_WATCHES = 4;
/** The agent id of the demo's subagent: the one fixtures/transcript/claude-subagent.json was read from. */
export const SIM_SUBAGENT = 'aa3716c63ba631707';

/** A synthetic screenshot: a gradient, a header bar and blocks laid out from the seed (no text: no font needed). */
export function drawPng(w: number, h: number, seed: number): Buffer {
  const png = new PNG({ width: w, height: h });
  const rnd = (n: number) => {
    let x = (seed * 374761393 + n * 668265263) >>> 0;
    x = ((x ^ (x >>> 13)) * 1274126177) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
  };
  const hue = (seed * 47) % 360;
  const rgb = (hh: number, sat: number, lum: number): [number, number, number] => {
    const a = sat * Math.min(lum, 1 - lum);
    const f = (n: number) => {
      const k = (n + hh / 30) % 12;
      return Math.round(255 * (lum - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const put = (x: number, y: number, c: [number, number, number]) => {
    const i = (y * w + x) * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, rgb(hue, 0.35, 0.16 + 0.12 * (y / h) + 0.04 * (x / w)));
  const bar = Math.max(6, Math.round(h * 0.09));
  for (let y = 0; y < bar; y++) for (let x = 0; x < w; x++) put(x, y, rgb((hue + 30) % 360, 0.45, 0.32));
  for (let k = 0; k < 5; k++) {
    const bw = Math.round(w * (0.18 + rnd(k * 4) * 0.3));
    const bh = Math.round(h * (0.1 + rnd(k * 4 + 1) * 0.22));
    const bx = Math.round(rnd(k * 4 + 2) * (w - bw));
    const by = bar + 4 + Math.round(rnd(k * 4 + 3) * (h - bar - bh - 8));
    const c = rgb((hue + 60 + k * 40) % 360, 0.55, 0.55);
    for (let y = Math.max(bar, by); y < Math.min(h, by + bh); y++) for (let x = bx; x < Math.min(w, bx + bw); x++) put(x, y, c);
  }
  return PNG.sync.write(png);
}

interface SimImage {
  bytes: Buffer;
  width: number;
  height: number;
  tooLarge: boolean;
}

/** Every image the simulator ever made, by hash (content addressed, as the bridge's cache). */
const IMAGES = new Map<string, SimImage>();

export interface SimImageSpec {
  w?: number;
  h?: number;
  seed?: number;
  origin?: 'input' | 'agent';
  kind?: 'generated' | 'viewed';
  tooLarge?: boolean;
  unavailable?: boolean;
  reason?: string;
  path?: string;
}

/** An ImageRef for a made image (or an unavailable one: no bytes). */
export function simImage(spec: SimImageSpec = {}): ImageRef {
  const origin = spec.origin ?? 'agent';
  const base: ImageRef = { source: spec.path ? 'path' : 'inline', origin, ...(origin === 'agent' ? { kind: spec.kind ?? 'viewed' } : {}), ...(spec.path ? { path: spec.path } : {}) };
  if (spec.unavailable) return { ...base, unavailable: true, reason: spec.reason ?? 'not_allowed' };
  const w = spec.w ?? 640;
  const h = spec.h ?? 400;
  const bytes = drawPng(w, h, spec.seed ?? 1);
  const hash = createHash('sha256').update(bytes).digest('hex');
  IMAGES.set(hash, { bytes, width: w, height: h, tooLarge: !!spec.tooLarge });
  return { ...base, hash, mime: 'image/png', bytes: bytes.length, width: w, height: h };
}

export interface TranscriptHost {
  worker(id: string): Worker | undefined;
  floor(session: string): Floor | undefined;
  now(): number;
  error(code: string, message: string): Error;
  /** #57: items the worker's timeline has on top of the demo (its ask calls, tools/fixture-ask.ts). */
  extra?(id: string): TranscriptItem[];
  /** #98: the image its current activity shows (tools/fixture-activity.ts): served without a watch, like the bridge. */
  activityHash?(id: string): string | undefined;
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'transcript');

let subagent: TranscriptItem[] | null = null;
const subagentItems = (): TranscriptItem[] => (subagent ??= JSON.parse(readFileSync(join(FIXTURES, 'claude-subagent.json'), 'utf8')) as TranscriptItem[]);

// The demo's images: real PNGs made once. The user's two screenshots (one sent twice), one that is outside the bridge's
// roots, what the agent viewed with a Read, and two it generated.
const SHOT = simImage({ origin: 'input', w: 1280, h: 720, seed: 3 });
const SHOT_B = simImage({ origin: 'input', w: 375, h: 667, seed: 5 });
const LOST = simImage({ origin: 'input', path: '/etc/hosts.png', unavailable: true, reason: 'not_allowed' });
const VIEWED = simImage({ w: 375, h: 667, seed: 8 });
const VIEWED_B = simImage({ w: 1024, h: 640, seed: 9 });
const MOCK = simImage({ kind: 'generated', w: 512, h: 512, seed: 12 });
const MOCK_B = simImage({ kind: 'generated', w: 640, h: 360, seed: 14 });

/** The demo timeline at `now`: every kind the bridge sends, a few of each worth looking at (and some hostile text). */
export function demoTimeline(now: number): TranscriptItem[] {
  let seq = 0;
  const it = (kind: TranscriptItem['kind'], extra: Partial<TranscriptItem>, id?: string): TranscriptItem => {
    seq++;
    return { id: id ?? `demo-${seq}`, seq, ts: now - (40 - seq) * 20_000, kind, ...extra };
  };
  return [
    it('notice', { hidden: true, notice: { text: 'claude 2.1.0', source: 'system/init' } }),
    it('user', { parts: [{ text: 'The HUD overlaps the laptop screen on small windows. Can you fix it and add a test?' }, { image: SHOT }, { image: SHOT_B }, { image: LOST }] }),
    it('thinking', { parts: [{ text: 'The seat pose uses `insets()`; the overlap is probably the seat bar height.' }] }),
    it('assistant', { parts: [{ text: "I'll look at how the seated camera is placed. The relevant code is in `seatPose`:\n\n```ts\nconst top = Math.min(H * 0.3, ins.top + 10);\nconst bottom = Math.min(H * 0.35, ins.bottom + 10);\n```" }] }),
    it('tool', { tool: { name: 'Grep', input_summary: 'insets\\(\\) in src/', status: 'ok', output_text: 'src/app.ts:361\nsrc/laptop/index.ts:343' } }, 'toolu_demo_grep'),
    it('tool', { tool: { name: 'Read', input_summary: 'dialog-evidence/hire-375x667.png', status: 'ok', images: [{ image: VIEWED }, { image: VIEWED_B }] } }, 'toolu_demo_read'),
    it('assistant', { parts: [{ image: MOCK }] }),
    it('assistant', { parts: [{ image: MOCK_B }] }),
    it('user', { parts: [{ text: 'Same screenshot again, the seat bar this time:' }, { image: SHOT }] }),
    it('notice', { hidden: true, notice: { text: 'Turn took 41s', source: 'system/turn_duration' } }),
    it(
      'tool',
      {
        tool: {
          name: 'Edit',
          input_summary: 'src/laptop/index.ts',
          status: 'ok',
          diff: {
            path: 'src/laptop/index.ts',
            hunks: [
              {
                old_start: 341,
                old_lines: 4,
                new_start: 341,
                new_lines: 4,
                lines: ['     const H = Math.max(1, window.innerHeight);', '     const ins = this.host.insets();', '-    const top = Math.min(H * 0.3, ins.top + 10);', '+    const top = Math.min(H * 0.3, ins.top + 14);', '     const bottom = Math.min(H * 0.35, ins.bottom + 10);'],
              },
            ],
          },
        },
      },
      'toolu_demo_edit',
    ),
    it('compaction', { notice: { text: 'Conversation compacted', source: 'system/compact_boundary' } }),
    it('subagent', { tool: { name: 'Agent', input_summary: 'Check the other seated overlays', status: 'ok' }, subagent: { agent_id: SIM_SUBAGENT, description: 'Check the other seated overlays', status: 'completed' } }, 'toolu_demo_agent'),
    it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop', status: 'error', output_text: '\u001b[31m FAIL \u001b[39m src/laptop/keys.test.ts > seatedKey\n\u001b[2mAssertionError: expected none(true)\u001b[22m\n\n Tests  1 failed | 41 passed' } }, 'toolu_demo_bash1'),
    it('notice', { notice: { text: 'Interrupted by user', source: 'user/interrupt' } }),
    it('assistant', { parts: [{ text: 'One test fails because of **the Esc mapping**. See <script>window.__pwned = 1</script> [details](javascript:window.__pwned=2) and <img src=x onerror="window.__pwned=3">.' }] }),
    it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop --reporter dot', status: 'running' } }, 'toolu_demo_bash2'),
    it('unknown', { hidden: true, raw_type: 'queue-operation' }),
  ].map(link);
}

/**
 * #171: code changes, every shape and state: what the bridge makes of its own Claude fixtures
 * (fixtures/transcript/claude-changes.json: Edit, Write create and overwrite with and without hunks, Bash one file, several,
 * files without a diff, incomplete, shared, skipped, then a failed, a denied and an interrupted edit), a Codex patch over
 * two files (codex.json) and one still running (proposed), and an Edit whose diff the list cut (`H171_FULL` has it whole,
 * for `transcript.item`).
 */
export function h171Timeline(now: number): TranscriptItem[] {
  const codexPatch = fixture('codex.json').find((it) => it.tool?.name === 'apply_patch') as TranscriptItem;
  const proposed: TranscriptItem = {
    id: 'h171-proposed',
    seq: 0,
    ts: 0,
    kind: 'tool',
    tool: {
      name: 'apply_patch',
      input_summary: 'src/tide.ts',
      status: 'running',
      diff: { path: 'src/tide.ts', hunks: [{ old_start: 0, old_lines: 1, new_start: 0, new_lines: 2, lines: ['-export const HIGH = 4.1;', '+export const HIGH = 4.3;', '+export const LOW = 0.6;'] }] },
    },
  };
  const all: TranscriptItem[] = [
    { id: 'h171-ask', seq: 0, ts: 0, kind: 'user', parts: [{ text: 'Tidy the helpers, bump the version and format the sources. Show me what changed.' }] },
    ...fixture('claude-changes.json'),
    { id: 'h171-say', seq: 0, ts: 0, kind: 'assistant', parts: [{ text: 'Now the Codex side of it, and one large edit.' }] },
    codexPatch,
    cutItem(false),
    proposed,
  ];
  return all.map((it, i) => ({ ...it, seq: i + 1, ts: now - (all.length - i) * 15_000 }));
}

/** What the bridge makes of one of its own fixtures (fixtures/transcript, kept in step by internal/transcript's TestGameFixtures). */
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as TranscriptItem[];

/**
 * #21: Codex's code changes, every source and state: what the bridge makes of its own Codex fixtures
 * (fixtures/transcript/codex-changes.json: exec scripts and the patches they ran, one or several files and calls, a built
 * patch, failed, escaped, direct, legacy, a nested failure, renamed, declined, interrupted, one still running). A
 * screenshot and the scripts' half come first, then 210 replies, then the direct and later patches: a watch's 200 items
 * end before the first half, which "Jump to message" from the screenshot pages in.
 */
export function h21Timeline(now: number): TranscriptItem[] {
  const changes = fixture('codex-changes.json');
  const half = changes.findIndex((it) => it.id === 'call_c21direct0000000000000007');
  const say = Array.from({ length: 210 }, (_, i): TranscriptItem => ({ id: `h21-say-${i + 1}`, seq: 0, ts: 0, kind: 'assistant', parts: [{ text: `Checked tide table ${i + 1}: no change needed.` }] }));
  const all: TranscriptItem[] = [
    { id: 'h21-ask', seq: 0, ts: 0, kind: 'user', parts: [{ text: 'Patch the tide tables and show me every change. This is the chart they came from:' }, { image: SHOT }] },
    ...changes.slice(0, half),
    ...say,
    ...changes.slice(half),
  ];
  return all.map((it, i) => link({ ...it, seq: i + 1, ts: now - (all.length - i) * 15_000 }));
}

/** #171: an Edit with 2,500 changed lines (past the view's 2,000 a page); the list's copy has the first 200 and says it was cut. */
function cutItem(full: boolean): TranscriptItem {
  const n = full ? 1250 : 100;
  const lines = Array.from({ length: n }, (_, i) => [`-  { id: ${i + 1}, depth: ${(i % 9) + 1} },`, `+  { id: ${i + 1}, depth: ${(i % 9) + 1}, tide: 'high' },`]).flat();
  return {
    id: 'h171-cut',
    seq: 0,
    ts: 0,
    kind: 'tool',
    tool: {
      name: 'Edit',
      input_summary: '/home/dev/project/src/soundings.ts',
      status: 'ok',
      diff: { path: '/home/dev/project/src/soundings.ts', op: 'edit', hunks: [{ old_start: 3, old_lines: 1250, new_start: 3, new_lines: 1250, lines }], ...(full ? {} : { truncated: true }) },
    },
  };
}

/**
 * #206: the diff highlighter's worst cases, from real code (this repository's src/laptop/transcriptRender.ts, as the
 * issue's benchmark): a created 2,000-line TypeScript file (one hunk: the worker's) and an edit of ten hunks across it
 * (each the page's thread's), then the #171 timeline (its cut change: "Show next" over a loaded 2,500-line hunk).
 */
export function h206Timeline(now: number): TranscriptItem[] {
  const src = readFileSync(join(import.meta.dirname, '../src/laptop/transcriptRender.ts'), 'utf8').split('\n').slice(0, 2000);
  const create: TranscriptItem = {
    id: 'h206-create',
    seq: 0,
    ts: 0,
    kind: 'tool',
    tool: {
      name: 'Write',
      input_summary: '/home/dev/project/src/render.ts',
      status: 'ok',
      diff: { path: '/home/dev/project/src/render.ts', op: 'create', hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: src.length, lines: src.map((l) => `+${l}`) }] },
    },
  };
  // Ten hunks, every 190 lines: three lines of context, four deleted, five added (the four edited, one new), three of context.
  let shift = 0;
  const hunks = Array.from({ length: 10 }, (_, k) => {
    const at = 40 + k * 190;
    const ctx = (from: number) => src.slice(from, from + 3).map((l) => ` ${l}`);
    const old = src.slice(at + 3, at + 7);
    const lines = [...ctx(at), ...old.map((l) => `-${l}`), ...old.map((l) => `+${l.replace(/\b(const|let)\b/, 'let').replace(/;$/, ' ;')}`), `+  // #206: edited (${k + 1}).`, ...ctx(at + 7)];
    const h = { old_start: at + 1, old_lines: 10, new_start: at + 1 + shift, new_lines: 11, lines };
    shift++;
    return h;
  });
  const edit: TranscriptItem = {
    id: 'h206-edit',
    seq: 0,
    ts: 0,
    kind: 'tool',
    tool: { name: 'Edit', input_summary: '/home/dev/project/src/render.ts', status: 'ok', diff: { path: '/home/dev/project/src/render.ts', op: 'edit', hunks } },
  };
  const all: TranscriptItem[] = [
    { id: 'h206-ask', seq: 0, ts: 0, kind: 'user', parts: [{ text: 'Write the renderer, then tidy it in ten places.' }] },
    create,
    edit,
    ...h171Timeline(now),
  ];
  return all.map((it, i) => ({ ...it, seq: i + 1, ts: now - (all.length - i) * 15_000 }));
}

/** #171: the timelines `simtx` picks (by name), and the items `transcript.item` answers whole for each. */
const TIMELINES: Record<string, { items: (now: number) => TranscriptItem[]; full: () => TranscriptItem[] }> = {
  'demo-h171': { items: h171Timeline, full: () => [cutItem(true)] },
  'demo-h206': { items: h206Timeline, full: () => [cutItem(true)] },
  'demo-h21': { items: h21Timeline, full: () => [] },
};

/** Every image ref of an item, in order. */
function refsOf(it: TranscriptItem): ImageRef[] {
  const out: ImageRef[] = [];
  for (const p of it.parts ?? []) if ('image' in p) out.push(p.image);
  for (const p of it.tool?.images ?? []) if ('image' in p) out.push(p.image);
  return out;
}

/** The bridge fills each ref with the item it is in. Copies: the same ref can be in two items. */
function link(it: TranscriptItem): TranscriptItem {
  const fill = (r: ImageRef): ImageRef => ({ ...r, item_id: it.id, seq: it.seq, ts: it.ts });
  const out: TranscriptItem = { ...it };
  if (it.parts) out.parts = it.parts.map((p) => ('image' in p ? { image: fill(p.image) } : p));
  if (it.tool?.images) out.tool = { ...it.tool, images: it.tool.images.map((p) => ('image' in p ? { image: fill(p.image) } : p)) };
  return out;
}

interface Watch {
  send: Send;
  items: TranscriptItem[];
  /** The hashes this connection was sent for this worker. */
  sent: Set<string>;
}

export class TranscriptSim {
  readonly watches = new Map<string, Watch>();
  private readonly host: TranscriptHost;
  private readonly on: boolean;
  /** #171: the timeline every watch gets (`simtx`; none or unknown: the demo). */
  private readonly timeline: (typeof TIMELINES)[string] | undefined;

  constructor(host: TranscriptHost, on = true, timeline?: string) {
    this.host = host;
    this.on = on;
    this.timeline = timeline && Object.hasOwn(TIMELINES, timeline) ? TIMELINES[timeline] : undefined;
  }

  /** Handles the transcript commands; false for anything else. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !(t.startsWith('transcript.') || t === 'sim.transcript' || t === 'sim.transcripts' || t === 'sim.image')) return false;
    try {
      if (!this.on && t.startsWith('transcript.')) throw this.host.error('unknown_command', `unknown command: "${t}"`);
      if (t === 'transcript.watch') ack(this.watch(a, send));
      else if (t === 'transcript.unwatch') {
        this.watches.delete(this.str(a, 'id'));
        ack();
      } else if (t === 'transcript.page') ack(this.page(a));
      else if (t === 'transcript.item') ack(this.item(a));
      else if (t === 'transcript.image') ack(this.image(a));
      else if (t === 'transcript.images') ack(this.images(a));
      else if (t === 'sim.image') ack(simImage(a as SimImageSpec));
      else if (t === 'sim.transcript') ack(this.sim(a));
      else if (t === 'sim.transcripts') ack({ watches: this.watches.size, ids: [...this.watches.keys()] });
      else throw this.host.error('unknown_command', `unknown command: "${t}"`);
      return true;
    } catch (e) {
      fail(e);
      return true;
    }
  }

  private str(a: Obj, k: string, optional = false): string {
    const v = a[k];
    if (optional && (v === undefined || v === '')) return '';
    if (typeof v !== 'string' || !v) throw this.host.error('bad_request', `bad args: ${k} must be a string`);
    return v;
  }

  private limit(a: Obj): number {
    const v = a.limit ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 500) throw this.host.error('bad_request', 'limit must be 1-500');
    return v || 200;
  }

  private worker(id: string): Worker {
    const w = this.host.worker(id);
    if (!w) throw this.host.error('unknown_worker', `unknown worker: "${id}"`);
    if (this.host.floor(w.session)?.state === 'asleep') throw this.host.error('invalid_state', `floor "${w.session}" is asleep`);
    return w;
  }

  private watch(a: Obj, send: Send): Obj {
    const id = this.str(a, 'id');
    const limit = this.limit(a);
    this.worker(id);
    const n = this.watches.size - (this.watches.has(id) ? 1 : 0);
    if (n >= SIM_MAX_TRANSCRIPT_WATCHES) throw this.host.error('capacity', `capacity: this connection already watches ${n} transcripts (--max-transcript-watches)`);
    const items = (this.timeline?.items ?? demoTimeline)(this.host.now());
    const top = items.reduce((m, it) => Math.max(m, it.seq), 0);
    (this.host.extra?.(id) ?? []).forEach((it, i) => items.push({ ...it, seq: top + i + 1 }));
    const watch: Watch = { send, items, sent: new Set() };
    this.watches.set(id, watch);
    const visible = items.filter((it) => !it.hidden);
    const from = visible.length > limit ? items.indexOf(visible[visible.length - limit] as TranscriptItem) : 0;
    const shown = items.slice(from);
    this.note(watch, shown);
    return { harness: 'claude', session: `sim-${id}`, version: '2.1.0', cursor: `c:${items[from]?.seq ?? 1}`, has_more: from > 0, pending: false, items: shown };
  }

  private watched(a: Obj): Watch {
    const id = this.str(a, 'id');
    const w = this.watches.get(id);
    if (!w) {
      this.worker(id);
      throw this.host.error('invalid_state', 'invalid state: this connection does not watch that transcript');
    }
    return w;
  }

  private page(a: Obj): Obj {
    const w = this.watched(a);
    const before = this.str(a, 'before', true);
    const agent = this.str(a, 'agent', true);
    this.limit(a);
    if (before && !/^c:[1-9]\d*$/.test(before)) throw this.host.error('bad_request', 'before must be a cursor');
    if (!agent) {
      if (!before) throw this.host.error('bad_request', 'before is needed (it is optional with agent)');
      const seq = Number(before.slice(2));
      const older = w.items.filter((it) => it.seq < seq);
      this.note(w, older);
      return { items: older, cursor: 'c:1', has_more: false };
    }
    if (agent !== SIM_SUBAGENT) throw this.host.error('not_found', `no transcript for subagent "${agent}"`);
    this.note(w, subagentItems());
    return { items: subagentItems(), cursor: 'c:1', has_more: false };
  }

  private item(a: Obj): Obj {
    const w = this.watched(a);
    const want = this.str(a, 'item');
    const agent = this.str(a, 'agent', true);
    const from = agent === SIM_SUBAGENT ? subagentItems() : agent ? null : w.items;
    const shown = from?.find((x) => x.id === want);
    if (!shown) throw this.host.error('not_found', `no item "${want}" in the transcript`);
    // #171: what the list cut, whole.
    const whole = agent ? undefined : this.timeline?.full().find((x) => x.id === want);
    const it = whole ? { ...whole, seq: shown.seq, ts: shown.ts } : shown;
    this.note(w, [it]);
    return { item: it };
  }

  private note(w: Watch, items: readonly TranscriptItem[]): void {
    for (const it of items) for (const r of refsOf(it)) if (r.hash) w.sent.add(r.hash);
  }

  private images(a: Obj): Obj {
    const w = this.watched(a);
    const refs = w.items.flatMap(refsOf);
    for (const r of refs) if (r.hash) w.sent.add(r.hash);
    return { images: refs };
  }

  private image(a: Obj): Obj {
    const hash = this.str(a, 'hash');
    // #98: the worker's current activity image is served to a connection on its floor, watched or not.
    const shown = !!hash && this.host.activityHash?.(this.str(a, 'id')) === hash;
    const w = shown ? (this.worker(this.str(a, 'id')), null) : this.watched(a);
    const size = this.str(a, 'size');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw this.host.error('bad_request', 'bad args: hash must be the sha256 of an image, in hex');
    if (size !== 'thumb' && size !== 'full') throw this.host.error('bad_request', 'bad args: size must be "thumb" or "full"');
    const img = IMAGES.get(hash);
    if (!(shown || w?.sent.has(hash)) || !img) throw this.host.error('not_found', 'no image with that hash was sent on this connection');
    if (size === 'full' && img.tooLarge) throw this.host.error('too_large', 'the image is over 12 MiB of base64');
    let bytes = img.bytes;
    let width = img.width;
    let height = img.height;
    if (size === 'thumb' && Math.max(width, height) > 480) {
      // Nearest-neighbour is enough for a stand-in.
      const k = 480 / Math.max(width, height);
      const tw = Math.max(1, Math.round(width * k));
      const th = Math.max(1, Math.round(height * k));
      const src = PNG.sync.read(bytes);
      const dst = new PNG({ width: tw, height: th });
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) src.data.copy(dst.data, (y * tw + x) * 4, (Math.floor(y / k) * width + Math.floor(x / k)) * 4, (Math.floor(y / k) * width + Math.floor(x / k)) * 4 + 4);
      bytes = PNG.sync.write(dst);
      width = tw;
      height = th;
    }
    return { mime: 'image/png', width, height, bytes: bytes.length, size, data: bytes.toString('base64') };
  }

  /** #57 (tools/fixture-ask.ts): pushes items / updates to a worker's watch, if it has one; false when not watched. */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): boolean {
    if (!this.watches.has(id)) return false;
    this.sim({ id, items, updates });
    return true;
  }

  /** The seq an item added to a worker's watch now gets (1 when not watched). */
  nextSeq(id: string): number {
    const w = this.watches.get(id);
    return (w?.items.reduce((m, it) => Math.max(m, it.seq), 0) ?? 0) + 1;
  }

  /** The item of a worker's watch, if it has it. */
  itemOf(id: string, item: string): TranscriptItem | undefined {
    return this.watches.get(id)?.items.find((it) => it.id === item);
  }

  private sim(a: Obj): Obj {
    const id = this.str(a, 'id');
    const w = this.watches.get(id);
    if (!w) throw this.host.error('invalid_state', `no transcript watch of "${id}"`);
    if (typeof a.close === 'string' && a.close) {
      this.close(id, a.close);
      return { closed: true };
    }
    const items = Array.isArray(a.items) ? (a.items as TranscriptItem[]) : [];
    const updates = Array.isArray(a.updates) ? (a.updates as TranscriptItem[]) : [];
    for (const it of [...items, ...updates]) {
      const at = w.items.findIndex((x) => x.id === it.id);
      if (at >= 0) w.items[at] = it;
      else w.items.push(it);
    }
    this.note(w, items);
    this.note(w, updates);
    w.send({ t: 'transcript.items', id, items, updates });
    return { pushed: items.length + updates.length };
  }

  private close(id: string, reason: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    this.watches.delete(id);
    w.send({ t: 'transcript.closed', id, reason });
  }

  /** World events end the watches they concern (as the bridge's syncTranscriptWatches). */
  onEvent(m: Obj): void {
    if (!this.watches.size || typeof m.seq !== 'number') return;
    if (m.t === 'worker.removed' && typeof m.id === 'string') this.close(m.id, 'worker_removed');
    else if (m.t === 'floor.upsert') {
      const f = m.floor as Floor | undefined;
      if (f?.state !== 'asleep') return;
      for (const id of [...this.watches.keys()]) if (this.host.worker(id)?.session === f.session) this.close(id, 'asleep');
    }
  }
}
