/**
 * #108 round 3: a prompt's send with "Review prompt secrets before sending" on, the one module every composer uses
 * (the P overlay, the laptop's prompt box and a paste into its terminal; round 4: every other composer, a hire, a run,
 * a schedule, a hire preset, the answers, a handoff, a wrap-up, a dictated sentence).
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
 *
 * Round 4: the dialog's final action says what comes next ("Confirm and continue" before a language model reads the
 * text: pack up, a dictated hire); a stored prompt (a schedule's, a hire preset's) is reviewed with every match ignored
 * and nothing protectable, and saved with that review ("Confirm and save"); a command with several texts reviews each
 * alone, one after the other (`reviewFields`), and sends a review per text keyed by its path.
 *
 * A composer's review is its own while it is up (`SecretsRequest.live`): closed (or opened again, for another worker)
 * while its text is scanned or reviewed again, nothing of it goes and no review opens for it (`Kept`, `gone`).
 */

import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, SecretsReview, SecretsReviews } from '../net/protocol';
import { hideRanges, promptSecretsFailureText, scanOf, SecretReview, type FieldText, type PromptSecretsBook } from '../world/promptSecrets';

export type { FieldText };
import { keyName, pressesBinding, type KeyEventLike } from '../input/shortcuts';
import { h } from './dom';
import type { SecretsReviewOutcome, SecretsReviewRequest } from './secretsReview';

export interface SecretsFlowHost {
  book: PromptSecretsBook;
  send(t: 'prompt_secrets.scan', args: CommandArgs['prompt_secrets.scan']): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  /** Opens the review (the app's one dialog) and resolves how it ended. */
  review(req: SecretsReviewRequest): Promise<SecretsReviewOutcome>;
}

/** The final action's words: a text that goes on, or (#108 round 4) one a language model reads first (pack up, a dictated hire). */
export type SecretsAction = 'Confirm and send' | 'Confirm and continue' | 'Confirm and save';

/** Why a stored prompt's review protects nothing (docs/protocol.md "Stored prompts"). */
export const STORED_REASON = 'A saved prompt keeps no protected file: remove the value from the prompt, or protect it when you hire with it.';

export interface SecretsRequest {
  /** Whom it goes to (a worker's id, or a composer's own key): the review of an unanswered send is kept per key, for its retry. */
  key: string;
  /** The exact text the command will carry. */
  text: string;
  /** Its name, for the review's title. */
  target: string;
  /** Opened on purpose ("Review secrets", Ctrl/⌘+Shift+X): the review shows even when nothing is found. */
  manual?: boolean;
  /** The dialog's final action (default "Confirm and send"; "Confirm and save" for a stored prompt). */
  action?: SecretsAction;
  /**
   * #108 round 4: a prompt that is saved (a schedule's, a hire preset's): every match starts ignored and stays so, and
   * nothing can be protected or marked (`STORED_REASON` says why): the bridge stores the prompt as typed.
   */
  stored?: boolean;
  /** Which of the command's texts this is (a composer with several), for the review's title. */
  field?: string;
  /** Why it is reviewed now, above the prompt (a failed schedule's repair); a refusal's own note wins. */
  notice?: string;
  /**
   * #108 round 4: the composer's send is still the one that asked (its dialog open, the same opening, the same worker):
   * read before and after each scan, after each review and before each send (a refusal's review again included). Gone:
   * no review opens and nothing goes (`Kept`, `gone`, which the composer says nothing of). Absent: always.
   */
  live?: () => boolean;
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


export interface FieldsRequest extends Omit<SecretsRequest, 'text' | 'field'> {
  /** The texts the command sends (an empty one is left out: there is nothing to review). */
  fields: readonly FieldText[];
}

/** Send them: with `secrets` keyed by path when a review decided anything. */
export interface GoFields {
  kind: 'send';
  secrets?: SecretsReviews;
  protects: number;
  /** Each text as a composer may show it (`Go.shown`), by path. */
  shown: Record<string, string>;
  reviews: Record<string, SecretReview | null>;
  retry?: boolean;
}

/** Nothing was sent: the draft stays, the composer says `message` (`gone`: it was closed meanwhile, nothing to say). */
export interface Kept {
  kind: 'kept';
  why: 'cancel' | 'off' | 'changed' | 'failed' | 'gone';
  message: string;
}

export type Reviewed = Go | Kept;
export type Delivered = { kind: 'answered'; result: CommandResult; go: Go } | Kept;
export type ReviewedFields = GoFields | Kept;
export type DeliveredFields = { kind: 'answered'; result: CommandResult; go: GoFields } | Kept;

/** The command's outcome is not known: it may have gone, or not. */
const UNANSWERED = new Set(['timeout', 'disconnected', 'offline']);
/** The bridge's refusals that mean "scan again and review" (docs/protocol.md "Prompt secrets"). */
const AGAIN: Readonly<Record<string, string>> = {
  secrets_review_stale: 'This review no longer fits: the bridge restarted, or its rules or the switch changed. Look it over again, then confirm.',
  secrets_review_required: 'herdr-world found possible secrets this review did not cover. Look them over, then confirm.',
};
export const OFF_MEANWHILE = 'Review prompt secrets was switched off before this went: nothing was sent. Send it again to send it as written.';
const GONE: Kept = { kind: 'kept', why: 'gone', message: 'Not sent: it was closed before it went.' };
/** The composer that asked is gone (`SecretsRequest.live`). */
const gone = (req: { live?: () => boolean }): boolean => req.live !== undefined && !req.live();

const plain = (text: string): Go => ({ kind: 'send', protects: 0, shown: text, review: null });

function goOf(review: SecretReview): Go {
  const ranges = review.protectedRanges();
  const decisions = review.decisions();
  return { kind: 'send', ...(decisions.length ? { secrets: { revision: review.revision, decisions } } : {}), protects: ranges.length, shown: hideRanges(review.text, ranges), review };
}

/** #108: the chord that opens the review now, from a prompt box (`dialog.secrets`, docs/shortcuts.md). */
export const reviewKey = (e: KeyEventLike): boolean => pressesBinding(e, 'dialog.secrets');

/**
 * #108 round 4: a composer's "Review secrets" (shown only with the switch on): the review on purpose, to mark a value
 * the scan would not find, then the composer's own action. `why`: what blocks it now (its title, and a press does
 * nothing). The P overlay's and the prompt box's own controls are this one's model.
 */
export function reviewButton(flow: PromptSecretsFlow | undefined, why: string | null, run: () => void, what = 'text'): HTMLButtonElement | null {
  if (!flow?.on) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn',
      'data-key': 'review',
      'aria-disabled': why ? 'true' : null,
      title: why ?? `Look over the ${what}’s possible secrets now, and mark one the scan missed (${keyName('dialog.secrets')})`,
      onclick: () => {
        if (!why) run();
      },
    },
    'Review secrets',
  ) as HTMLButtonElement;
}

