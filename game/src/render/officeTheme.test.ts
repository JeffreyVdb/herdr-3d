import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Floor } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildingPlan } from '../world/building';
import { floorLayout, openingsFor, outlineOf, type Opening } from '../world/layout';
import { FloorPool } from './floorPool';
import { officeLamps, OfficeView } from './office';
import { OutsideView } from './outside';
import { OFFICE, OFFICE_UBUNTU, officePalette, type LobbyPalette, type OfficePalette } from './palette';
import type { UiThemeId } from '../ui/uiTheme';

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

// The lobby is baked into the building's outside, so the outside is built in the theme.

const outline = outlineOf([8]);
const plan = buildingPlan(outline, 1, floorLayout(8, outline).fireDoor);
const openings: readonly Opening[] = openingsFor(outline.width, outline.depth);
const look = (theme?: UiThemeId) => ({ name: 'Kiswe', tint: 0xffb8b0, floors: [{ id: 'top', name: 'Top', asleep: false }], ...(theme ? { theme } : {}) });

/** The vertex colours of the lobby's room (the street's are in another mesh), as the hexes the Baker was given (up-facing and flat faces are unshaded). */
function baked(o: OutsideView): Set<number> {
  const out = new Set<number>();
  const c = (o.group.getObjectByName('outside.lobby') as THREE.Mesh).geometry.getAttribute('color');
  for (let i = 0; i < c.count; i++) out.add(new THREE.Color(c.getX(i), c.getY(i), c.getZ(i)).getHex());
  return out;
}

/** What the lobby draws unshaded in its own colours: the terrazzo, its border, the mat, the carpet, the ceiling. */
const FLAT = ['floor', 'border', 'mat', 'ceiling'] as const satisfies ReadonlyArray<keyof LobbyPalette>;

describe('the lobby in the UI theme', () => {
  it('the lobby palette: Quiet’s is what the lobby always had, Ubuntu’s its own', () => {
    expect(OFFICE.reception).toMatchObject({ floor: 0xece5d7, border: 0xd7cdb8, wall: 0xf4f1ea, navy: 0x24406e, mat: 0x2c3a5e, ink: '#1c2540', accent: 0xffc233, accentText: '#ffc233' });
    for (const k of ['floor', 'border', 'wall', 'ceiling', 'navy', 'mat', 'ink', 'accent', 'accentText'] as const) expect(OFFICE.reception[k], k).not.toBe(OFFICE_UBUNTU.reception[k]);
  });

  it('an Ubuntu lobby has its room, carpet and accents in Ubuntu’s colours and none of Quiet’s', () => {
    const quiet = baked(new OutsideView(plan, openings, look()));
    const ubuntu = baked(new OutsideView(plan, openings, look('ubuntu')));
    const each = (P: OfficePalette) => [...FLAT.map((k) => P.reception[k]), P.rug, P.reception.accent];
    for (const h of each(OFFICE)) expect(quiet.has(h), `quiet ${h.toString(16)}`).toBe(true);
    for (const h of each(OFFICE_UBUNTU)) expect(ubuntu.has(h), `ubuntu ${h.toString(16)}`).toBe(true);
    for (const h of each(OFFICE)) expect(ubuntu.has(h), `no quiet ${h.toString(16)} in ubuntu`).toBe(false);
  });

  it('the lobby’s departures board and the elevator are dressed too', () => {
    const housing = (o: OutsideView) => {
      const cols = new Set<number>();
      o.lobby.group.traverse((m) => m instanceof THREE.Mesh && cols.add((m.material as THREE.MeshBasicMaterial).color?.getHex()));
      return cols;
    };
    expect(housing(new OutsideView(plan, openings, look())).has(OFFICE.screens.housing)).toBe(true);
    const ubuntu = housing(new OutsideView(plan, openings, look('ubuntu')));
    expect(ubuntu.has(OFFICE_UBUNTU.screens.housing)).toBe(true);
    expect(ubuntu.has(OFFICE.screens.housing)).toBe(false);
  });

  it('an outside is Quiet’s without a theme, and carries the one it was built in', () => {
    expect(new OutsideView(plan, openings, look()).theme).toBe('quiet');
    expect(new OutsideView(plan, openings, look('ubuntu')).theme).toBe('ubuntu');
  });
});
