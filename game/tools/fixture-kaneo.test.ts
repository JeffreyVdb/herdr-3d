import { describe, expect, it } from 'vitest';
import type { BoardIssues, Snapshot, WorldEvent } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SimWorld, type SimOptions } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m4 (floors herdr-3d with a GitHub repo, pastry without one), manual timers. */
function rig(o: Partial<SimOptions> = {}) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {}, ...o });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') store.applyEvent(m as unknown as WorldEvent);
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    const got = () => out.slice(from);
    return { got, ack: () => got().find((m) => m.t === 'ack' && m.req_id === req_id) as Msg | undefined, err: () => got().find((m) => m.t === 'error' && m.req_id === req_id) as Msg | undefined };
  };
  const settle = () => {
    while (timers.length) (timers.shift() as () => void)();
  };
  const issues = () => out.filter((m) => m.t === 'board.issues') as unknown as BoardIssues[];
  return { sim, store, cmd, settle, out, issues };
}

const URL = 'https://kaneo.example.test';
const connect = (r: ReturnType<typeof rig>, key = 'sim-key') => {
  r.cmd('kaneo.test', { url: URL, key });
  return r.cmd('kaneo.set', { url: URL, key, default_workspace: 'ws-studio' });
};
const linkKaneo = (r: ReturnType<typeof rig>, project = 'p-herdr', ws = 'ws-studio') => r.cmd('floor.settings.set', { session: 'herdr-3d', tracker: 'kaneo', kaneo: { workspace_id: ws, project_id: project } });

