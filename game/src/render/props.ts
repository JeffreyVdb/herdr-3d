import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Box3, Prop } from '../world/layout';
import { FONT } from './cards/atlasCards';
import { OFFICE } from './palette';
import { buildClock, type ClockMesh } from './clock';
import { buildRadio, type RadioMesh } from './radio';
import { buildOverviewScreen, type OverviewScreenMesh } from './overviewScreen';
import { buildFloorDepartures, type FloorDeparturesMesh } from './departuresBoard';
import { buildRack, type RackMesh } from './rack';
import { buildTv, type TvMesh } from './tv';

/** Static placeholder props (boards, lounge, cabinet, …): a few meshes per floor, textures drawn once. */

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const toon = (color: number, extra: Partial<THREE.MeshToonMaterialParameters> = {}) => new THREE.MeshToonMaterial({ color, ...extra });

function boxAt(b: Box3, mat: THREE.Material): THREE.Mesh {
  const size = [0, 1, 2].map((i) => (b.max[i] as number) - (b.min[i] as number)) as [number, number, number];
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return m;
}

/** A cork board with a title and placeholder sticky notes. */
function boardTexture(title: string, note: string, tint: string): THREE.CanvasTexture {
  return canvasTexture(1024, 512, (g) => {
    g.fillStyle = '#c99d6b';
    g.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = i % 2 ? 'rgba(90,55,20,0.10)' : 'rgba(255,240,210,0.10)';
      g.fillRect((i * 97) % 1024, (i * 53) % 512, 3, 3);
    }
    g.fillStyle = '#1c2540';
    g.fillRect(0, 0, 1024, 96);
    g.fillStyle = '#ffffff';
    g.font = `800 58px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(title, 36, 50);
    g.font = `600 30px ${FONT}`;
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(note, 990, 52);
    g.textAlign = 'left';
    const notes = [tint, '#ffe27a', '#a9e7ff', '#ffd0e0', '#c8f5b5', '#ffe27a'];
    for (let i = 0; i < 6; i++) {
      const x = 50 + (i % 3) * 320 + ((i * 37) % 30);
      const y = 130 + Math.floor(i / 3) * 185 + ((i * 23) % 20);
      g.save();
      g.translate(x + 120, y + 75);
      g.rotate((((i * 7) % 5) - 2) * 0.03);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(-116, -66, 240, 150);
      g.fillStyle = notes[i] ?? '#ffe27a';
      g.fillRect(-120, -75, 240, 150);
      g.fillStyle = 'rgba(28,37,64,0.35)';
      for (let l = 0; l < 3; l++) g.fillRect(-95, -40 + l * 32, 150 + ((i + l) % 3) * 20, 10);
      g.fillStyle = '#e8413a';
      g.beginPath();
      g.arc(0, -64, 9, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
}

export function signTexture(text: string, sub: string, bg: string, fg: string, w = 512, h = 192): THREE.CanvasTexture {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${Math.round(h * 0.34)}px ${FONT}`;
    g.fillText(text, w / 2, h * 0.42);
    g.font = `600 ${Math.round(h * 0.16)}px ${FONT}`;
    g.globalAlpha = 0.75;
    g.fillText(sub, w / 2, h * 0.76);
  });
}

/** M13: the whiteboard before anything is drawn on it (a few strokes, and how to start). */
function whiteboardPlaceholder(): THREE.CanvasTexture {
  return canvasTexture(1024, 420, (g) => {
    g.fillStyle = '#fbfcff';
    g.fillRect(0, 0, 1024, 420);
    g.strokeStyle = '#2f6bf0';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(200, 210, 80, 0, Math.PI * 2);
    g.moveTo(280, 210);
    g.bezierCurveTo(420, 120, 520, 320, 660, 200);
    g.stroke();
    g.strokeStyle = '#e8413a';
    g.strokeRect(690, 130, 220, 150);
    g.fillStyle = '#1c2540';
    g.font = `700 44px ${FONT}`;
    g.fillText('Whiteboard', 36, 58);
    g.font = `500 28px ${FONT}`;
    g.fillStyle = '#7a8398';
    g.fillText('Empty · look here and press E to draw', 36, 390);
  });
}

