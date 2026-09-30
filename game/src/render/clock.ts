import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import { FONT } from './cards/layout';

/**
 * The office wall clock (M17): a digital face on the board partition, facing
 * the desks. A navy case with the lobby's yellow cap, an ink face that is lit
 * from behind (a basic material with a canvas texture, like the radio's
 * display), so it reads the same at night: the time big in warm white, the
 * date under it in the elevator panel's sky blue, and a small sun or moon for
 * the light outside. The canvas is drawn only when what it shows changes.
 */

export interface ClockFace {
  time: string;
  date: string;
  /** Day outside: the sun shows (the moon at night). */
  day: boolean;
}

export interface ClockMesh {
  group: THREE.Group;
  /** The time and date shown; redrawn only when they change. */
  set(face: Pick<ClockFace, 'time' | 'date'>): void;
  /** How light it is outside (0 … 1): the sun from 0.5 up, the moon below. */
  setDay(day: number): void;
  /** What the face shows now (test hook). */
  readonly shown: ClockFace | null;
  dispose(): void;
}

const W = 512;
const H = 224;
const INK = '#0e1422';
const TIME = '#fff4dc';
const GLOW = 'rgba(255,178,56,0.2)';
const DATE = '#9fd6ff';
const SUN = '#ffc233';

function draw(g: CanvasRenderingContext2D, f: ClockFace): void {
  g.fillStyle = INK;
  g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  // The time, with a faint amber bloom behind it.
  g.font = `800 132px ${FONT}`;
  g.fillStyle = GLOW;
  g.fillText(f.time, W / 2 + 3, 142);
  g.fillStyle = TIME;
  g.fillText(f.time, W / 2, 138);
  // A rule in the partition's yellow, then the date.
  g.fillStyle = SUN;
  g.fillRect(W / 2 - 150, 158, 300, 3);
  g.font = `700 36px ${FONT}`;
  g.fillStyle = DATE;
  g.fillText(f.date, W / 2, 203);
  // Sun or moon in the corner.
  const x = W - 34;
  const y = 34;
  g.fillStyle = f.day ? SUN : '#c9d6f2';
  g.beginPath();
  g.arc(x, y, 12, 0, Math.PI * 2);
  g.fill();
  if (!f.day) {
    g.fillStyle = INK;
    g.beginPath();
    g.arc(x + 7, y - 5, 11, 0, Math.PI * 2);
    g.fill();
  }
}

/** The clock in `box` (its case), its face on the box's -z side (the partition's north face, towards the desks). */
export function buildClock(box: Box3): ClockMesh {
  const group = new THREE.Group();
  group.name = 'clock';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const w = x1 - x0;
  const h = y1 - y0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(cx, cy, cz), new THREE.MeshToonMaterial({ color: 0x1c2540 }));
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w, 0.035, d + 0.004).translate(cx, y1 - 0.0175, cz), new THREE.MeshToonMaterial({ color: 0xffc233 }));
  group.add(caseMesh, cap);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const fw = w - 0.07;
  const fh = Math.min(h - 0.09, (fw * H) / W);
  // Faces -z: a +z plane turned half a turn.
  const face = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh).rotateY(Math.PI).translate(cx, cy - 0.012, z0 - 0.002), new THREE.MeshBasicMaterial({ map: texture }));
  face.name = 'clock.face';
  group.add(face);
  let shown: ClockFace | null = null;
  let text = { time: '', date: '' };
  let day = true;
  const redraw = () => {
    if (!text.time || (shown && shown.time === text.time && shown.date === text.date && shown.day === day)) return;
    shown = { ...text, day };
    if (g) draw(g, shown);
    texture.needsUpdate = true;
  };

  return {
    group,
    set(f) {
      text = { time: f.time, date: f.date };
      redraw();
    },
    setDay(k) {
      day = k >= 0.5;
      redraw();
    },
    get shown() {
      return shown;
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
