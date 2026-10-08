/**
 * #155: the shared Codex server. The bridge-wide switch (new Codex workers run their terminal against a Codex
 * app-server of their own) as the snapshot's `codex_server` and the `codex_server.update` events carry it
 * (`CodexServerBook`), and what a worker's launch has to tell you (`codexNotice`). Pure.
 */

import type { CodexServerState, Worker } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A well-formed switch (unknown keys dropped), else null. */
export function codexServerStateOf(v: unknown): CodexServerState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.available !== 'boolean') return null;
  return { enabled: v.enabled, available: v.available };
}

/** The switch, and who listens for changes. */
export class CodexServerBook {
  private cur: CodexServerState | null = null;
  private readonly listeners = new Set<() => void>();

  /** null: an older bridge, without the switch. */
  get state(): CodexServerState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = codexServerStateOf(v);
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = codexServerStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** What the seat bar says about a worker's Codex launch: `down` needs you, `note` is for your information. */
export interface CodexNotice {
  tone: 'down' | 'note';
  text: string;
}

/**
 * A shared worker whose server died (its terminal waits to reconnect, and herdr may still say it works), or whose
 * resume failed; a hire that asked for its own server and runs Codex's embedded one instead, and why (#186: what that
 * costs); a shared worker woken without its server (it runs on the embedded one until the next wake), and why. Else null.
 */
export function codexNotice(w: { codex?: Worker['codex'] | undefined }): CodexNotice | null {
  const c = w.codex;
  if (!c) return null;
  if (c.mode === 'shared' && c.server === 'down') {
    return { tone: 'down', text: 'Its Codex server stopped: the terminal is waiting to reconnect. Put the floor to sleep and wake it to start the server again.' };
  }
  if (c.mode === 'shared' && c.server === 'stopped' && c.note?.startsWith('shared Codex server: ')) {
    // Woken without its own server: its terminal runs on Codex's built-in one, and the next wake tries its own again.
    const why = c.note.replace(/^shared Codex server: /, '').replace(/; (resumed|started) without its own server, on Codex's built-in one$/, '');
    return { tone: 'note', text: `No own Codex server this time: ${plainWhy(why)}. It runs with Codex’s built-in one; the next wake tries its own again.` };
  }
  if (c.mode === 'shared' && c.server === 'stopped' && c.note) return { tone: 'down', text: `Its Codex server is not running (${c.note}).` };
  if (c.mode === 'legacy' && c.note) {
    const why = c.note.replace(/^shared Codex server: /, '').replace(/; started the usual way$/, '');
    return { tone: 'note', text: `No own Codex server: ${plainWhy(why)}. It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript.` };
  }
  return null;
}

/**
 * #186: the bridge's refusal of a Codex its shared server is not verified with, by `codex --version`
 * (`unsupported Codex version: "codex-cli 0.163.0" (supported: codex-cli 0.160.x, 0.161.x or 0.162.x)`) or by the server's
 * userAgent (`… app-server "herdr_3d/0.163.0 (…) …" (supported: 0.160.x, 0.161.x or 0.162.x)`), in plain words; any other
 * reason as it is.
 */
function plainWhy(why: string): string {
  const m = /^unsupported Codex version: (?:app-server "[^"/ ]+\/|"codex-cli )([^" ]+)[^"]*" \(supported: (?:codex-cli )?([^)]+)\)$/.exec(why);
  return m ? `the shared Codex server is not verified with Codex ${m[1]} yet (verified: ${m[2]})` : why;
}

/** Plain words for a `codex_server.*` failure. */
export function codexServerFailureText(code: string, message: string): string {
  switch (code) {
    case 'unsupported':
      return 'This bridge has no place for Codex servers’ sockets (its --codex-run directory is off).';
    case 'unknown_command':
      return 'This bridge can’t give Codex workers their own server yet. Update it to use this.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    default:
      return message.trim() || code;
  }
}