describe('the simulated Kaneo connection (#184)', () => {
  it('starts off, never sends a key, and saves only a tested draft', () => {
    const r = rig();
    expect(r.store.kaneo.state?.state).toBe('off');
    expect(r.cmd('kaneo.set', { url: URL, key: 'k1' }).err()?.code).toBe('test_required');
    expect(r.cmd('kaneo.test', { url: URL, key: 'bad-key' }).err()?.code).toBe('unauthorized');
    expect(r.cmd('kaneo.test', { url: 'https://offline.example.test', key: 'k1' }).err()?.code).toBe('unreachable');
    expect(r.cmd('kaneo.test', { url: 'ftp://x', key: 'k1' }).err()?.code).toBe('bad_url');
    expect((r.cmd('kaneo.test', { url: URL, key: 'empty-key' }).ack()?.data as Msg).workspaces).toEqual([]);
    const set = connect(r);
    expect(set.ack()).toBeTruthy();
    expect(JSON.stringify(r.out)).not.toContain('sim-key');
    expect(r.store.kaneo.state).toMatchObject({ state: 'ready', key_set: true, generation: 1, default_workspace: { name: 'Studio' } });
    // The saved key only for the saved instance.
    expect(r.cmd('kaneo.test', { url: 'https://elsewhere.example.test' }).err()?.code).toBe('key_required');
    expect(r.cmd('kaneo.test', { url: `${URL}/api` }).ack()).toBeTruthy();
  });

  it('lists projects with the saved connection: locked, empty and slow workspaces', () => {
    const r = rig();
    expect(r.cmd('kaneo.workspaces', {}).err()?.code).toBe('not_configured');
    connect(r);
    expect(((r.cmd('kaneo.projects', { workspace_id: 'ws-studio' }).ack()?.data as Msg).projects as Msg[]).map((p) => p.name)).toEqual(['herdr-3d', 'Website']);
    expect(r.cmd('kaneo.projects', { workspace_id: 'ws-locked' }).err()?.code).toBe('forbidden');
    expect((r.cmd('kaneo.projects', { workspace_id: 'ws-empty' }).ack()?.data as Msg).projects).toEqual([]);
    const slow = r.cmd('kaneo.projects', { workspace_id: 'ws-slow' });
    expect(slow.ack()).toBeUndefined();
    r.settle();
    expect(slow.ack()).toBeTruthy();
  });

  it('checks a floor’s link and keeps the GitHub settings', () => {
    const r = rig();
    expect(linkKaneo(r).err()?.code).toBe('not_configured');
    connect(r);
    expect(linkKaneo(r, 'p-garden').err()?.code).toBe('bad_request');
    expect(linkKaneo(r, 'gone').err()?.code).toBe('not_found');
    expect(linkKaneo(r).ack()).toBeTruthy();
    const f = r.store.floorView('herdr-3d');
    expect(f?.settings).toMatchObject({ tracker: 'kaneo', kaneo: { workspace_name: 'Studio', project_name: 'herdr-3d' } });
    r.cmd('floor.settings.set', { session: 'herdr-3d', tracker: null });
    expect(r.store.floorView('herdr-3d')?.settings?.kaneo?.project_id).toBe('p-herdr');
  });

  it('a Kaneo floor’s board: virtual columns, two final columns, no close, a stale reorder, a truncated board', () => {
    const r = rig();
    connect(r);
    linkKaneo(r);
    const w = r.cmd('board.watch', { session: 'herdr-3d' });
    expect(w.ack()?.data).toEqual({ enabled: true });
    const b = r.issues().at(-1)!;
    expect(b.provider).toBe('kaneo');
    expect(b.columns.filter((c) => c.kind).map((c) => c.kind)).toEqual(['planned', 'archived']);
    expect(b.columns.filter((c) => c.done).length).toBe(2);
    expect(b.capabilities?.close).toBe(false);
    expect(b.cards.every((c) => c.updated_at === 0)).toBe(true);
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: b.cards[0]!.id, reason: 'completed', confirm: true }).err()?.code).toBe('unsupported');
    r.cmd('sim.kaneo', { stale: true });
    expect(r.cmd('issue.set_status', { session: 'herdr-3d', id: 'task-hrd-5', column: 'to-do', after: null }).err()?.code).toBe('stale');
    expect(r.cmd('issue.set_status', { session: 'herdr-3d', id: 'task-hrd-5', column: 'done' }).ack()).toBeTruthy();
    r.settle();
    expect(r.issues().at(-1)!.cards.find((c) => c.id === 'task-hrd-5')?.state).toBe('closed');
    linkKaneo(r, 'p-web');
    r.cmd('board.watch', { session: 'herdr-3d' });
    expect(r.issues().at(-1)!.truncated).toBe(true);
    expect(r.cmd('issue.set_status', { session: 'herdr-3d', id: 'task-web-1', column: 'done', after: null }).err()?.code).toBe('unsupported');
  });

  it('a refused key pauses the board until a passing re-test', () => {
    const r = rig();
    connect(r);
    linkKaneo(r);
    r.cmd('board.watch', { session: 'herdr-3d' });
    r.cmd('sim.kaneo', { fail: 'unauthorized' });
    r.settle();
    expect(r.issues().at(-1)).toMatchObject({ stale: true, error_code: 'unauthorized' });
    expect(r.store.kaneo.state?.state).toBe('paused');
    expect(r.cmd('board.refresh', { session: 'herdr-3d' }).ack()?.data).toEqual({ queued: false });
    r.cmd('kaneo.test', {});
    r.settle();
    expect(r.store.kaneo.state?.state).toBe('ready');
    expect(r.issues().at(-1)?.stale).toBe(false);
  });

  it('a run on a Kaneo task: an item ticket, named by its link in the prompt (#102), in the preview and the start', () => {
    const r = rig({ stepMs: 20 });
    connect(r);
    linkKaneo(r);
    const link = `${URL}/dashboard/workspace/ws-studio/project/p-herdr/task/task-hrd-4`;
    const prep = r.cmd('run.prepare', { session: 'herdr-3d', work_item: { provider: 'kaneo', id: 'task-hrd-4' }, extra: 'Keep it small.' }).ack()?.data as Msg;
    expect(prep.ticket).toEqual({ kind: 'item', url: link, item: { provider: 'kaneo', id: 'task-hrd-4', key: 'HRD-4', title: 'A task with a long description', url: link }, provider_name: 'Kaneo' });
    expect(prep.label).toBe('ORCH|hrd-4');
    const prompt = String(prep.prompt);
    expect(prompt.startsWith(`/write-code ${link}\n\nTeam:\n`)).toBe(true);
    expect(prompt.endsWith('\n\nKeep it small.')).toBe(true);
    for (const not of ['Step 40', 'A task with a long description', 'not a GitHub issue', 'with gh', 'Move the ticket status']) expect(prompt).not.toContain(not);
    const started = r.cmd('run.start', { session: 'herdr-3d', desk_index: 12, work_item: { provider: 'kaneo', id: 'task-hrd-4' }, preset: prep.preset, orch: prep.orch, extra: 'Keep it small.' });
    r.settle();
    expect(started.err()).toBeUndefined();
    expect((started.ack()?.data as Msg).prompt).toBe(prompt);
  });

  it('#102: a task’s description can be slow to read, or fail, and comes back at once again', () => {
    const r = rig();
    connect(r);
    linkKaneo(r);
    expect(r.cmd('sim.kaneo', { detail: 'fail' }).ack()?.data).toMatchObject({ detail: 'fail' });
    expect(r.cmd('issue.get', { session: 'herdr-3d', id: 'task-hrd-4' }).err()?.code).toBe('provider_failed');
    r.cmd('sim.kaneo', { detail: 'slow' });
    const slow = r.cmd('issue.get', { session: 'herdr-3d', id: 'task-hrd-4' });
    expect(slow.ack()).toBeUndefined();
    r.settle();
    expect((slow.ack()?.data as Msg).body).toContain('Step 40');
    r.cmd('sim.kaneo', { detail: null });
    expect((r.cmd('issue.get', { session: 'herdr-3d', id: 'task-hrd-4' }).ack()?.data as Msg).body).toContain('Step 40');
  });
});
