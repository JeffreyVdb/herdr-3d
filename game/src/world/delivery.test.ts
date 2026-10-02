import { describe, expect, it } from 'vitest';
import type { Worker } from '../net/protocol';
import { crewView } from './crew';
import { DeliveryBook, deliveryKey, reportArrived, reportFact, TRAY_CAP, type ReportFact } from './delivery';

const fact = (id: string, at: number, orch = 'o1', extra: Partial<ReportFact> = {}): ReportFact => ({ id, session: 's', desk: 1, orch, at, tone: null, ...extra });

describe('reportArrived', () => {
  it('pending → ready, or a new ready report, is an arrival; the same one again is not', () => {
    expect(reportArrived({ state: 'pending' }, { state: 'ready', at: 5 })).toBe(true);
    expect(reportArrived(undefined, { state: 'ready', at: 5 })).toBe(true);
    expect(reportArrived({ state: 'ready', at: 5 }, { state: 'ready', at: 5 })).toBe(false);
    expect(reportArrived({ state: 'ready', at: 5 }, { state: 'ready', at: 9 })).toBe(true);
    expect(reportArrived({ state: 'ready', at: 5 }, { state: 'pending' })).toBe(false);
    expect(reportArrived({ state: 'pending' }, { state: 'invalid', at: 1 })).toBe(false);
  });
});

describe('reportFact', () => {
  const w = (report: Worker['report'], extra: Partial<Worker> = {}): Worker => ({ id: 'f1', session: 's', workspace_id: 'w', label: 'REVIEW|x|1|r1', status: 'done', role: 'review', orch_id: 'o1', report, ...extra }) as Worker;
  const view = (worker: Worker) => ({ worker, desk: 3, crew: crewView(worker, true) });
  it('a ready report of a freelancer to its orchestrator, with the verdict’s tone', () => {
    expect(reportFact(view(w({ state: 'ready', at: 7, verdict: 'CHANGES_REQUIRED', blockers: 2 })))).toEqual({ id: 'f1', session: 's', desk: 3, orch: 'o1', at: 7, tone: 'changes' });
    expect(reportFact(view(w({ state: 'ready', at: 7, summary: 'done' })))?.tone).toBeNull();
  });
  it('none for a pending one, one that asks (it stays at the desk), no orchestrator, or an orchestrator itself', () => {
    expect(reportFact(view(w({ state: 'pending' })))).toBeNull();
    expect(reportFact(view(w({ state: 'ready', at: 7, input_required: 'Which port?' })))).toBeNull();
    const lone = w({ state: 'ready', at: 7 });
    delete lone.orch_id;
    expect(reportFact(view(lone))).toBeNull();
    expect(reportFact(view(w({ state: 'ready', at: 7 }, { role: 'orch' })))).toBeNull();
  });
});

