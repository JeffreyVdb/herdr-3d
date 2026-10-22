import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { holdDisposals } from './disposeHold';

const dispatch = THREE.EventDispatcher.prototype.dispatchEvent;

/** What three's renderer does with a work item it picked before a yield: listens for the dispose that already fired. */
function lateListener(target: THREE.EventDispatcher<{ dispose: object }>): { fired: number } {
  const seen = { fired: 0 };
  const on = () => {
    seen.fired++;
    target.removeEventListener('dispose', on);
  };
  target.addEventListener('dispose', on);
  return seen;
}

describe('holdDisposals (#141)', () => {
  it('fires a dispose again once the work is done, for whoever started listening after it', async () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const tex = new THREE.Texture();
    const late: Array<{ fired: number }> = [];
    await holdDisposals(async () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
      tex.dispose();
      await Promise.resolve();
      // The compile reaches them now: it builds them and listens for their dispose.
      for (const t of [mesh, mesh.geometry, mesh.material as THREE.Material, tex]) late.push(lateListener(t));
      expect(late.map((l) => l.fired)).toEqual([0, 0, 0, 0]);
    });
    expect(late.map((l) => l.fired)).toEqual([1, 1, 1, 1]);
  });

  it('a listener there before the dispose hears it once', async () => {
    const mat = new THREE.MeshBasicMaterial();
    const early = lateListener(mat);
    await holdDisposals(async () => mat.dispose());
    expect(early.fired).toBe(1);
  });

  it('leaves other events and disposes after the work alone', async () => {
    const mat = new THREE.MeshBasicMaterial();
    let other = 0;
    mat.addEventListener('other' as 'dispose', () => other++);
    await holdDisposals(async () => {
      mat.dispatchEvent({ type: 'other' as 'dispose' });
    });
    expect(other).toBe(1);
    const after = lateListener(mat);
    mat.dispose();
    expect(after.fired).toBe(1);
    const again = lateListener(mat);
    await holdDisposals(async () => {});
    expect(again.fired).toBe(0);
  });

  it('fires them again also when the work throws, and stops recording', async () => {
    const mat = new THREE.MeshBasicMaterial();
    let late: { fired: number } | null = null;
    await expect(
      holdDisposals(async () => {
        mat.dispose();
        late = lateListener(mat);
        throw new Error('lost');
      }),
    ).rejects.toThrow('lost');
    expect(late).toEqual({ fired: 1 });
    expect(THREE.EventDispatcher.prototype.dispatchEvent).toBe(dispatch);
    const after = lateListener(mat);
    await holdDisposals(async () => {});
    expect(after.fired).toBe(0);
  });

  it('a work that throws before returning a promise ends its hold too', async () => {
    const mat = new THREE.MeshBasicMaterial();
    let endOther!: () => void;
    const other = holdDisposals(() => new Promise<void>((r) => (endOther = r)));
    await expect(
      holdDisposals((): Promise<void> => {
        throw new Error('at once');
      }),
    ).rejects.toThrow('at once');
    mat.dispose();
    const late = lateListener(mat);
    endOther();
    await other;
    expect(late).toEqual({ fired: 1 });
    expect(THREE.EventDispatcher.prototype.dispatchEvent).toBe(dispatch);
  });

  it('a hold inside a hold fires them once, when the outer one ends', async () => {
    const mat = new THREE.MeshBasicMaterial();
    let late: { fired: number } | null = null;
    await holdDisposals(async () => {
      await holdDisposals(async () => {
        mat.dispose();
        late = lateListener(mat);
      });
      expect(late).toEqual({ fired: 0 });
    });
    expect(late).toEqual({ fired: 1 });
  });

  it('a hold started inside one that ends first keeps recording until it ends too (#146)', async () => {
    const mat = new THREE.MeshBasicMaterial();
    let endOuter!: () => void;
    let endInner!: () => void;
    const outer = holdDisposals(() => new Promise<void>((r) => (endOuter = r)));
    const inner = holdDisposals(() => new Promise<void>((r) => (endInner = r)));
    endOuter();
    await outer;
    expect(THREE.EventDispatcher.prototype.dispatchEvent).not.toBe(dispatch);
    mat.dispose();
    const late = lateListener(mat);
    endInner();
    await inner;
    expect(late).toEqual({ fired: 1 });
    expect(THREE.EventDispatcher.prototype.dispatchEvent).toBe(dispatch);
  });

  /**
   * Every order two and three holds can start and end in (nested, crossed, one after the other), each ending its work
   * or throwing, with a material disposed before, between each step and after: what was disposed while any hold ran
   * is fired again once, when the last of those running then ends; nothing else is.
   */
  type Step = { hold: number; start: boolean };
  /** The orders of `steps` in which each hold starts before it ends. */
  function orders(left: Step[], started = new Set<number>()): Step[][] {
    if (!left.length) return [[]];
    return left.flatMap((step, i) => {
      if (!step.start && !started.has(step.hold)) return [];
      const rest = left.filter((_, j) => j !== i);
      const next = step.start ? new Set([...started, step.hold]) : started;
      return orders(rest, next).map((o) => [step, ...o]);
    });
  }
  const cases = [2, 3].flatMap((n) => {
    const steps = Array.from({ length: n }, (_, hold) => [
      { hold, start: true },
      { hold, start: false },
    ]).flat();
    return orders(steps).flatMap((order) =>
      Array.from({ length: 1 << n }, (_, mask) => ({ order, throws: (hold: number) => (mask >> hold) & 1 })),
    );
  });

  it(`overlapping holds fire each dispose again once, after the last running one (${cases.length} cases)`, async () => {
    expect(cases.length).toBe(6 * 4 + 90 * 8);
    for (const { order, throws } of cases) {
      const name = order.map((s) => `${s.start ? 's' : throws(s.hold) ? 'x' : 'e'}${s.hold}`).join(' ');
      const ends: Array<() => void> = [];
      const runs: Array<Promise<unknown>> = [];
      /** Per material: how often a listener there before its dispose and one added after it heard it. */
      const disposals: Array<{ before: { n: number }; after: { n: number }; held: boolean; done: boolean }> = [];
      let running = 0;
      const dispose = () => {
        const mat = new THREE.MeshBasicMaterial();
        // three's own: removed when it fires.
        const before = { n: 0 };
        const once = () => {
          before.n++;
          mat.removeEventListener('dispose', once);
        };
        mat.addEventListener('dispose', once);
        mat.dispose();
        // Kept, to count every fire after the dispose.
        const after = { n: 0 };
        mat.addEventListener('dispose', () => after.n++);
        disposals.push({ before, after, held: running > 0, done: false });
      };
      const check = (at: string) => {
        expect(THREE.EventDispatcher.prototype.dispatchEvent === dispatch, `${name} @${at}`).toBe(running === 0);
        expect(
          disposals.map((d) => [d.before.n, d.after.n]),
          `${name} @${at}`,
        ).toEqual(disposals.map((d) => [1, d.held && d.done ? 1 : 0]));
      };
      dispose();
      for (const [i, step] of order.entries()) {
        if (step.start) {
          const end = (res: () => void, rej: (e: Error) => void) => (throws(step.hold) ? rej(new Error('x')) : res());
          runs[step.hold] = holdDisposals(
            () => new Promise<void>((res, rej) => (ends[step.hold] = () => end(res, rej))),
          ).catch(() => 'threw');
          running++;
        } else {
          ends[step.hold]!();
          expect(await runs[step.hold], name).toBe(throws(step.hold) ? 'threw' : undefined);
          // The last running hold has ended: what was disposed since the first is fired again now, not before.
          if (--running === 0) for (const d of disposals) d.done = true;
        }
        check(`${i}`);
        dispose();
        check(`${i}+`);
      }
    }
  });
});
