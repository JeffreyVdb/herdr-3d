/**
 * #108 round 4: a composer's DOM test through the real send flow and the real review dialog, over the fixture bridge's
 * prompt secrets (tools/fixture-secrets.ts: its scan, and its check of a review, are the bridge's rules). jsdom only:
 * `installDialogs()` first (in a `beforeEach`).
 */

import { SECRETS_DIR, SecretsSim } from '../../tools/fixture-secrets.ts';
import type { CommandResult } from '../net/client';
import { PromptSecretsBook } from '../world/promptSecrets';
import { PromptSecretsFlow } from '../ui/secretsFlow';
import { SecretsReviewDialog } from '../ui/secretsReview';

/** jsdom has no modal dialogs nor scrolling: what the dialogs need of them. */
export function installDialogs(): void {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  Element.prototype.scrollIntoView = function () {};
}

export const flush = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** The flow and the dialog over the fixture's switch (`on`), and what was scanned. */
export function secretsBridge(o: { on?: boolean; parent?: HTMLElement } = {}) {
  const on = o.on ?? true;
  const book = new PromptSecretsBook();
  book.reset({ enabled: on, available: true, dir: SECRETS_DIR });
  const sim = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false }, { on });
  const dlg = new SecretsReviewDialog(o.parent ?? document.body, { book });
  const scans: string[] = [];
  let held: Array<() => void> | null = null;
  const flow = new PromptSecretsFlow({
    book,
    unsupported: () => false,
    send: (t, args) =>
      new Promise<CommandResult>((resolve) => {
        scans.push(args.text);
        const run = () => {
          try {
            sim.handle(t, { ...args }, () => {}, (data) => resolve({ ok: true, data }));
          } catch (e) {
            const err = e as { code?: string; message: string };
            resolve({ ok: false, code: err.code ?? 'internal', message: err.message });
          }
        };
        if (held) held.push(run);
        else run();
      }),
    review: (req) => dlg.open(req),
  });
  const button = (key: string) => document.querySelector<HTMLElement>(`.desk-dlg--secrets [data-key="${key}"]`);
  return {
    book,
    sim,
    dlg,
    flow,
    scans,
    /** The review open now (null: none). */
    open: () => dlg.summary(),
    /** Ignores these matches of the open review (keys `c1`, …), then confirms it. */
    confirm(...ignore: string[]): void {
      for (const k of ignore) {
        document.querySelector<HTMLElement>(`.desk-dlg--secrets .sr-mark[data-key="${k}"]`)?.click();
        button('ignore')?.click();
      }
      button('confirm')?.click();
    },
    cancel: () => button('cancel')?.click(),
    /** Scans from now on wait (a scan on its way) until the function it returns answers them all, and the next go at once. */
    holdScans(): () => void {
      const mine: Array<() => void> = [];
      held = mine;
      return () => {
        if (held === mine) held = null;
        for (const run of mine.splice(0)) run();
      };
    },
    /**
     * The bridge's gate on one text (`SecretsSim.protect`): the text with its references and how many, or the refusal's
     * code. `stored`: a saved prompt's.
     */
    gate(text: string, secrets: unknown, owner = 'w1', opts: { stored?: boolean; field?: string } = {}): { text: string; protected: number } | { code: string } {
      try {
        const p = sim.protect(text, secrets, owner, () => {}, opts);
        return p ? { text: p.text, protected: p.protected } : { text, protected: 0 };
      } catch (e) {
        return { code: (e as { code?: string }).code ?? 'internal' };
      }
    },
  };
}

export type SecretsBridge = ReturnType<typeof secretsBridge>;
