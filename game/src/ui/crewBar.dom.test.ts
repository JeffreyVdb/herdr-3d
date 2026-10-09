// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { crewAria, crewBarKey, crewLine } from './crewBar';

const w = (over: Partial<Worker>): Worker => ({ id: 'f', session: 'lab', workspace_id: 'w1', label: 'CODE|x|1|r1', role: 'code', status: 'done', agent_kind: 'claude', name: 'Ember', desk_index: 1, orch_id: 'o', ...over });
const orch = w({ id: 'o', label: 'ORCH|x', role: 'orch', name: 'Cog', desk_index: 0, orch_id: undefined as never });

function view(f: Worker) {
  const s = new WorldStore(0);
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: ['lab'], floors: [{ session: 'lab', state: 'running', building: null, index: null, desks: 8 }], workers: [orch, f] } };
  s.applySnapshot(snap);
  return s.workerView('f')!;
}

describe('the crew line of a report request (#215)', () => {
  const text = `${'x'.repeat(600)} Or accept the existing evidence: ORCHESTRATOR ACCEPTANCE.`;

  it('says it is a report request and who decides; the whole text is the title and the label', () => {
    const v = view(w({ report: { state: 'ready', at: 1, input_required: text } }));
    const el = crewLine(v)!.querySelector<HTMLElement>('.crew-ask')!;
    expect(el.textContent?.startsWith('Report request · Asked of the orchestrator (Cog) — ')).toBe(true);
    expect(el.title).toContain('ORCHESTRATOR ACCEPTANCE');
    expect(crewAria(v)).toContain('Report request · Asked of the orchestrator (Cog)');
    expect(crewAria(v)).toContain('ORCHESTRATOR ACCEPTANCE');
    expect(crewLine(v)!.textContent).not.toContain('Waiting for an answer');
  });

  it('says where the whole request is when the line cannot show it, and not for a short one (#215)', () => {
    const long = view(w({ report: { state: 'ready', at: 1, input_required: text } }));
    expect(crewLine(long)!.querySelector('.crew-more')?.textContent).toBe('Shift+N: full request');
    expect(crewAria(long)).toContain('Press Shift+N for the full request');
    const lines = view(w({ report: { state: 'ready', at: 1, input_required: 'Port?\nOr 8080?' } }));
    expect(crewLine(lines)!.querySelector('.crew-more')).not.toBeNull();
    const short = view(w({ report: { state: 'ready', at: 1, input_required: 'Port?' } }));
    expect(crewLine(short)!.querySelector('.crew-more')).toBeNull();
    expect(crewAria(short)).not.toContain('full request');
  });

  it('a resolved one is a quiet note, not an alert, and the bar redraws on the change', () => {
    const open = view(w({ report: { state: 'ready', at: 1, input_required: text } }));
    const done = view(w({ report: { state: 'ready', at: 1, input_required: text, input_resolved: { by: 'orchestrator', note: 'accepted as AC4 evidence' } } }));
    expect(done.display).toBe('done');
    const line = crewLine(done)!;
    expect(line.querySelector('.crew-ask')).toBeNull();
    expect(line.querySelector('.crew-resolved')?.textContent).toBe('Request resolved by orchestrator: accepted as AC4 evidence');
    expect(crewBarKey(done)).not.toEqual(crewBarKey(open));
  });

  it('asks of you without an orchestrator, or when the report says so', () => {
    const lone = view(w({ orch_id: undefined as never, report: { state: 'ready', at: 1, input_required: 'Port?' } }));
    expect(crewLine(lone)!.querySelector('.crew-ask')?.textContent).toBe('Report request · Asked of you — Port?');
    const user = view(w({ report: { state: 'ready', at: 1, input_required: 'Port?', input_for: 'user' } }));
    expect(crewLine(user)!.querySelector('.crew-ask')?.textContent).toContain('Asked of you');
  });
});
