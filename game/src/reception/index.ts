import * as THREE from 'three/webgpu';
import type { GameAudio } from '../audio';
import { SpeechBubble } from './bubble';
import { LineBook, type LineKind, type ReceptionContext, type ReceptionEvent, type Said } from './lines';
import { CLIP_MS, clipKey, RECEPTIONIST_LINES } from './manifest';
import { BUBBLE_ANCHOR, MOUTH, ReceptionistModel } from './model';

export type { LineKind, ReceptionContext, ReceptionEvent, Said } from './lines';
export type { GameAudio } from '../audio';
export { createGameAudio } from '../audio';
export { mountAudioControls } from '../ui/audioControls';
export { receptionContext } from './context';

export interface Reception {
  /** Receptionist model: origin at its feet on the lobby floor, facing +z (south, toward the front door). */
  readonly object: THREE.Object3D;
  /** Handle an event; returns what was said (a welcome may be followed by a nudge: return both, in order),
   *  or [] when the cooldown suppresses it. `interact` ignores the cooldown. */
  handle(ev: ReceptionEvent, ctx: ReceptionContext): Said[];
  /** Per frame: idle animation, bubble placement and fade. `camera` is the active camera. */
  update(dt: number, camera: THREE.Camera): void;
  /** Test hook payload (exposed as `window.__h3d.reception()`). */
  debug(): {
    said: Array<Said & { at: number }>;
    /** Clip ids in the order they were played (recorded even when muted or without audio). */
    clips: string[];
    /** End of the greeting cooldown (ms, context clock), null before the first greeting. */
    cooldownUntil: number | null;
    /** The same for goodbyes. */
    goodbyeUntil: number | null;
    /** What the speech bubble shows right now, null when it's hidden. */
    bubble: string | null;
  };
  dispose(): void;
}

export interface ReceptionOptions {
  audio: GameAudio;
  /** Element the speech bubble (M2 card style, DOM) is appended to: the HUD root. */
  overlay: HTMLElement;
  /** Random in [0, 1) for picking variants (tests). */
  rng?: () => number;
  /** Cast shadows (match the renderer's shadow setting). */
  shadows?: boolean;
}

/** How long a bubble stays up for reading, whatever the clip length (ms). */
export function readingMs(text: string): number {
  return Math.min(9000, Math.max(2600, 1200 + text.length * 60));
}

const WAVES: ReadonlySet<LineKind> = new Set(['welcome-morning', 'welcome-afternoon', 'welcome-evening', 'welcome-night', 'elevator', 'goodbye']);
/** The receptionist turns to face you within this range (m) and angle (rad). */
const LOOK_RANGE = 14;
const LOOK_MAX = 1.1;

class ReceptionDesk implements Reception {
  readonly object: THREE.Object3D;
  private readonly model: ReceptionistModel;
  private readonly bubble: SpeechBubble;
  private readonly book: LineBook;
  private readonly audio: GameAudio;
  private readonly overlay: HTMLElement;
  private readonly said: Array<Said & { at: number }> = [];
  private readonly clips: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private t = 0;
  private talkUntil = 0;
  private talk = 0;
  private waveStart = -10;
  private look = 0;
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();

  constructor(o: ReceptionOptions) {
    this.audio = o.audio;
    this.overlay = o.overlay;
    this.model = new ReceptionistModel(o.shadows ?? true);
    this.object = this.model.object;
    this.bubble = new SpeechBubble(o.overlay);
    this.book = new LineBook(RECEPTIONIST_LINES, o.rng ?? Math.random);
  }

  handle(ev: ReceptionEvent, ctx: ReceptionContext): Said[] {
    const lines = this.book.handle(ev, ctx);
    if (!lines.length) return [];
    const at = ctx.now.getTime();
    for (const s of lines) this.said.push({ ...s, at });
    // A new line cuts off whatever was still being said.
    if (this.timer) clearTimeout(this.timer);
    this.audio.stop();
    this.speak(lines, 0);
    return lines;
  }

  /** Says line `i` (clip, bubble, mouth), then moves on when its clip and reading time are over. */
  private speak(lines: Said[], i: number): void {
    this.timer = null;
    const s = lines[i];
    if (!s) {
      this.bubble.hide();
      return;
    }
    this.clips.push(s.id);
    this.audio.playAt(clipKey(s.id), this.mouth());
    this.bubble.show(s, this.audio.muted || this.audio.state !== 'running');
    const clip = CLIP_MS[s.id] || readingMs(s.text) * 0.6;
    this.talkUntil = this.t + clip / 1000;
    if (WAVES.has(s.kind) && i === 0) this.waveStart = this.t;
    const last = i === lines.length - 1;
    const hold = last ? Math.max(clip + 900, readingMs(s.bubble)) : Math.max(clip + 350, readingMs(s.bubble));
    // Timers, not frames: the sequence finishes even when the lobby isn't rendered (walked out the door).
    this.timer = setTimeout(() => this.speak(lines, i + 1), hold);
  }

  private mouth(): { x: number; y: number; z: number } {
    this.object.updateWorldMatrix(true, false);
    const p = this.v.copy(MOUTH).applyMatrix4(this.object.matrixWorld);
    return { x: p.x, y: p.y, z: p.z };
  }

  update(dt: number, camera: THREE.Camera): void {
    const d = Math.min(0.1, Math.max(0, dt));
    this.t += d;
    this.object.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);

    // Turn toward the player when close, back to the door otherwise.
    this.w.setFromMatrixPosition(camera.matrixWorld);
    const local = this.object.worldToLocal(this.v.copy(this.w));
    const near = Math.hypot(local.x, local.z) < LOOK_RANGE;
    const target = near ? Math.max(-LOOK_MAX, Math.min(LOOK_MAX, Math.atan2(local.x, local.z))) : 0;
    this.look += (target - this.look) * (1 - Math.exp(-4 * d));

    const talking = this.t < this.talkUntil ? 1 : 0;
    this.talk += (talking - this.talk) * (1 - Math.exp(-12 * d));
    const since = this.t - this.waveStart;
    const wave = since < 0 || since > 1.8 ? 0 : Math.sin((since / 1.8) * Math.PI) ** 0.6;
    this.model.pose({ t: this.t, talk: this.talk, wave, look: this.look });

    if (this.bubble.current === null) return;
    // The tail points at the air above the head; behind the camera docks it.
    const anchor = this.v.copy(BUBBLE_ANCHOR).applyMatrix4(this.object.matrixWorld);
    const dist = anchor.distanceTo(this.w);
    const inView = this.w.copy(anchor).applyMatrix4(camera.matrixWorldInverse).z < -0.05;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let p: { x: number; y: number } | null = null;
    if (inView) {
      anchor.project(camera);
      p = { x: ((anchor.x + 1) / 2) * vw, y: ((1 - anchor.y) / 2) * vh };
    }
    const top = parseFloat(this.overlay.style.getPropertyValue('--topbar-bottom')) || 70;
    this.bubble.place(p, 4.5 / Math.max(0.1, dist), vw, vh, top);
  }

  debug(): ReturnType<Reception['debug']> {
    return {
      said: this.said.map((s) => ({ ...s })),
      clips: [...this.clips],
      cooldownUntil: this.book.cooldownEnd('greeting'),
      goodbyeUntil: this.book.cooldownEnd('goodbye'),
      bubble: this.bubble.current,
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.bubble.dispose();
    this.model.dispose();
    this.object.removeFromParent();
  }
}

export function createReception(opts: ReceptionOptions): Reception {
  return new ReceptionDesk(opts);
}
