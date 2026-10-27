import type { CommandRequest, ManualProcess, Worker } from '../src/net/protocol.ts';
import { askpassEligible, askpassForm } from '../src/world/askpass.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;
interface Host { workers: Worker[]; now(): number; emit(send: Send, m: Obj): void; upsert(send: Send, w: Worker): void; final(id: string, text: string): void; later(fn: () => void, ms: number): void; }
interface State { records: Map<string, ManualProcess>; retired: Map<string, ManualProcess>; ops: Map<string, string>; next: number; closed: boolean }
const shared = new Map<string, State>();
const state = (): State => ({ records: new Map(), retired: new Map(), ops: new Map(), next: 0, closed: false });
const hostName = 'fixture-bridge';
const withoutCredential = (p: ManualProcess): ManualProcess => { const copy = { ...p }; delete copy.credential; return copy; };

/** Deterministic process simulator. No shell or external effects are run. */
export class ManualProcessSim {
  private readonly data: State;
  private readonly h: Host;
  private readonly preset: string | undefined;
  private readonly requestPreset: string | undefined;
  constructor(h: Host, preset: string | undefined, requestPreset: string | undefined) {
    this.h = h; this.preset = preset; this.requestPreset = requestPreset;
    if (preset) { this.data = shared.get(preset) ?? state(); shared.set(preset, this.data); }
    else this.data = state();
  }
  seed(): void {
    const w = this.h.workers.find((x) => x.name === 'Zippy') ?? this.h.workers[0];
    if (!w) return;
    if (this.preset && /cleanup|gone|all/.test(this.preset) && !this.data.records.has('mp_deadbeef')) {
      this.data.records.set('mp_deadbeef', { id: 'mp_deadbeef', op: 'seed-gone', worker: 'gone-worker', worker_name: 'Gone worker', floor: w.floor ?? w.session, session: w.session, workspace_id: '', tab_id: '', pane_id: '', host: hostName, cwd: w.cwd ?? '/', command: 'sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525', title: 'Tailscale background share', source: { kind: 'manual' }, state: 'exited', exit_code: 0, cleanup: 'needed', cleanup_note: 'Tailscale Serve https:8443 stays on until cleaned up', effects: [{ kind: 'tailscale_serve', endpoint: 'https:8443', cleanup_command: 'sudo tailscale serve --bg --https=8443 off', state: 'active' }], created_at: this.h.now() - 120_000, started_at: this.h.now() - 120_000, ended_at: this.h.now() - 60_000 });
    }
    if (!this.requestPreset) return;
    const isBg = this.requestPreset === 'tailscale-bg';
    const cmd = this.requestPreset === 'sudo' ? 'sudo id' : this.requestPreset === 'multi-line' ? 'printf "first\\n"\nprintf "second\\n"' : isBg ? 'sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525' : 'printf "hello from the fixture\\n"';
    this.h.final(w.id, `Please run this command on the bridge:\n\n\`\`\`sh\n${cmd}\n\`\`\``);
    if (this.data.closed) return;
    w.command_request = { key: `fixture-${this.requestPreset}`, at: this.h.now(), commands: [{ command: cmd, cwd: w.cwd ?? '/', cwd_named: false, host: this.requestPreset === 'other-host' ? 'other' : 'bridge', host_text: this.requestPreset === 'other-host' ? 'the build machine' : '', why: 'The agent needs this command run.', ...(isBg ? { variants: [{ label: 'temporary (foreground)', command: 'sudo tailscale serve --https=8443 http://127.0.0.1:39525', note: 'Ends when the process stops; --bg would keep serving after restarts.' }] } : {}) }] };
  }
  decorate(world: Obj): void { world.host = hostName; world.manual_processes = [...this.data.records.values()]; }
  has(id: string): boolean { return this.data.records.has(id); }
  private update(send: Send, p: ManualProcess): void { this.data.records.set(p.id, p); this.h.emit(send, { t: 'manual_process.upsert', process: p }); }
  private request(p: ManualProcess, attempt: number): ManualProcess { return { ...p, state: 'waiting', credential: { request: `cr_${p.id}_${attempt}`, prompt: '[sudo] password for fixture:', user: 'root', attempt, expires_at: this.h.now() + 120_000 } }; }
  handle(t: unknown, a: Obj, send: Send, ack: (v?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !(t.startsWith('manual_process.') || t === 'worker.dismiss_command_request' || t.startsWith('sim.manual_'))) return false;
    const error = (code: string, message: string) => fail(Object.assign(new Error(message), { code }));
    const id = String(a.id ?? '');
    if (t === 'sim.manual_list') { ack({ processes: [...this.data.records.values()] }); return true; }
    if (t === 'sim.manual_finish') { const p = this.data.records.get(id); if (!p) error('not_found', 'process not found'); else { this.update(send, { ...withoutCredential(p), state: 'exited', exit_code: Number(a.exit_code ?? 0), ended_at: this.h.now() }); ack(); } return true; }
    if (t === 'worker.dismiss_command_request') {
      const w = this.h.workers.find((x) => x.id === id);
      if (!w?.command_request || w.command_request.key !== a.key) error('stale', 'request is out of date');
      else { delete w.command_request; this.data.closed = true; this.h.upsert(send, w); ack(); }
      return true;
    }
    if (t === 'manual_process.start') {
      const op = String(a.op ?? ''); const command = String(a.command ?? ''); const worker = String(a.worker ?? '');
      const old = this.data.ops.get(op);
      if (old) { ack({ process: this.data.records.get(old) ?? this.data.retired.get(old) }); return true; }
      const w = this.h.workers.find((x) => x.id === worker);
      if (!w || !op || !command.trim()) { error('bad_args', 'worker, op and command are required'); return true; }
      if (a.askpass === true && !askpassEligible(command)) { error('bad_args', 'This command cannot use the password dialog.'); return true; }
      const source = (a.source ?? { kind: 'manual' }) as ManualProcess['source'];
      if (source.kind === 'suggestion') {
        const request: CommandRequest | undefined = w.command_request; const entry = request?.commands[source.index ?? -1];
        if (!request || request.key !== source.key || !entry || entry.host !== 'bridge' || ![entry.command, ...(entry.variants ?? []).map((v) => v.command)].includes(command)) { error('stale', 'request is out of date'); return true; }
        delete w.command_request; this.data.closed = true; this.h.upsert(send, w);
      }
      const now = this.h.now(); const pid = `mp_${(++this.data.next).toString(16).padStart(8, '0')}`;
      const bg = /tailscale\s+serve\s+.*--bg/.test(command);
      let p: ManualProcess = { id: pid, op, worker, worker_name: w.name ?? worker, floor: w.floor ?? w.session, session: w.session, workspace_id: 'fixture:w', tab_id: 'fixture:t', pane_id: `fixture:${pid}`, host: hostName, cwd: String(a.cwd || w.cwd || '/'), command, ...(a.askpass === true ? { launched: askpassForm(command) } : {}), title: command.split('\n')[0]!.slice(0, 60), source, state: 'starting', cleanup: bg ? 'needed' : 'none', ...(bg ? { cleanup_note: 'Tailscale Serve https:8443 stays on until cleaned up', effects: [{ kind: 'tailscale_serve', endpoint: 'https:8443', cleanup_command: 'sudo tailscale serve --bg --https=8443 off', state: 'active' as const }] } : {}), created_at: now, started_at: now, ended_at: 0 };
      this.data.ops.set(op, pid); this.update(send, p); ack({ process: p });
      this.h.later(() => { const current = this.data.records.get(pid); if (!current || current.state !== 'starting') return; p = a.askpass === true ? this.request(current, 1) : { ...current, state: 'running' }; this.update(send, p); }, 100);
      return true;
    }
    const p = this.data.records.get(id);
    if (!p) { error('not_found', 'process not found'); return true; }
    if (t === 'manual_process.stop') { this.update(send, { ...withoutCredential(p), state: 'stopped', ended_at: this.h.now(), cleanup: p.cleanup === 'needed' || p.cleanup === 'failed' ? 'done' : p.cleanup, ...(p.effects ? { effects: p.effects.map((e) => ({ ...e, state: 'removed' as const })) } : {}) }); ack({ process: this.data.records.get(id) }); return true; }
    if (t === 'manual_process.dismiss') { if (!['exited', 'stopped', 'failed'].includes(p.state) || !['none', 'done'].includes(p.cleanup)) error('invalid_state', 'process still needs cleanup'); else { this.data.retired.set(id, p); this.data.records.delete(id); this.h.emit(send, { t: 'manual_process.removed', id }); ack(); } return true; }
    if (t === 'manual_process.credential') {
      if (!p.credential || p.credential.request !== a.request) { error('stale', 'request is out of date'); return true; }
      if (a.cancel === true) this.update(send, { ...withoutCredential(p), state: 'exited', exit_code: 1, ended_at: this.h.now() });
      else if (a.secret === 'fixture-pass') this.update(send, { ...withoutCredential(p), state: 'running' });
      else this.update(send, this.request(p, p.credential.attempt + 1));
      ack(); return true;
    }
    return false;
  }
}
