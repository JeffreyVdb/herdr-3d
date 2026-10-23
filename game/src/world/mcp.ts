import type { McpHarness, McpProvider, McpServer, McpSnapshot } from '../net/protocol';

/**
 * #196: the MCP & skills wall's logic, pure (no DOM, no three.js): how a Snapshot (`mcp.inventory` / `mcp.check`'s ack,
 * docs/protocol.md "MCP and skills") reads. The rows of the overview (the client merge rule), what each provider cell
 * says, which results are stale, the attention counts and the wall screen's lines. The screen is render/mcpScreen.ts,
 * the page ui/mcpOverview.ts, the polling mcp/link.ts.
 *
 * Rules (contract.md, AC5): both providers are always shown; a name absent from a provider whose configuration read is
 * ok is "not configured" there (informational), and only a name in `expected` counts as a missing configuration alert;
 * absent from a provider whose read is partial, failed, pending, unavailable or unsupported it is "unknown", never "not
 * configured" (only a whole read proves a name absent). Disabled, auth required, failed and approval required are
 * configured servers, never missing. A configuration read never says connected. Stale results (the bridge says so, or
 * the read is over 2 minutes old) never look healthy; nor does a status from a check or a worker over 10 minutes old.
 */

export const HARNESSES: readonly McpHarness[] = ['claude', 'codex'];
export const PROVIDER_NAME: Readonly<Record<McpHarness, string>> = { claude: 'Claude Code', codex: 'Codex' };
/** The client asks `mcp.inventory` this often while the wall is in view or the page is open. */
export const MCP_POLL_MS = 20_000;
/** A read older than this is stale (contract.md), whatever the bridge says. */
export const MCP_STALE_MS = 2 * 60_000;
/** A connection status (a separate check's or a worker's) older than this may be out of date: never healthy. */
export const MCP_EVIDENCE_STALE_MS = 10 * 60_000;

/** When a Snapshot came: its `generated_at` and the client's clock when its ack arrived (ages are the bridge's, never the clocks' skew). */
export interface Received {
  snap: McpSnapshot;
  /** Client ms (`Date.now()` scale) the ack arrived. */
  at: number;
}

const parse = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/**
 * How old a bridge timestamp of `r` is at `now` (client ms): its age on the bridge's clock when the Snapshot was made,
 * plus the time since it arrived. Null when there is none (or it does not parse).
 */
export function ageOf(at: string | null | undefined, r: Received, now: number): number | null {
  const t = parse(at);
  if (t === null) return null;
  const gen = parse(r.snap.generated_at) ?? t;
  return Math.max(0, gen - t) + Math.max(0, now - r.at);
}

