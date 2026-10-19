// #66: schedule suggestions for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over). Rules,
// like herdr-world's (docs/protocol.md "Schedule suggestions"):
// - the snapshot's `schedule_suggestions` is the feature's state (absent with `simai=off`, `simfail=no_ai` or
//   `simschedsuggest=none`, and then every command below answers `unknown_command`). Without a knob it follows the
//   simulated AI integration (tools/fixture-ai.ts): `off` until `schedule_suggestions.set {enabled: true}` (no test),
//   `incomplete` (with `missing`) while a model is not ready, and that set is refused `incomplete`.
//   `simschedsuggest=on|off|incomplete|env|env-off` fixes the state with no models at all (`incomplete`: the LLM is not
//   set up; `env`: on and read-only, `env-off`: off and read-only, `env_locked` to change); every change is a
//   `schedule_suggestions.update` with the state flat in it;
// - `schedule_suggestions.zone {zone}` keeps an IANA zone (this Node's Intl knows it, not "Local"), else `bad_request`;
// - `sim.suggest {id, due_at?, title?, draft_prompt?}` (the simulator's own) gives a worker a suggestion of its current
//   reply (its handoff candidate's message; `sim.final` plays one): a worker.upsert, the ack `{suggestion}`. Its time
//   defaults to 10:45 UTC tomorrow;
// - `worker.dismiss_schedule_suggestion {id, suggestion}` checks like the bridge (`unknown_worker`, `stale`) and
//   clears it; a `schedule.create` whose `source` is `{kind: suggestion}` of the worker's suggestion's message clears it
//   too (after the create); `worker.prompt`, `sim.prompt_turn` and `sim.final` (the transcript went on) clear it;
// - `simsuggest=<key>` starts Zippy (else the first Claude worker) with a finished reply and its suggestion. A
//   suggestion dismissed or saved is remembered by the key, as a bridge's database would: a reload (a new connection)
//   does not seed it again. The key keeps parallel tests apart.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { ScheduleSuggestion, Worker } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface SchedSuggestHost {
  readonly workers: Worker[];
  readonly ai: AiSim;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
  upsert(send: Send, w: Worker): void;
  /** The simulator's `sim.final`: the worker's agent ends its turn with text (its handoff candidate). */
  final(id: string, text: string): void;
}

/** The knob's states: rules on the AI integration, or fixed. */
export type SchedSuggestMode = 'rules' | 'on' | 'off' | 'incomplete' | 'env' | 'env-off' | 'none';

const MODES: readonly string[] = ['on', 'off', 'incomplete', 'env', 'env-off', 'none'];

export function schedSuggestMode(v: string | null | undefined): SchedSuggestMode {
  return v && MODES.includes(v) ? (v as SchedSuggestMode) : 'rules';
}

/** The seeded reply: the motivating rollout summary. */
export const SEED_REPLY =
  '## Vector 0.59 rollout\n\nPR #412 is merged and the play ran on all 14 log shippers; every host reports 0.59.1.\n\n**Remaining**\n- 24h soak, until about 10:45 UTC tomorrow.\n- After the soak: delete the `/var/backups/vector-0.58/` backups on all 14 hosts, attach the dashboard to OPS-2291 and close it.';

const SEED_TITLE = 'Post-soak cleanup: Vector 0.59 rollout';
const SEED_PROMPT =
  'You are picking up the Vector 0.59 rollout after its 24h soak. Read the attached handoff (the original agent’s summary) first.\n\n1. Check the Loki ingest dashboard and the shippers’ `journalctl -u vector` for errors.\n2. If both are clean, delete `/var/backups/vector-0.58/` on all 14 hosts.\n3. Attach the dashboard screenshot to OPS-2291 and close it.';

/** What a key's connections share: the seeded suggestion's outcome. */
const shared = new Map<string, { closed: boolean }>();

/** 10:45 UTC on the day after `now` (UTC). */
export function tomorrowAt1045(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 10, 45);
}

