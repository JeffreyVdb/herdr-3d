/**
 * #213 (phase 4 of #209): the dictation bar as data, pure. What a key in its field means, and what `hire.interpret`'s
 * answer (docs/protocol.md "Hire interpretation") makes the bar do: a hire proposal goes to the review (ui/hireReview.ts),
 * everything else is a line in the bar, with the text kept. The window is ui/dictation.ts (this file is its pure part); the game (app.ts) routes.
 *
 * Nothing here hires: the review's Hire is the only way (#212, through the hire coordinator of #210).
 */

import type { CommandResult } from '../net/client';
import type { HireInterpretAck, HireInterpretation } from '../net/protocol';
import { failureText } from './messages';

/** What the bar says for a clear request for anything but a hire. */
export const NOT_SUPPORTED = 'Not supported yet.';
/** What the bar says when no clear request was made (a negation, a quote, a hypothetical, an effort with nothing to fill). */
export const UNCLEAR = 'Your intent is unclear.';

export type Interpreted =
  | { kind: 'hire'; hire: HireInterpretation }
  | { kind: 'unsupported' }
  | { kind: 'unclear' }
  /** The request failed or the interpreter could not answer: the text stays, nothing was hired, Enter tries again. */
  | { kind: 'error'; message: string };

/** The interpreter's operational errors (the ack's `error.code`), as the bar says them. */
const ACK_ERROR: Readonly<Record<string, string>> = {
  not_ready: 'No AI model is ready to read commands. Set up the LLM in Settings (AI integration), then press Enter again.',
  timeout: 'The AI model did not answer in time. Press Enter to try again.',
  provider_failed: 'The AI provider failed. Press Enter to try again.',
  rate_limited: 'The AI provider is rate limiting herdr-world. Wait a moment, then press Enter again.',
  auth_failed: 'The AI provider rejected its key. Fix it in Settings, then press Enter again.',
  unreachable: 'The AI endpoint cannot be reached. Press Enter to try again.',
  bad_pending: 'The review’s proposal could not be read back. Change it in the review, or cancel the review and dictate again.',
};

/** Answers the model wrote but the bridge could not use: say it again, perhaps differently. */
const UNUSABLE = new Set(['truncated', 'empty_answer', 'bad_response', 'bad_answer', 'bad_span']);

/** The bar's line for an operational error of the interpreter. */
export function interpretErrorText(code: string, message = ''): string {
  if (ACK_ERROR[code]) return ACK_ERROR[code];
  if (UNUSABLE.has(code)) return 'The AI model’s answer was not usable. Press Enter to try again, or say it differently.';
  const why = message.trim();
  return `The command could not be read (${code}${why ? `: ${why}` : ''}). Press Enter to try again.`;
}

/** The bar's line for a request that failed before any answer (no connection, no answer in time, an older bridge). */
function requestErrorText(code: string, message: string): string {
  switch (code) {
    // Interpreting changes nothing, so trying again is always safe (unlike the generic timeout text).
    case 'timeout':
      return 'herdr-world did not answer in time. Nothing was hired; press Enter to try again.';
    case 'disconnected':
      return 'The connection to herdr-world dropped before it answered. Nothing was hired; press Enter to try again.';
    case 'bad_request':
      return `herdr-world refused the text${message.trim() ? ` (${message.trim()})` : ''}.`;
    default:
      return failureText('hire.interpret', code, message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What `hire.interpret`'s result makes the bar do. An answer of the wrong shape is an error, never a hire. */
export function interpretOutcome(r: CommandResult): Interpreted {
  if (!r.ok) return { kind: 'error', message: requestErrorText(r.code, r.message) };
  const a = r.data as Partial<HireInterpretAck> | null;
  if (!isObj(a)) return { kind: 'error', message: interpretErrorText('bad_response') };
  if (isObj(a.error)) return { kind: 'error', message: interpretErrorText(String(a.error.code ?? ''), String(a.error.message ?? '')) };
  if (a.intent === 'unsupported') return { kind: 'unsupported' };
  if (a.intent === 'unclear') return { kind: 'unclear' };
  if (a.intent === 'hire' && isObj(a.hire)) return { kind: 'hire', hire: a.hire as HireInterpretation };
  return { kind: 'error', message: interpretErrorText('bad_response') };
}

/** The line for a non-hire outcome. */
export function outcomeText(o: Exclude<Interpreted, { kind: 'hire' }>): string {
  return o.kind === 'unsupported' ? NOT_SUPPORTED : o.kind === 'unclear' ? UNCLEAR : o.message;
}

/** Why a follow-up could not go to the review it was dictated for. */
export function followupLost(why: 'closed' | 'hiring'): string {
  return why === 'hiring'
    ? 'The review’s hire is already on its way, so nothing in it changed. Dictate again once it is done.'
    : 'The review this answered was closed meanwhile, so nothing changed and nothing was hired. Press Enter to start a new one.';
}

/** The question the floor list asks when no floor is in context. */
export const FLOOR_QUESTION = 'Hire on which floor?';

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * What a keydown in the bar's field means: `submit` (Enter, also with Ctrl/⌘ as the dialogs' submit), `close` (Esc), or
 * null (the field's own: Shift+Enter a new line, a paste, a letter). An IME composing a word owns Enter and Esc: Safari
 * sends the committing Enter after `compositionend` with `isComposing` false, but `keyCode` 229.
 */
export function barKey(e: KeyLike): 'submit' | 'close' | null {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null;
  if (e.key === 'Escape') return e.shiftKey || e.altKey || e.ctrlKey || e.metaKey ? null : 'close';
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return null;
  return 'submit';
}
