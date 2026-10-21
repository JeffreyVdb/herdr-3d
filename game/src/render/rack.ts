import * as THREE from 'three/webgpu';
import { attribute, float, fract, mix, select, step, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HostDiskRate, HostStats } from '../net/protocol';
import { barTone, memText, pctText, rackLevels, RACK_SERVERS, sampleClock, updatesText, type RackMode, type Tone } from '../world/hostStats';
import type { Box3 } from '../world/layout';
import { FONT } from './cards/layout';
import { meshKit, reuse, type FloorPool, type PoolKit } from './floorPool';

/**
 * #74: the server rack: a short rack of five 1U/2U servers (face plates, vents, drive bays) with a monitor and a keyboard on top,
 * against the north wall. It costs three draws a floor:
 * - the body (frame, side panels, plinth, the servers' plates and vents, the monitor, the keyboard) is one merged geometry
 *   with vertex colours;
 * - every LED (a power LED, a read and a write LED and a link LED per server) is one `InstancedMesh`. Its blink runs in the
 *   shader from a time uniform, with a rate, a phase and a kind per instance in one attribute, so nothing is computed per LED per
 *   frame. The rates are written once per `host.disk` frame (`setDisks`: a handful of floats, once a second), never per frame;
 * - the monitor's screen is one plane with a canvas texture, drawn only when what it says changes (`setScreen`'s key), so a
 *   frame of stats costs one draw, and nothing is drawn per frame.
 * The LEDs are always green. Without live data (nobody watches, an old bridge, no physical disk) the activity LEDs
 * blink slowly and calmly in the shader too, and the power LEDs stay lit.
 */

export interface RackInfo {
  /** The meshes it draws: body, LEDs, screen. */
  drawCalls: number;
  mode: RackMode;
  /** Canvas draws of the screen so far, and what the last one said. */
  draws: number;
  lines: string[];
  tones: { cpu: Tone | null; mem: Tone | null };
  /** Per LED, in instance order (per server: power, read, write, link): its kind (0 power, 1 disk, 2 calm) and level. */
  leds: Array<{ kind: number; level: number }>;
  /** How many times the LEDs' rates were written to the GPU buffer. */
  rateWrites: number;
  motion: boolean;
}

export interface RackMesh {
  group: THREE.Group;
  /** The activity LEDs' rates from a `host.disk` frame (`null`: no live data, the calm blink). Writes the buffer only when a rate changed. */
  setDisks(disks: readonly HostDiskRate[] | null): void;
  /** The monitor: redrawn only when its mode or the frame's numbers changed. */
  setScreen(mode: RackMode, frame: HostStats | null): void;
  /** The shaders' clock, seconds; once per frame is a uniform write. */
  setTime(seconds: number): void;
  /** Reduced motion or battery saver: steady LEDs. */
  setMotion(on: boolean): void;
  info(): RackInfo;
  dispose(): void;
}

// The room's colours: graphite rack, blue-grey plates, like the lounge's dark steel.
const FRAME = 0x23283a;
const PANEL = 0x1b2031;
const PLINTH = 0x12151f;
const TOP = 0x2e344a;
const PLATE_A = 0x3a425c;
const PLATE_B = 0x343b54;
const BLANK = 0x272c3e;
const EAR = 0x5a6380;
const VENT = 0x0d111b;
const BAY = 0x1f2538;
const HANDLE = 0x6c7592;
const BUTTON = 0x8f98b3;
const KEYS = 0x20263a;
const KEYTOP = 0x4a5270;
const BEZEL = 0x141a2b;

/** The monitor's screen texture and the picture on it. */
const W = 512;
const H = 325;
const INK = '#0b1022';
const INK_3 = '#1c2540';
const TEXT = '#eef2fb';
const TEXT_2 = '#b9c3dc';
const TEXT_3 = '#7d89ab';
const GREY = '#8a93ab';
const TONE: Record<Tone, string> = { ok: '#4be28a', warn: '#ffc233', hot: '#ff5a4d' };

function part(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return g;
}

