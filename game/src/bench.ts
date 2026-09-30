import * as THREE from 'three/webgpu';
import type { App } from './app';
import { backendName } from './backend';

/**
 * In-game performance run, same method as docs/research/engine-bench so the
 * numbers compare: fixed dt, (A) serialized update+render+GPU wait, (B)
 * pipelined throughput, (C) GPU timestamp queries, plus (D) rAF-driven frames
 * that include the browser's style/layout/paint work (what the DOM card layer
 * costs). The e2e specs only read (A) and the draw counts, so they can skip (B) and
 * (D), which are most of the frames on llvmpipe.
 */

export interface BenchOptions {
  frames?: number;
  warm?: number;
  /** Camera motion every frame, so cards/badges are re-laid out each frame. */
  sway?: boolean;
  /** (B) the pipelined throughput run (default true). Off: `pipelinedMs` is null. */
  pipelined?: boolean;
  /** (D) the 120 rAF-driven frames (default true). Off: `rafMainMs` and `rafIntervalMs` are null. */
  raf?: boolean;
}

export interface Stats {
  med: number;
  p95: number;
  mean: number;
}

export interface BenchResult {
  backend: string;
  view: string;
  /** M3b: where the camera stood (floor, lobby, fire-escape, street), null in the city. */
  area: string | null;
  workers: number;
  px: string;
  frameMs: Stats;
  updateMs: Stats;
  submitMs: Stats;
  /** Null when the run skipped it (`pipelined: false`). */
  pipelinedMs: number | null;
  /** Null when the run skipped the rAF frames (`raf: false`). */
  rafMainMs: Stats | null;
  rafIntervalMs: Stats | null;
  gpuTimestampMs: Stats | 'unavailable' | null;
  drawCalls: number;
  triangles: number;
  visibleCards: number;
  secure: boolean;
  adapter: string;
  ua: string;
}

const stats = (a: number[]): Stats => {
  const s = [...a].sort((x, y) => x - y);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
  return { med: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), mean: +(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2) };
};

interface GpuBackend {
  isWebGPUBackend?: boolean;
  device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
  gl?: WebGL2RenderingContext;
}

export async function runBench(app: App, r: THREE.WebGPURenderer, o: BenchOptions = {}): Promise<BenchResult> {
  const FRAMES = o.frames ?? 300;
  const WARM = o.warm ?? 60;
  const sway = o.sway ?? true;
  const doPipelined = o.pipelined ?? true;
  const doRaf = o.raf ?? true;
  const be = r.backend as unknown as GpuBackend;
  const name = backendName(r.backend);
  const px = new Uint8Array(4);
  const sync =
    name === 'webgpu' && be.device
      ? () => be.device!.queue.onSubmittedWorkDone()
      : async () => {
          be.gl?.readPixels(0, 0, 1, 1, be.gl.RGBA, be.gl.UNSIGNED_BYTE, px);
        };
  app.pause();
  const dt = 1 / 60;
  let t = app.time;
  const base = app.mode === 'floor' ? app.pose() : null;
  const cam = app.cameraCity;
  const target = app.orbit.target.clone();
  const offset = cam.position.clone().sub(target);
  const radius = Math.hypot(offset.x, offset.z);
  const az0 = Math.atan2(offset.x, offset.z);
  let ct = 0;
  const move = () => {
    ct += dt;
    if (!sway) return;
    if (base) app.setPose({ x: base.x, z: base.z, y: base.y, yaw: base.yaw + Math.sin(ct * 0.8) * 0.22, pitch: base.pitch ?? 0 });
    else {
      const a = az0 + Math.sin(ct * 0.2) * 0.3;
      cam.position.set(target.x + Math.sin(a) * radius, cam.position.y, target.z + Math.cos(a) * radius);
      cam.lookAt(target);
    }
  };
  const frame = () => {
    move();
    t += dt;
    app.step(dt, t);
  };

  for (let i = 0; i < WARM; i++) {
    frame();
    app.render();
    await sync();
  }
  const tot: number[] = [];
  const upd: number[] = [];
  const sub: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    frame();
    const t1 = performance.now();
    app.render();
    const t2 = performance.now();
    await sync();
    const t3 = performance.now();
    tot.push(t3 - t0);
    upd.push(t1 - t0);
    sub.push(t2 - t1);
  }
  let pipelined: number | null = null;
  if (doPipelined) {
    const tp0 = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      frame();
      app.render();
      if (i % 4 === 3) await sync();
    }
    await sync();
    pipelined = (performance.now() - tp0) / FRAMES;
  }

  // rAF frames: JS + the browser's own rendering steps for this frame.
  const main: number[] = [];
  const ts: number[] = [];
  if (doRaf) {
    await new Promise<void>((done) => {
      const ch = new MessageChannel();
      let t0 = 0;
      ch.port1.onmessage = () => {
        main.push(performance.now() - t0);
        if (main.length >= 120) {
          ch.port1.close();
          done();
        } else requestAnimationFrame(cb);
      };
      const cb = (now: number) => {
        ts.push(now);
        t0 = performance.now();
        frame();
        app.render();
        ch.port2.postMessage(0);
      };
      requestAnimationFrame(cb);
    });
  }

  let gpu: Stats | 'unavailable' | null = null;
  const tsr = r as unknown as { resolveTimestampsAsync?: (type: string) => Promise<number | undefined> };
  if ((r as unknown as { backend: { trackTimestamp?: boolean } }).backend.trackTimestamp && tsr.resolveTimestampsAsync) {
    const g: number[] = [];
    for (let i = 0; i < 60; i++) {
      frame();
      app.render();
      await sync();
      const v = await tsr.resolveTimestampsAsync('render');
      if (typeof v === 'number') g.push(v);
    }
    gpu = g.length ? stats(g) : 'unavailable';
  }

  r.info.reset();
  app.render();
  await sync();
  const info = r.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
  const adapter =
    name === 'webgpu' && 'gpu' in navigator
      ? await (navigator as unknown as { gpu: { requestAdapter(): Promise<{ info: { vendor: string; architecture: string } } | null> } }).gpu
          .requestAdapter()
          .then((a) => (a ? `${a.info.vendor}/${a.info.architecture}` : 'none'))
      : String(be.gl?.getParameter(be.gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0x1f01) ?? 'unknown');
  const workers = app.mode === 'floor' ? (app.office?.applied.size ?? 0) : app.city.applied.size;
  const intervals = ts.slice(1).map((x, i) => x - (ts[i] ?? x));
  const size = r.getDrawingBufferSize(new THREE.Vector2());
  app.resume();
  return {
    backend: name,
    view: app.mode === 'floor' ? `floor:${app.office?.session ?? ''}` : 'city',
    area: app.mode === 'floor' ? app.place.area : null,
    workers,
    px: `${size.x}x${size.y}`,
    frameMs: stats(tot),
    updateMs: stats(upd),
    submitMs: stats(sub),
    pipelinedMs: pipelined === null ? null : +pipelined.toFixed(2),
    rafMainMs: doRaf ? stats(main) : null,
    rafIntervalMs: intervals.length ? stats(intervals) : null,
    gpuTimestampMs: gpu,
    drawCalls: info.drawCalls ?? info.calls ?? 0,
    triangles: info.triangles,
    visibleCards: app.mode === 'floor' ? (app.office?.cards.shown().length ?? 0) : 0,
    secure: window.isSecureContext,
    adapter,
    ua: navigator.userAgent.replace(/.*\) /, ''),
  };
}