/** An age in coarse words (`just now`, `4 min ago`, `2 h ago`, `3 d ago`): the wall redraws only when this changes. */
export function ageText(ms: number | null): string {
  if (ms === null) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.floor(hr / 24)} d ago`;
}

/** The provider's configuration is known: read ok or partially (its servers can be shown and counted). */
export function configKnown(p: McpProvider): boolean {
  return p.config.state === 'ok' || p.config.state === 'partial';
}

/** The provider's configuration was read whole: only then does an absent name mean "not configured" (a partial read may have missed it). */
export function configWhole(p: McpProvider): boolean {
  return p.config.state === 'ok';
}

/** The provider's configuration result is stale: the bridge says so, or it was read over `MCP_STALE_MS` ago (or never says when). */
export function configStale(p: McpProvider, r: Received, now: number): boolean {
  if (p.config.stale) return true;
  if (!configKnown(p)) return false;
  const age = ageOf(p.config.read_at, r, now);
  return age === null || age > MCP_STALE_MS;
}

/** The provider's skills result is stale, by the same rule. */
export function skillsStale(p: McpProvider, r: Received, now: number): boolean {
  if (p.skills.stale) return true;
  if (p.skills.state !== 'ok' && p.skills.state !== 'partial') return false;
  const age = ageOf(p.skills.read_at, r, now);
  return age === null || age > MCP_STALE_MS;
}

/** A configured server that needs you: failed, waiting for a sign-in or for approval. */
export const ATTENTION_STATUS: ReadonlySet<string> = new Set(['failed', 'auth_required', 'approval_required']);

/**
 * One provider's cell of a row: `present` (configured there: its server), `not_configured` (its read is whole and the
 * name is not in it), `missing` (the same, and the name is expected: an alert), `unknown` (its read is partial, failed,
 * pending, unavailable or unsupported: nothing can be said).
 */
export type McpCellKind = 'present' | 'not_configured' | 'missing' | 'unknown';

export interface McpCell {
  kind: McpCellKind;
  server: McpServer | null;
  /** It needs you: a missing expected server, or a configured one that failed, waits for a sign-in or an approval. */
  attention: boolean;
}

export interface McpRow {
  name: string;
  expected: boolean;
  cells: Record<McpHarness, McpCell>;
  /** A provider is missing this expected server. */
  missing: boolean;
}

/** Names compare exactly (contract.md: no merge by likeness); rows sort by name, case aside, then exactly. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** The cell of `name` in a provider. */
export function cellOf(p: McpProvider, name: string, expected: boolean): McpCell {
  const server = p.servers.find((s) => s.name === name) ?? null;
  if (server) return { kind: 'present', server, attention: ATTENTION_STATUS.has(server.status) };
  if (!configWhole(p)) return { kind: 'unknown', server: null, attention: false };
  return expected ? { kind: 'missing', server: null, attention: true } : { kind: 'not_configured', server: null, attention: false };
}

/**
 * The client merge rule: one row per name in either provider's servers or in `expected`, its cells per provider (the
 * same name in both is one row but two services: the cells stay apart). Pure.
 */
export function mcpRows(snap: Pick<McpSnapshot, 'providers' | 'expected'>): McpRow[] {
  const expected = new Set(snap.expected ?? []);
  const names = new Set<string>(expected);
  for (const h of HARNESSES) for (const s of snap.providers[h].servers) names.add(s.name);
  return [...names].sort(byName).map((name) => {
    const exp = expected.has(name);
    const cells = { claude: cellOf(snap.providers.claude, name, exp), codex: cellOf(snap.providers.codex, name, exp) };
    return { name, expected: exp, cells, missing: HARNESSES.some((h) => cells[h].kind === 'missing') };
  });
}

/** A provider's attention count: its configured servers that need you, and the expected names it is missing (when its read is whole). */
export function attentionCount(p: McpProvider, expected: readonly string[] = []): number {
  let n = p.servers.filter((s) => ATTENTION_STATUS.has(s.status)).length;
  if (configWhole(p)) for (const name of new Set(expected)) if (!p.servers.some((s) => s.name === name)) n++;
  return n;
}

/** What a provider's overall state reads as, worst first: the bridge cannot, the CLI is missing, nothing yet, the read failed, … */
export type ProviderTone = 'unsupported' | 'unavailable' | 'pending' | 'failed' | 'stale' | 'partial' | 'ok';

export function providerTone(p: McpProvider, r: Received, now: number): ProviderTone {
  if (p.config.state === 'unsupported') return 'unsupported';
  if (!p.available || p.config.state === 'unavailable') return 'unavailable';
  if (p.config.state === 'pending') return 'pending';
  if (p.config.state === 'failed') return p.servers.length && p.config.read_at ? 'stale' : 'failed';
  if (!configKnown(p)) return 'failed'; // a state this client does not know: never healthy
  if (configStale(p, r, now)) return 'stale';
  return p.config.state === 'partial' ? 'partial' : 'ok';
}

/** A server's status in words. */
export const STATUS_TEXT: Readonly<Record<string, string>> = {
  not_checked: 'Configured',
  disabled: 'Disabled',
  approval_required: 'Needs approval',
  blocked: 'Blocked by policy',
  connecting: 'Connecting',
  connected: 'Connected',
  auth_required: 'Needs sign-in',
  failed: 'Failed',
  unknown: 'Unknown',
};

export const statusText = (s: string): string => STATUS_TEXT[s] ?? 'Unknown';

/** How a status looks: `ok` (green) only for a connected server on a fresh result; never for stale or unknown data. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'muted';

export function statusTone(s: string, stale: boolean): StatusTone {
  if (stale) return 'muted';
  if (s === 'connected') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'auth_required' || s === 'approval_required') return 'warn';
  return 'muted';
}

/** Where a status came from, in words: the configuration, a separate check (its own process, not a worker), or a running worker (named). */
export function evidenceText(s: McpServer): string {
  if (s.status_scope === 'probe') return 'Separate check';
  if (s.status_scope === 'worker') return s.worker?.name ? `Worker ${s.worker.name}` : 'Running worker';
  return 'Configuration';
}

/** The status came from a check or a worker: it has its own time (`status_at`) and ages on its own. */
const observed = (s: McpServer) => s.status_scope === 'probe' || s.status_scope === 'worker';

/** A check's or a worker's status is over `MCP_EVIDENCE_STALE_MS` old (or never says when). */
export function evidenceStale(s: McpServer, r: Received, now: number): boolean {
  const age = ageOf(s.status_at, r, now);
  return age === null || age > MCP_EVIDENCE_STALE_MS;
}

/**
 * A cell's data may be out of date: its provider's configuration is stale (or the last read failed and these are the
 * servers it kept), or its status came from a check or a worker too long ago. Then it never looks healthy.
 */
export function cellStale(c: McpCell, p: McpProvider, r: Received, now: number): boolean {
  if (configStale(p, r, now) || (p.config.state === 'failed' && c.kind === 'present')) return true;
  return !!c.server && observed(c.server) && evidenceStale(c.server, r, now);
}

const OUT_OF_DATE = ', may be out of date';

/**
 * When a server's status was observed, in words: the configuration's read (`read 1 min ago`), the check's (`checked 3
 * min ago`) or the worker's (`seen just now`); a check or a worker status past `MCP_EVIDENCE_STALE_MS` says it may be out
 * of date.
 */
export function observedText(s: McpServer, p: McpProvider, r: Received, now: number): string {
  if (!observed(s)) {
    const age = ageText(ageOf(p.config.read_at, r, now));
    return age ? `read ${age}` : 'read time unknown';
  }
  const age = ageText(ageOf(s.status_at, r, now));
  const when = age ? `${s.status_scope === 'probe' ? 'checked' : 'seen'} ${age}` : 'time unknown';
  return evidenceStale(s, r, now) ? `${when}${OUT_OF_DATE}` : when;
}

/** The provider's last connection check is over `MCP_EVIDENCE_STALE_MS` old (false when there was none). */
export function checkStale(p: McpProvider, r: Received, now: number): boolean {
  if (p.check.state === 'none' || !p.check.at) return false;
  const age = ageOf(p.check.at, r, now);
  return age === null || age > MCP_EVIDENCE_STALE_MS;
}

/**
 * The provider's last connection check in words (`Checked 3 min ago`, `Check failed 1 h ago, may be out of date`), or ''
 * when there was none. `short`: without "may be out of date" (the wall says that on a line of its own).
 */
export function checkText(p: McpProvider, r: Received, now: number, short = false): string {
  if (p.check.state === 'none' || !p.check.at) return '';
  const word = p.check.state === 'ok' ? 'Checked' : p.check.state === 'timeout' ? 'Check timed out' : p.check.state === 'skipped' ? 'Check skipped' : 'Check failed';
  const text = `${word} ${ageText(ageOf(p.check.at, r, now))}`;
  return !short && checkStale(p, r, now) ? `${text}${OUT_OF_DATE}` : text;
}

/** A server's or a skill's source and scope in words (`plugin` names its plugin). */
export function sourceText(s: Pick<McpServer, 'source' | 'plugin'>): string {
  if (s.source === 'plugin') return s.plugin ? `Plugin ${s.plugin}` : 'Plugin';
  const words: Record<string, string> = { user: 'User', local: 'Local', project: 'Project', managed: 'Managed', connector: 'Connector', system: 'System', repo: 'Repository', admin: 'Admin' };
  return words[s.source] ?? 'Unknown source';
}

/** A cell's one line: the status of a configured server, or why there is none. */
export function cellText(c: McpCell, h: McpHarness): string {
  switch (c.kind) {
    case 'present':
      return statusText(c.server?.status ?? 'unknown');
    case 'missing':
      return `Expected, not configured in ${PROVIDER_NAME[h]}`;
    case 'not_configured':
      return `Not configured in ${PROVIDER_NAME[h]}`;
    case 'unknown':
      return 'Unknown';
  }
}

/**
 * A short next step for a provider's state, or '' when there is nothing to do: the CLI missing, a read that failed,
 * nothing configured. Read-only: it says what to do, it never does it.
 */
export function providerNextStep(h: McpHarness, p: McpProvider): string {
  const cli = h === 'claude' ? 'claude' : 'codex';
  if (p.config.state === 'unsupported') return `This bridge cannot read ${PROVIDER_NAME[h]}’s configuration.`;
  if (!p.available || p.config.state === 'unavailable') return `Install the ${cli} CLI on the bridge host (or put it on its PATH), then Refresh.`;
  // Pending with the bridge's own note (waiting for a free reader): that note says what happens, nothing to add.
  if (p.config.state === 'pending') return p.config.note ? '' : 'Reading the configuration; it shows here when it is in.';
  if (p.config.state === 'failed') return 'The configuration could not be read. It is tried again by itself; Refresh tries now.';
  if (configWhole(p) && p.servers.length === 0) return h === 'claude' ? 'No MCP servers configured here. Add one with claude mcp add.' : 'No MCP servers configured here. Add one with codex mcp add.';
  return '';
}

/** A server's next step, or '': sign in, approve, look at why it failed, or add an expected one. */
export function cellNextStep(c: McpCell, h: McpHarness): string {
  if (c.kind === 'missing') return h === 'claude' ? 'Add it with claude mcp add.' : 'Add it with codex mcp add.';
  const s = c.server?.status;
  if (s === 'auth_required') return h === 'claude' ? 'Sign in with /mcp in Claude Code.' : 'Sign in with codex mcp login.';
  if (s === 'approval_required') return 'Approve it with /mcp in Claude Code in this checkout.';
  if (s === 'failed') return 'Check connections again after fixing it.';
  return '';
}

// ---- the wall screen ------------------------------------------------------------------------------------------------

/**
 * What the wall shows: a calm screen for a bridge without the command, a dropped connection, nobody looking yet, the
 * first read under way; else the data, per provider.
 */
export type McpWallMode = 'unsupported' | 'offline' | 'idle' | 'loading' | 'error' | 'data';

export interface McpWallProvider {
  harness: McpHarness;
  name: string;
  tone: ProviderTone;
  /** "4 MCP servers", or the state's word when there is no count to trust ("CLI not found", "Reading…"). */
  big: string;
  /** "1 needs attention", "Nothing needs attention", or ''. */
  attention: string;
  attentionCount: number;
  skills: string;
  /** "Read 3 min ago". */
  age: string;
  /** "Checked 4 min ago", "Check failed 2 h ago", or '' (never checked). */
  check: string;
  /** The last check is over `MCP_EVIDENCE_STALE_MS` old: its line is grey, "May be out of date" under it. */
  checkOld: boolean;
  /** A tag on the column: "stale", "partial", "" (fresh). */
  tag: string;
}

export interface McpWallModel {
  mode: McpWallMode;
  title: string;
  /** The checkout and the Codex profile the data is for (or what the calm screen says). */
  scope: string;
  providers: McpWallProvider[];
  /** Everything the picture says: the screen redraws only when it changes. */
  key: string;
}

export const MCP_TITLE = 'MCP & skills';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The scope line: the checkout (or user scope only) and the Codex profile. */
export function scopeText(snap: McpSnapshot): string {
  const c = snap.context;
  const where = c.cwd === null ? 'User scope only' : c.cwd_display || c.cwd;
  return `${where} · Codex profile ${c.codex_profile_name || 'default'}`;
}

/** One provider's column on the wall. */
export function wallProvider(h: McpHarness, r: Received, now: number): McpWallProvider {
  const p = r.snap.providers[h];
  const tone = providerTone(p, r, now);
  const expected = r.snap.expected ?? [];
  const known = configKnown(p) || tone === 'stale';
  const n = attentionCount(p, expected);
  const big =
    tone === 'unsupported'
      ? 'Not supported'
      : tone === 'unavailable'
        ? 'CLI not found'
        : tone === 'pending'
          ? 'Reading…'
          : tone === 'failed'
            ? 'Couldn’t read'
            : plural(p.servers.length, 'MCP server', 'MCP servers');
  const attention = !known ? '' : n > 0 ? `${n} need${n === 1 ? 's' : ''} attention` : 'Nothing needs attention';
  const sk = p.skills;
  const skills = sk.state === 'ok' || sk.state === 'partial' || (sk.items.length > 0 && sk.read_at) ? `${sk.items.length}${sk.complete ? '' : '+'} ${sk.items.length === 1 && sk.complete ? 'skill' : 'skills'}` : sk.state === 'pending' ? 'Skills: reading…' : 'Skills unknown';
  const read = ageText(ageOf(p.config.read_at, r, now));
  const age = read ? `Read ${read}` : '';
  const tag = tone === 'stale' ? 'stale' : tone === 'partial' ? 'partial' : '';
  return { harness: h, name: PROVIDER_NAME[h], tone, big, attention, attentionCount: known ? n : 0, skills, age, check: checkText(p, r, now, true), checkOld: checkStale(p, r, now), tag };
}

/** What the wall says now. `r`: the Snapshot of the shown context (null: none yet). `error`: the bridge refused the request (its words). */
export function wallModel(o: { unsupported: boolean; live: boolean; asking: boolean; r: Received | null; error?: string | null; now: number }): McpWallModel {
  const calm = (mode: McpWallMode, scope: string): McpWallModel => ({ mode, title: MCP_TITLE, scope, providers: [], key: JSON.stringify([mode, scope]) });
  if (o.unsupported) return calm('unsupported', 'No MCP inventory on this bridge');
  if (!o.live) return calm('offline', 'Not connected to the bridge');
  if (!o.r) {
    if (o.error) return calm('error', o.error);
    return o.asking ? calm('loading', 'Reading the configuration…') : calm('idle', 'Look here to read it');
  }
  const providers = HARNESSES.map((h) => wallProvider(h, o.r as Received, o.now));
  const scope = scopeText(o.r.snap);
  return { mode: 'data', title: MCP_TITLE, scope, providers, key: JSON.stringify(['data', scope, providers]) };
}

/** The look-at bar's line for the screen. */
export function hudLine(m: McpWallModel): string {
  if (m.mode !== 'data') return m.scope;
  return m.providers.map((p) => (p.tone === 'ok' || p.tone === 'partial' || p.tone === 'stale' ? `${p.name} ${p.big.replace(/ MCP servers?$/, ' MCP')}${p.attentionCount ? ` (${p.attentionCount} need${p.attentionCount === 1 ? 's' : ''} you)` : ''}${p.tag ? `, ${p.tag}` : ''}` : `${p.name}: ${p.big}`)).join(' · ');
}

// ---- the expected list ----------------------------------------------------------------------------------------------

export const EXPECTED_MAX = 32;
export const EXPECTED_NAME_MAX = 100;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Why a name cannot be added to the expected list (trimmed first), or null: it is fine. The bridge's rules (contract.md). */
export function expectedNameError(raw: string, list: readonly string[]): string | null {
  const name = raw.trim();
  if (!name) return 'Type a server name.';
  if (bytes(name) > EXPECTED_NAME_MAX) return `Keep the name to ${EXPECTED_NAME_MAX} bytes.`;
  if (CONTROL.test(name)) return 'The name has a control character.';
  if (list.includes(name)) return `${name} is on the list already.`;
  if (list.length >= EXPECTED_MAX) return `At most ${EXPECTED_MAX} expected servers.`;
  return null;
}
