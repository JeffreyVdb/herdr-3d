// #223: literal handoffs and the filing cabinet for the fixture server's `sim=1` (tools/fixture-sim.ts hands these
// commands over). Rules, like herdr-world's (docs/protocol.md "Handoffs"):
// - the snapshot's `handoffs` is the cabinet (`{counts}`; absent with `simfail=no_handoff`, and then every command
//   below answers `unknown_command`); `simhandoffs=<n>` seeds n handoffs on the first floor;
// - `sim.final {id, text, harness?, images?}` (the simulator's own) plays a worker's agent ending its turn with `text`:
//   an assistant item in its transcript (pushed to a watch of it; Claude's id `<message>#0`, Codex's the message id) and
//   the worker's `handoff` candidate (a worker.upsert); the ack is `{candidate}`. `sim.prompt_turn {id}` plays a new
//   genuine prompt: a user item, and the candidate goes;
// - `worker.handoff_preview` and `worker.handoff` check the candidate like the bridge (`handoff_unavailable` for a
//   stale one, `bad_request` for the args); `sim.handoff_fail {code}` makes the next filing fail with that code
//   (`handoff_failed`, `handoff_source`); a repeated `op` answers the first handoff (`existing`); `send_home` sends the
//   worker home through the simulator's own worker.fire once filed, unless it is working or blocked (`skipped`);
// - `handoff.list` matches every term (the last as a prefix) in the title, label, worker, branch and body, titles
//   first, with a snippet around the first body match between U+E000 and U+E001; `handoff.get`, `handoff.delete`
//   (`confirm: true`, else `confirmation_required`) and the `handoff.added` / `handoff.removed` events.
// - #224 "Ask the agent": `worker.handoff_preview {mode: 'agent'}` answers `agent` (the skill call by harness: Claude
//   `/handoff`, Codex `$handoff`; askable when idle or done with no request running) and `cache` (`sim.cache {id,
//   state}` sets it, else `expired` with the worker's context tokens); `worker.handoff {mode: 'agent', instruction?,
//   send_home?, op}` and an exact top-level `worker.prompt` "/handoff [instruction]" start a request (the worker's
//   `agent_handoff` pending; a repeated op, or a second /handoff while one runs, answers it; `sim.agent_skill
//   {missing}` refuses with `handoff_skill_missing`); `sim.agent_turn {id, text?, fail?}` plays the agent's turn: filed
//   as an `agent` handoff (then sent home when asked), or failed with `fail` as the reason; `worker.handoff_cancel`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { AgentHandoff, CacheState, HandoffCandidate, HandoffEntry, TranscriptItem, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface HandoffHost {
  readonly workers: Worker[];
  readonly floors: () => string[];
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): boolean;
  nextSeq(id: string): number;
  upsert(send: Send, w: Worker): void;
  /** The simulator's worker.fire with the worktree kept; a refusal throws. */
  fire(id: string, send: Send): void;
  /** Why worker.fire would refuse it now ("": it would not). */
  fireBlocked(id: string): string;
}

const PREVIEW = 64 << 10;
const MAX = 1 << 20;
const OPEN = '\uE000';
const CLOSE = '\uE001';

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;