/** The rack's servers from the bottom: a blank, then 2U, 1U, 2U, 1U, 2U servers, and a blank (each number is its height in U). */
const STACK: Array<{ u: number; server: boolean }> = [
  { u: 1, server: false },
  { u: 2, server: true },
  { u: 1, server: true },
  { u: 2, server: true },
  { u: 1, server: true },
  { u: 2, server: true },
  { u: 1, server: false },
];
const U = 0.1;
const BODY_H = 1.12;
const PLINTH_H = 0.07;
const LEDS_PER_SERVER = 4; // power, read, write, link
const LED_R = 0.0105;

interface Build {
  body: THREE.BufferGeometry;
  leds: THREE.Matrix4[];
  /** The screen's rectangle: centre and size, and z of the glass. */
  screen: { x: number; y: number; z: number; w: number; h: number };
}

function build(box: Box3): Build {
  const [x0, , z0] = box.min;
  const [x1, , z1] = box.max;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const front = z1 - 0.06; // the servers' plates
  const parts: THREE.BufferGeometry[] = [];
  const leds: THREE.Matrix4[] = [];

  // The frame: plinth, four posts, side and back panels, the top.
  parts.push(part(w - 0.04, PLINTH_H, z1 - z0 - 0.04, cx, PLINTH_H / 2, (z0 + z1) / 2, PLINTH));
  for (const px of [x0 + 0.0175, x1 - 0.0175]) for (const pz of [z0 + 0.0175, z1 - 0.0175]) parts.push(part(0.035, BODY_H - PLINTH_H, 0.035, px, (BODY_H + PLINTH_H) / 2, pz, FRAME));
  for (const sx of [x0 + 0.006, x1 - 0.006]) parts.push(part(0.012, BODY_H - PLINTH_H - 0.025, z1 - z0 - 0.07, sx, (BODY_H + PLINTH_H - 0.025) / 2, (z0 + z1) / 2 - 0.0, PANEL));
  parts.push(part(w - 0.02, BODY_H - PLINTH_H - 0.025, 0.012, cx, (BODY_H + PLINTH_H - 0.025) / 2, z0 + 0.012, PANEL));
  parts.push(part(w, 0.025, z1 - z0, cx, BODY_H - 0.0125, (z0 + z1) / 2, TOP));

  // The units.
  const plateW = w - 0.075;
  let y = PLINTH_H + 0.02;
  let server = 0;
  for (const slot of STACK) {
    const h = slot.u * U - 0.008;
    const yc = y + (slot.u * U) / 2;
    const px0 = cx - plateW / 2;
    const px1 = cx + plateW / 2;
    if (!slot.server) {
      parts.push(part(plateW, h, 0.02, cx, yc, front + 0.01, BLANK));
      y += slot.u * U;
      continue;
    }
    const plate = server % 2 ? PLATE_B : PLATE_A;
    parts.push(part(plateW, h, 0.03, cx, yc, front + 0.015, plate));
    parts.push(part(plateW - 0.02, h - 0.01, 0.4, cx, yc, front - 0.2, FRAME)); // the chassis behind it
    // Rack ears at both ends.
    for (const ex of [px0 + 0.011, px1 - 0.011]) parts.push(part(0.022, h, 0.034, ex, yc, front + 0.015, EAR));
    // Vents: horizontal slots over the left half.
    const slots = slot.u === 1 ? 6 : 11;
    const vx0 = px0 + 0.04;
    const vw = plateW * 0.42;
    const pitch = (h - 0.024) / slots;
    for (let k = 0; k < slots; k++) parts.push(part(vw, pitch * 0.45, 0.004, vx0 + vw / 2, y + 0.012 + pitch * (k + 0.5) + 0.002, front + 0.031, VENT));
    // Drive bays: a row (two for a 2U) of small bays with a handle, right of the vents.
    const rows = slot.u;
    const bw = 0.065;
    const bx0 = vx0 + vw + 0.035;
    for (let r = 0; r < rows; r++) {
      for (let b = 0; b < 3; b++) {
        const bx = bx0 + bw / 2 + b * (bw + 0.008);
        const by = y + 0.012 + ((h - 0.024) / rows) * (r + 0.5) - (rows === 1 ? 0.004 : 0.012);
        parts.push(part(bw, rows === 1 ? 0.042 : 0.034, 0.004, bx, by, front + 0.031, BAY));
        parts.push(part(bw * 0.6, 0.004, 0.005, bx, by - (rows === 1 ? 0.008 : 0.005), front + 0.0315, HANDLE));
      }
    }
    // The power button and the LEDs, at the right end of the plate, on its top line.
    const ly = yc + (slot.u === 1 ? 0.0 : h / 2 - 0.02);
    const bx = px1 - 0.035;
    parts.push(part(0.014, 0.014, 0.006, bx, ly, front + 0.031, BUTTON));
    for (let l = 0; l < LEDS_PER_SERVER; l++) leds.push(new THREE.Matrix4().makeTranslation(bx - 0.03 - (LEDS_PER_SERVER - 1 - l) * 0.026, ly, front + 0.0325));
    y += slot.u * U;
    server++;
  }

  // The keyboard on the top, in front of the monitor.
  const topY = BODY_H;
  const kw = 0.44;
  parts.push(part(kw, 0.016, 0.15, cx, topY + 0.008, z1 - 0.2, KEYS));
  for (let r = 0; r < 4; r++) parts.push(part(kw - 0.04, 0.004, 0.02, cx, topY + 0.018, z1 - 0.2 - 0.054 + r * 0.03, KEYTOP));
  // The monitor: foot, neck, bezel box; its glass is the screen plane.
  const mz = z0 + 0.36;
  parts.push(part(0.26, 0.012, 0.18, cx, topY + 0.006, mz, BEZEL));
  parts.push(part(0.05, 0.06, 0.035, cx, topY + 0.042, mz - 0.03, BEZEL));
  const scW = 0.56;
  const scH = 0.35;
  const bezel = 0.018;
  const sy = topY + 0.07 + bezel + scH / 2;
  parts.push(part(scW + 2 * bezel, scH + 2 * bezel, 0.035, cx, sy, mz - 0.03, BEZEL));
  const glassZ = mz - 0.03 + 0.0175 + 0.002;
  const body = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return { body, leds, screen: { x: cx, y: sy, z: glassZ, w: scW, h: scH } };
}

