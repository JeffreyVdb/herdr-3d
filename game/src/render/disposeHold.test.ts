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
});
