/**
 * #110 pack up on request, with #108 round 4's prompt secrets: the check between a prompt's review and its send, shared
 * by the P overlay and the laptop's prompt box.
 *
 * The review comes first (its final action "Confirm and continue" when the check will run: a language model reads the
 * text next). `packup.detect` carries the review: the bridge writes the protected values to files and the models read
 * the text with their references (`sent`). A stale review is reviewed again before the check goes (the flow's
 * `deliver`). What follows the check is the text the models read, with the check's hand-over (`secrets_pending`), so the
 * same values are not reviewed twice and their files become the worker's: `worker.prompt` for "send as written" (no
 * match, or "Send as written (stay)"), `worker.wrapup` for "Send and go home" (the send-home dialog sends it). A check
 * that fails or comes too late leaves the prompt to its own review, as written.
 */

import type { CommandResult } from '../net/client';
import type { PackupDetectAck, SecretsReview } from '../net/protocol';
import { packupVerdict, type PackupOutcome } from '../world/packup';
import type { Go, Kept, PromptSecretsFlow, SecretsAction, SecretsRequest } from './secretsFlow';
import type { PackupChoice, PackupConfirm } from './sendHome';

/** The pack-up check a composer goes through (the app's: `packup.detect`, then the confirm or the send home). */
export interface PackupCheck {
  /** A prompt to this worker is checked now (the feature ready, a Claude or Codex agent, not a freelancer). */
  applies(id: string): boolean;
  /** `packup.detect` (with the review of the text's secrets, when it decided anything). */
  detect(id: string, text: string, secrets?: SecretsReview): Promise<CommandResult>;
  /** The check's answer acted on: the confirm when it matched (`signal`: Esc, the composer closed). */
  decide(id: string, text: string, result: CommandResult, signal: AbortSignal): Promise<PackupOutcome>;
}

/** What the app's check needs: whether it applies, the command, and the send-home dialog for a match. */
export interface PackupCheckHost {
  applies(id: string): boolean;
  detect(args: { id: string; text: string; secrets?: SecretsReview }): Promise<CommandResult>;
  /** The plain send home (nothing of the prompt was left). */
  sendHome(id: string): void;
  /** The pack-up confirm (`SendHomeDialog.openPackup`). */
  confirm(id: string, pk: PackupConfirm): Promise<PackupChoice>;
}

/**
 * The app's check: `packup.detect` with the review, then its answer read against the text the models read (`sent`, else
 * the text as typed: `removed` indexes it). Send as written, the confirm (it shows that text, and "Send and go home"
 * sends its task with the hand-over), or the plain send home. As written, a reviewed check's text goes with its hand-over.
 */
export function packupCheck(host: PackupCheckHost): PackupCheck {
  return {
    applies: (id) => host.applies(id),
    detect: (id, text, secrets) => host.detect({ id, text, ...(secrets ? { secrets } : {}) }),
    async decide(id, text, r, signal) {
      if (signal.aborted) return 'cancel';
      const ack = (r.ok ? (r.data ?? {}) : {}) as Partial<PackupDetectAck>;
      const read = typeof ack.sent === 'string' && ack.sent ? ack.sent : text;
      const pending = typeof ack.secrets_pending === 'string' && ack.secrets_pending ? ack.secrets_pending : null;
      const asWritten = (): PackupOutcome => (pending ? { handover: pending, text: read } : 'send');
      const v = r.ok ? packupVerdict(r.data, read) : ({ kind: 'send' } as const);
      if (v.kind === 'send') return asWritten();
      if (v.kind === 'home') {
        host.sendHome(id);
        return 'cancel';
      }
      const c = await host.confirm(id, { original: read, task: v.task, removed: v.removed, ...(pending ? { pending } : {}) });
      if (c === 'done') return 'done';
      return c === 'stay' && !signal.aborted ? asWritten() : 'cancel';
    },
  };
}

/** What follows the check: the composer's own send (with this review), the hand-over's, nothing more to do, or kept. */
export type PackupStep = { kind: 'send'; go: Go } | { kind: 'handover'; text: string; pending: string } | { kind: 'done' } | { kind: 'cancel' } | Kept;

/** The review's final action for a prompt to `id`: a model reads it first when the check applies. */
export function packupAction(check: PackupCheck | undefined, id: string): SecretsAction {
  return check?.applies(id) ? 'Confirm and continue' : 'Confirm and send';
}

/** The check of `req.text` to worker `req.key` after its review `go` (see the top). */
export async function packupStep(check: PackupCheck, flow: PromptSecretsFlow | undefined, req: SecretsRequest, go: Go, signal: AbortSignal): Promise<PackupStep> {
  const detect = (g: Go) => check.detect(req.key, req.text, g.secrets);
  const d = flow ? await flow.deliver(req, go, detect) : ({ kind: 'answered', result: await detect(go), go } as const);
  if (d.kind === 'kept') return d;
  if (signal.aborted) return { kind: 'cancel' };
  const out = await check.decide(req.key, req.text, d.result, signal);
  if (out === 'send') return { kind: 'send', go: d.go };
  if (out === 'done' || out === 'cancel') return { kind: out };
  return { kind: 'handover', text: out.text, pending: out.handover };
}

/** A hand-over refused as stale (expired, the switch changed): its files may be gone, so nothing goes without a new review. */
export const HANDOVER_STALE = 'Not sent: the check of the prompt’s secrets no longer holds (it expired, or the setting changed). Send it again to review it.';
