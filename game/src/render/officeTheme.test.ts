import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Floor } from '../net/protocol';
import { WorldStore } from '../world/store';
import { FloorPool } from './floorPool';
import { officeLamps, OfficeView } from './office';
import { OFFICE, OFFICE_UBUNTU, officePalette, type OfficePalette } from './palette';

// The office wears the UI theme: Quiet's navy and yellow interior, Ubuntu's aubergine and orange one.

const floor: Floor = { session: 'top', state: 'running', building: 'b1', index: 0, desks: 8 };

function world(): WorldStore {
  const s = new WorldStore(1000);
  s.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors: [floor], workers: [] } });
  return s;
}

/** Every plain material colour in the office (vertex-coloured art and the radio, a product in its own colours, aside), as hex. */
function colours(o: OfficeView): Set<number> {
  const out = new Set<number>();
  const radio = o.root.getObjectByName('radio');
  o.root.traverse((m) => {
    if (!(m instanceof THREE.Mesh) || (radio && m.parent === radio)) return;
    for (const mat of [m.material].flat() as THREE.Material[]) {
      const c = (mat as THREE.MeshToonMaterial).color;
      if (c && !mat.vertexColors && !(mat as THREE.MeshToonMaterial).map) out.add(c.getHex());
    }
  });
  return out;
}

/** The named office's colours that differ between the themes. */
const changed = (keys: ReadonlyArray<keyof OfficePalette>) => keys.filter((k) => OFFICE[k] !== OFFICE_UBUNTU[k]);
const DRESS = ['floor', 'lobby', 'wall', 'boardWall', 'ceiling', 'deskTop', 'deskLeg', 'chair', 'chairBase', 'rug', 'sofa', 'cushion', 'accent'] as const;
/** Of those, the ones nothing else in the room shares (the wall clock's cap is the accent's yellow, the crew's things too). */
const ROOM = DRESS.filter((k) => k !== 'chairBase' && k !== 'accent');

describe('the office in the UI theme', () => {
  it('officePalette: Quiet is the office it always was, Ubuntu its own', () => {
    expect(officePalette('quiet')).toBe(OFFICE);
    expect(officePalette('ubuntu')).toBe(OFFICE_UBUNTU);
    expect(changed(DRESS)).toEqual([...DRESS]);
  });

  it('an Ubuntu office has its walls, floor, furniture and accents in Ubuntu’s colours and none of Quiet’s', () => {
    const quiet = colours(new OfficeView(world().floorView('top')!, { shadows: false }));
    const ubuntu = colours(new OfficeView(world().floorView('top')!, { shadows: false, theme: 'ubuntu' }));
    for (const k of DRESS) {
      expect(quiet.has(OFFICE[k] as number), `quiet ${k}`).toBe(true);
      expect(ubuntu.has(OFFICE_UBUNTU[k] as number), `ubuntu ${k}`).toBe(true);
    }
    for (const k of ROOM) expect(ubuntu.has(OFFICE[k] as number), `no quiet ${k} in ubuntu`).toBe(false);
    // The screens' bezels too.
    expect(quiet.has(OFFICE.screens.housing)).toBe(true);
    expect(ubuntu.has(OFFICE_UBUNTU.screens.housing)).toBe(true);
    expect(ubuntu.has(OFFICE.screens.housing)).toBe(false);
  });

  it('the pooled desks and chairs take each office’s colours: a switch of theme, and back, on the same kit', () => {
    const pool = new FloorPool(officeLamps);
    const store = world();
    const seen: Array<Set<number>> = [];
    for (const theme of ['quiet', 'ubuntu', 'quiet'] as const) {
      const o = new OfficeView(store.floorView('top')!, { shadows: false, pool, theme });
      expect(o.theme).toBe(theme);
      seen.push(colours(o));
      o.dispose();
    }
    expect(pool.kits().length).toBeGreaterThan(0);
    for (const [i, P] of [OFFICE, OFFICE_UBUNTU, OFFICE].entries()) {
      for (const k of ['deskTop', 'deskLeg', 'chair', 'chairBase'] as const) expect(seen[i]?.has(P[k]), `${i} ${k}`).toBe(true);
    }
    expect(seen[1]?.has(OFFICE.chair)).toBe(false);
    expect(seen[2]?.has(OFFICE_UBUNTU.chair)).toBe(false);
  });

  it('without a theme an office is Quiet’s (the city’s low desks and the tests)', () => {
    expect(new OfficeView(world().floorView('top')!, { shadows: false }).theme).toBe('quiet');
  });
});
