import type { CommandRequest, ManualProcess, RequestedCommand, Worker } from '../net/protocol';

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';

/** Reject malformed requests rather than presenting an incomplete command for execution. */
export function commandRequestOf(worker: Pick<Worker, 'command_request'> | null | undefined): CommandRequest | null {
  const r: unknown = worker?.command_request;
  if (!obj(r) || !string(r.key) || !r.key || typeof r.at !== 'number' || !Number.isFinite(r.at) || !Array.isArray(r.commands) || !r.commands.length || r.commands.length > 3) return null;
  const commands: RequestedCommand[] = [];
  for (const c of r.commands) {
    if (!obj(c) || !string(c.command) || !c.command || !string(c.cwd) || typeof c.cwd_named !== 'boolean' || !['bridge', 'other', 'unknown'].includes(String(c.host)) || (c.host_text !== undefined && !string(c.host_text)) || (c.why !== undefined && !string(c.why))) return null;
    if (c.variants !== undefined && (!Array.isArray(c.variants) || !c.variants.every((v: unknown) => obj(v) && string(v.label) && string(v.command) && !!v.command && string(v.note)))) return null;
    const command: RequestedCommand = { command: c.command, cwd: c.cwd, cwd_named: c.cwd_named, host: c.host as RequestedCommand['host'], host_text: string(c.host_text) ? c.host_text : '', why: string(c.why) ? c.why : '' };
    if (Array.isArray(c.variants)) command.variants = c.variants.map((v) => ({ label: v.label as string, command: v.command as string, note: v.note as string }));
    commands.push(command);
  }
  return { key: r.key, at: r.at, commands };
}

export class ManualProcessBook {
  known = false;
  version = 0;
  private readonly byId = new Map<string, ManualProcess>();
  reset(list: ManualProcess[] | undefined): void {
    this.known = Array.isArray(list);
    this.byId.clear();
    for (const process of list ?? []) if (validProcess(process)) this.byId.set(process.id, process);
    this.version++;
  }
  upsert(process: ManualProcess): void {
    if (!validProcess(process)) return;
    this.known = true;
    this.byId.set(process.id, process);
    this.version++;
  }
  removed(id: string): void {
    this.known = true;
    if (this.byId.delete(id)) this.version++;
  }
  get(id: string): ManualProcess | undefined { return this.byId.get(id); }
  all(): ManualProcess[] { return [...this.byId.values()]; }
}

function validProcess(p: unknown): p is ManualProcess {
  return obj(p) && string(p.id) && !!p.id && string(p.worker) && string(p.state) && string(p.cleanup);
}

export function needsAttention(p: ManualProcess): boolean {
  return !['exited', 'stopped', 'failed'].includes(p.state) || p.cleanup === 'needed' || p.cleanup === 'failed';
}
