/**
 * #83: wrap up, then send home. Pure: the prompts the dialog starts from, the worktree choice it preselects, and the
 * words the game says about a worker's wrap-up (its desk tape, its toasts).
 */

import type { FirePrepare, FireWorktree, Worker, WrapUp } from '../net/protocol';
import { fireOptions } from './hire';

/** The cleanup task the Wrap up prompt starts with (editable; the bridge appends its result-line footer). */
export const WRAPUP_PROMPT = 'Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.';

/** "Wrap up again": a short follow-up, re-armed with a fresh nonce. */
export const WRAPUP_AGAIN_PROMPT = 'Report the wrap-up line again when done.';

/** The desk tape of a worker wrapping up. */
export const WRAPPING_UP = 'WRAPPING UP';

/** The worktree choice a send home or a wrap-up starts with: delete it whenever that is possible, else keep it. */
export function defaultChoice(p: FirePrepare): FireWorktree {
  return fireOptions(p).enabled.delete ? 'delete' : 'keep';
}

/** The worker's wrap-up, when it is one this game knows how to show. */
export function wrapUpOf(w: Pick<Worker, 'wrapup'>): WrapUp | null {
  const u = w.wrapup;
  return u && (u.state === 'armed' || u.state === 'needs_you') ? u : null;
}

/** What happens to the worktree on CLEAN, as the end of a sentence ("…, and its worktree is deleted"). */
export function worktreeFate(choice: FireWorktree, linked: boolean): string {
  if (choice === 'delete_branch') return 'Its worktree and branch are deleted.';
  if (choice === 'delete') return 'Its worktree is deleted.';
  return linked ? 'Its worktree is kept.' : '';
}

/** The toast once a wrap-up sent its worker home (its `worker.removed` `sent_home`). */
export function sentHomeText(name: string, u: WrapUp, linked: boolean): string {
  const fate = worktreeFate(u.worktree, linked);
  return `Sent ${name} home after wrap-up.${fate ? ` ${fate}` : ''}`;
}

/** The toast when an armed wrap-up stops without a send home. */
export function needsYouText(name: string, u: WrapUp): string {
  return `${name}’s wrap-up needs you: ${sentence(u.reason || 'it stopped without a result')}`;
}

/** The task line of a worker whose wrap-up needs you. */
export function needsYouLine(u: WrapUp): string {
  return `Wrap-up: ${u.reason || 'stopped without a result'}`;
}

/** What the dialog says while it is armed: what it waits for, and what CLEAN does. */
export function armedText(name: string, u: WrapUp, linked: boolean): string {
  const fate = worktreeFate(u.worktree, linked);
  return `${name} is wrapping up. Once it reports CLEAN it goes home${fate ? `: ${fate.charAt(0).toLowerCase()}${fate.slice(1)}` : '.'}`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
