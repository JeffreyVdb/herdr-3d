import { describe, expect, it } from 'vitest';
import { HIRE_GOTO_POLL_MS, HIRE_GOTO_WAIT_MS, waitForHire, type HireGotoWait } from './hireGoto';

/** A clock and a timer queue by hand: `tick(ms)` moves time on and runs what came due. */
const rig = (o: Partial<HireGotoWait> = {}) => {
  let t = 1000;
  let queue: Array<{ at: number; fn: () => void }> = [];
  const log = { go: 0, end: 0, checks: 0 };
  const w: HireGotoWait = {
    check: () => (log.checks++, 'wait'),
    acted: () => false,
    go: () => void log.go++,
    end: () => void log.end++,
    now: () => t,
    schedule: (fn, ms) => void queue.push({ at: t + ms, fn }),
    ...o,
  };
  const tick = (ms: number) => {
    t += ms;
    const due = queue.filter((q) => q.at <= t);
    queue = queue.filter((q) => q.at > t);
    for (const q of due) q.fn();
  };
  /** Time passes without the timer running (a throttled tab): the callback comes in late, in one go. */
  const late = (ms: number) => tick(ms);
  return { w, tick, late, log, pending: () => queue.length, set: (v: Partial<HireGotoWait>) => Object.assign(w, v) };
};

describe('waitForHire', () => {
  it('goes at once when the world is ready', () => {
    const r = rig({ check: () => 'go' });
    waitForHire(r.w);
    expect(r.log).toMatchObject({ go: 1, end: 1 });
    expect(r.pending()).toBe(0);
  });

  it('polls until ready, then goes once', () => {
    let ready = false;
    const r = rig({ check: () => (ready ? 'go' : 'wait') });
    waitForHire(r.w);
    r.tick(HIRE_GOTO_POLL_MS);
    expect(r.log.go).toBe(0);
    ready = true;
    r.tick(HIRE_GOTO_POLL_MS);
    r.tick(HIRE_GOTO_POLL_MS);
    expect(r.log).toMatchObject({ go: 1, end: 1 });
  });

  it('gives up for good at the deadline', () => {
    const r = rig();
    waitForHire(r.w);
    for (let i = 0; i < HIRE_GOTO_WAIT_MS / HIRE_GOTO_POLL_MS + 5; i++) r.tick(HIRE_GOTO_POLL_MS);
    expect(r.log).toMatchObject({ go: 0, end: 1 });
    expect(r.pending()).toBe(0);
  });

  it('#116 R3: a look that comes in after the deadline does not act on a readiness that came meanwhile', () => {
    let ready = false;
    const r = rig({ check: () => (ready ? 'go' : 'wait') });
    waitForHire(r.w);
    ready = true;
    r.late(HIRE_GOTO_WAIT_MS + 500); // the throttled timer fires at t > 6 s, the worker is ready
    expect(r.log).toMatchObject({ go: 0, end: 1 });
  });

  it('drops when the world says so', () => {
    let v: 'wait' | 'drop' = 'wait';
    const r = rig({ check: () => v });
    waitForHire(r.w);
    v = 'drop';
    r.tick(HIRE_GOTO_POLL_MS);
    expect(r.log).toMatchObject({ go: 0, end: 1 });
    expect(r.pending()).toBe(0);
  });

  it('#116 R1: once the player acted it is gone for good, even if the state looks fine again at the next look', () => {
    let acted = false;
    const r = rig({ acted: () => acted });
    waitForHire(r.w);
    acted = true;
    r.tick(HIRE_GOTO_POLL_MS);
    acted = false; // (they walked back to where they stood)
    r.set({ check: () => 'go' });
    r.tick(HIRE_GOTO_POLL_MS * 3);
    expect(r.log).toMatchObject({ go: 0, end: 1 });
  });

  it('the player acting is checked before readiness at the same look', () => {
    const r = rig({ check: () => 'go', acted: () => true });
    waitForHire(r.w);
    expect(r.log).toMatchObject({ go: 0, end: 1 });
  });

  it('cancel stops it, once', () => {
    const r = rig();
    const cancel = waitForHire(r.w);
    cancel();
    cancel();
    r.set({ check: () => 'go' });
    r.tick(HIRE_GOTO_POLL_MS * 3);
    expect(r.log).toMatchObject({ go: 0, end: 1 });
  });
});