function faceTexture(mesh: THREE.Mesh, tex: THREE.Texture, base: number): void {
  // Box face order: +x, -x, +y, -y, +z, -z. Front (+z) carries the texture.
  const plain = toon(base);
  const front = new THREE.MeshToonMaterial({ color: 0xffffff, map: tex });
  mesh.material = [plain, plain, plain, plain, front, plain];
}

/** Elevator doors on a south wall (frame, steel doors, the floor panel above): a lobby has one too. */
export function elevatorMeshes(box: Box3, label: string, sub: string): { group: THREE.Group; texture: THREE.Texture } {
  const group = new THREE.Group();
  const [x0, , z0] = box.min;
  const [x1, y1] = [box.max[0], box.max[1]];
  const cx = (x0 + x1) / 2;
  const frame = mergeGeometries([
    new THREE.BoxGeometry(x1 - x0 + 0.3, 0.2, 0.14).translate(cx, y1 + 0.1, z0 + 0.02),
    new THREE.BoxGeometry(0.16, y1, 0.14).translate(x0 - 0.07, y1 / 2, z0 + 0.02),
    new THREE.BoxGeometry(0.16, y1, 0.14).translate(x1 + 0.07, y1 / 2, z0 + 0.02),
  ]);
  group.add(new THREE.Mesh(frame, toon(0x5d6679)));
  const doors = mergeGeometries([
    new THREE.BoxGeometry((x1 - x0) / 2 - 0.01, y1, 0.06).translate(cx - (x1 - x0) / 4, y1 / 2, z0 + 0.04),
    new THREE.BoxGeometry((x1 - x0) / 2 - 0.01, y1, 0.06).translate(cx + (x1 - x0) / 4, y1 / 2, z0 + 0.04),
  ]);
  group.add(new THREE.Mesh(doors, new THREE.MeshStandardMaterial({ color: OFFICE.steel, metalness: 0.6, roughness: 0.35 })));
  const texture = signTexture(label, sub, '#101626', '#ffc233', 512, 170);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3).rotateY(Math.PI), new THREE.MeshBasicMaterial({ map: texture }));
  panel.position.set(cx, y1 + 0.42, z0 - 0.01);
  group.add(panel);
  return { group, texture };
}

export interface PropMeshes {
  group: THREE.Group;
  /** M7: puts another texture on the front of a board (its cork, drawn by the board's notes). */
  swapBoard(id: 'board.issues' | 'board.prs', tex: THREE.Texture): void;
  /** M15: the radio on the lounge counter (null when the layout has none). */
  radio: RadioMesh | null;
  /** M17: the wall clock (null when the layout has none). */
  clock: ClockMesh | null;
  /** M13: the screen-share TV (null when the layout has none). */
  tv: TvMesh | null;
  /** #118: the floor overview's wall screen (null when the layout has none). */
  overview: OverviewScreenMesh | null;
  /** #65: the departures board on the partition (null when the layout has none). */
  departures: FloorDeparturesMesh | null;
  /** #74: the server rack with its monitor and its disk-driven LEDs (null when the layout has none). */
  rack: RackMesh | null;
  /** M13: puts the board's render on the whiteboard (null: back to the placeholder); the one it replaces is disposed. */
  setWhiteboard(tex: THREE.Texture | null): void;
  /** #223: the cabinet's drawers, top to bottom, with this many folder tabs each (`world/handoff.drawerFill`). */
  setDrawers(fill: readonly [number, number, number]): void;
  /** #223: the folder tabs the drawers show now (test hook), top to bottom; null without a cabinet. */
  drawers(): [number, number, number] | null;
  dispose(): void;
}