function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

interface Painted {
  lines: string[];
  tones: { cpu: Tone | null; mem: Tone | null };
}

function drawBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, pct: number | null, color: string): void {
  g.fillStyle = INK_3;
  g.fillRect(x, y, w, h);
  if (pct === null) return;
  g.fillStyle = color;
  g.fillRect(x, y, Math.max(h, (w * Math.min(100, Math.max(0, pct))) / 100), h);
}

function paintCenter(g: CanvasRenderingContext2D, title: string, sub: string, lines: string[]): void {
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = TEXT_2;
  g.font = `800 40px ${FONT}`;
  g.fillText(title, W / 2, H / 2 - 6);
  g.fillStyle = TEXT_3;
  g.font = `500 24px ${FONT}`;
  g.fillText(sub, W / 2, H / 2 + 34);
  lines.push(title, sub);
}

function paint(g: CanvasRenderingContext2D, mode: RackMode, f: HostStats | null): Painted {
  const out: Painted = { lines: [], tones: { cpu: null, mem: null } };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = INK;
  g.fillRect(0, 0, W, H);
  if (mode === 'unsupported') {
    paintCenter(g, 'No host stats', 'on this bridge', out.lines);
    out.lines = ['No host stats on this bridge'];
    return out;
  }
  if (!f || mode === 'idle' || mode === 'waiting') {
    if (mode === 'waiting') paintCenter(g, 'Reading the host', 'one moment', out.lines);
    else paintCenter(g, 'Standing by', 'wakes when you look at it', out.lines);
    return out;
  }
  const grey = mode === 'stale';
  const cpu = f.cpu_pct;
  const cpuTone = cpu === null ? null : barTone(cpu);
  const memTone = barTone(f.mem_used_pct);
  out.tones = { cpu: cpuTone, mem: memTone };
  const padX = 30;
  const barW = W - padX * 2;
  const color = (t: Tone | null) => (grey ? GREY : t ? TONE[t] : TEXT_3);
  g.textBaseline = 'alphabetic';

  const row = (top: number, label: string, big: string, pct: number | null, tone: Tone | null, side?: string) => {
    g.textAlign = 'left';
    g.fillStyle = grey ? GREY : TEXT_2;
    g.font = `700 24px ${FONT}`;
    g.fillText(label, padX, top + 22);
    if (side) {
      g.textAlign = 'right';
      g.fillStyle = grey ? GREY : TEXT_2;
      g.font = `600 24px ${FONT}`;
      g.fillText(side, W - padX, top + 22);
    }
    g.textAlign = 'left';
    g.fillStyle = grey ? GREY : TEXT;
    g.font = `800 76px ${FONT}`;
    g.fillText(big, padX, top + 98);
    drawBar(g, padX, top + 112, barW, 16, pct, color(tone));
    out.lines.push(label, big);
    if (side) out.lines.push(side);
  };
  row(14, 'CPU', pctText(cpu), cpu, cpuTone);
  row(150, 'Memory', pctText(f.mem_used_pct), f.mem_used_pct, memTone, memText(f.mem_used_bytes, f.mem_total_bytes));

  // The foot: the updates line on the left (only when the host reports one), the sample's time, static, on the right.
  const upd = updatesText(f.updates);
  g.font = `600 22px ${FONT}`;
  g.textAlign = 'left';
  if (upd) {
    g.fillStyle = grey ? GREY : f.updates && f.updates.count > 0 ? TONE.warn : TONE.ok;
    g.fillText(upd, padX, H - 16);
    out.lines.push(upd);
  }
  g.textAlign = 'right';
  g.fillStyle = grey ? GREY : TEXT_3;
  const clock = sampleClock(f.sampled_at);
  g.fillText(clock, W - padX, H - 16);
  out.lines.push(clock);
  if (mode === 'stale' || mode === 'dim') {
    // A small tag in the corner: the numbers are the last ones read, not these seconds'.
    g.textAlign = 'center';
    g.fillStyle = TEXT_3;
    g.font = `700 20px ${FONT}`;
    const tag = mode === 'stale' ? 'stale' : 'paused';
    g.fillText(tag, W / 2, H - 16);
    out.lines.push(tag);
  }
  if (mode === 'dim') {
    g.fillStyle = 'rgba(11,16,34,0.58)';
    g.fillRect(0, 0, W, H);
  }
  return out;
}

