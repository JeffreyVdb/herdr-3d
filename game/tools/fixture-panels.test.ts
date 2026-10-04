import { describe, expect, it } from 'vitest';
import type { Changes, Snapshot, WorkerCommands, WorkerFiles, WorldEvent } from '../src/net/protocol';
import { changesView } from '../src/world/changes';
import { WorldStore } from '../src/world/store';
import { SIM_DIFF_CAP, SIM_FILES, simChanges, simCommands, simFiles } from './fixture-panels';
import { loadFixture } from './fixture-server';
import { SimWorld, type SimOptions } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m5, a store fed by it, and manual timers (with their delays). */
function rig(fail?: string, extra: Partial<SimOptions> = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const { snapshot } = loadFixture('demo-m5');
  const sim = new SimWorld(snapshot as never, { fail, stepMs: 100, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {}, ...extra });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') {
      expect(m.seq).toBe(store.seq + 1);
      store.applyEvent(m as unknown as WorldEvent);
    }
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    return { req_id, got: () => out.slice(from) };
  };
  const reply = (req_id: string) => out.find((m) => m.req_id === req_id);
  const tick = () => {
    const t = timers.shift();
    if (!t) throw new Error('nothing scheduled');
    t.fn();
  };
  const settle = (max = 50) => {
    for (let i = 0; i < max && timers.length; i++) tick();
  };
  const byName = (name: string) => {
    const w = [...store.workers.values()].find((x) => x.name === name);
    if (!w) throw new Error(`no ${name}`);
    return w;
  };
  return { sim, store, out, cmd, reply, tick, settle, timers, send, byName };
}

describe('SimWorld worker.prompt (M5)', () => {
  it('starts an idle agent working, acks, then it is done', () => {
    const r = rig();
    const pebble = r.byName('Pebble');
    const c = r.cmd('worker.prompt', { id: pebble.id, text: 'Write the M5 section of CONTRIBUTING\nand keep it short' });
    expect(c.got()).toEqual([]);
    r.tick();
    expect(r.byName('Pebble')).toMatchObject({ status: 'working', title: 'Write the M5 section of CONTRIBUTING' });
    expect(r.reply(c.req_id)).toEqual({ t: 'ack', req_id: c.req_id, data: { queued: false, retried: false } });
    r.tick();
    expect(r.byName('Pebble').status).toBe('done');
  });

  it('queues a prompt for a working agent and runs it when the turn ends', () => {
    const r = rig();
    const nibble = r.byName('Nibble');
    const c = r.cmd('worker.prompt', { id: nibble.id, text: 'Then update the docs' });
    expect(c.got()).toEqual([{ t: 'ack', req_id: c.req_id, data: { queued: true, retried: false } }]);
    // A prompt to an idle one: its turn ends and the queued-free agent is done; Nibble keeps working meanwhile.
    const p = r.cmd('worker.prompt', { id: r.byName('Pebble').id, text: 'x' });
    r.tick();
    expect(r.reply(p.req_id)).toMatchObject({ t: 'ack' });
    r.tick();
    expect(r.byName('Nibble').status).toBe('working');
  });

  it('refuses plain shells, asleep floors and bad text; scripts failures', () => {
    const r = rig();
    expect(r.cmd('worker.prompt', { id: r.byName('Sprout').id, text: 'ls' }).got()[0]).toMatchObject({ code: 'invalid_state', message: expect.stringContaining('plain shell') });
    expect(r.cmd('worker.prompt', { id: r.byName('Muffin').id, text: 'hi' }).got()[0]).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('worker.prompt', { id: r.byName('Tofu').id, text: 'yes' }).got()[0]).toMatchObject({ code: 'invalid_state', message: expect.stringContaining('blocked') });
    expect(r.cmd('worker.prompt', { id: r.byName('Pebble').id, text: '' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.prompt', { id: r.byName('Pebble').id, text: 'x'.repeat(16 * 1024 + 1) }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.prompt', { id: 'nope', text: 'x' }).got()[0]).toMatchObject({ code: 'unknown_worker' });
    const f = rig('prompt_failed');
    const c = f.cmd('worker.prompt', { id: f.byName('Pebble').id, text: 'x' });
    f.tick();
    expect(f.reply(c.req_id)).toMatchObject({ t: 'error', code: 'prompt_failed' });
    expect(f.byName('Pebble').status).toBe('idle');
    const t = rig('prompt_retried');
    const d = t.cmd('worker.prompt', { id: t.byName('Pebble').id, text: 'x' });
    t.tick();
    expect(t.reply(d.req_id)).toMatchObject({ data: { queued: false, retried: true } });
  });
});

