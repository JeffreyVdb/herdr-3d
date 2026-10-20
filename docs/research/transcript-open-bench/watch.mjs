// Read-only: times transcript.watch acks for every worker of a bridge (then unwatches). Run from the repo root:
//   node docs/research/transcript-open-bench/watch.mjs SOCKET [ROUNDS]
// Prints only worker ids, harness, timings and sizes, never transcript text.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { default: WebSocket } = await import(pathToFileURL(resolve('game/node_modules/ws/wrapper.mjs')));
const [socket, rounds = '2'] = process.argv.slice(2);
if (!socket) throw Error('usage: node watch.mjs SOCKET [ROUNDS]');
const ws = new WebSocket('ws+unix:' + socket + ':/ws');
const pending = new Map();
let seq = 0, snapshot;
const gotSnapshot = new Promise((r) => (snapshot = r));
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.t === 'world.snapshot') snapshot(m.world);
  if (pending.has(m.req_id)) {
    const p = pending.get(m.req_id);
    pending.delete(m.req_id);
    m.t === 'error' ? p.reject(Error(m.code + ': ' + m.message)) : p.resolve({ ...m.data, _wire: b.length });
  }
});
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'transcript-open-investigation' }));
const cmd = (t, args) => {
  const req_id = 'bench-' + ++seq;
  const p = new Promise((resolve, reject) => pending.set(req_id, { resolve, reject }));
  ws.send(JSON.stringify({ t, req_id, args }));
  return p;
};
const world = await gotSnapshot;
const workers = (world.workers || []).filter((w) => w.harness === 'claude' || w.harness === 'codex');
for (let r = 0; r < Number(rounds); r++) {
  for (const w of workers) {
    const start = performance.now();
    try {
      const a = await cmd('transcript.watch', { id: w.id, limit: 200 });
      const ms = performance.now() - start;
      console.log(JSON.stringify({ round: r, id: w.id, harness: w.harness, ms: Math.round(ms), bytes: a._wire, items: a.items.length, pending: a.pending }));
    } catch (e) {
      console.log(JSON.stringify({ round: r, id: w.id, harness: w.harness, error: String(e.message).slice(0, 80) }));
    }
    await cmd('transcript.unwatch', { id: w.id }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 3000)); // let the tracker drop the logs: the next round is a fresh open
}
ws.close();