/** #141: the LEDs' mesh, their per-LED attribute and their clock (see `FloorPool`). */
interface LedKit extends PoolKit {
  leds: THREE.InstancedMesh;
  aLed: THREE.InstancedBufferAttribute;
  uTime: ReturnType<typeof floatUniform>;
  uMotion: ReturnType<typeof floatUniform>;
}

const floatUniform = (v: number) => uniform(v);

function ledKit(n: number): LedKit {
  const ledGeo = new THREE.CircleGeometry(LED_R, 10);
  const aLed = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  ledGeo.setAttribute('aLed', aLed);
  const uTime = floatUniform(0);
  const uMotion = floatUniform(1);
  const led = attribute('aLed', 'vec4');
  const kind = led.x;
  const level = led.y;
  const freq = mix(float(0.9), float(11), level).mul(led.w.mul(0.4).add(0.8));
  const duty = mix(float(0.07), float(0.96), level.pow(0.8));
  const act = step(fract(uTime.mul(freq).add(led.z)), duty).mul(step(float(0.001), level));
  const calm = step(fract(uTime.mul(led.w.mul(0.3).add(0.25)).add(led.z)), float(0.3));
  const moving = select(kind.lessThan(0.5), float(1), select(kind.lessThan(1.5), act, calm));
  const steady = select(kind.lessThan(0.5), float(1), select(kind.lessThan(1.5), level.mul(0.9), float(0.4)));
  const bright = mix(float(0.12), float(1), mix(steady, moving, uMotion));
  const ledMat = new THREE.MeshBasicNodeMaterial();
  ledMat.colorNode = vec3(0.22, 1.0, 0.48).mul(bright);
  ledMat.toneMapped = false;
  const leds = new THREE.InstancedMesh(ledGeo, ledMat, n);
  leds.frustumCulled = false;
  return meshKit(n, [leds], { leds, aLed, uTime, uMotion });
}