/** #108 round 4: Ctrl/⌘+Shift+X in `el` (a composer's form or field) runs `run` with the switch on. */
export function onReviewKey(el: HTMLElement, flow: () => PromptSecretsFlow | undefined, run: () => void): void {
  el.addEventListener('keydown', (e) => {
    if (!reviewKey(e) || !flow()?.on) return;
    e.preventDefault();
    if (!e.repeat) run();
  });
}

/** What a refusal of a reviewed command means: review again (`notice`), keep the draft, or an answer like any other. */
type Refusal = { again: string } | Kept | null;

export class PromptSecretsFlow {
  /** Per key: the last review whose send went unanswered, and its text (the texts, for several). */
  private readonly unanswered = new Map<string, { text: string; go: Go | GoFields }>();

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
      return req.manual ? offManual() : plain(req.text);
    }
    const kept = this.unanswered.get(req.key);
    if (kept && kept.text === req.text && !req.manual && !again && 'review' in kept.go) return { ...kept.go, retry: true };
    return this.one(req, again, req.manual === true || again !== null);
  }

  /**
   * #108 round 4: the texts of a command with several (`run.start`, the answers), each scanned alone and reviewed in
   * turn in the one dialog (its title says which): nothing found in any of them is today's send; Cancel on any keeps
   * them all. A refusal reviews again each text that has something to decide (or had), its earlier choices taken over.
   */
  async reviewFields(req: FieldsRequest, again: { notice: string; earlier: Record<string, SecretReview | null> } | null = null): Promise<ReviewedFields> {
    const fields = req.fields.filter((f) => f.text !== '');
    const texts = JSON.stringify(fields.map((f) => [f.path, f.text]));
    if (!this.on) {
      this.unanswered.delete(req.key);
      if (req.manual) return offManual();
      return { kind: 'send', protects: 0, shown: Object.fromEntries(fields.map((f) => [f.path, f.text])), reviews: Object.fromEntries(fields.map((f) => [f.path, null])) };
    }
    const kept = this.unanswered.get(req.key);
    if (kept && kept.text === texts && !req.manual && !again && 'reviews' in kept.go) return { ...kept.go, retry: true };
    const out: GoFields = { kind: 'send', protects: 0, shown: {}, reviews: {} };
    const secrets: SecretsReviews = {};
    for (const f of fields) {
      const earlier = again?.earlier[f.path] ?? null;
      const opened = req.manual === true || (again !== null && !!earlier?.decisions().length);
      const r = await this.one({ ...req, text: f.text, field: f.label }, again && { notice: again.notice, earlier }, opened);
      if (r.kind === 'kept') return r;
      out.shown[f.path] = r.shown;
      out.reviews[f.path] = r.review;
      out.protects += r.protects;
      if (r.secrets) secrets[f.path] = r.secrets;
    }
    return Object.keys(secrets).length ? { ...out, secrets } : out;
  }

  /** One text: its scan, and the dialog when it found anything (or `open`: asked for, or reviewed again). */
  private async one(req: SecretsRequest, again: { notice: string; earlier: SecretReview | null } | null, open: boolean): Promise<Reviewed> {
    if (gone(req)) return GONE;
    const r = await this.host.send('prompt_secrets.scan', { text: req.text });
    // Closed (or opened for another) while it was scanned: no review opens over whatever is there now.
    if (gone(req)) return GONE;
    if (!r.ok) return { kind: 'kept', why: r.code === 'secrets_review_off' ? 'off' : 'failed', message: `Not sent: ${promptSecretsFailureText(r.code, r.message).replace(/ Nothing was sent\.$/, '')}` };
    // A review made before a change of the switch is stale: the change wins, nothing goes.
    if (!this.host.book.on) return { kind: 'kept', why: 'changed', message: OFF_MEANWHILE };
    const scan = scanOf(r.data, req.text);
    if (!scan) return { kind: 'kept', why: 'failed', message: 'Not sent: herdr-world’s scan of the prompt could not be read. Try again.' };
    if (!scan.candidates.length && !open) return plain(req.text);
    const review = new SecretReview(req.text, scan, again?.earlier ?? undefined);
    // A stored prompt is stored as typed: every match ignored (and kept so by the dialog).
    if (req.stored) for (const m of review.marks()) if (m.candidate) review.setState(m.key, 'ignore');
    const out = await this.host.review({
      review,
      target: req.target,
      field: req.field ?? null,
      notice: again?.notice ?? req.notice ?? null,
      manual: req.manual === true,
      action: req.action ?? (req.stored ? 'Confirm and save' : 'Confirm and send'),
      stored: req.stored ? STORED_REASON : null,
    });
    if (out.kind === 'cancel') return { kind: 'kept', why: 'cancel', message: req.stored ? 'Not saved: the review was cancelled.' : 'Not sent: the review was cancelled.' };
    if (out.kind === 'changed') return { kind: 'kept', why: 'changed', message: out.message };
    if (gone(req)) return GONE;
    return goOf(out.review);
  }

  /** What the bridge's refusal of a reviewed command means here (null: an answer like any other). */
  private refusal(result: CommandResult): Refusal {
    if (result.ok) return null;
    const notice = AGAIN[result.code];
    if (result.code === 'secrets_review_off' || (notice && !this.on)) return { kind: 'kept', why: 'off', message: OFF_MEANWHILE };
    if (result.code === 'secrets_unavailable') return { kind: 'kept', why: 'failed', message: promptSecretsFailureText(result.code, result.message) };
    return notice ? { again: notice } : null;
  }

  /** Sends `first` through `send` and sees it through the bridge's answer (see the top). */
  async deliver(req: SecretsRequest, first: Go, send: (go: Go) => Promise<CommandResult>): Promise<Delivered> {
    let go = first;
    for (;;) {
      if (gone(req)) return GONE;
      const result = await send(go);
      this.remember(req.key, req.text, go, go.secrets !== undefined, result);
      const why = this.refusal(result);
      if (!why) return { kind: 'answered', result, go };
      if ('kind' in why) return why;
      const next = await this.review(req, { notice: why.again, earlier: go.review });
      if (next.kind === 'kept') return next;
      go = next;
    }
  }

  /** `deliver()` for a command with several texts. */
  async deliverFields(req: FieldsRequest, first: GoFields, send: (go: GoFields) => Promise<CommandResult>): Promise<DeliveredFields> {
    const texts = JSON.stringify(req.fields.filter((f) => f.text !== '').map((f) => [f.path, f.text]));
    let go = first;
    for (;;) {
      if (gone(req)) return GONE;
      const result = await send(go);
      this.remember(req.key, texts, go, go.secrets !== undefined, result);
      const why = this.refusal(result);
      if (!why) return { kind: 'answered', result, go };
      if ('kind' in why) return why;
      const next = await this.reviewFields(req, { notice: why.again, earlier: go.reviews });
      if (next.kind === 'kept') return next;
      go = next;
    }
  }

  /** A send that carried a review and went unanswered is kept for its retry; any answer drops it. */
  private remember(key: string, text: string, go: Go | GoFields, reviewed: boolean, result: CommandResult): void {
    if (!result.ok && reviewed && UNANSWERED.has(result.code)) this.unanswered.set(key, { text, go: { ...go, retry: false } });
    else this.unanswered.delete(key);
  }
}

const offManual = (): Kept => ({ kind: 'kept', why: 'off', message: 'Review prompt secrets is off: switch it on in Settings to mark secrets.' });
