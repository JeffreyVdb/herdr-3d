// #93 hire presets for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over). Rules, like
// herdr-world's (docs/protocol.md "Hire presets"):
// - the snapshot's `hire_presets` lists every preset by name ignoring case (absent with `simfail=no_hire_presets`, and
//   then every command below answers `unknown_command`);
// - `hire_preset.create {name, floor?, prompt, harness, model, effort}` and `hire_preset.update {id, …the same}` check
//   like the bridge (`bad_request`: a name of 1-40 bytes without control characters, a prompt of 1-32 KiB not starting
//   with `--` (for Claude no control characters but line ends and tabs), the harness / model / effort of the hire
//   options; no other keys), a floor the world has (`unknown_session`; on update only when the floor changes) and a
//   name unique ignoring case within its scope (`name_taken`; the same name on another floor or globally is fine). The
//   ack is the preset; each change is a `hire_preset.upsert`, an unchanged update none; an unknown id is `not_found`;
// - `hire_preset.delete {id}` sends `hire_preset.removed {id}`; deleting a virtual floor (`floor.delete`) removes its
//   own presets the same way (`dropFloor`);
// - `simhirepresets=<key>`: the connections with the same key share the presets (a change reaches all of them, and a
//   reload finds them again: the bridge's database); without it they are the connection's own. Each test takes its own
//   key: the fixture server is shared by the parallel tests.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { HireOptions, HirePreset } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface HirePresetHost {
  /** Whether the world has this floor (a floor id). */
  hasFloor(id: string): boolean;
  readonly hire: HireOptions;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

interface Shared {
  presets: Map<string, HirePreset>;
  /** Each connection's announce (its last send), for a change another connection made. */
  worlds: Set<(m: Obj) => void>;
}

const shared = new Map<string, Shared>();
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const MAX_PROMPT = 32 << 10;
const MAX_NAME = 40;
const KEYS = ['name', 'floor', 'prompt', 'harness', 'model', 'effort'];
const OURS = ['hire_preset.create', 'hire_preset.update', 'hire_preset.delete'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const UNTYPABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

let serial = 0;

export class HirePresetSim {
  private readonly h: HirePresetHost;
  readonly enabled: boolean;
  private readonly group: Shared;
  private readonly hear: ((m: Obj) => void) | null;

  constructor(h: HirePresetHost, enabled: boolean, key: string | null, announce?: (m: Obj) => void) {
    this.h = h;
    this.enabled = enabled;
    let g = key === null ? undefined : shared.get(key);
    if (!g) {
      g = { presets: new Map(), worlds: new Set() };
      if (key !== null) shared.set(key, g);
    }
    this.group = g;
    this.hear = announce ?? null;
    if (announce) g.worlds.add(announce);
  }

  dispose(): void {
    if (this.hear) this.group.worlds.delete(this.hear);
  }

  view(): HirePreset[] {
    return [...this.group.presets.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)).map((p) => structuredClone(p));
  }

  decorate(world: Obj): void {
    if (this.enabled) world.hire_presets = this.view();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (typeof t !== 'string' || !OURS.includes(t)) return false;
    if (!this.enabled) throw this.h.error('unknown_command', `unknown command: ${t}`);
    if (t === 'hire_preset.delete') {
      this.only(a, ['id']);
      const p = this.get(a.id);
      this.group.presets.delete(p.id);
      this.tell(send, { t: 'hire_preset.removed', id: p.id });
      ack();
      return true;
    }
    if (t === 'hire_preset.create') {
      this.only(a, KEYS);
      const now = this.h.now();
      const p = this.check({ id: `hp_${(++serial).toString(16).padStart(16, '0')}`, created_at: now, updated_at: now }, a, null);
      this.group.presets.set(p.id, p);
      this.tell(send, { t: 'hire_preset.upsert', hire_preset: structuredClone(p) });
      ack(structuredClone(p));
      return true;
    }
    this.only(a, ['id', ...KEYS]);
    const cur = this.get(a.id);
    const next = this.check({ id: cur.id, created_at: cur.created_at, updated_at: cur.updated_at }, a, cur);
    if (JSON.stringify(next) === JSON.stringify(cur)) {
      ack(structuredClone(cur));
      return true;
    }
    next.updated_at = Math.max(this.h.now(), cur.updated_at + 1);
    this.group.presets.set(next.id, next);
    this.tell(send, { t: 'hire_preset.upsert', hire_preset: structuredClone(next) });
    ack(structuredClone(next));
    return true;
  }

  /** A deleted virtual floor's own presets go with it (the global ones stay). */
  dropFloor(floor: string, send: Send): void {
    for (const p of [...this.group.presets.values()])
      if (p.floor === floor) {
        this.group.presets.delete(p.id);
        this.tell(send, { t: 'hire_preset.removed', id: p.id });
      }
  }

  /** This connection first (through `send`), then every other connection of the key. */
  private tell(send: Send, m: Obj): void {
    this.h.emit(send, m);
    for (const w of this.group.worlds) if (w !== this.hear) w(m);
  }

  private get(id: unknown): HirePreset {
    const p = typeof id === 'string' ? this.group.presets.get(id) : undefined;
    if (!p) throw this.h.error('not_found', `not found: hire preset ${JSON.stringify(id)}`);
    return p;
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  private bad(why: string): Error {
    return this.h.error('bad_request', `invalid argument: ${why}`);
  }

  private check(base: Pick<HirePreset, 'id' | 'created_at' | 'updated_at'>, a: Obj, cur: HirePreset | null): HirePreset {
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    const name = str(a.name).trim();
    if (!name || bytes(name) > MAX_NAME || CONTROL.test(name)) throw this.bad(`preset name must be 1-${MAX_NAME} bytes without control characters`);
    const floor = str(a.floor);
    if (floor && floor !== cur?.floor && !this.h.hasFloor(floor)) throw this.h.error('unknown_session', `unknown session: "${floor}"`);
    const [harness, model, effort] = [str(a.harness), str(a.model), str(a.effort)];
    const o = this.h.hire[harness];
    if (!o) throw this.bad(`unknown harness ${harness}`);
    if (!o.models.includes(model)) throw this.bad(`${harness} has no model ${model}`);
    if (![...o.efforts, ...(o.extra_efforts?.[model] ?? [])].includes(effort)) throw this.bad(`${model} has no effort ${effort}`);
    const prompt = str(a.prompt);
    if (!prompt.trim() || bytes(prompt) > MAX_PROMPT || prompt.startsWith('--') || prompt.includes('\u0000')) throw this.bad(`prompt must be 1-${MAX_PROMPT} bytes of text, not starting with "--"`);
    if (harness === 'claude' && UNTYPABLE.test(prompt)) throw this.bad('prompt for Claude is typed: it must not be blank or hold control characters other than line ends and tabs');
    for (const p of this.group.presets.values())
      if (p.id !== base.id && (p.floor ?? '') === floor && p.name.toLowerCase() === name.toLowerCase())
        throw this.h.error('name_taken', `name already used: a hire preset ${floor ? 'on this floor' : 'global'} is called "${name}"`);
    const p: HirePreset = { id: base.id, name, prompt, harness, model, effort, created_at: base.created_at, updated_at: base.updated_at };
    return floor ? { ...p, floor } : p;
  }
}