/** Whether this Node's Intl knows an IANA zone name (the bridge loads it with Go's time package). */
export function knownZone(zone: string): boolean {
  // An offset (+02:00) is no IANA name, though this Intl takes one: Go's time package does not.
  if (!/^[A-Za-z]/.test(zone) || zone === 'Local' || zone.length > 64 || /[^\x21-\x7e]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export class SchedSuggestSim {
  private enabled: boolean;
  private threshold = 0.7;
  private zone = '';
  private last = '';
  private turns = 0;
  private readonly h: SchedSuggestHost;
  private readonly mode: SchedSuggestMode;
  private readonly key: string | null;
  /** The worker whose suggestion is the seeded one (its outcome is the key's). */
  private seeded: string | null = null;

  constructor(h: SchedSuggestHost, mode: SchedSuggestMode, key: string | null = null) {
    this.h = h;
    this.mode = mode;
    this.key = key;
    this.enabled = mode === 'on' || mode === 'incomplete' || mode === 'env';
  }

  get present(): boolean {
    return this.mode !== 'none' && this.h.ai.present;
  }

  private missing(): Array<'classifier' | 'llm'> {
    if (this.mode === 'incomplete') return ['llm'];
    if (this.mode !== 'rules') return [];
    return (['classifier', 'llm'] as const).filter((r) => !this.h.ai.ready(r));
  }

  view(): Obj {
    const missing = this.missing();
    const state = !this.enabled ? 'off' : missing.length ? 'incomplete' : 'ready';
    const roles =
      this.mode === 'rules'
        ? (() => {
            const v = this.h.ai.view() as { classifier: { state: string }; llm: { state: string } };
            return { classifier: v.classifier.state, llm: v.llm.state };
          })()
        : { classifier: 'ready', llm: missing.includes('llm') ? 'off' : 'ready' };
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      state,
      ...(missing.length ? { missing } : {}),
      roles,
      env: this.mode === 'env' || this.mode === 'env-off' ? ['enabled'] : [],
      ...(this.zone ? { zone: this.zone } : {}),
    };
  }

  decorate(world: Obj): void {
    if (this.present) world.schedule_suggestions = this.view();
  }

  /** Emits schedule_suggestions.update when the state changed (also after the AI integration's). */
  changed(send: Send): void {
    if (!this.present) return;
    const v = JSON.stringify(this.view());
    if (v === this.last) return;
    this.last = v;
    this.h.emit(send, { t: 'schedule_suggestions.update', ...this.view() });
  }

  /** `simsuggest=<key>`: Zippy's finished reply and its suggestion, unless the key's was dismissed or saved. In the snapshot: no event. */
  seed(): void {
    if (this.key === null || shared.get(this.key)?.closed) return;
    const w = this.h.workers.find((x) => x.name === 'Zippy') ?? this.h.workers.find((x) => (x.harness ?? x.agent_kind) === 'claude');
    if (!w) return;
    this.h.final(w.id, SEED_REPLY);
    w.schedule_suggestion = this.suggestion(w, { due_at: tomorrowAt1045(this.h.now()), title: SEED_TITLE, draft_prompt: SEED_PROMPT });
    this.seeded = w.id;
  }

  private suggestion(w: Worker, a: Obj): ScheduleSuggestion {
    const message = w.handoff?.message;
    return {
      id: `sug${String(++this.turns).padStart(13, '0')}`,
      ...(message ? { message } : {}),
      due_at: typeof a.due_at === 'number' ? a.due_at : tomorrowAt1045(this.h.now()),
      title: typeof a.title === 'string' && a.title.trim() ? a.title : SEED_TITLE,
      draft_prompt: typeof a.draft_prompt === 'string' && a.draft_prompt.trim() ? a.draft_prompt : SEED_PROMPT,
      score: 0.93,
      at: this.h.now(),
    };
  }

  private worker(a: Obj): Worker {
    const w = this.h.workers.find((x) => x.id === a.id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(a.id)}"`);
    return w;
  }

  /** Clears worker id's suggestion (closed: the key remembers the seeded one). */
  private clear(send: Send, w: Worker, closed: boolean): void {
    if (!w.schedule_suggestion) return;
    delete w.schedule_suggestion;
    if (closed && w.id === this.seeded && this.key !== null) shared.set(this.key, { closed: true });
    this.h.upsert(send, w);
  }

  /** The transcript went on (a prompt, a new turn): the suggestion is moot. */
  moved(id: unknown, send: Send): void {
    const w = this.h.workers.find((x) => x.id === id);
    if (w) this.clear(send, w, false);
  }

  /** A schedule.create acked: one whose source names a worker's suggestion's message closes it. */
  created(source: unknown, send: Send): void {
    const s = source as { kind?: unknown; worker?: unknown; message?: unknown } | null;
    if (!s || s.kind !== 'suggestion') return;
    const w = this.h.workers.find((x) => x.id === s.worker);
    if (w?.schedule_suggestion && (w.schedule_suggestion.message ?? '') === (typeof s.message === 'string' ? s.message : '')) this.clear(send, w, true);
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    const ours = ['schedule_suggestions.get', 'schedule_suggestions.set', 'schedule_suggestions.zone', 'worker.dismiss_schedule_suggestion', 'sim.suggest'];
    if (typeof t !== 'string' || !ours.includes(t)) return false;
    if (!this.present && t !== 'sim.suggest') {
      fail(this.h.error('unknown_command', `unknown command: ${t}`));
      return true;
    }
    try {
      switch (t) {
        case 'schedule_suggestions.get':
          ack(this.view());
          break;
        case 'schedule_suggestions.set': {
          const th = a.threshold;
          if (th !== undefined && (typeof th !== 'number' || !(th >= 0.05 && th <= 0.99))) throw this.h.error('bad_request', 'bad args: threshold must be 0.05-0.99');
          if (typeof a.enabled === 'boolean' && a.enabled !== this.enabled) {
            if (this.mode === 'env' || this.mode === 'env-off') throw this.h.error('env_locked', 'schedule suggestions are switched by the bridge environment (HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED)');
            if (a.enabled && this.missing().length) throw this.h.error('incomplete', 'schedule suggestions need the classification model and the LLM to be ready');
            this.enabled = a.enabled;
          }
          if (typeof th === 'number') this.threshold = th;
          this.changed(send);
          ack(this.view());
          break;
        }
        case 'schedule_suggestions.zone': {
          const zone = typeof a.zone === 'string' ? a.zone : '';
          if (!knownZone(zone)) throw this.h.error('bad_request', `bad args: not an IANA time zone name: "${zone}"`);
          this.zone = zone;
          this.changed(send);
          ack(this.view());
          break;
        }
        case 'worker.dismiss_schedule_suggestion': {
          const w = this.worker(a);
          if (!w.schedule_suggestion || w.schedule_suggestion.id !== a.suggestion) throw this.h.error('stale', `stale: the worker has no open schedule suggestion "${String(a.suggestion)}" (accepted, dismissed, or the transcript went on)`);
          this.clear(send, w, true);
          ack();
          break;
        }
        case 'sim.suggest': {
          const w = this.worker(a);
          w.schedule_suggestion = this.suggestion(w, a);
          this.h.upsert(send, w);
          ack({ suggestion: w.schedule_suggestion });
          break;
        }
      }
    } catch (e) {
      fail(e);
    }
    return true;
  }
}
