import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSnapshot, isWorldEvent, parseMessage, type Snapshot } from '../net/protocol';
import { childTree, type ChildTreeNode } from './children';
import { WorldStore } from './store';

// #22: the child-agent fixtures end to end, the game's half. internal/childagents/testdata/<name>.json are the scripts and
// the trees each worker must end with; game/fixtures/children-<name>.jsonl the frames a bridge sends a client while it
// plays one (written by the Go test TestChildFixturesEndToEnd, which checks the same trees on its side). Fed through the
// decoder and the world store, they make the same trees here (#144: a running child's last_activity_at aside, which the
// snapshot has but no event sends alone).

const SCRIPTS = resolve(import.meta.dirname, '../../../internal/childagents/testdata');
const FRAMES = resolve(import.meta.dirname, '../../fixtures');

/** The bridge's `childagentstest.Node`: what a client shows of a child, without the row ids. */
interface Node {
  native_id?: string;
  provider: string;
  parent: string;
  name?: string;
  type?: string;
  description?: string;
  state: string;
  source: string;
  started_at?: number;
  last_activity_at?: number;
  ended_at?: number;
  transcript: string;
  children?: Node[];
}

interface Script {
  workers: Array<{ name: string; agent_session: string }>;
  expect: Record<string, Node[]>;
}

function canonical(tree: ChildTreeNode[]): Node[] {
  return tree.map(({ child: c, children }) => {
    const n: Node = { provider: c.provider, parent: c.parent, state: c.state, source: c.source, transcript: c.transcript };
    for (const k of ['native_id', 'name', 'type', 'description', 'started_at', 'last_activity_at', 'ended_at'] as const) {
      if (c[k] !== undefined) (n as unknown as Record<string, unknown>)[k] = c[k];
    }
    if (children.length) n.children = canonical(children);
    return n;
  });
}

/** #144: a tree without a running child's `last_activity_at`: no `child.upsert` says that alone, so the frames may lag it. */
const quietRunning = (tree: Node[]): Node[] =>
  tree.map(({ last_activity_at, children, ...n }) => ({ ...n, ...(n.state !== 'running' && last_activity_at !== undefined ? { last_activity_at } : {}), ...(children ? { children: quietRunning(children) } : {}) }));

const names = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort();

describe('#22 child-agent fixtures, bridge frames → decoder → store', () => {
  it('has every script and its frames', () => {
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const n of names) expect(readdirSync(FRAMES)).toContain(`children-${n}.jsonl`);
  });

  for (const name of names) {
    it(name, () => {
      const script = JSON.parse(readFileSync(join(SCRIPTS, `${name}.json`), 'utf8')) as Script;
      const frames = readFileSync(join(FRAMES, `children-${name}.jsonl`), 'utf8').trim().split('\n');
      const store = new WorldStore(0);
      const [first, ...rest] = frames.map((l) => parseMessage(l));
      expect(first && isSnapshot(first)).toBe(true);
      const snap = first as Snapshot;
      store.applySnapshot(snap, 0);
      expect(store.children.known).toBe(true);
      let lastSeq = snap.seq;
      for (const m of rest) {
        expect(m && isWorldEvent(m), JSON.stringify(m)).toBe(true);
        if (!m || !isWorldEvent(m)) continue;
        expect(m.seq).toBe(lastSeq + 1); // one stream, in seq order
        lastSeq = m.seq;
        store.applyEvent(m, 0);
      }
      // Worker ids by workspace, from the snapshot (a removed worker is no longer in the store).
      const ids = new Map(snap.world.workers.map((w) => [w.workspace_id, w.id]));
      for (const [ws, want] of Object.entries(script.expect)) {
        const id = ids.get(ws);
        expect(id, ws).toBeDefined();
        const children = store.children.of(id!);
        for (const c of children) expect(c.generation, `${ws} ${c.id}`).toBe(store.children.generation(id!));
        expect(quietRunning(canonical(childTree(children))), ws).toEqual(quietRunning(want));
      }
    });
  }
});
