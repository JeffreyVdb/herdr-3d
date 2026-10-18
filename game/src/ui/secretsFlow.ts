/**
 * #108 round 3: a prompt's send with "Review prompt secrets before sending" on, the one module every composer uses
 * (the P overlay, the laptop's prompt box and a paste into its terminal; round 4 plugs the others in).
 *
 * `review()` comes first, before anything else sees the text (pack up's LLM check included): the switch off (or an
 * older bridge) is today's send, no scan. On, the exact text the command will carry is scanned (`prompt_secrets.scan`);
 * nothing found is today's send without a review, and anything found opens the review (`SecretsReviewDialog`) over
 * the whole text. Nothing goes before its Confirm. `deliver()` then sends through the composer's own `send`, with the
 * review as `secrets`: a stale or incomplete review (the bridge restarted, its rules or the switch changed, it found
 * more) is scanned and reviewed again, the earlier choices taken over, and goes only on a new Confirm; the switch gone
 * off or no private directory keeps the draft with a note. Never an automatic send.
 *
 * A send whose answer never came (a timeout, a dropped connection) keeps its review: the same Send of the same text to
 * the same worker carries the same revision and decisions again (the bridge reuses the files it wrote for it).
 * Everything here is memory only.
 */

import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, SecretsReview } from '../net/protocol';
import { hideRanges, promptSecretsFailureText, scanOf, SecretReview, type PromptSecretsBook } from '../world/promptSecrets';
import { pressesBinding, type KeyEventLike } from '../input/shortcuts';
import type { SecretsReviewOutcome, SecretsReviewRequest } from './secretsReview';

export interface SecretsFlowHost {
  book: PromptSecretsBook;
  send(t: 'prompt_secrets.scan', args: CommandArgs['prompt_secrets.scan']): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  /** Opens the review (the app's one dialog) and resolves how it ended. */
  review(req: SecretsReviewRequest): Promise<SecretsReviewOutcome>;
}

export interface SecretsRequest {
  /** Whom it goes to (a worker's id): the review of an unanswered send is kept per key, for its retry. */
  key: string;
  /** The exact text the command will carry. */
  text: string;
  /** Its name, for the review's title. */
  target: string;
  /** Opened on purpose ("Review secrets", Ctrl/⌘+Shift+X): the review shows even when nothing is found. */
  manual?: boolean;
}

/** Send it: with `secrets` when a review decided anything. */
export interface Go {
  kind: 'send';
  secrets?: SecretsReview;
  /** How many ranges go to files. */
  protects: number;
  /** The text with each protected range as `[secret]`: all a composer may show of it before the bridge's answer. */
  shown: string;
  /** The review it came from (null: none was needed). */
  review: SecretReview | null;
  /** The identical submission again, after the last one went unanswered: the same revision and decisions. */
  retry?: boolean;
}

/** Nothing was sent: the draft stays, the composer says `message`. */
export interface Kept {
  kind: 'kept';
  why: 'cancel' | 'off' | 'changed' | 'failed';
  message: string;
}

export type Reviewed = Go | Kept;
export type Delivered = { kind: 'answered'; result: CommandResult; go: Go } | Kept;

/** The command's outcome is not known: it may have gone, or not. */
const UNANSWERED = new Set(['timeout', 'disconnected', 'offline']);
/** The bridge's refusals that mean "scan again and review" (docs/protocol.md "Prompt secrets"). */
const AGAIN: Readonly<Record<string, string>> = {
  secrets_review_stale: 'This review no longer fits: the bridge restarted, or its rules or the switch changed. Look it over again, then confirm.',
  secrets_review_required: 'herdr-world found possible secrets this review did not cover. Look them over, then confirm.',
};
export const OFF_MEANWHILE = 'Review prompt secrets was switched off before this went: nothing was sent. Send it again to send it as written.';

const plain = (text: string): Go => ({ kind: 'send', protects: 0, shown: text, review: null });

