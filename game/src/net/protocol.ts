/**
 * herdr-world protocol v1 (docs/protocol.md), as the game consumes it.
 *
 * Fields marked "M2" are additive and may be missing when talking to an older
 * bridge; the world store supplies fallbacks for every one of them.
 * Unknown fields and unknown message types are ignored.
 */

export const PROTO = 1;

export type WorkerStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Building {
  id: string;
  name: string;
  sort: number;
  /** Sessions in this building, top floor first (bridge-derived). */
  floors: string[];
}

export interface Floor {
  session: string;
  state: string; // running | asleep
  default?: boolean;
  building: string | null;
  index: number | null;
  error?: string;
  /** M2: desks the floor renders. */
  desks?: number;
}

export interface Worktree {
  repo_root: string;
  repo_name?: string;
  checkout_path: string;
  linked: boolean;
}

export interface Worker {
  id: string;
  session: string;
  workspace_id: string;
  label: string;
  cwd?: string;
  pane_id?: string;
  pane_label?: string;
  agent_kind?: string;
  agent_name?: string;
  agent_session?: string;
  status: string;
  title?: string;
  tokens?: Record<string, string>;
  worktree?: Worktree;
  role?: string;
  run?: string;
  /** M2: cute display name, unique per floor. */
  name?: string;
  /** M2: persistent desk slot on its floor. */
  desk_index?: number;
  /** M2: claude | codex | other. */
  harness?: string;
  /** M2: e.g. claude-opus-5-5, gpt-6-sol. */
  model?: string;
  /** M2: reasoning effort. */
  effort?: string;
  /** M2: unix ms (bridge clock) when `status` last changed. */
  status_since?: number;
}

export interface World {
  buildings: Building[];
  unassigned: string[];
  floors: Floor[];
  workers: Worker[];
}

export interface Hello {
  t: 'hello';
  proto: number;
  client: string;
  since_seq?: number;
  epoch?: string;
}

export interface Welcome {
  t: 'welcome';
  proto: number;
  server_seq: number;
  epoch: string;
  resume: 'snapshot' | 'replay';
  server?: string;
}

export interface Snapshot {
  t: 'world.snapshot';
  seq: number;
  world: World;
}

export interface BuildingUpsert {
  t: 'building.upsert';
  seq: number;
  building: Building;
}
export interface BuildingRemoved {
  t: 'building.removed';
  seq: number;
  id: string;
}
export interface FloorUpsert {
  t: 'floor.upsert';
  seq: number;
  floor: Floor;
}
export interface FloorRemoved {
  t: 'floor.removed';
  seq: number;
  session: string;
}
export interface WorkerUpsert {
  t: 'worker.upsert';
  seq: number;
  worker: Worker;
}
export interface WorkerStatusEvent {
  t: 'worker.status';
  seq: number;
  id: string;
  session: string;
  workspace_id: string;
  status: string;
  prev_status?: string;
  /** M2 */
  status_since?: number;
  /** M2: the terminal title, "" when cleared. Absent on an older bridge. */
  title?: string;
}
export interface WorkerRemoved {
  t: 'worker.removed';
  seq: number;
  id: string;
  session: string;
  workspace_id: string;
}

export type WorldEvent =
  | BuildingUpsert
  | BuildingRemoved
  | FloorUpsert
  | FloorRemoved
  | WorkerUpsert
  | WorkerStatusEvent
  | WorkerRemoved;

export interface ErrorMessage {
  t: 'error';
  req_id?: string;
  code: string;
  message: string;
}

/** Any other object with a string `t` (acks, future event types). */
export interface OtherMessage {
  t: string;
  seq?: number;
}

export type ServerMessage = Welcome | Snapshot | WorldEvent | ErrorMessage | OtherMessage;

const EVENT_TYPES = new Set([
  'building.upsert',
  'building.removed',
  'floor.upsert',
  'floor.removed',
  'worker.upsert',
  'worker.status',
  'worker.removed',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Parses one text frame; null when it is not a JSON object with a string `t`. */
export function parseMessage(raw: string): ServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || !isStr(v.t)) return null;
  return v as unknown as ServerMessage;
}

export function isWelcome(m: ServerMessage): m is Welcome {
  const o = m as unknown as Obj;
  return m.t === 'welcome' && isInt(o.server_seq) && isStr(o.epoch) && (o.resume === 'snapshot' || o.resume === 'replay');
}

export function isSnapshot(m: ServerMessage): m is Snapshot {
  const o = m as unknown as Obj;
  if (m.t !== 'world.snapshot' || !isInt(o.seq) || !isObj(o.world)) return false;
  const w = o.world;
  return Array.isArray(w.buildings) && Array.isArray(w.floors) && Array.isArray(w.workers);
}

/** A known world event with the fields the store needs; anything else is ignored. */
export function isWorldEvent(m: ServerMessage): m is WorldEvent {
  if (!EVENT_TYPES.has(m.t)) return false;
  const o = m as unknown as Obj;
  if (!isInt(o.seq)) return false;
  switch (m.t) {
    case 'building.upsert':
      return isObj(o.building) && isStr(o.building.id);
    case 'building.removed':
      return isStr(o.id);
    case 'floor.upsert':
      return isObj(o.floor) && isStr(o.floor.session);
    case 'floor.removed':
      return isStr(o.session);
    case 'worker.upsert':
      return isObj(o.worker) && isStr(o.worker.id) && isStr(o.worker.session);
    case 'worker.status':
      return isStr(o.id) && isStr(o.status);
    case 'worker.removed':
      return isStr(o.id);
  }
  return false;
}

export function isError(m: ServerMessage): m is ErrorMessage {
  const o = m as unknown as Obj;
  return m.t === 'error' && isStr(o.code);
}