describe('SimWorld worker.answer (M5)', () => {
  it('answers with the question hash: the question goes, the agent works, then is done', () => {
    const r = rig();
    const tofu = r.byName('Tofu');
    expect(tofu.question?.kind).toBe('permission');
    const c = r.cmd('worker.answer', { id: tofu.id, hash: tofu.question?.hash, choice: 1 });
    expect(c.got().map((m) => m.t)).toEqual(['worker.upsert', 'ack']);
    expect(r.reply(c.req_id)).toMatchObject({ data: { sent: ['1'], resolved: true } });
    expect(r.byName('Tofu')).toMatchObject({ status: 'working' });
    expect(r.byName('Tofu').question).toBeUndefined();
    r.tick();
    expect(r.byName('Tofu').status).toBe('done');
  });

  it('a "No" choice or a cancel leaves it idle', () => {
    const r = rig();
    const s = r.byName('Sprocket');
    const c = r.cmd('worker.answer', { id: s.id, hash: s.question?.hash, choice: 3 });
    expect(r.reply(c.req_id)).toMatchObject({ data: { sent: ['3'], resolved: true } });
    expect(r.byName('Sprocket').status).toBe('idle');
    const t = r.byName('Waffle');
    const d = r.cmd('worker.answer', { id: t.id, hash: t.question?.hash, cancel: true });
    expect(r.reply(d.req_id)).toMatchObject({ data: { sent: ['esc'], resolved: true } });
    expect(r.byName('Waffle').status).toBe('idle');
  });

  it("answers Claude's trust dialog with arrows from the cursor, like the bridge", () => {
    const r = rig();
    const t = r.byName('Tater');
    expect(t.question?.choices.map((c) => c.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    const c = r.cmd('worker.answer', { id: t.id, hash: t.question?.hash, choice: 2 });
    expect(r.reply(c.req_id)).toMatchObject({ data: { sent: ['down', 'enter'], resolved: true } });
    // Trusted, Claude Code waits for its first prompt (seen live).
    expect(r.byName('Tater').status).toBe('idle');
  });

  it('a wrong hash is stale, after the current question went out; other errors like the bridge', () => {
    const r = rig();
    const q = r.byName('Quibble');
    const c = r.cmd('worker.answer', { id: q.id, hash: 'ffffffffffffffff', choice: 1 });
    expect(c.got().map((m) => m.t)).toEqual(['worker.upsert', 'error']);
    expect(c.got()[1]).toMatchObject({ code: 'stale' });
    expect(r.byName('Quibble').status).toBe('blocked');
    expect(r.cmd('worker.answer', { id: q.id, hash: q.question?.hash, choice: 7 }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.answer', { id: q.id, hash: q.question?.hash, choice: 1, cancel: true }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.answer', { id: r.byName('Nibble').id, hash: 'x', choice: 1 }).got()[0]).toMatchObject({ code: 'invalid_state' });
    const u = rig('answer_unresolved');
    const qq = u.byName('Quibble');
    const d = u.cmd('worker.answer', { id: qq.id, hash: qq.question?.hash, choice: 3 });
    expect(u.reply(d.req_id)).toMatchObject({ data: { sent: ['3'], resolved: false } });
    expect(u.byName('Quibble').status).toBe('blocked');
  });
});

describe('SimWorld worker.changes (M5)', () => {
  const data = (r: ReturnType<typeof rig>, name: string) => {
    const c = r.cmd('worker.changes', { id: r.byName(name).id });
    r.tick();
    const m = r.reply(c.req_id);
    if (m?.t !== 'ack') throw new Error(JSON.stringify(m));
    return m.data as Changes;
  };

  it('a working worker: staged, unstaged, untracked and committed files, the stat and per-file diffs', () => {
    const r = rig();
    const c = data(r, 'Pixel');
    expect(c).toMatchObject({ branch: 'h3d/pixel-m2-go', upstream: 'origin/h3d/pixel-m2-go', ahead: 2, behind: 0, base: { ref: 'origin/main' }, truncated: false, omitted: [] });
    const v = changesView(c);
    expect(v.files.map((f) => [f.path, f.state.chips.map((x) => x.kind).join('+')])).toEqual([
      ['game/src/world/next.ts', 'staged'],
      ['docs/img/m5-prompt.png', 'staged'],
      ['game/src/app.ts', 'unstaged'],
      ['game/src/ui/hud.ts', 'unstaged'],
      ['notes/todo.md', 'untracked'],
      ['game/src/world/usage.ts', 'committed'],
      ['docs/protocol.md', 'committed'],
    ]);
    // Every file's counts agree with its diff, and the stat is the tracked files' total.
    for (const f of v.files) {
      if (f.binary) continue;
      expect(f.diff, f.path).not.toBeNull();
      expect(f.diff?.kinds.filter((k) => k === 'add').length, f.path).toBe(f.insertions);
      expect(f.diff?.kinds.filter((k) => k === 'del').length, f.path).toBe(f.deletions);
    }
    const tracked = c.files.filter((f) => !f.untracked);
    expect(c.stat).toEqual({ files: tracked.length, insertions: tracked.reduce((s, f) => s + f.insertions, 0), deletions: tracked.reduce((s, f) => s + f.deletions, 0) });
    expect(c.diff_bytes).toBe(Buffer.byteLength(c.diff));
  });

  it('cuts a big diff at 256 KiB, whole files in order, and lists the rest', () => {
    const r = rig();
    const c = data(r, 'Gizmo');
    expect(c.truncated).toBe(true);
    expect(c.omitted).toEqual(['perf/trace-city240.json', 'perf/trace-floor96.json']);
    expect(Buffer.byteLength(c.diff)).toBeLessThanOrEqual(SIM_DIFF_CAP);
    expect(Buffer.byteLength(c.diff)).toBeGreaterThan(200 * 1024);
    expect(c.diff_bytes).toBeGreaterThan(1.5 * 1024 * 1024);
    expect(changesView(c).files.filter((f) => f.diff).map((f) => f.path)).toEqual(['game/src/render/city.ts', 'game/fixtures/perf-city240-replay.jsonl', 'docs/perf.md']);
  });

  it('clean, blocked and done workers; not a repo; a scripted failure', () => {
    const r = rig();
    expect(data(r, 'Pebble').files).toEqual([]);
    expect(data(r, 'Tofu')).toMatchObject({ ahead: 1, files: [{ path: 'game/src/world/usage.ts', index: '.', worktree: '.' }] });
    expect(data(r, 'Marble')).toMatchObject({ branch: 'h3d/timers-notify', ahead: 0, behind: 3 });
    expect(data(r, 'Marble').files.map((f) => f.path)).toEqual(['src/units.ts', 'README.md']);
    expect(r.cmd('worker.changes', { id: r.byName('Inky').id }).got()[0]).toMatchObject({ code: 'not_a_repo' });
    expect(r.cmd('worker.changes', { id: r.byName('Muffin').id }).got()[0]).toMatchObject({ code: 'invalid_state' });
    const f = rig('changes_failed');
    const c = f.cmd('worker.changes', { id: f.byName('Pixel').id });
    f.tick();
    expect(f.reply(c.req_id)).toMatchObject({ code: 'changes_failed' });
  });

  it('is deterministic', () => {
    const r = rig();
    const w = r.sim.snapshot() as { world: { workers: Array<{ name: string }> } };
    const pixel = (w.world.workers.find((x) => x.name === 'Pixel') ?? {}) as never;
    expect(simChanges(pixel)).toEqual(simChanges(pixel));
  });
});

describe('SimWorld worker.usage (M5)', () => {
  it('sends working agents’ usage every usageMs, and keeps it in the snapshot', () => {
    const r = rig(undefined, { usageMs: 250 });
    r.sim.start(r.send);
    expect(r.timers.map((t) => t.ms)).toEqual([250]);
    const before = r.byName('Nibble').usage?.tokens ?? 0;
    const from = r.out.length;
    r.tick();
    const usage = r.out.slice(from).filter((m) => m.t === 'worker.usage');
    // Every working agent with usage on a running floor: 9 on herdr-3d, 6 in pastry, 1 in the lot.
    expect(usage.length).toBe(16);
    expect(r.byName('Nibble').usage?.tokens).toBeGreaterThan(before);
    expect(r.byName('Nibble').usage?.cost_usd_est).toBeGreaterThan(0);
    // Idle and asleep workers keep theirs.
    expect(usage.some((m) => m.id === r.byName('Pebble').id || m.id === r.byName('Muffin').id)).toBe(false);
    expect(r.timers.map((t) => t.ms)).toEqual([250]);
    const snap = r.sim.snapshot() as { world: { workers: Array<{ name: string; usage?: { tokens: number } }> } };
    expect(snap.world.workers.find((x) => x.name === 'Nibble')?.usage?.tokens).toBe(r.byName('Nibble').usage?.tokens);
  });

  it('is off with usageMs 0', () => {
    const r = rig(undefined, { usageMs: 0 });
    r.sim.start(r.send);
    expect(r.timers).toEqual([]);
  });
});

describe('SimWorld worker.commands (#136)', () => {
  it("answers each harness's commands, skills and custom commands", () => {
    const r = rig();
    for (const [name, harness] of [['Nibble', 'claude'], ['Pixel', 'codex']] as const) {
      const c = r.cmd('worker.commands', { id: r.byName(name).id });
      expect(c.got()).toEqual([]);
      r.tick();
      const m = r.reply(c.req_id);
      expect(m).toMatchObject({ t: 'ack', data: { partial: false } });
      const data = (m as { data: WorkerCommands }).data;
      expect(data).toEqual(simCommands(harness));
      for (const e of data.commands) expect(Object.keys(e).sort()).toEqual(['argument_hint', 'description', 'kind', 'name']);
    }
    expect(new Set(simCommands('claude')?.commands.map((e) => e.kind))).toEqual(new Set(['command', 'skill', 'custom']));
  });

  it('fails like the bridge', () => {
    const r = rig();
    expect(r.cmd('worker.commands', { id: r.byName('Sprout').id }).got()[0]).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('worker.commands', { id: r.byName('Muffin').id }).got()[0]).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('worker.commands', { id: 'nope' }).got()[0]).toMatchObject({ code: 'unknown_worker' });
    expect(r.cmd('worker.commands', { id: r.byName('Nibble').id, cwd: '/etc' }).got()[0]).toMatchObject({ code: 'bad_request' });
  });
});

