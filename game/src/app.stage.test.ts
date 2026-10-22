import './test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { App } from './app';

/**
 * #146: the first city's staged compile (`App.stageCity`) and what `h3d.ready` waits for (`App.cityReady`). No App test
 * builds a whole App (it needs a renderer and a page): these take its prototype and give it the parts it reads.
 */

interface Inside {
  city: { furniture: THREE.Object3D[] };
  r: { info: { calls: number }; compileAsync(o: THREE.Object3D, cam: THREE.Camera, scene: THREE.Scene): Promise<void> };
  cityCam: THREE.PerspectiveCamera;
  store: { snapshots: number };
  frames: number;
  mode: 'city' | 'floor';
  stageCity(): Promise<void>;
}

/** What a cold floor ride's compile (`App.warmUp`, #141) reads and sets. */
interface Ride {
  office: { root: THREE.Object3D };
  walk: { scene: THREE.Scene };
  fpCam: THREE.PerspectiveCamera;
  staging: boolean;
  warming: boolean;
  warmUp(): Promise<void>;
}

/** Two furniture groups of two meshes each, one culled; compileAsync records what was visible when it picked. */
function harness() {
  const groups = [0, 1].map(() => {
    const g = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      m.frustumCulled = i === 0;
      g.add(m);
    }
    return g;
  });
  const picked: Array<{ visible: boolean; culled: boolean[] }> = [];
  const finish: Array<(err?: Error) => void> = [];
  const scene = new THREE.Scene();
  const app = Object.create(App.prototype) as App;
  const inside = app as unknown as Inside;
  Object.assign(inside, {
    city: { scene, furniture: groups },
    r: {
      info: { calls: 0 },
      compileAsync: (o: THREE.Object3D, _cam: THREE.Camera, target: THREE.Scene) => {
        expect(target).toBe(scene);
        picked.push({ visible: o.visible, culled: o.children.map((c) => c.frustumCulled) });
        return new Promise<void>((res, rej) => finish.push((err) => (err ? rej(err) : res())));
      },
    },
    cityCam: new THREE.PerspectiveCamera(),
    store: { snapshots: 1 },
    frames: 0,
    mode: 'city',
    cityBuiltAt: -1,
    staging: false,
    stagedAt: -1,
  });
  return { app, inside, groups, picked, finish };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('App.stageCity (#146)', () => {
  it('compiles the furniture as it is, hides it while the shell draws, then shows it; ready once it is drawn', async () => {
    const h = harness();
    const done = h.inside.stageCity();
    // Picked visible and unculled, so compileAsync builds every mesh; hidden and culled as before at once.
    expect(h.picked).toEqual([
      { visible: true, culled: [false, false] },
      { visible: true, culled: [false, false] },
    ]);
    expect(h.groups.map((g) => g.visible)).toEqual([false, false]);
    expect(h.groups.map((g) => g.children.map((c) => c.frustumCulled))).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(h.inside.r.info.calls).toBe(1);
    // The shell's frames: drawn, not ready.
    h.inside.frames = 3;
    expect(h.app.cityDrawn).toBe(true);
    expect(h.app.cityReady).toBe(false);
    h.finish[0]!();
    await flush();
    expect(h.groups.map((g) => g.visible)).toEqual([false, false]); // both groups, together
    h.finish[1]!();
    await done;
    expect(h.groups.map((g) => g.visible)).toEqual([true, true]);
    expect(h.app.cityReady).toBe(false); // not drawn with them yet
    h.inside.frames = 4;
    expect(h.app.cityReady).toBe(true);
  });

  it('a compile that fails still shows the furniture and lets ready come', async () => {
    const h = harness();
    const done = h.inside.stageCity();
    h.finish[0]!(new Error('device lost'));
    h.finish[1]!();
    await expect(done).rejects.toThrow('device lost');
    expect(h.groups.map((g) => g.visible)).toEqual([true, true]);
    h.inside.frames = 1;
    expect(h.app.cityReady).toBe(true);
  });

  it('no snapshot yet: not ready, whatever the frames', () => {
    const h = harness();
    h.inside.store.snapshots = 0;
    h.inside.frames = 9;
    expect(h.app.cityReady).toBe(false);
    h.inside.store.snapshots = 1;
    expect(h.app.cityReady).toBe(true); // no city built (an empty first snapshot does not stage): as before #146
  });

  it('the city counts as drawn only in the city view', async () => {
    const h = harness();
    const done = h.inside.stageCity();
    h.inside.mode = 'floor';
    h.inside.frames = 2;
    expect(h.app.cityDrawn).toBe(false);
    for (const f of h.finish) f();
    await done; // its disposal hold ends
  });

  /** The harness with an office to ride to; each compile (the city's and the floor's) ends on its `finish`. */
  function rideHarness() {
    const h = harness();
    const material = new THREE.MeshBasicMaterial();
    const office = new THREE.Group();
    office.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const ride = h.inside as Inside & Ride;
    Object.assign(ride, {
      office: { root: office },
      walk: { scene: new THREE.Scene() },
      fpCam: new THREE.PerspectiveCamera(),
    });
    ride.r.compileAsync = () => new Promise<void>((res, rej) => h.finish.push((err) => (err ? rej(err) : res())));
    return { ...h, ride, material };
  }

  it('a cold ride whose compile starts during it and ends after it still has its disposals fired again', async () => {
    const { ride, material, finish } = rideHarness();
    const city = ride.stageCity();
    // The doors closed while the start-up city still compiled; the floor's compile starts.
    const floor = ride.warmUp();
    expect(finish).toHaveLength(3);
    expect([ride.staging, ride.warming]).toEqual([true, true]);
    finish[0]!();
    finish[1]!();
    await city;
    expect([ride.staging, ride.warming]).toEqual([false, true]);
    // The world disposes what the floor's compile picked, before it builds it (and listens for its dispose).
    material.dispose();
    let late = 0;
    material.addEventListener('dispose', () => late++);
    finish[2]!();
    await floor;
    expect(ride.warming).toBe(false);
    expect(late).toBe(1);
  });

  it('a cold ride alone has its disposals fired again', async () => {
    const { ride, material, finish } = rideHarness();
    const floor = ride.warmUp();
    material.dispose();
    let late = 0;
    material.addEventListener('dispose', () => late++);
    finish[0]!();
    await floor;
    expect(late).toBe(1);
  });
});
