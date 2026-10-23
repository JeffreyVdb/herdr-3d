import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import type { McpWallModel, McpWallProvider, ProviderTone } from '../world/mcp';
import { pictureMaterial } from './overviewScreen';
import { WALL, type WallPalette } from './palette';

/**
 * #196: the MCP & skills screen on the north wall, over the server rack: a dark bezel box a few cm off the wall, facing
 * +z, and in it one canvas texture: the title and the scope (checkout, Codex profile) on top, then a column per provider
 * (Claude Code, Codex) with its configured MCP count, what needs attention, its skills, the age of the last read and
 * of the last connection check (grey, "may be out of date", past 10 minutes). Unlit (not tone mapped), so it reads like a screen in any light (M17). Calm screens for a bridge without the
 * command, no connection, nobody looking yet and the first read.
 *
 * It is drawn only when what it shows changes (the model's `key`: its words and a coarse age bucket), never per frame.
 * Nothing on it is green (a configuration read never says a server connects): what needs you is amber, stale, pending,
 * unknown and unsupported data grey.
 */

const BEZEL = 0.05;
/** The canvas: wide enough for the text to read at 2–3 m (the rack's 180 px a metre would be ~380 px: too coarse). */
const W = 1024;
const WARN = '#ffc233';
const GREY = '#8a93ab';

export interface McpScreenInfo {
  drawCalls: number;
  mode: McpWallModel['mode'];
  draws: number;
  /** What the last draw said, in order. */
  lines: string[];
  /** Per provider column, the colour its attention line took: amber for something to do, grey when stale, else plain; and its check line's ('' when there is none). */
  tones: Array<{ harness: string; tone: ProviderTone; ink: 'warn' | 'grey' | 'text'; check: 'grey' | 'text' | '' }>;
}

export interface McpScreenMesh {
  group: THREE.Group;
  set(m: McpWallModel): void;
  info(): McpScreenInfo;
  dispose(): void;
}