describe('DeliveryBook', () => {
  it('a live report starts exactly one delivery (keyed by worker and report time); seeing it again starts none', () => {
    const b = new DeliveryBook();
    expect(b.add(fact('f1', 10), true)).toBe('queued');
    expect(b.add(fact('f1', 10), true)).toBe('known');
    expect(b.next('o1')?.key).toBe(deliveryKey('f1', 10));
    expect(b.next('o1')).toBeNull();
    expect(b.add(fact('f1', 10), true)).toBe('known');
    expect(b.pending('o1')).toHaveLength(1);
  });

  it('a report already ready in a snapshot starts none: the folder is on the tray', () => {
    const b = new DeliveryBook();
    b.sync([fact('f1', 10), fact('f2', 11)]);
    expect(b.next('o1')).toBeNull();
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f1', 'f2']);
    // The same report in a later snapshot: still none, and nothing doubled.
    b.sync([fact('f1', 10), fact('f2', 11)]);
    expect(b.tray('o1')).toHaveLength(2);
    expect(b.add(fact('f1', 10), true)).toBe('known');
  });

  it('a second report to the same orchestrator queues behind the first; another orchestrator’s does not wait', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), true);
    b.add(fact('f3', 12, 'o2'), true);
    const first = b.next('o1')!;
    expect(first.id).toBe('f1');
    expect(b.next('o1')).toBeNull();
    expect(b.next('o2')?.id).toBe('f3');
    b.land(first.key);
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f1']);
    expect(b.next('o1')?.id).toBe('f2');
  });

  it('a delivery that could not start goes back to the front of the queue', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), true);
    const e = b.next('o1')!;
    b.unstart(e.key);
    expect(b.next('o1')?.id).toBe('f1');
  });

  it('nobody watching: everything on the floor resolves at once, onto the tray', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), true);
    b.next('o1');
    b.add(fact('f3', 12, 'o2', { session: 'other' }), true);
    expect(b.resolve('s').map((e) => e.id).sort()).toEqual(['f1', 'f2']);
    expect(b.tray('o1')).toHaveLength(2);
    expect(b.pending()).toHaveLength(1);
    b.resolve();
    expect(b.pending()).toHaveLength(0);
  });

  it('shows the last five folders, oldest under; a newer report of a freelancer replaces its older folder', () => {
    const b = new DeliveryBook();
    for (let i = 0; i < TRAY_CAP + 3; i++) b.add(fact(`f${i}`, i), false);
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f3', 'f4', 'f5', 'f6', 'f7']);
    b.add(fact('f7', 99), false);
    expect(b.tray('o1').filter((e) => e.id === 'f7')).toHaveLength(1);
    expect(b.tray('o1').at(-1)?.at).toBe(99);
  });

  it('a folder goes when its freelancer’s workspace closes', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), false);
    b.add(fact('f2', 11), false);
    expect(b.close('f1')).toEqual([]);
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f2']);
    b.dropOrch('o1');
    expect(b.size).toBe(0);
  });

  it('closed mid-delivery: the folder ends on the tray, and goes once the freelancer has left', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), true);
    const e = b.next('o1')!;
    expect(b.close('f1')).toEqual([e.key]);
    expect(b.tray('o1').map((x) => x.id)).toEqual(['f1']);
    // The queue moves on; a queued delivery that closes before it started lands too.
    expect(b.close('f2')).toEqual([deliveryKey('f2', 11)]);
    expect(b.tray('o1').map((x) => x.id)).toEqual(['f1', 'f2']);
    b.settle('f1');
    b.settle('f2');
    expect(b.tray('o1')).toEqual([]);
    expect(b.busy('f1')).toBe(false);
  });

  it('closed while its delivery walk goes on after the folder landed: the folder stays until the freelancer has left', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), false);
    const e = b.next('o1')!;
    b.land(e.key);
    // The walk (key) is still going: its folder stays (a landed one goes at once, `close('f1')` without a walk).
    expect(b.close('f1', e.key)).toEqual([]);
    expect(b.tray('o1').map((x) => `${x.id}@${x.at}`)).toEqual(['f1@10', 'f2@11']);
    expect(b.get(e.key)?.leaving).toBe(true);
    b.settle('f1');
    expect(b.tray('o1').map((x) => x.id)).toEqual(['f2']);
  });

  it('a snapshot overtakes a walk and forgets the gone', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), false);
    b.next('o1');
    b.sync([fact('f1', 10)]);
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f1']);
    expect(b.busy('f1')).toBe(false);
  });

  it('a floor with a delivery under way starts no other (one walk at a time on a floor); another floor’s is free', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11, 'o2'), true);
    b.add(fact('f3', 12, 'o3', { session: 'other' }), true);
    const busy = b.activeSessions();
    expect([...busy]).toEqual([]);
    expect(b.next('o1', busy)?.id).toBe('f1');
    busy.add('s');
    expect(b.next('o2', busy)).toBeNull();
    expect(b.next('o3', busy)?.id).toBe('f3');
    expect(b.activeSessions()).toEqual(new Set(['s', 'other']));
    // When the first has landed, the second goes; it was never lost.
    b.land(deliveryKey('f1', 10));
    expect(b.next('o2', b.activeSessions())?.id).toBe('f2');
  });

  it('a reconnect snapshot with the report pending, then ready again with the same time: it does not play again, its folder is back on the tray', () => {
    const b = new DeliveryBook();
    expect(b.add(fact('f1', 10), true)).toBe('queued');
    b.next('o1');
    b.land(deliveryKey('f1', 10));
    // The snapshot has f1 in the world with a pending report: no ready facts.
    b.sync([], new Set(['f1', 'o1']));
    expect(b.tray('o1')).toEqual([]);
    expect(b.add(fact('f1', 10), true)).toBe('tray');
    expect(b.pending()).toEqual([]);
    expect(b.tray('o1').map((e) => e.id)).toEqual(['f1']);
    expect(b.next('o1')).toBeNull();
    // A genuinely new report still plays.
    expect(b.add(fact('f1', 20), true)).toBe('queued');
    expect(b.next('o1')?.at).toBe(20);
  });

  it('an older report replaced by a newer one does not replay if its time comes round again', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), false);
    b.add(fact('f1', 20), false);
    expect(b.add(fact('f1', 10), true)).toBe('tray');
    expect(b.pending()).toEqual([]);
  });

  it('what was played is forgotten with its worker: gone from a snapshot, or removed', () => {
    const b = new DeliveryBook();
    b.add(fact('f1', 10), true);
    b.add(fact('f2', 11), true);
    b.sync([], new Set(['f2']));
    expect(b.add(fact('f2', 11), true)).toBe('tray');
    expect(b.add(fact('f1', 10), true)).toBe('queued');
    b.forget('f2');
    expect(b.add(fact('f2', 11), true)).toBe('known');
    b.close('f2');
    b.forget('f2');
    expect(b.add(fact('f2', 11), true)).toBe('queued');
  });
});
