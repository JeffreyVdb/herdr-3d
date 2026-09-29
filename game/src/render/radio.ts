import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Box3 } from '../world/layout';
import { FONT } from './cards/layout';

/**
 * The office radio (M15): a small retro box on the lounge's coffee counter,
 * its face toward the lounge (+x). A speaker grille of dark slots on teal
 * cloth, a front display that shows what it is tuned to (a low-res canvas
 * texture, drawn only when the genre changes), two knobs, a carrying handle,
 * an antenna, and a small LED that glows while it plays. A handful of merged
 * toon meshes, one texture, one basic material for the LED: it costs nothing
 * per frame.
 */

export interface RadioMesh {
  group: THREE.Group;
  /** What the display says (`null`: the radio is off) and whether the LED is lit. */
  set(display: string | null, playing: boolean): void;
  dispose(): void;
}

const toon = (color: number) => new THREE.MeshToonMaterial({ color });

const W = 256;
const H = 64;
const LED_ON = 0xffb238;
const LED_OFF = 0x4b2a1f;

function drawDisplay(g: CanvasRenderingContext2D, text: string | null): void {
  g.fillStyle = '#10190f';
  g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (text === null) {
    g.fillStyle = '#5d6a3f';
    g.font = `800 30px ${FONT}`;
    g.fillText('OFF', W / 2, H / 2 + 1);
    return;
  }
  // Long names shrink to fit rather than clip.
  let size = 34;
  g.font = `800 ${size}px ${FONT}`;
  while (g.measureText(text).width > W - 24 && size > 16) g.font = `800 ${--size}px ${FONT}`;
  g.fillStyle = 'rgba(255,178,56,0.22)';
  g.fillText(text, W / 2 + 2, H / 2 + 3);
  g.fillStyle = '#ffb238';
  g.fillText(text, W / 2, H / 2 + 1);
}

/** The radio in `box` (its footprint on the counter), facing +x. */
export function buildRadio(box: Box3): RadioMesh {
  const group = new THREE.Group();
  group.name = 'radio';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const d = x1 - x0;
  const w = z1 - z0;
  const h = y1 - y0;
  // Geometry in the box's own frame (origin at its centre, front at +x/2).
  const at = (g: THREE.BufferGeometry) => g.translate(cx, y0 + h / 2, cz);
  const front = d / 2;

  const body = at(new THREE.BoxGeometry(d, h, w));
  group.add(new THREE.Mesh(body, toon(0xf3e6c8)));

  // Carrying handle on top and the antenna on its back corner.
  const handle = at(
    mergeGeometries([
      new THREE.BoxGeometry(0.02, 0.03, w * 0.62).translate(0, h / 2 + 0.03, 0),
      new THREE.BoxGeometry(0.02, 0.03, 0.02).translate(0, h / 2 + 0.005, -w * 0.31),
      new THREE.BoxGeometry(0.02, 0.03, 0.02).translate(0, h / 2 + 0.005, w * 0.31),
    ]),
  );
  group.add(new THREE.Mesh(handle, toon(0x2a3143)));
  const antenna = at(new THREE.CylinderGeometry(0.004, 0.004, 0.26, 5).rotateZ(-0.35).translate(-d * 0.3, h / 2 + 0.12, w * 0.4));
  group.add(new THREE.Mesh(antenna, toon(0xb4bcc8)));

  // Speaker: teal cloth on the south half of the face (the viewer's left), with dark slots across it.
  const sz = w * 0.22;
  const sw = w * 0.5;
  const sh = h * 0.56;
  const sy = -h * 0.14;
  group.add(new THREE.Mesh(at(new THREE.BoxGeometry(0.008, sh, sw).translate(front + 0.002, sy, sz)), toon(0x1f8c8c)));
  const slots = mergeGeometries(Array.from({ length: 6 }, (_, i) => new THREE.BoxGeometry(0.006, 0.006, sw - 0.03).translate(front + 0.007, sy + sh / 2 - 0.02 - i * ((sh - 0.04) / 5), sz)));
  group.add(new THREE.Mesh(at(slots), toon(0x0e4444)));

  // Display: a dark bezel across the top of the face, the screen inside it.
  const bw = w * 0.86;
  const bh = h * 0.28;
  const by = h / 2 - bh / 2 - 0.018;
  group.add(new THREE.Mesh(at(new THREE.BoxGeometry(0.008, bh, bw).translate(front + 0.002, by, 0)), toon(0x1b1f2b)));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const draw = (text: string | null) => {
    if (g) drawDisplay(g, text);
    texture.needsUpdate = true;
  };
  draw(null);
  const screen = new THREE.Mesh(at(new THREE.PlaneGeometry(bw - 0.014, bh - 0.014).rotateY(Math.PI / 2).translate(front + 0.0075, by, 0)), new THREE.MeshBasicMaterial({ map: texture }));
  group.add(screen);

  // Two knobs and the LED on the north half.
  const kz = -w * 0.2;
  const knobs = mergeGeometries([-0.04, 0.04].map((off) => new THREE.CylinderGeometry(0.026, 0.026, 0.02, 12).rotateZ(Math.PI / 2).translate(front + 0.008, sy + 0.03, kz + off)));
  group.add(new THREE.Mesh(at(knobs), toon(0xe8413a)));
  const dial = mergeGeometries([new THREE.BoxGeometry(0.006, 0.006, 0.05).translate(front + 0.004, sy - 0.05, kz)]);
  group.add(new THREE.Mesh(at(dial), toon(0x2a3143)));
  const ledMat = new THREE.MeshBasicMaterial({ color: LED_OFF });
  const led = new THREE.Mesh(at(new THREE.SphereGeometry(0.011, 8, 6).translate(front + 0.004, sy - 0.075, kz + 0.05)), ledMat);
  group.add(led);

  return {
    group,
    set(display, playing) {
      draw(display);
      ledMat.color.setHex(playing ? LED_ON : LED_OFF);
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      texture.dispose();
    },
  };
}
