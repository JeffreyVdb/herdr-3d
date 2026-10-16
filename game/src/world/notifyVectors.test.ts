import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker } from '../net/protocol';
import { crewRole } from './crew';
import { inboxQueue, inboxReason } from './inbox';
import { WorldStore } from './store';

// #11: the bridge notifies with its own port of the inbox rule (internal/notify). Both are pinned by one file,
// internal/notify/testdata/inbox_vectors.json, written by `go test ./internal/server -run TestNotifyInboxVectors
// -update-notify-vectors`: each worker goes through the game's real WorldStore.workerView, inboxReason and inboxQueue
// here and must come out as the Go side says.
interface Vector {
  name: string;
  asleep: boolean;
  worker: Worker;
  expect: { display: string; reason: string; since: number; candidate: boolean; candidate_with_freelancers: boolean };
}

const file = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../internal/notify/testdata/inbox_vectors.json'), 'utf8')) as { vectors: Vector[] };

const snapshot = (workers: Worker[]): Snapshot => ({
  t: 'world.snapshot',
  seq: 1,
  world: {
    buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['awake', 'sleepy'] }],
    unassigned: [],
    floors: [
      { id: 'awake', session: 'awake', state: 'running', building: 'b1', index: 0 },
      { id: 'sleepy', session: 'sleepy', state: 'asleep', building: 'b1', index: 1 },
    ],
    workers,
  },
});

describe('the inbox rule, as the bridge notifies by it (#11)', () => {
  const store = new WorldStore(0);
  store.applySnapshot(snapshot(file.vectors.map((v) => v.worker)));

  it('has vectors on both floors', () => {
    expect(file.vectors.length).toBeGreaterThan(30);
    expect(file.vectors.some((v) => v.asleep)).toBe(true);
  });

  for (const v of file.vectors) {
    it(v.name, () => {
      const view = store.workerView(v.worker.id);
      expect(view).not.toBeNull();
      if (!view) return;
      const cand = [{ id: view.worker.id, floor: view.worker.floor ?? view.worker.session, building: 'b1', display: view.display, since: view.since, desk: view.desk, name: view.name, role: crewRole(view.worker) }];
      expect({
        display: view.display,
        reason: inboxReason(view),
        since: view.since,
        candidate: inboxQueue(cand, { freelancers: false }).length === 1,
        candidate_with_freelancers: inboxQueue(cand, { freelancers: true }).length === 1,
      }).toEqual(v.expect);
    });
  }
});
