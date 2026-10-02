// #110: pack up on request for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over). Rules,
// like herdr-world's (docs/protocol.md "Pack up on request"):
// - the snapshot's `packup` is the feature's state (absent with `simai=off` or `simfail=no_ai`): `off` until
//   `packup.set {enabled: true}`, which is `test_required` unless `packup.test` passed with the models in use
//   (tools/fixture-ai.ts), `incomplete` (with `missing`) while a model is not ready; every change is a
//   `packup.update` with the state flat in it;
// - `packup.test` runs the labelled sample prompts through the classifier (Jev at `simjev=<url>`) and the core
//   matches through the LLM (the AI integration's endpoint), really called, like the bridge; only the core ones gate;
// - `packup.detect {id, text}`: off, not ready, a freelancer or a worker without a Claude or Codex agent: no match,
//   no call. Else the classifier scores the prompt (image markers masked to `[Image #n]`); at the threshold the LLM
//   lists the spans to remove, each an exact substring found in order and never over an image, cut out with the
//   joins tidied. Anything invalid, a failure, or 1.2 s gone by (the bridge's bound; the game's is 1.5 s): `{matched: false}`;
// - `sim.packup_lag {ms}` (the simulator's own, not a bridge command) holds every later detect's ack that long after its
//   answer, as a slow link or a busy bridge would: past the game's 1.5 s its answer comes too late (0: no lag).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Worker } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface PackupHost {
  readonly workers: Worker[];
  readonly ai: AiSim;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

const GATE = 'After the task, does the prompt tell the AI coding agent to wrap up and leave (go home, leave the office, clean up its worktree, end its session)?';
const FREELANCERS = ['code', 'review', 'ux', 'ground'];
const DETECT_MS = 1200;
const MAX_CHARS = 8000;
const SEPARATORS = ',;:–—-';

/** The labelled prompts (a part of the bridge's internal/packup samples): the four core ones first. */
const SAMPLES: Array<{ text: string; match: boolean; core?: boolean; task?: string }> = [
  { text: 'Please make a PR and end your turn', match: true, core: true, task: 'Please make a PR' },
  { text: 'Please make a PR and stop working', match: true, core: true, task: 'Please make a PR' },
  { text: 'Do the action, leave the office and clean up the worktree', match: true, core: true, task: 'Do the action' },
  { text: 'Please make a PR', match: false, core: true },
  { text: 'Fix the flaky login test, open a PR, then go home.', match: true },
  { text: 'Mach einen PR und geh dann nach Hause.', match: true },
  { text: 'Stop the dev server and restart it with --verbose.', match: false },
  { text: 'Add a \'Go home\' button to the elevator panel.', match: false },
];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const MARKER = /\[Image #(\d+)(?:: [^\]\n]+)?\]/g;

interface View {
  text: string;
  base: number;
  marks: Array<{ vs: number; ve: number; ps: number; pe: number }>;
}

/** What a model sees: the tail, each image marker as `[Image #n]`. */
function modelView(prompt: string): View {
  let base = Math.max(0, prompt.length - MAX_CHARS);
  const all = [...prompt.matchAll(MARKER)];
  for (const m of all) if (m.index < base && base < m.index + m[0].length) base = m.index + m[0].length;
  const v: View = { text: '', base, marks: [] };
  let at = base;
  for (const m of all) {
    if (m.index < base) continue;
    v.text += prompt.slice(at, m.index);
    const vs = v.text.length;
    v.text += `[Image #${m[1]}]`;
    v.marks.push({ vs, ve: v.text.length, ps: m.index, pe: m.index + m[0].length });
    at = m.index + m[0].length;
  }
  v.text += prompt.slice(at);
  return v;
}

function at(v: View, i: number): number {
  let d = v.base;
  for (const m of v.marks) if (m.ve <= i) d += m.pe - m.ps - (m.ve - m.vs);
  return i + d;
}

function join(left: string, right: string): string {
  const l = left.replace(/[ \t]+$/, '');
  const r = right.replace(/^[ \t]+/, '');
  const trimEnd = (s: string, chars: string) => {
    let e = s.length;
    while (e > 0 && chars.includes(s[e - 1]!)) e--;
    return s.slice(0, e);
  };
  if (!l.trim()) {
    let i = 0;
    while (i < r.length && ` \t\r\n${SEPARATORS}.`.includes(r[i]!)) i++;
    return r.slice(i);
  }
  if (!r.trim()) return trimEnd(l, ` \t\r\n${SEPARATORS}`);
  if ('.,;:!?)'.includes(r[0]!)) return trimEnd(l, ` \t${SEPARATORS}`) + r;
  if (l.endsWith('\n') || r.startsWith('\n') || r.startsWith('\r')) return l + r;
  return `${l} ${r}`;
}

/** Cuts the spans out of the prompt like the bridge, or says why it cannot. */
export function cutSpans(prompt: string, spans: string[]): { task: string; removed: Array<{ start: number; end: number }> } | string {
  const v = modelView(prompt);
  const cuts: Array<{ s: number; e: number }> = [];
  let pos = 0;
  for (const [i, sp] of spans.entries()) {
    const j = v.text.indexOf(sp, pos);
    if (j < 0) return `part ${i + 1} is not in the prompt (in order)`;
    const s = j;
    const e = j + sp.length;
    if (v.marks.some((m) => s < m.ve && m.vs < e)) return `part ${i + 1} would remove an image`;
    pos = e;
    const ps = at(v, s);
    const pe = at(v, e);
    const last = cuts.at(-1);
    if (last && last.e === ps) last.e = pe;
    else cuts.push({ s: ps, e: pe });
  }
  const pieces: string[] = [];
  let k = 0;
  for (const c of cuts) {
    pieces.push(prompt.slice(k, c.s));
    k = c.e;
  }
  pieces.push(prompt.slice(k));
  let acc = pieces[0]!;
  pieces.slice(1).forEach((p, i) => {
    if (!p.trim() && i !== pieces.length - 2) return;
    acc = join(acc, p);
  });
  return { task: acc.trim(), removed: cuts.map((c) => ({ start: c.s, end: c.e })) };
}

/** The LLM's answer: 1-8 non-blank spans, else why not. */
function parseSpans(text: string): string[] | string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return 'the LLM did not answer with a JSON object';
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return 'the LLM did not answer with a JSON object';
  }
  const r = isObj(raw) ? raw.remove : undefined;
  if (!Array.isArray(r) || !r.every((x) => typeof x === 'string')) return 'the LLM’s JSON is not a list of parts to remove';
  if (!r.length) return 'the LLM found nothing to remove';
  if (r.length > 8) return `the LLM listed ${r.length} parts (at most 8)`;
  if (r.some((x) => !x.trim())) return 'a part is empty';
  return r as string[];
}

