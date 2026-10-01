import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import { FONT } from './cards/atlasCards';
import type { ScreenShare, ShareView } from '../screen/share';

/**
 * M13: the screen-share TV on the north wall of every floor. A dark set with a black screen; while the Mac shares,
 * the share plays on it as a `VideoTexture` (sRGB, unlit, not tone mapped, so it reads like a screen in any light),
 * letterboxed (never cropped or stretched); otherwise a sign says how to start. Nothing leaves the browser for this:
 * the texture is the local `<video>` of the capture.
 */

/** The largest `vw:vh` box inside `boxW × boxH` (aspect kept). */
export function letterbox(boxW: number, boxH: number, vw: number, vh: number): { w: number; h: number } {
  if (!(vw > 0) || !(vh > 0) || !(boxW > 0) || !(boxH > 0)) return { w: 0, h: 0 };
  const s = Math.min(boxW / vw, boxH / vh);
  return { w: vw * s, h: vh * s };
}

/**
 * The share's texture, one for the whole game (each floor's TV shows the same one). three.js textures keep the size
 * they were first uploaded at, so a new size (a resize, another surface) makes a new texture and disposes the old;
 * stopping disposes it. The texture follows the video's frames by itself (requestVideoFrameCallback).
 */
export class ScreenTexture {
  private tex: THREE.VideoTexture | null = null;
  private size = { w: 0, h: 0 };
  private paused = false;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;

  constructor(private readonly share: Pick<ScreenShare, 'onChange' | 'video' | 'view'>) {
    this.off = share.onChange((v) => this.sync(v));
    this.sync(share.view);
  }

  /** The texture and the video size while live, else null; `paused` while the source has no picture. */
  get current(): { texture: THREE.VideoTexture; w: number; h: number; paused: boolean } | null {
    return this.tex ? { texture: this.tex, w: this.size.w, h: this.size.h, paused: this.paused } : null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private sync(v: ShareView): void {
    const video = this.share.video;
    const live = v.phase === 'live' && video !== null && v.w > 0 && v.h > 0;
    const old = this.tex;
    if (!live) {
      if (!old) return;
      this.tex = null;
      this.size = { w: 0, h: 0 };
      this.notify();
      old.dispose();
      return;
    }
    const resized = !old || v.w !== this.size.w || v.h !== this.size.h;
    if (!resized && v.paused === this.paused) return;
    this.paused = v.paused;
    if (resized) {
      const t = new THREE.VideoTexture(video);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      this.tex = t;
      this.size = { w: v.w, h: v.h };
    }
    this.notify();
    if (resized) old?.dispose();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  dispose(): void {
    this.off();
    this.tex?.dispose();
    this.tex = null;
    this.listeners.clear();
  }
}

export interface TvMesh {
  group: THREE.Group;
  /** Shows the share's texture (`w × h` video), or the sign (null). The TV never owns or disposes the texture. */
  show(tex: THREE.Texture | null, w: number, h: number, paused: boolean): void;
  /** What it shows (test hook): the letterboxed picture in metres, or none. */
  info(): { live: boolean; paused: boolean; w: number; h: number; screenW: number; screenH: number };
  dispose(): void;
}

const BEZEL = 0.06;

function sign(title: string, sub: string, w = 768, h = 432): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#141b2e');
    grad.addColorStop(1, '#0a0f1c');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#9fd6ff';
    g.font = `800 ${Math.round(h * 0.15)}px ${FONT}`;
    g.fillText(title, w / 2, h * 0.43);
    g.globalAlpha = 0.72;
    g.font = `600 ${Math.round(h * 0.075)}px ${FONT}`;
    g.fillText(sub, w / 2, h * 0.62);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The TV on its wall: `box` is the prop's box, its front at max z, facing +z (into the room). */
export function buildTv(box: Box3): TvMesh {
  const group = new THREE.Group();
  group.name = 'tv';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const screenW = x1 - x0 - 2 * BEZEL;
  const screenH = y1 - y0 - 2 * BEZEL;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshToonMaterial({ color: 0x1b1f2b }));
  body.position.set(cx, cy, (z0 + z1) / 2);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  // The set's own parts use the plain basic material the other signs use (no new shader program when a floor
  // loads); only the picture is unlit without tone mapping, and it compiles once the share is on.
  const basic = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial(o);
  const black = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), basic({ color: 0x000000 }));
  black.position.set(cx, cy, z1 + 0.002);
  const idle = sign('Screen share', 'Share screen in the top bar');
  const paused = sign('Paused', 'the shared source is hidden');
  const signMat = basic({ map: idle });
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), signMat);
  signMesh.position.set(cx, cy, z1 + 0.003);
  const picMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  // three r186 keys a render pipeline by a map's `mapping` (and, on WebGPU, its filters), not by its being a video.
  // On the WebGL2 backend the picture then reuses the sign's program, which lacks the shader's sRGB decode a video
  // gets (it is uploaded raw), and shows washed out. A key of its own keeps it a program of its own.
  const key = picMat.customProgramCacheKey.bind(picMat);
  picMat.customProgramCacheKey = () => `${key()}|h3d-video`;
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), picMat);
  pic.position.set(cx, cy, z1 + 0.004);
  pic.visible = false;
  // A small red light under the screen while the share is on it.
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.018, 12), basic({ color: 0xff3b30 }));
  lamp.position.set(x1 - BEZEL - 0.03, y0 + BEZEL / 2, z1 + 0.002);
  lamp.visible = false;
  group.add(black, signMesh, pic, lamp);
  let state = { live: false, paused: false, w: 0, h: 0 };
  return {
    group,
    show(tex, w, h, isPaused) {
      const live = tex !== null && w > 0 && h > 0;
      if (picMat.map !== tex) {
        picMat.map = live ? tex : null;
        picMat.needsUpdate = true;
      }
      const fit = live ? letterbox(screenW, screenH, w, h) : { w: 0, h: 0 };
      pic.scale.set(Math.max(fit.w, 1e-4), Math.max(fit.h, 1e-4), 1);
      pic.visible = live && !isPaused;
      signMesh.visible = !live || isPaused;
      const map = live && isPaused ? paused : idle;
      if (signMat.map !== map) {
        signMat.map = map;
        signMat.needsUpdate = true;
      }
      lamp.visible = live;
      state = { live, paused: live && isPaused, w: fit.w, h: fit.h };
    },
    info: () => ({ ...state, screenW, screenH }),
    dispose() {
      picMat.map = null; // the share's texture is not the TV's to dispose
      for (const m of [body, black, signMesh, pic, lamp]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      idle.dispose();
      paused.dispose();
      group.removeFromParent();
    },
  };
}
