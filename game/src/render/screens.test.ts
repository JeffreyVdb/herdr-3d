import '../test/fakeCanvas';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { floorLayout } from '../world/layout';
import { FROZEN_CELLS, ScreenMeshes, type ScreenOwner } from './screens';

// #52: a frozen screen is a cell of one atlas, uploaded at most every 400 ms. A cell handed to a new owner keeps the
// previous owner's pixels on the GPU until the next upload, so the glass must not show it until then.

const canvas = document.createElement('canvas') as unknown as HTMLCanvasElement;
const A: ScreenOwner = { id: 'old', pane: 'p1' };
const B: ScreenOwner = { id: 'new', pane: 'p2' };

/** The real meshes, and per desk: whether its frozen instance is on the glass, and whose image the GPU has there. */
function harness(desks = 4) {
  const m = new ScreenMeshes(floorLayout(desks).slots);
  const inst = m.group.getObjectByName('screens.frozen') as THREE.InstancedMesh;
  const mat = new THREE.Matrix4();
  const visible = (desk: number) => {
    inst.getMatrixAt(desk, mat);
    return mat.determinant() !== 0;
  };
  // What the GPU holds per desk: the owner its image had when the atlas was last uploaded (version went up).
  const gpu = new Map<number, string | null>();
  let seen = m.atlasVersion();
  const update = (now: number) => {
    m.update(now);
    if (m.atlasVersion() === seen) return;
    seen = m.atlasVersion();
    gpu.clear();
    for (let d = 0; d < desks; d++) {
      const o = m.frozenOwner(d);
      if (o) gpu.set(d, `${o.id}@${o.pane}`);
    }
  };
  /** Every desk on the glass shows the image the GPU has for its current owner. */
  const honest = () => {
    for (let d = 0; d < desks; d++) {
      if (!visible(d)) continue;
      const o = m.frozenOwner(d);
      expect(o && gpu.get(d)).toBe(o && `${o.id}@${o.pane}`);
    }
  };
  return { m, visible, update, honest };
}

describe('ScreenMeshes frozen screens', () => {
  it('a frozen screen goes on the glass with the upload that carries its image', () => {
    const { m, visible, update, honest } = harness();
    m.freeze(0, canvas, A);
    expect(m.isFrozen(0)).toBe(true);
    expect(visible(0)).toBe(false);
    expect(m.shownOwner(0)).toBeNull();
    const v = m.atlasVersion();
    update(1000);
    expect(m.atlasVersion()).toBe(v + 1);
    expect(visible(0)).toBe(true);
    expect(m.shownOwner(0)).toEqual(A);
    honest();
  });

  it('a reused cell does not show the previous owner under the new one before its upload (the review probe)', () => {
    const { m, visible, update, honest } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    const v = m.atlasVersion();
    m.unfreeze(0);
    expect(visible(0)).toBe(false);
    m.freeze(0, canvas, B);
    update(1100);
    // Throttled: the GPU still has A's pixels in the cell, so B's frozen screen is not on the glass yet.
    expect(m.atlasVersion()).toBe(v);
    expect(m.frozenOwner(0)).toEqual(B);
    expect(visible(0)).toBe(false);
    expect(m.shownOwner(0)).toBeNull();
    honest();
    update(1400);
    expect(m.atlasVersion()).toBe(v + 1);
    expect(visible(0)).toBe(true);
    expect(m.shownOwner(0)).toEqual(B);
    honest();
  });

  it('the same goes for another desk taking the freed cell', () => {
    const { m, visible, update, honest } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    m.unfreeze(0);
    m.freeze(1, canvas, B);
    update(1100);
    expect(visible(1)).toBe(false);
    honest();
    update(1400);
    expect(visible(1)).toBe(true);
    honest();
  });

  it('re-freezing the same owner keeps its screen on the glass (its older image) until the upload', () => {
    const { m, visible, update, honest } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    m.freeze(0, canvas, A);
    update(1100);
    expect(visible(0)).toBe(true);
    honest();
    m.unfreeze(0);
    m.freeze(0, canvas, A);
    expect(visible(0)).toBe(true);
    honest();
  });

  it('a cell drawn by someone else since the last upload is not shown under the owner the GPU last had', () => {
    const { m, visible, update, honest } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    m.unfreeze(0);
    m.freeze(0, canvas, B);
    m.unfreeze(0);
    // The upload carries the free cell too: it now holds B's pixels on the GPU, not A's.
    update(1500);
    m.freeze(0, canvas, A);
    expect(visible(0)).toBe(false);
    honest();
    update(1900);
    expect(visible(0)).toBe(true);
    honest();
  });

  it('covered, a pending screen stays hidden and the upload does not uncover it', () => {
    const { m, visible, update } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    m.unfreeze(0);
    m.freeze(0, canvas, B);
    m.setCovered(0, true);
    m.setCovered(0, false);
    expect(visible(0)).toBe(false);
    m.setCovered(0, true);
    update(1400);
    expect(visible(0)).toBe(false);
    expect(m.shownOwner(0)).toEqual(B);
    m.setCovered(0, false);
    expect(visible(0)).toBe(true);
  });

  it('unfreezing a pending screen keeps it off the glass after the upload', () => {
    const { m, visible, update } = harness();
    m.freeze(0, canvas, A);
    update(1000);
    m.unfreeze(0);
    m.freeze(0, canvas, B);
    m.unfreeze(0);
    update(1400);
    expect(visible(0)).toBe(false);
    expect(m.shownOwner(0)).toBeNull();
  });

  it('the least recently frozen screen gives up its cell: hidden, and the new owner waits for the upload', () => {
    const desks = FROZEN_CELLS + 1;
    const { m, visible, update, honest } = harness(desks);
    for (let d = 0; d < FROZEN_CELLS; d++) m.freeze(d, canvas, { id: `w${d}`, pane: `p${d}` });
    update(1000);
    expect(visible(0)).toBe(true);
    m.freeze(FROZEN_CELLS, canvas, B);
    expect(m.isFrozen(0)).toBe(false);
    expect(visible(0)).toBe(false);
    expect(visible(FROZEN_CELLS)).toBe(false);
    honest();
    update(1400);
    expect(visible(FROZEN_CELLS)).toBe(true);
    honest();
  });
});