/** Fits `text` into `max` px by shortening it with an ellipsis (the canvas's font must be set). */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (g.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

export function buildMcpScreen(box: Box3, c: Readonly<WallPalette> = WALL): McpScreenMesh {
  const group = new THREE.Group();
  group.name = 'screen.mcp';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshToonMaterial({ color: c.housing }));
  body.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  body.receiveShadow = true;
  body.name = 'screen.mcp.body';
  group.add(body);

  const sw = x1 - x0 - 2 * BEZEL;
  const sh = y1 - y0 - 2 * BEZEL;
  const H = Math.round((W * sh) / sw);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), pictureMaterial(tex, false, 'h3d-mcp'));
  glass.position.set((x0 + x1) / 2, (y0 + y1) / 2, z1 + 0.003);
  glass.name = 'screen.mcp.glass';
  group.add(glass);

  let drawKey = '';
  let draws = 0;
  let mode: McpWallModel['mode'] = 'idle';
  let lines: string[] = [];
  let tones: McpScreenInfo['tones'] = [];
  const font = (weight: number, px: number) => `${weight} ${px}px ${c.font}`;

  const head = (m: McpWallModel, out: string[]) => {
    if (!g) return;
    const pad = 44;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = c.accent;
    g.font = font(800, 56);
    g.fillText(m.title, pad, 82);
    const tw = g.measureText(m.title).width;
    out.push(m.title);
    if (m.mode === 'data') {
      g.textAlign = 'right';
      g.fillStyle = c.text2;
      g.font = font(600, 28);
      const s = fit(g, m.scope, W - pad * 2 - tw - 40);
      g.fillText(s, W - pad, 80);
      out.push(m.scope);
    }
    g.fillStyle = c.ink3;
    g.fillRect(pad, 108, W - pad * 2, 3);
  };

  const calm = (m: McpWallModel, out: string[]) => {
    if (!g) return;
    const sub: Record<string, string> = {
      unsupported: 'Update herdr-world to see them here',
      offline: 'Shows again when the bridge is back',
      idle: 'It reads the configuration while you look',
      loading: 'One moment',
      error: 'Open it (E) to pick another',
    };
    g.textAlign = 'center';
    g.fillStyle = c.text2;
    g.font = font(800, 44);
    g.fillText(fit(g, m.scope, W - 120), W / 2, H / 2 + 20);
    g.fillStyle = c.text3;
    g.font = font(500, 28);
    const s = sub[m.mode] ?? '';
    g.fillText(s, W / 2, H / 2 + 66);
    out.push(m.scope, s);
  };

  const column = (p: McpWallProvider, left: number, width: number, out: string[]) => {
    if (!g) return;
    const grey = p.tone === 'stale' || p.tone === 'unavailable' || p.tone === 'unsupported' || p.tone === 'pending' || p.tone === 'failed';
    const top = 136;
    const max = width - 8;
    g.textAlign = 'left';
    g.fillStyle = c.text2;
    g.font = font(700, 36);
    g.fillText(p.name, left, top + 36);
    out.push(p.name);
    if (p.tag) {
      // A tag beside the name: the numbers are the last good ones (stale), or not the whole configuration (partial).
      const nw = g.measureText(p.name).width;
      g.font = font(700, 22);
      const tw = g.measureText(p.tag).width + 20;
      const tx = left + nw + 16;
      g.strokeStyle = p.tag === 'stale' ? GREY : WARN;
      g.lineWidth = 2;
      g.strokeRect(tx, top + 10, tw, 30);
      g.fillStyle = p.tag === 'stale' ? GREY : WARN;
      g.fillText(p.tag, tx + 10, top + 33);
      out.push(p.tag);
    }
    g.fillStyle = grey ? GREY : c.text;
    // The big line as large as its column takes it (68 px down to 40), then shortened only if even that is too wide.
    let px = 68;
    for (g.font = font(800, px); px > 40 && g.measureText(p.big).width > max; px -= 4) g.font = font(800, px - 4);
    g.fillText(fit(g, p.big, max), left, top + 124);
    out.push(p.big);
    let ink: McpScreenInfo['tones'][number]['ink'] = 'text';
    if (p.attention) {
      // Nothing to do is said calmly, never in green: a configuration read does not say a server connects (AC5).
      ink = p.tone === 'stale' ? 'grey' : p.attentionCount > 0 ? 'warn' : 'text';
      g.fillStyle = ink === 'grey' ? GREY : ink === 'warn' ? WARN : c.text2;
      g.font = font(700, 34);
      g.fillText(fit(g, p.attention, max), left, top + 182);
      out.push(p.attention);
    }
    tones.push({ harness: p.harness, tone: p.tone, ink, check: p.check ? (p.checkOld ? 'grey' : 'text') : '' });
    g.fillStyle = c.text2;
    g.font = font(600, 32);
    g.fillText(fit(g, p.skills, max), left, top + 238);
    out.push(p.skills);
    if (p.age) {
      g.fillStyle = c.text3;
      g.font = font(500, 28);
      g.fillText(fit(g, p.age, max), left, top + 290);
      out.push(p.age);
    }
    if (p.check) {
      // An old check's line says so, in grey; it gets smaller (28 px down to 22) before it is shortened.
      g.fillStyle = p.checkOld ? GREY : c.text3;
      let cpx = 28;
      for (g.font = font(500, cpx); cpx > 22 && g.measureText(p.check).width > max; cpx -= 2) g.font = font(500, cpx - 2);
      g.fillText(fit(g, p.check, max), left, top + 330);
      out.push(p.check);
    }
  };

  const paint = (m: McpWallModel) => {
    const out: string[] = [];
    tones = [];
    if (!g) return out;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.ink;
    g.fillRect(0, 0, W, H);
    head(m, out);
    if (m.mode !== 'data') {
      calm(m, out);
      return out;
    }
    const pad = 44;
    const gap = 48;
    const colW = (W - pad * 2 - gap) / 2;
    m.providers.forEach((p, i) => column(p, pad + i * (colW + gap), colW, out));
    g.fillStyle = c.ink3;
    g.fillRect(W / 2 - 1, 136, 2, H - 136 - 36);
    return out;
  };

  return {
    group,
    set(m) {
      mode = m.mode;
      if (m.key === drawKey || !g) return;
      drawKey = m.key;
      lines = paint(m);
      tex.needsUpdate = true;
      draws++;
    },
    info: () => ({ drawCalls: group.children.length, mode, draws, lines: [...lines], tones: tones.map((t) => ({ ...t })) }),
    dispose() {
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      glass.geometry.dispose();
      (glass.material as THREE.Material).dispose();
      tex.dispose();
      group.removeFromParent();
    },
  };
}
