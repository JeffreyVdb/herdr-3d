import type { CDPSession } from '@playwright/test';

// The perf specs' trace method (#58, m58-activity-perf.spec.ts; #145, h145-overview-perf.spec.ts): Chrome's trace
// (devtools.timeline, toplevel, gpu) for the paints, layouts, style recalcs, long tasks and each thread's busy time;
// Performance.getMetrics for the renderer's totals; LayerTree for the compositor's layers.

export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string; data?: { clip?: number[]; nodeId?: number } };
}

/** Chrome's trace for `ms`. */
export function trace(cdp: CDPSession, ms: number): Promise<TraceEvent[]> {
  return traceWhile(cdp, () => new Promise((r) => setTimeout(r, ms)));
}

/** #145: Chrome's trace while `during` runs (a scroll, an open). */
export async function traceWhile(cdp: CDPSession, during: () => Promise<unknown>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: unknown[] }) => {
    events.push(...(e.value as TraceEvent[]));
  };
  cdp.on('Tracing.dataCollected', onData);
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,toplevel,gpu,viz,cc', transferMode: 'ReportEvents' });
  await during();
  await cdp.send('Tracing.end');
  await done;
  cdp.off('Tracing.dataCollected', onData);
  return events;
}

/** Paints (count, area), layouts, style recalcs, long tasks and each thread's busy time (ms) of a trace of `ms`. */
export function summarise(events: TraceEvent[], ms: number) {
  const threads = new Map<string, string>();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const busy: Record<string, number> = {};
  let longTasks = 0;
  for (const e of events) {
    if (e.ph !== 'X' || (e.name !== 'ThreadControllerImpl::RunTask' && e.name !== 'RunTask') || !e.dur) continue;
    const name = threads.get(`${e.pid}:${e.tid}`) ?? 'other';
    busy[name] = (busy[name] ?? 0) + e.dur / 1000;
    if (name === 'CrRendererMain' && e.dur > 50_000) longTasks++;
  }
  const paints = events.filter((e) => e.name === 'Paint' && (e.ph === 'X' || e.ph === 'B'));
  let area = 0;
  let small = 0;
  for (const p of paints) {
    const c = p.args?.data?.clip;
    if (!c || c.length < 8) continue;
    const xs = [c[0], c[2], c[4], c[6]] as number[];
    const ys = [c[1], c[3], c[5], c[7]] as number[];
    const r = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    const a = (r.right - r.left) * (r.bottom - r.top);
    area += a;
    // A paint of less than a fifth of the 1280x720 viewport: not the whole-layer paints the page makes anyway.
    if (a < 200_000) small++;
  }
  const count = (n: string) => events.filter((e) => e.name === n && (e.ph === 'X' || e.ph === 'B' || e.ph === 'I' || e.ph === 'i')).length;
  const round = (x: number) => Math.round(x * 10) / 10;
  // #145: the main thread's time in style, layout and paint (complete events only: the trace's own durations).
  const main = (n: string) => round(events.filter((e) => e.name === n && e.ph === 'X' && threads.get(`${e.pid}:${e.tid}`) === 'CrRendererMain').reduce((a, e) => a + (e.dur ?? 0) / 1000, 0));
  return {
    seconds: ms / 1000,
    paints: paints.length,
    paintArea: Math.round(area),
    smallPaints: small,
    layouts: count('Layout'),
    recalcStyles: count('UpdateLayoutTree') + count('RecalculateStyles'),
    longTasks,
    styleMs: main('UpdateLayoutTree'),
    layoutMs: main('Layout'),
    paintMs: main('Paint'),
    busyMs: Object.fromEntries(Object.entries(busy).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)])),
  };
}

export interface Layer {
  layerId: string;
  backendNodeId?: number;
  paintCount?: number;
  drawsContent: boolean;
  width: number;
  height: number;
}

/** The compositor's layers as last reported (LayerTree.layerTreeDidChange), and the layer of a node. */
export class Layers {
  last: Layer[] = [];
  constructor(cdp: CDPSession) {
    cdp.on('LayerTree.layerTreeDidChange', (e: { layers?: unknown[] }) => {
      if (e.layers) this.last = e.layers as Layer[];
    });
  }
  of(backendNodeId: number): Layer | null {
    return this.last.find((l) => l.backendNodeId === backendNodeId) ?? null;
  }
}

export async function backendId(cdp: CDPSession, selector: string): Promise<number | null> {
  const doc = (await cdp.send('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
  const q = (await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })) as { nodeId: number };
  if (!q.nodeId) return null;
  const d = (await cdp.send('DOM.describeNode', { nodeId: q.nodeId })) as { node: { backendNodeId: number } };
  return d.node.backendNodeId;
}

/** The renderer's Performance.getMetrics totals. */
export async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const r = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}