/** The rack in `box` (its footprint, 0 to its top), its front toward +z; `pool`: its LEDs from there (#141). */
export function buildRack(box: Box3, pool?: FloorPool): RackMesh {
  const group = new THREE.Group();
  group.name = 'server.rack';
  const b = build(box);

  const body = new THREE.Mesh(b.body, new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }));
  body.name = 'server.rack.body';
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // The LEDs: one instanced draw; kind, level, phase and a rate jitter per instance. #141: pooled, the same mesh on every floor.
  const n = RACK_SERVERS * LEDS_PER_SERVER;
  const holder = {};
  const kit = pool ? pool.take('rack.leds', n, holder, ledKit) : ledKit(n);
  kit.holder = holder;
  const { leds, aLed, uTime, uMotion } = kit;
  reuse(leds, n);
  leds.name = 'server.rack.leds';
  uTime.value = 0;
  uMotion.value = 1;
  b.leds.forEach((m, i) => leds.setMatrixAt(i, m));
  // A fixed random phase and jitter per LED, so they never strobe in unison (the same on every floor and every run).
  let seed = 74;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    const isActivity = i % LEDS_PER_SERVER === 1 || i % LEDS_PER_SERVER === 2;
    const isLink = i % LEDS_PER_SERVER === 3;
    aLed.setXYZW(i, isActivity ? 2 : isLink ? 2 : 0, 0, rnd(), rnd());
  }
  aLed.needsUpdate = true;
  /** #141: a rack of a floor you left writes nothing into the pooled LEDs. */
  const live = () => kit.holder === holder;
  group.add(leds);

  // The screen: a canvas texture, redrawn only when what it says changes.
  const cv = canvas();
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const screenMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const key = screenMat.customProgramCacheKey.bind(screenMat);
  screenMat.customProgramCacheKey = () => `${key()}|h3d-rack`;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(b.screen.w, b.screen.h), screenMat);
  screen.name = 'server.rack.screen';
  screen.position.set(b.screen.x, b.screen.y, b.screen.z);
  group.add(screen);

  let drawKey = '';
  let draws = 0;
  let mode: RackMode = 'idle';
  let painted: Painted = { lines: [], tones: { cpu: null, mem: null } };
  let levels: number[] | null = null;
  let rateWrites = 0;
  let motion = true;

  /** The kinds and levels of the LEDs: power steady, activity from `levels` (or calm without), link always calm. */
  const writeRates = (next: number[] | null) => {
    const same = next === null ? levels === null : levels !== null && next.length === levels.length && next.every((v, i) => v === levels?.[i]);
    if (same || !live()) return;
    levels = next;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i / LEDS_PER_SERVER);
      const slot = i % LEDS_PER_SERVER;
      if (slot === 1 || slot === 2) {
        const lv = next?.[s * 2 + (slot - 1)] ?? 0;
        aLed.setXY(i, next ? 1 : 2, lv);
      }
    }
    aLed.needsUpdate = true;
    rateWrites++;
  };
  writeRates(null);
  rateWrites = 0;

  return {
    group,
    setDisks(disks) {
      writeRates(disks && disks.length > 0 ? rackLevels(disks, RACK_SERVERS) : null);
    },
    setScreen(m, f) {
      // What the picture says, and nothing else: a new frame with the same numbers is not a redraw.
      const k = JSON.stringify([m, m === 'unsupported' || m === 'idle' || m === 'waiting' ? null : f ? [f.cpu_pct, f.mem_used_pct, f.mem_used_bytes, f.mem_total_bytes, f.sampled_at, f.updates?.count ?? null] : null]);
      mode = m;
      if (k === drawKey || !g) return;
      drawKey = k;
      painted = paint(g, m, f);
      tex.needsUpdate = true;
      draws++;
    },
    setTime(s) {
      if (live()) uTime.value = s;
    },
    setMotion(on) {
      motion = on;
      if (live()) uMotion.value = on ? 1 : 0;
    },
    info: () => ({
      drawCalls: group.children.length,
      mode,
      draws,
      lines: [...painted.lines],
      tones: { ...painted.tones },
      leds: Array.from({ length: n }, (_, i) => ({ kind: aLed.getX(i), level: +aLed.getY(i).toFixed(3) })),
      rateWrites,
      motion,
    }),
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh && !pool?.owns(o)) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      tex.dispose();
      group.removeFromParent();
    },
  };
}