interface Run {
  score: number;
  matched: boolean;
  task?: string;
  removed?: Array<{ start: number; end: number }>;
  error?: string;
}

export class PackupSim {
  private enabled = false;
  private threshold = 0.85;
  private passed: { fp: string; at: number } | null = null;
  private last = '';
  /** `sim.packup_lag`: ms each detect ack is held after its answer. */
  private lag = 0;

  constructor(private readonly h: PackupHost) {}

  private missing(): Array<'classifier' | 'llm'> {
    return (['classifier', 'llm'] as const).filter((r) => !this.h.ai.ready(r));
  }

  private fp(): string {
    return this.h.ai.fingerprint('classifier') + '|' + this.h.ai.fingerprint('llm');
  }

  private tested(): boolean {
    return !!this.passed && this.passed.fp === this.fp() && this.h.now() - this.passed.at <= 30 * 60_000;
  }

  view(): Obj {
    const missing = this.missing();
    const state = !this.enabled ? 'off' : missing.length ? 'incomplete' : 'ready';
    const view = this.h.ai.view() as { classifier: { state: string }; llm: { state: string } };
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      state,
      ...(missing.length ? { missing } : {}),
      roles: { classifier: view.classifier.state, llm: view.llm.state },
      env: [],
      tested: this.tested(),
    };
  }

  decorate(world: Obj): void {
    if (this.h.ai.present) world.packup = this.view();
  }

  /** Emits packup.update when the state changed (also after the AI integration's). */
  changed(send: Send): void {
    const v = JSON.stringify(this.view());
    if (v === this.last) return;
    this.last = v;
    this.h.emit(send, { t: 'packup.update', ...this.view() });
  }

  private conv(e: unknown): unknown {
    return e instanceof Error && typeof (e as Error & { code?: unknown }).code === 'string' ? this.h.error((e as Error & { code: string }).code, e.message) : e;
  }

  private async pipeline(prompt: string, threshold: number, extract = true): Promise<Run> {
    const v = modelView(prompt);
    const score = await this.h.ai.classify({ prompt: v.text }, GATE);
    if (score < threshold || !extract) return { score, matched: false };
    let out: string;
    try {
      out = await this.h.ai.complete(
        [
          { role: 'system', content: 'List the exact parts of the prompt to remove so that only the task is left, as {"remove":["..."]}.' },
          { role: 'user', content: `The prompt:\n\n${v.text}` },
        ],
        true,
      );
    } catch (e) {
      return { score, matched: false, error: e instanceof Error ? e.message : String(e) };
    }
    const spans = parseSpans(out);
    if (typeof spans === 'string') return { score, matched: false, error: spans };
    const cut = cutSpans(prompt, spans);
    if (typeof cut === 'string') return { score, matched: false, error: cut };
    return { score, matched: true, ...cut };
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t === 'sim.packup_lag') {
      if (typeof a.ms !== 'number' || !(a.ms >= 0)) throw this.h.error('bad_request', 'sim.packup_lag needs ms >= 0');
      this.lag = a.ms;
      ack();
      return true;
    }
    const ours = ['packup.get', 'packup.set', 'packup.test', 'packup.detect'];
    if (typeof t !== 'string' || !ours.includes(t)) return false;
    if (!this.h.ai.present) throw this.h.error('unsupported', 'unsupported: the bridge has no AI integration');
    switch (t) {
      case 'packup.get':
        ack(this.view());
        return true;
      case 'packup.set': {
        const th = a.threshold;
        if (th !== undefined && (typeof th !== 'number' || th < 0.05 || th > 0.99)) throw this.h.error('bad_request', 'threshold must be 0.05-0.99');
        if (a.enabled === true && !this.enabled) {
          if (this.missing().length) throw this.h.error('incomplete', 'pack up on request needs the classification model and the LLM to be ready');
          if (!this.tested()) throw this.h.error('test_required', 'run the pack-up test first: it must pass with the models in use');
        }
        if (typeof a.enabled === 'boolean') this.enabled = a.enabled;
        if (typeof th === 'number') this.threshold = th;
        this.changed(send);
        ack(this.view());
        return true;
      }
      case 'packup.test': {
        if (this.missing().length) throw this.h.error('incomplete', 'the pack-up test needs the classification model and the LLM to be ready');
        const th = typeof a.threshold === 'number' ? a.threshold : this.threshold;
        const fp = this.fp();
        const t0 = Date.now();
        void (async () => {
          const samples: Obj[] = [];
          let reason: string | undefined;
          for (const s of SAMPLES) {
            const r = await this.pipeline(s.text, th, !!(s.core && s.match));
            const right = !s.match ? r.score < th : s.core ? r.matched && r.task?.toLowerCase() === s.task?.toLowerCase() : r.score >= th;
            samples.push({ text: s.text, expect: s.match ? 'match' : 'skip', ...(s.core ? { core: true } : {}), score: r.score, matched: !!(s.core && r.matched),
              ...(s.core && r.task ? { task: r.task } : {}), ...(s.task ? { want_task: s.task } : {}), right, ...(s.core && r.error ? { error: r.error } : {}) });
            if (s.core && !right && !reason) {
              reason = !s.match
                ? `"${s.text}" scored ${r.score.toFixed(2)}, at or over the threshold ${th.toFixed(2)}`
                : r.score < th
                  ? `"${s.text}" scored ${r.score.toFixed(2)}, under the threshold ${th.toFixed(2)}`
                  : `the LLM did not cut "${s.text}": ${r.error ?? `it left "${r.task ?? ''}"`}`;
            }
          }
          if (!reason) this.passed = { fp, at: this.h.now() };
          this.changed(send);
          return { ok: !reason, ...(reason ? { reason } : {}), threshold: th, samples, right: samples.filter((s) => s.right).length, total: samples.length, latency_ms: Date.now() - t0 };
        })().then(ack, (e) => fail(this.conv(e)));
        return true;
      }
      default: {
        // packup.detect
        const text = typeof a.text === 'string' ? a.text : '';
        if (!text.trim()) throw this.h.error('bad_request', 'bad args: text must be 1-16384 bytes of UTF-8 without NUL');
        const w = this.h.workers.find((x) => x.id === a.id);
        if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(a.id)}"`);
        const kind = w.agent_kind ?? '';
        const skip = this.enabled === false || this.missing().length > 0 || FREELANCERS.includes(w.role ?? '') || (kind !== 'claude' && kind !== 'codex');
        if (skip) {
          ack({ matched: false, score: 0 });
          return true;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<Run>((done) => (timer = setTimeout(() => done({ score: 0, matched: false, error: 'timed out' }), DETECT_MS)));
        Promise.race([this.pipeline(text, this.threshold), late])
          .catch((): Run => ({ score: 0, matched: false }))
          .then((r) => {
            clearTimeout(timer);
            const answer = () => ack(r.matched ? { matched: true, ...(r.task ? { task: r.task } : {}), removed: r.removed, score: r.score } : { matched: false, score: r.score });
            if (this.lag > 0) setTimeout(answer, this.lag);
            else answer();
          });
        return true;
      }
    }
  }
}