function goOf(review: SecretReview): Go {
  const ranges = review.protectedRanges();
  const decisions = review.decisions();
  return { kind: 'send', ...(decisions.length ? { secrets: { revision: review.revision, decisions } } : {}), protects: ranges.length, shown: hideRanges(review.text, ranges), review };
}

/** #108: the chord that opens the review now, from a prompt box (`dialog.secrets`, docs/shortcuts.md). */
export const reviewKey = (e: KeyEventLike): boolean => pressesBinding(e, 'dialog.secrets');

export class PromptSecretsFlow {
  /** Per key: the last review whose send went unanswered, and its text. */
  private readonly unanswered = new Map<string, { text: string; go: Go }>();

  constructor(private readonly host: SecretsFlowHost) {}

  /** Prompts are scanned and reviewed before they go (the switch on, on a bridge that has it). */
  get on(): boolean {
    return this.host.book.on && !this.host.unsupported('prompt_secrets.scan');
  }

  /** The switch changed (a composer shows or hides its "Review secrets"). */
  onChange(fn: () => void): () => void {
    return this.host.book.onChange(fn);
  }

  /** What to do with `req.text`: send it (and how), or keep it. `again`: the bridge refused the last review. */
  async review(req: SecretsRequest, again: { notice: string; earlier: SecretReview | null } | null = null): Promise<Reviewed> {
    if (!this.on) {
      this.unanswered.delete(req.key);
      return req.manual ? { kind: 'kept', why: 'off', message: 'Review prompt secrets is off: switch it on in Settings to mark secrets.' } : plain(req.text);
    }
    const kept = this.unanswered.get(req.key);
    if (kept && kept.text === req.text && !req.manual && !again) return { ...kept.go, retry: true };
    const r = await this.host.send('prompt_secrets.scan', { text: req.text });
    if (!r.ok) return { kind: 'kept', why: r.code === 'secrets_review_off' ? 'off' : 'failed', message: `Not sent: ${promptSecretsFailureText(r.code, r.message).replace(/ Nothing was sent\.$/, '')}` };
    // A review made before a change of the switch is stale: the change wins, nothing goes.
    if (!this.host.book.on) return { kind: 'kept', why: 'changed', message: OFF_MEANWHILE };
    const scan = scanOf(r.data, req.text);
    if (!scan) return { kind: 'kept', why: 'failed', message: 'Not sent: herdr-world’s scan of the prompt could not be read. Try again.' };
    if (!scan.candidates.length && !req.manual && !again) return plain(req.text);
    const out = await this.host.review({ review: new SecretReview(req.text, scan, again?.earlier ?? undefined), target: req.target, notice: again?.notice ?? null, manual: req.manual === true, action: 'Confirm and send' });
    if (out.kind === 'cancel') return { kind: 'kept', why: 'cancel', message: 'Not sent: the review was cancelled.' };
    if (out.kind === 'changed') return { kind: 'kept', why: 'changed', message: out.message };
    return goOf(out.review);
  }

  /** Sends `first` through `send` and sees it through the bridge's answer (see the top). */
  async deliver(req: SecretsRequest, first: Go, send: (go: Go) => Promise<CommandResult>): Promise<Delivered> {
    let go = first;
    for (;;) {
      const result = await send(go);
      if (!result.ok && go.secrets && UNANSWERED.has(result.code)) this.unanswered.set(req.key, { text: req.text, go: { ...go, retry: false } });
      else this.unanswered.delete(req.key);
      if (result.ok) return { kind: 'answered', result, go };
      const notice = AGAIN[result.code];
      if (result.code === 'secrets_review_off' || (notice && !this.on)) return { kind: 'kept', why: 'off', message: OFF_MEANWHILE };
      if (result.code === 'secrets_unavailable') return { kind: 'kept', why: 'failed', message: promptSecretsFailureText(result.code, result.message) };
      if (!notice) return { kind: 'answered', result, go };
      const next = await this.review(req, { notice, earlier: go.review });
      if (next.kind === 'kept') return next;
      go = next;
    }
  }
}