/** The bridge's title rule (internal/handoff.Title): the first H1 outside fences, else the first line, else worker and date. */
export function titleOf(body: string, worker: string, at: number): string {
  let fence = false;
  let first = '';
  const clean = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    const r = [...t];
    return r.length <= 80 ? t : `${r.slice(0, 79).join('').trim()}…`;
  };
  const heading = (t: string) => {
    const m = /^(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(t);
    return m ? { level: (m[1] as string).length, text: m[2] ?? '' } : null;
  };
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (!first && t) first = t;
      continue;
    }
    const hd = heading(t);
    if (hd && hd.level === 1 && line.length - line.trimStart().length <= 3 && clean(hd.text)) return clean(hd.text);
    if (!first && t) first = t;
  }
  if (first) {
    const hd = heading(first);
    const c = clean(hd ? hd.text : first);
    if (c) return c;
  }
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return clean(`${worker.trim() || 'Handoff'} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
}

const slug = (s: string, max = 48) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'handoff';

interface Filed {
  e: HandoffEntry;
  body: string;
  op: string;
  source: string; // candidate id + revision
}

interface Cand {
  c: HandoffCandidate;
  text: string;
}

export class HandoffSim {
  private readonly cands = new Map<string, Cand>();
  private readonly filed: Filed[] = [];
  private next = 1;
  private turns = 0;
  private failNext: string | null = null;
  /** The items `sim.final` and `sim.prompt_turn` added to each worker's timeline (a new watch has them too). */
  private readonly items = new Map<string, TranscriptItem[]>();
  /** #224: agent handoff requests by op, the skill missing, and each worker's cache state. */
  private readonly reqs = new Map<string, AgentHandoff & { worker: string }>();
  private skillMissing = false;
  private readonly caches = new Map<string, CacheState>();

  constructor(
    private readonly h: HandoffHost,
    readonly enabled: boolean,
    seed = 0,
  ) {
    const floor = h.floors()[0];
    if (enabled && floor && seed > 0) {
      const names = ['Pixel', 'Mochi', 'Tofu', 'Biscuit'];
      for (let i = 0; i < seed; i++) {
        const worker = names[i % names.length] as string;
        const body = `# ${['Session loader refactor', 'Transcript pagination', 'Filing cabinet search', 'Hire review copy'][i % 4]}\n\nWhat changed, what is left.\n\n- The loader streams now.\n- \`make test\` passes.\n\n\`\`\`sh\nmake e2e SPEC=e2e/h223-handoff.spec.ts\n\`\`\`\n`;
        this.add(floor, { worker_name: worker, label: `h3d-${worker.toLowerCase()}`, harness: i % 2 ? 'codex' : 'claude', model: i % 2 ? 'gpt-6-sol' : 'claude-opus-5-5', branch: `h3d/${slug(worker)}-${i}`, cwd: `/home/u/.herdr/worktrees/herdr-3d/h3d-${slug(worker)}-${i}` }, body, h.now() - (seed - i) * 3_600_000, `seed-${i}`, `seed-${i}`);
      }
    }
  }

  decorate(world: Obj): void {
    if (!this.enabled) return;
    const counts: Record<string, number> = {};
    for (const f of this.filed) counts[f.e.floor] = (counts[f.e.floor] ?? 0) + 1;
    world.handoffs = { counts };
  }

  private count(floor: string): number {
    return this.filed.filter((f) => f.e.floor === floor).length;
  }

  private add(floor: string, w: Partial<HandoffEntry> & { worker_name: string }, body: string, at: number, op: string, source: string, kind: 'literal' | 'agent' = 'literal'): HandoffEntry {
    const title = titleOf(body, w.worker_name, at);
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    const base = `/home/u/handoff/${floor.replace(/[^A-Za-z0-9._-]/g, '-')}/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${slug(w.worker_name, 32)}-${slug(title)}`;
    let path = `${base}.md`;
    for (let i = 2; this.filed.some((f) => f.e.path === path); i++) path = `${base}-${i}.md`;
    const e: HandoffEntry = { ...w, id: this.next++, floor, path, title, created_at: at, source: kind, bytes: byteLen(body) + 120 };
    this.filed.push({ e, body, op, source });
    return e;
  }

  private worker(a: Obj, key = 'id'): Worker {
    const id = a[key];
    const w = typeof id === 'string' ? this.h.workers.find((x) => x.id === id) : undefined;
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(id)}"`);
    return w;
  }

  private current(a: Obj): { w: Worker; c: Cand } {
    const w = this.worker(a, 'worker');
    const c = this.cands.get(w.id);
    if (!c) throw this.h.error('handoff_unavailable', `no such handoff candidate: ${w.name ?? w.id} has no completed reply to file now`);
    if (c.c.id !== a.candidate) throw this.h.error('handoff_unavailable', `no such handoff candidate: reply "${String(a.candidate)}" is not ${w.name ?? w.id}'s latest completed reply any more`);
    if (typeof a.session === 'string' && a.session && a.session !== c.c.session) throw this.h.error('handoff_unavailable', 'no such handoff candidate: the agent session changed');
    if (typeof a.revision === 'string' && a.revision && a.revision !== c.c.revision) throw this.h.error('handoff_unavailable', 'no such handoff candidate: the reply changed');
    return { w, c };
  }

  private canGo(w: Worker): string {
    if (w.status === 'working') return `${w.name ?? w.id} is working`;
    if (w.status === 'blocked') return `${w.name ?? w.id} is blocked: it waits on you`;
    if (w.ask) return `${w.name ?? w.id} waits on its question`;
    return this.h.fireBlocked(w.id);
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    const ours = ['sim.final', 'sim.prompt_turn', 'sim.handoff_fail', 'worker.handoff_preview', 'worker.handoff', 'handoff.list', 'handoff.get', 'handoff.delete', 'worker.handoff_cancel', 'sim.agent_turn', 'sim.agent_skill', 'sim.cache'];
    // #224: an exact top-level "/handoff [instruction]" from the composer is a request; any other prompt is not ours.
    if (t === 'worker.prompt' && this.enabled && typeof a.text === 'string') {
      const m = /^\s*\/handoff(?:\s+([\s\S]*?))?\s*$/.exec(a.text);
      if (!m) return false;
      const w = this.worker(a);
      const r = this.ask(w, typeof a.op === 'string' && a.op ? a.op : `prompt-${++this.turns}`, m[1] ?? '', false, send, true);
      ack({ queued: false, retried: false, handoff: r.request, ...(r.existing ? { existing: true } : {}) });
      return true;
    }
    if (typeof t !== 'string' || !ours.includes(t)) return false;
    if (!this.enabled && !t.startsWith('sim.')) throw this.h.error('unknown_command', `unknown command: "${t}"`);
    switch (t) {
      case 'sim.final': {
        const w = this.worker(a);
        const text = typeof a.text === 'string' ? a.text : '';
        const harness = a.harness === 'codex' || (w.harness ?? w.agent_kind) === 'codex' ? 'codex' : 'claude';
        const n = ++this.turns;
        const message = `msg_sim${n}`;
        const item: TranscriptItem = { id: harness === 'codex' ? message : `${message}#0`, seq: this.h.nextSeq(w.id), ts: this.h.now(), kind: 'assistant', parts: [{ text }] };
        this.h.push(w.id, [item], []);
        this.keep(w.id, item);
        const images = Number.isInteger(a.images) ? (a.images as number) : 0;
        const c: HandoffCandidate = { id: `cand${String(n).padStart(12, '0')}`, session: w.agent_session ?? 'sim-session', revision: `rev${n}-${byteLen(text)}`, harness, message, source: 'message', bytes: byteLen(text), ...(images ? { images } : {}), ...(byteLen(text) > MAX ? { too_large: true } : {}) };
        if (!text.trim()) {
          this.cands.delete(w.id);
          delete w.handoff;
        } else {
          this.cands.set(w.id, { c, text });
          w.handoff = c;
        }
        this.h.upsert(send, w);
        ack({ candidate: w.handoff ?? null });
        return true;
      }
      case 'sim.prompt_turn': {
        const w = this.worker(a);
        const item: TranscriptItem = { id: `sim-prompt-${++this.turns}`, seq: this.h.nextSeq(w.id), ts: this.h.now(), kind: 'user', parts: [{ text: typeof a.text === 'string' ? a.text : 'Go on.' }] };
        this.h.push(w.id, [item], []);
        this.keep(w.id, item);
        this.cands.delete(w.id);
        delete w.handoff;
        this.h.upsert(send, w);
        ack();
        return true;
      }
      case 'sim.handoff_fail':
        this.failNext = typeof a.code === 'string' ? a.code : 'handoff_failed';
        ack();
        return true;
      case 'sim.agent_skill':
        this.skillMissing = a.missing === true;
        ack();
        return true;
      case 'sim.cache': {
        const w = this.worker(a);
        this.caches.set(w.id, a.state === 'warm' || a.state === 'unknown' ? a.state : 'expired');
        ack();
        return true;
      }
      case 'sim.agent_turn': {
        const w = this.worker(a);
        const r = [...this.reqs.values()].find((x) => x.worker === w.id && x.state === 'pending');
        if (!r) throw this.h.error('invalid_state', `${w.name ?? w.id} has no handoff request running`);
        if (typeof a.fail === 'string') {
          this.settle(w, r, { state: 'failed', reason: a.fail }, send);
          ack({ request: this.view(r) });
          return true;
        }
        const body = typeof a.text === 'string' ? a.text : `# ${w.name ?? w.id}: handoff\n\nWhat changed, what is left.\n`;
        const e = this.add(
          w.session,
          JSON.parse(JSON.stringify({ worker_id: w.id, worker_name: w.name ?? w.id, label: w.label, harness: w.harness ?? w.agent_kind, model: w.model, branch: w.branch, cwd: w.worktree?.checkout_path ?? w.cwd, agent_session: w.agent_session })) as HandoffEntry,
          body,
          this.h.now(),
          r.op,
          `agent/${r.op}`,
          'agent',
        );
        this.h.emit(send, { t: 'handoff.added', session: e.floor, handoff: e, handoff_count: this.count(e.floor) });
        const done: Partial<AgentHandoff> = { state: 'filed', handoff: e.id };
        if (r.send_home) {
          const why = this.canGo(w);
          if (why) Object.assign(done, { send_home_result: 'skipped', send_home_reason: why });
          else done.send_home_result = 'started';
        }
        this.settle(w, r, done, send);
        if (done.send_home_result === 'started') {
          try {
            this.h.fire(w.id, send);
          } catch {
            // gone already
          }
        }
        ack({ request: this.view(r), handoff: e });
        return true;
      }
      case 'worker.handoff_cancel': {
        const w = this.worker(a, 'worker');
        const r = this.reqs.get(String(a.op));
        if (!r || r.worker !== w.id || w.agent_handoff?.op !== r.op) throw this.h.error('invalid_state', `${w.name ?? w.id} has no handoff request "${String(a.op)}"`);
        if (r.state === 'pending') this.settle(w, r, { state: 'failed', reason: 'cancelled' }, send);
        else {
          delete w.agent_handoff;
          this.h.upsert(send, w);
        }
        ack(this.view(r));
        return true;
      }
      case 'worker.handoff_preview': {
        if (a.mode === 'agent') {
          const w = this.worker(a, 'worker');
          const c = this.cands.get(w.id);
          const why = this.canGo(w);
          const harness = (w.harness ?? w.agent_kind) === 'codex' ? 'codex' : 'claude';
          const cannot = this.cannotAsk(w);
          const state = this.caches.get(w.id) ?? 'expired';
          const ctx = w.usage?.context_tokens ?? 48_200;
          const at = this.h.now();
          ack({
            ...(c && c.c.id === a.candidate ? { candidate: c.c, text: c.text.slice(0, PREVIEW), title: titleOf(c.text, w.name ?? '', at) } : {}),
            provenance: { floor: w.session, worker_name: w.name ?? w.id, label: w.label, harness: w.harness ?? w.agent_kind, model: w.model, branch: w.branch, cwd: w.worktree?.checkout_path ?? w.cwd, session: w.agent_session },
            can_send_home: !why,
            ...(why ? { send_home_blocked: why } : {}),
            agent: { ...(this.skillMissing ? {} : { call: harness === 'codex' ? '$handoff' : '/handoff' }), can_ask: !cannot, ...(cannot ? { cannot_ask: cannot } : {}), harness, model: w.model, instruction: 'summarize the conversation' },
            cache: {
              state,
              estimated: true,
              evidence: {
                estimated: true,
                provider: harness === 'codex' ? 'openai' : 'anthropic',
                model: w.model,
                policy: harness === 'codex' ? 'assumed' : 'observed_1h',
                ...(harness === 'codex' ? { reason: 'ChatGPT-subscription cache lifetime is not documented' } : { ttl_min_ms: 3_600_000, ttl_max_ms: 3_600_000 }),
                request_from: at - (state === 'warm' ? 600_000 : 7_200_000) - 4000,
                request_to: at - (state === 'warm' ? 600_000 : 7_200_000),
                cache_read: 41_000,
                context_tokens: ctx,
              },
            },
          });
          return true;
        }
        const { w, c } = this.current(a);
        let text = c.text;
        let cut = false;
        if (byteLen(text) > PREVIEW) {
          text = new TextDecoder().decode(enc.encode(text).slice(0, PREVIEW)).replace(/�+$/, '');
          cut = true;
        }
        const why = this.canGo(w);
        ack({
          candidate: c.c,
          text,
          ...(cut ? { truncated: true } : {}),
          title: titleOf(c.text, w.name ?? '', this.h.now()),
          provenance: { floor: w.session, worker_name: w.name ?? w.id, label: w.label, harness: w.harness ?? w.agent_kind, model: w.model, branch: w.branch, cwd: w.worktree?.checkout_path ?? w.cwd, session: c.c.session },
          can_send_home: !why,
          ...(why ? { send_home_blocked: why } : {}),
        });
        return true;
      }
      case 'worker.handoff': {
        for (const k of Object.keys(a)) if (!['worker', 'mode', 'session', 'candidate', 'revision', 'send_home', 'op', 'instruction'].includes(k)) throw this.h.error('bad_request', `bad args: json: unknown field "${k}"`);
        if (a.mode === 'agent') {
          if (typeof a.op !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.op)) throw this.h.error('bad_request', 'bad args: op must be 1–64 characters of A-Z, a-z, 0-9, _ and -');
          const r = this.ask(this.worker(a, 'worker'), a.op, typeof a.instruction === 'string' ? a.instruction : '', a.send_home === true, send, false);
          ack({ request: r.request, ...(r.existing ? { existing: true } : {}) });
          return true;
        }
        if (a.mode !== 'literal') throw this.h.error('bad_request', `bad args: mode must be "literal" or "agent", got "${String(a.mode)}"`);
        if (typeof a.op !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.op)) throw this.h.error('bad_request', 'bad args: op must be 1–64 characters of A-Z, a-z, 0-9, _ and -');
        const { w, c } = this.current(a);
        if (c.c.too_large) throw this.h.error('too_large', 'the reply is too large');
        const prior = this.filed.find((f) => f.op === a.op) ?? this.filed.find((f) => f.source === `${c.c.id}/${c.c.revision}`);
        const res: Obj = {};
        if (prior) {
          res.handoff = prior.e;
          res.existing = true;
        } else {
          if (this.failNext) {
            const code = this.failNext;
            this.failNext = null;
            throw this.h.error(code, code === 'handoff_source' ? 'the reply\'s lines changed' : 'filing the handoff failed: disk full (simulated)');
          }
          const e = this.add(
            w.session,
            JSON.parse(JSON.stringify({ worker_id: w.id, worker_name: w.name ?? w.id, label: w.label, harness: w.harness ?? w.agent_kind, model: w.model, branch: w.branch, cwd: w.worktree?.checkout_path ?? w.cwd, agent_session: c.c.session })) as HandoffEntry,
            c.text,
            this.h.now(),
            a.op,
            `${c.c.id}/${c.c.revision}`,
          );
          this.h.emit(send, { t: 'handoff.added', session: e.floor, handoff: e, handoff_count: this.count(e.floor) });
          res.handoff = e;
        }
        if (a.send_home === true) {
          const why = this.canGo(w);
          if (why) Object.assign(res, { send_home: 'skipped', send_home_reason: why });
          else {
            try {
              this.h.fire(w.id, send);
              res.send_home = 'started';
            } catch (err) {
              Object.assign(res, { send_home: 'skipped', send_home_reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        ack(res);
        return true;
      }
      case 'handoff.list': {
        const floor = typeof a.floor === 'string' ? a.floor : '';
        if (!floor) throw this.h.error('bad_request', 'bad args: floor is required');
        const terms = (typeof a.q === 'string' ? a.q : '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
        let rows = this.filed.filter((f) => f.e.floor === floor);
        if (!terms.length) {
          ack({ floor, handoffs: rows.map((f) => f.e).sort((x, y) => y.created_at - x.created_at || y.id - x.id) });
          return true;
        }
        const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const hit = (s: string, t: string, last: boolean) => words(s).some((w) => (last ? w.startsWith(t) : w === t || w.startsWith(t)));
        rows = rows.filter((f) => terms.every((t, i) => [f.e.title, f.e.label ?? '', f.e.worker_name, f.e.branch ?? '', f.body].some((s) => hit(s, t, i === terms.length - 1))));
        const score = (f: Filed) => terms.filter((t) => hit(f.e.title, t, true)).length;
        const out = rows
          .sort((x, y) => score(y) - score(x) || y.e.created_at - x.e.created_at)
          .map((f) => {
            const lower = f.body.toLowerCase();
            const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), f.body.length));
            const from = Math.max(0, at - 40);
            const piece = f.body.slice(from, at + 80);
            let snip = piece;
            for (const t of terms) snip = snip.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi'), `${OPEN}$1${CLOSE}`);
            return { ...f.e, snippet: `${from > 0 ? '…' : ''}${snip}${at + 80 < f.body.length ? '…' : ''}` };
          });
        ack({ floor, handoffs: out });
        return true;
      }
      case 'handoff.get': {
        const f = this.filed.find((x) => x.e.id === a.id);
        if (!f) throw this.h.error('not_found', 'not found');
        ack({ handoff: f.e, body: f.body });
        return true;
      }
      default: {
        // handoff.delete
        if (a.confirm !== true) throw this.h.error('confirmation_required', 'confirmation required: deleting a handoff needs confirm: true');
        const i = this.filed.findIndex((x) => x.e.id === a.id);
        if (i < 0) throw this.h.error('not_found', 'not found');
        const [f] = this.filed.splice(i, 1) as [Filed];
        this.h.emit(send, { t: 'handoff.removed', session: f.e.floor, handoff_id: f.e.id, handoff_count: this.count(f.e.floor) });
        ack({ handoff: f.e });
        return true;
      }
    }
  }

  /** #224: why worker w's agent can't be asked now ("": it can). */
  private cannotAsk(w: Worker): string {
    const name = w.name ?? w.id;
    const kind = w.harness ?? w.agent_kind;
    if (kind !== 'claude' && kind !== 'codex') return `${name} runs no Claude or Codex agent`;
    if (w.ask) return `${name} waits on its question: answer it first`;
    if (w.status !== 'idle' && w.status !== 'done') return `${name} is ${w.status}: only an idle or done worker can be asked for a handoff`;
    if (w.agent_handoff && (w.agent_handoff.state === 'pending' || w.agent_handoff.state === 'starting' || w.agent_handoff.state === 'filing')) return `${name} is writing a handoff already`;
    if (this.skillMissing) return `${kind} lists no "handoff" skill in ${w.worktree?.checkout_path ?? w.cwd ?? 'its checkout'}`;
    return '';
  }

  private view(r: AgentHandoff & { worker: string }): AgentHandoff {
    const { worker: _w, ...v } = r;
    return { ...v };
  }

  /** #224: starts a request (or answers the one its op, or the worker's running one from the composer, names). */
  private ask(w: Worker, op: string, instruction: string, sendHome: boolean, send: Send, prompt: boolean): { request: AgentHandoff; existing: boolean } {
    const known = this.reqs.get(op);
    if (known) {
      if (known.worker !== w.id) throw this.h.error('bad_request', `bad args: op "${op}" is another worker's handoff`);
      return { request: this.view(known), existing: true };
    }
    const running = w.agent_handoff && w.agent_handoff.state === 'pending' ? this.reqs.get(w.agent_handoff.op) : undefined;
    if (prompt && running) return { request: this.view(running), existing: true };
    const cannot = this.cannotAsk(w);
    if (cannot) {
      if (this.skillMissing && cannot.includes('"handoff" skill')) throw this.h.error('handoff_skill_missing', `no handoff skill: ${cannot}`);
      throw this.h.error(cannot.endsWith('already') ? 'busy' : 'invalid_state', cannot);
    }
    const text = instruction.trim() || 'summarize the conversation';
    const r = { worker: w.id, op, state: 'pending' as const, started_at: this.h.now(), instruction: text, ...(sendHome ? { send_home: true } : {}) };
    this.reqs.set(op, r);
    w.agent_handoff = this.view(r);
    const call = (w.harness ?? w.agent_kind) === 'codex' ? '$handoff' : '/handoff';
    const item: TranscriptItem = { id: `sim-handoff-${++this.turns}`, seq: this.h.nextSeq(w.id), ts: this.h.now(), kind: 'user', parts: [{ text: `${call} ${text}\n\nSave the handoff document at this exact path, not in the temporary directory: write it to /home/u/handoff/.pending/${w.session}/${op}.md.tmp first, then rename that file.\n\n(H3D-HANDOFF 0123456789abcdef)` }] };
    this.h.push(w.id, [item], []);
    this.keep(w.id, item);
    this.h.upsert(send, w);
    return { request: this.view(r), existing: false };
  }

  private settle(w: Worker, r: AgentHandoff & { worker: string }, done: Partial<AgentHandoff>, send: Send): void {
    Object.assign(r, done);
    w.agent_handoff = this.view(r);
    this.h.upsert(send, w);
  }

  private keep(id: string, it: TranscriptItem): void {
    const list = this.items.get(id) ?? [];
    list.push(it);
    this.items.set(id, list.slice(-40));
  }

  /** The items played into a worker's timeline, for a new watch of it. */
  extra(id: string): TranscriptItem[] {
    return this.items.get(id) ?? [];
  }

  /** A worker that left: its candidate goes. */
  forget(id: string): void {
    this.cands.delete(id);
  }
}