describe('SimWorld worker.files (#137)', () => {
  const files = (r: ReturnType<typeof rig>, name: string, args: Record<string, unknown>) => {
    const c = r.cmd('worker.files', { id: r.byName(name).id, ...args });
    expect(c.got()).toEqual([]);
    r.tick();
    const m = r.reply(c.req_id);
    expect(m).toMatchObject({ t: 'ack' });
    return (m as { data: WorkerFiles }).data;
  };

  it('answers ranked matches with code point indices, verbatim paths and derived directories', () => {
    const r = rig();
    const d = files(r, 'Nibble', { query: 'my file' });
    expect(d).toMatchObject({ source: 'git', reason: null });
    expect(d.files[0]).toEqual({ path: 'docs/my file #1?.md', kind: 'file', indices: [5, 6, 7, 8, 9, 10, 11] });
    for (const m of d.files) expect(Object.keys(m).sort()).toEqual(['indices', 'kind', 'path']);
    // Code points, not UTF-16 units: the rocket is one.
    const [rocket] = files(r, 'Nibble', { query: 'launch' }).files;
    expect(rocket).toEqual({ path: 'docs/🚀 launch.md', kind: 'file', indices: [7, 8, 9, 10, 11, 12] });
    expect(Array.from(rocket?.path ?? '').slice(7, 13).join('')).toBe('launch');
    // A directory: `@game/src/ui` picks the folder.
    expect(files(r, 'Nibble', { query: 'src/ui' }).files[0]).toMatchObject({ path: 'game/src/ui', kind: 'dir' });
    // Smart case.
    expect(files(r, 'Nibble', { query: 'button' }).files.map((m) => m.path)).toEqual(['game/src/ui/Button.ts']);
    expect(files(r, 'Nibble', { query: 'BUTTON' }).files).toEqual([]);
    // An empty query: shallow first, directories first; limit default, 0, cap.
    const all = files(r, 'Nibble', { query: '' });
    expect(all.files.slice(0, 6).map((m) => `${m.path}:${m.kind}`)).toEqual(['cmd:dir', 'docs:dir', 'game:dir', 'internal:dir', 'README.md:file', 'go.mod:file']);
    expect(all.files.every((m) => m.indices.length === 0)).toBe(true);
    expect(files(r, 'Nibble', { query: '', limit: 3 }).files).toHaveLength(3);
    expect(files(r, 'Nibble', { query: 'o', limit: 0 }).files.length).toBeLessThanOrEqual(30);
    expect(simFiles('', 1000).length).toBe(SIM_FILES.length + 11);
    expect(files(r, 'Pixel', { query: '', limit: 1000 }).files).toHaveLength(SIM_FILES.length + 11);
  });

  it('outside git with no rg: empty with a reason', () => {
    const r = rig();
    expect(files(r, 'Inky', { query: 'a' })).toEqual({ files: [], source: 'none', reason: expect.stringContaining('rg') });
  });

  it('fails like the bridge', () => {
    const r = rig();
    const id = r.byName('Nibble').id;
    expect(r.cmd('worker.files', { id, query: 'a', limit: -1 }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.files', { id, query: 'é'.repeat(257) }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.files', { id, query: 'a', cwd: '/etc' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('worker.files', { id: r.byName('Muffin').id, query: 'a' }).got()[0]).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('worker.files', { id: 'nope', query: 'a' }).got()[0]).toMatchObject({ code: 'unknown_worker' });
  });
});
