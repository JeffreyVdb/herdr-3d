import type { HireAck } from '../net/protocol';
import { codexNotice } from '../world/codexServer';
import type { ToastKind } from './hud';

/**
 * #186: the toast for a hire (or a run start) the bridge acknowledged: `lead`, then what went wrong on the way. The
 * worker is there, so that is never an error by itself. `failure` (a task that did not reach the worker: you prompt it
 * yourself; '' when none) is an error; a Codex hire that asked for its own server and runs on Codex's built-in one
 * (#155) is a warning: it works, without the transcript's async answers. #139: what the hire found about its Codex
 * profile follows (`profile_note`): a warning unless its account was confirmed. The more severe wins; all are said.
 */
export function hiredToast(lead: string, ack: Pick<HireAck, 'codex'> | undefined, failure: string): { text: string; kind: ToastKind } {
  const fallback = codexNotice({ codex: ack?.codex });
  const profile = ack?.codex?.profile_note ?? '';
  const text = [lead, failure, fallback?.text ?? '', profile].filter(Boolean).join(' ');
  const warn = !!fallback || (!!profile && ack?.codex?.account !== 'confirmed');
  return { text, kind: failure ? 'error' : warn ? 'warn' : 'info' };
}