export function buildProps(props: readonly Prop[], layout: { width: number; depth: number; rug: { x0: number; z0: number; x1: number; z1: number } }, floorLabel: string): PropMeshes {
  const group = new THREE.Group();
  group.name = 'props';
  const textures: THREE.Texture[] = [];
  const tex = <T extends THREE.Texture>(t: T) => (textures.push(t), t);
  const byId = new Map(props.map((p) => [p.id, p]));
  const add = (m: THREE.Object3D) => {
    m.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    group.add(m);
    return m;
  };

  const boards: Array<[Prop['id'], string, string, string]> = [
    ['board.issues', 'Issues', 'connecting…', '#ffb38a'],
    ['board.prs', 'Pull requests', 'connecting…', '#b9a5ff'],
    ['board.services', 'Services', 'arrives in M12', '#8fe0c0'],
  ];
  const boardMeshes = new Map<string, THREE.Mesh>();
  for (const [id, title, note, tint] of boards) {
    const p = byId.get(id);
    if (!p) continue;
    const m = boxAt(p.box, toon(0x7a5230));
    faceTexture(m, tex(boardTexture(title, note, tint)), 0x7a5230);
    add(m);
    boardMeshes.set(id, m);
  }

  // M13: the whiteboard shows its floor's latest render (setWhiteboard); this placeholder until there is one.
  const wb = byId.get('whiteboard');
  let wbFront: THREE.MeshToonMaterial | null = null;
  let wbPlaceholder: THREE.Texture | null = null;
  let wbShown: THREE.Texture | null = null;
  if (wb) {
    const m = boxAt({ min: [wb.box.min[0], wb.box.min[1], wb.box.min[2]], max: [wb.box.max[0], wb.box.max[1], wb.box.max[2]] }, toon(0xffffff));
    wbPlaceholder = tex(whiteboardPlaceholder());
    faceTexture(m, wbPlaceholder, 0xdfe4ee);
    const mats = m.material;
    if (Array.isArray(mats) && mats[4] instanceof THREE.MeshToonMaterial) {
      wbFront = mats[4];
      // Readable in the room's light, like the boards' notes.
      wbFront.emissive.set(0xffffff);
      wbFront.emissiveMap = wbPlaceholder;
      wbFront.emissiveIntensity = 0.25;
    }
    m.name = 'whiteboard';
    add(m);
  }

  // M13: the screen-share TV (render/tv.ts); it gets the share's texture through `tv.show`.
  const tvProp = byId.get('tv');
  const tv = tvProp ? buildTv(tvProp.box) : null;
  if (tv) group.add(tv.group);

  // #118: the floor overview on the lounge wall (render/overviewScreen.ts); the app feeds it the floor's tree.
  const ovProp = byId.get('screen.overview');
  const overview = ovProp ? buildOverviewScreen(ovProp.box) : null;
  if (overview) group.add(overview.group);

  // #65: the departures board on the partition (render/departuresBoard.ts); the app ticks it with the schedules.
  const depProp = byId.get('board.departures');
  const departures = depProp ? buildFloorDepartures(depProp.box) : null;
  if (departures) group.add(departures.group);

  // #74: the server rack: three draws (body, LEDs, screen); the app feeds it the host's frames.
  const rackProp = byId.get('server.rack');
  const rack = rackProp ? buildRack(rackProp.box) : null;
  if (rack) group.add(rack.group);

  const filing = byId.get('filing');
  // #223: the drawers fill: manila folder tabs peek over each drawer's front, bottom drawer first (`drawerFill`).
  let drawFiling: ((fill: readonly [number, number, number]) => void) | null = null;
  let filingShown = '';
  if (filing) {
    const m = boxAt(filing.box, toon(0x9aa4b5));
    m.rotation.y = 0;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const t = tex(new THREE.CanvasTexture(canvas));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    drawFiling = (fill) => {
      const g = canvas.getContext('2d');
      if (!g) return;
      g.fillStyle = '#a7b0c0';
      g.fillRect(0, 0, 256, 512);
      for (let i = 0; i < 3; i++) {
        const y = 16 + i * 166;
        // Folder tabs in the drawer's gap above its front, a little apart, alternating left and right.
        const n = fill[i] ?? 0;
        for (let k = 0; k < n; k++) {
          const x = 22 + ((k * 53) % 180);
          g.fillStyle = k % 2 ? '#d9b866' : '#e9cd84';
          g.fillRect(x, y - 2, 34, 12);
        }
        g.fillStyle = '#8f99ab';
        g.fillRect(14, y + 8, 228, 142);
        g.fillStyle = '#e9edf4';
        g.fillRect(98, y + 52, 60, 14);
        g.fillStyle = '#ffffff';
        g.fillRect(90, y + 92, 76, 30);
        if (n > 0) {
          // The label card gets a line of ink per few folders.
          g.fillStyle = '#5b6685';
          for (let k = 0; k < Math.min(3, Math.ceil(n / 3)); k++) g.fillRect(96, y + 98 + k * 8, 64 - k * 14, 3);
        }
      }
      t.needsUpdate = true;
    };
    drawFiling([0, 0, 0]);
    filingShown = '0,0,0';
    // The cabinet stands against the east wall and faces west (-x).
    const plain = toon(0x9aa4b5);
    m.material = [plain, new THREE.MeshToonMaterial({ color: 0xffffff, map: t }), plain, plain, plain, plain];
    add(m);
  }

  const lounge = byId.get('lounge');
  if (lounge) {
    const sofa = toon(OFFICE.sofa);
    const [x0, , z0] = lounge.box.min;
    const [x1, , z1] = lounge.box.max;
    const cx = (x0 + x1) / 2;
    const geo = mergeGeometries([
      new THREE.BoxGeometry(x1 - x0, 0.42, z1 - z0).translate(cx, 0.21, (z0 + z1) / 2),
      new THREE.BoxGeometry(x1 - x0, 0.45, 0.22).translate(cx, 0.62, z0 + 0.11),
      new THREE.BoxGeometry(0.22, 0.3, z1 - z0).translate(x0 + 0.11, 0.55, (z0 + z1) / 2),
      new THREE.BoxGeometry(0.22, 0.3, z1 - z0).translate(x1 - 0.11, 0.55, (z0 + z1) / 2),
    ]);
    add(new THREE.Mesh(geo, sofa));
    const cushions = new THREE.Mesh(
      mergeGeometries([0, 1, 2].map((i) => new THREE.BoxGeometry((x1 - x0 - 0.5) / 3 - 0.04, 0.1, z1 - z0 - 0.3).translate(x0 + 0.25 + ((x1 - x0 - 0.5) / 3) * (i + 0.5), 0.47, (z0 + z1) / 2 + 0.08))),
      toon(0x27a3a3),
    );
    add(cushions);
    const table = mergeGeometries([
      new THREE.BoxGeometry(1.4, 0.05, 0.7).translate(2.2, 0.42, 2.45),
      ...[
        [1.6, 2.2],
        [2.8, 2.2],
        [1.6, 2.7],
        [2.8, 2.7],
      ].map(([x, z]) => new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6).translate(x as number, 0.2, z as number)),
    ]);
    add(new THREE.Mesh(table, toon(OFFICE.wood)));
    const counter = mergeGeometries([new THREE.BoxGeometry(0.6, 0.9, 1.4).translate(0.32, 0.45, 4.1)]);
    add(new THREE.Mesh(counter, toon(OFFICE.wood)));
    const machine = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.34).translate(0.3, 1.11, 4.1), toon(0x2a3143));
    add(machine);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6).translate(0.49, 1.2, 4.1), new THREE.MeshBasicMaterial({ color: 0xff5a4d }));
    add(lamp);
    const mugs = new THREE.Mesh(
      mergeGeometries([0, 1, 2].map((i) => new THREE.CylinderGeometry(0.04, 0.036, 0.09, 10).translate(0.3, 0.945, 3.6 + i * 0.1))),
      toon(0xffffff),
    );
    add(mugs);
  }
  const radioProp = byId.get('radio');
  const radio = radioProp ? buildRadio(radioProp.box) : null;
  if (radio) add(radio.group);
  const clockProp = byId.get('clock');
  const clock = clockProp ? buildClock(clockProp.box) : null;
  if (clock) {
    clock.group.traverse((o) => {
      // The case casts no shadow onto the desks; it takes the room's.
      if (o instanceof THREE.Mesh) o.receiveShadow = !(o.material instanceof THREE.MeshBasicMaterial);
    });
    group.add(clock.group);
  }
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.rug.x1 - layout.rug.x0, layout.rug.z1 - layout.rug.z0).rotateX(-Math.PI / 2),
    toon(OFFICE.rug),
  );
  rug.position.set((layout.rug.x0 + layout.rug.x1) / 2, 0.004, (layout.rug.z0 + layout.rug.z1) / 2);
  rug.receiveShadow = true;
  group.add(rug);

  const drop = byId.get('dropzone');
  if (drop) {
    const [x0, , z0] = drop.box.min;
    const [x1, y1, z1] = drop.box.max;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    add(
      new THREE.Mesh(
        mergeGeometries([
          new THREE.BoxGeometry(x1 - x0, 0.05, z1 - z0).translate(cx, y1 - 0.2, cz),
          new THREE.BoxGeometry(0.06, y1 - 0.2, 0.06).translate(x0 + 0.08, (y1 - 0.2) / 2, cz),
          new THREE.BoxGeometry(0.06, y1 - 0.2, 0.06).translate(x1 - 0.08, (y1 - 0.2) / 2, cz),
        ]),
        toon(OFFICE.deskLeg),
      ),
    );
    const tray = mergeGeometries([
      new THREE.BoxGeometry(0.7, 0.02, 0.45).translate(cx, y1 - 0.16, cz),
      new THREE.BoxGeometry(0.7, 0.08, 0.02).translate(cx, y1 - 0.12, cz - 0.22),
      new THREE.BoxGeometry(0.7, 0.08, 0.02).translate(cx, y1 - 0.12, cz + 0.22),
      new THREE.BoxGeometry(0.02, 0.08, 0.45).translate(cx - 0.35, y1 - 0.12, cz),
      new THREE.BoxGeometry(0.02, 0.08, 0.45).translate(cx + 0.35, y1 - 0.12, cz),
    ]);
    add(new THREE.Mesh(tray, toon(0x2fc46a)));
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.34),
      new THREE.MeshBasicMaterial({ map: tex(signTexture('DROP ZONE', 'inbox · arrives in M11', '#1c2540', '#ffffff')), side: THREE.DoubleSide }),
    );
    sign.position.set(cx, y1 + 0.24, cz);
    sign.rotation.y = Math.PI; // faces into the room
    group.add(sign);
  }

  const lift = byId.get('elevator');
  if (lift) {
    const e = elevatorMeshes(lift.box, floorLabel, 'elevator · press E');
    textures.push(e.texture);
    e.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o.material instanceof THREE.MeshBasicMaterial)) o.castShadow = o.receiveShadow = true;
    });
    group.add(e.group);
  }

  // Plants in the corners of the desk area.
  const plant = mergeGeometries([new THREE.CylinderGeometry(0.2, 0.16, 0.36, 10).translate(0, 0.18, 0)]);
  const leaves = mergeGeometries([
    new THREE.SphereGeometry(0.34, 10, 8).translate(0, 0.72, 0),
    new THREE.SphereGeometry(0.24, 10, 8).translate(0.14, 1.02, 0.05),
  ]);
  const spots = [
    [layout.width - 1.8, 0.6],
    [6.4, layout.depth - 0.7],
    [layout.width - 0.6, layout.depth - 0.7],
    [0.6, layout.depth - 0.7],
  ];
  const pots = new THREE.InstancedMesh(plant, toon(OFFICE.pot), spots.length);
  const greens = new THREE.InstancedMesh(leaves, toon(OFFICE.plant), spots.length);
  spots.forEach(([x, z], i) => {
    const m = new THREE.Matrix4().makeTranslation(x as number, 0, z as number);
    pots.setMatrixAt(i, m);
    greens.setMatrixAt(i, m);
  });
  add(pots);
  add(greens);

  return {
    group,
    swapBoard(id, t) {
      const m = boardMeshes.get(id);
      const mats = m?.material;
      if (!Array.isArray(mats)) return;
      const front = mats[4];
      if (front instanceof THREE.MeshToonMaterial) {
        front.map = t;
        // Readable in the room's light: the board's own print glows a little.
        front.emissive.set(0xffffff);
        front.emissiveMap = t;
        front.emissiveIntensity = 0.3;
        front.needsUpdate = true;
      }
    },
    radio,
    clock,
    setWhiteboard(t) {
      if (!wbFront) {
        t?.dispose();
        return;
      }
      const next = t ?? wbPlaceholder;
      if (wbShown && wbShown !== t) wbShown.dispose();
      wbShown = t;
      wbFront.map = next;
      wbFront.emissiveMap = next;
      wbFront.needsUpdate = true;
    },
    tv,
    overview,
    departures,
    rack,
    setDrawers(fill) {
      const key = fill.join(',');
      if (!drawFiling || key === filingShown) return;
      filingShown = key;
      drawFiling(fill);
    },
    drawers() {
      return drawFiling ? (filingShown.split(',').map(Number) as [number, number, number]) : null;
    },
    dispose() {
      tv?.dispose(); // first: it lets go of the share's texture, which is not the floor's to dispose
      overview?.dispose(); // its two canvas textures
      departures?.dispose(); // its canvas texture
      rack?.dispose(); // its screen's canvas texture and the LEDs
      wbShown?.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) (m as THREE.Material).dispose();
        }
      });
      for (const t of textures) t.dispose();
    },
  };
}
