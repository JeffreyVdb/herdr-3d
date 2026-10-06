import { answerable, answerKeys } from '../world/answer';
import { askOf, isSimple, optionLabel, quickReplyBlocker, waitingText } from '../world/ask';
import { askingText, asyncBatches, wantsAnswer } from '../world/codexQuestions';
import type { WorkerView } from '../world/store';
import { usageText } from '../world/usage';
import { h } from './dom';

/**
 * M5 parts of the look-at prompt bar for a worker: its usage after the
 * model (`≈$0.09 · 37k tokens · ctx 4%`, `*` for an unknown model), and for
 * a blocked worker with a question the Approve / Deny keys (the digits that
 * pick them on its card; 0 dismisses with Esc).
 */

/** What these parts show, so the bar redraws when any of it changes. */
export function promptBarKey(w: WorkerView): string[] {
  const q = w.display === 'needs_you' ? answerable(w.worker.question) : null;
  const ask = w.display === 'needs_you' ? askOf(w.worker) : null;
  // The ask's waiting time, to the minute (the bar is redrawn when it changes).
  return [usageText(w.worker.usage).line, q?.hash ?? '', ask ? `${ask.tool_use_id} ${waitingText(ask.since, Date.now()).replace(/ \d+s$/, ' <1m')}` : '', String(w.asks ?? 0)];
}

/**
 * #57: "asks · waiting 3m" on the bar of a worker whose agent waits on its question. #157: "asks 2 questions" on a
 * Codex worker's whose async questions want an answer while it works on.
 */
export function askChip(w: WorkerView, now = Date.now()): HTMLElement | null {
  const ask = w.display === 'needs_you' ? askOf(w.worker) : null;
  if (!ask && w.asks) {
    const titles = asyncBatches(w.worker).flatMap((b) => b.questions.filter(wantsAnswer).map((q) => q.title));
    return h('span', { class: 'prompt-ask prompt-ask--async', title: `Codex works on. Answer at its laptop (E):\n${titles.join('\n')}` }, askingText(w.asks));
  }
  if (!ask) return null;
  const wait = waitingText(ask.since, now).replace(/ \d+s$/, ' <1m');
  return h('span', { class: 'prompt-ask', title: ask.questions.map((q) => q.question).join('\n') }, `asks · ${wait}`);
}

export function usageChip(w: WorkerView): HTMLElement | null {
  const u = usageText(w.worker.usage);
  if (!u.line) return null;
  return h('span', { class: `prompt-usage${u.flagged ? ' prompt-usage--flagged' : ''}`, title: u.title }, u.line);
}

/** Approve / Deny on a blocked worker's question (none when it has no question); `off` says why they can't be used. */
export function answerKeyEls(w: WorkerView, off: { live: boolean; why?: string } | undefined = undefined): HTMLElement[] {
  const no = off && !off.live ? (off.why ?? 'Not available') : null;
  const key = (kbd: string, label: string, title: string, kind: string) =>
    h('span', { class: `key key--answer key--${kind}`, title: no ?? title, 'aria-disabled': no ? 'true' : null }, h('kbd', {}, kbd), label);
  // #57: an ask: its digits pick when one pick answers it (0 dismisses); anything richer is answered at the laptop.
  const ask = w.display === 'needs_you' ? askOf(w.worker) : null;
  if (ask) {
    const q0 = ask.questions[0] as NonNullable<(typeof ask.questions)[0]>;
    if (!isSimple(ask)) return [key('E', 'Answer at laptop', `${quickReplyBlocker(ask)}: sit at its laptop and answer in the transcript view`, 'approve')];
    const n = q0.options.length;
    const first = optionLabel(q0.options[0]?.label ?? '').text;
    return [key(n > 1 ? `1–${n}` : '1', 'Answer', `1 answers “${first}”${n > 1 ? `, up to ${n}` : ''}`, 'approve'), key('0', 'Dismiss', 'Esc on its dialog', 'deny')];
  }
  const q = w.display === 'needs_you' ? answerable(w.worker.question) : null;
  if (!q) return [];
  const k = answerKeys(q);
  const out: HTMLElement[] = [];
  if (k.approve) out.push(key(String(k.approve.n), 'Approve', `Answer “${k.approve.label}”`, 'approve'));
  if (k.denyChoice) out.push(key(String(k.denyChoice.n), 'Deny', `Answer “${k.denyChoice.label}”`, 'deny'));
  else out.push(key('0', 'Deny', 'Dismiss the question (Esc on its screen)', 'deny'));
  return out;
}

/** The same for screen readers: appended to the bar's label. */
export function promptBarAria(w: WorkerView): string {
  const parts: string[] = [];
  const u = usageText(w.worker.usage).line;
  if (u) parts.push(u.replace('≈$', 'about $'));
  if (w.asks && !(w.display === 'needs_you' && askOf(w.worker))) parts.push(`Codex ${askingText(w.asks)}`); // #157
  for (const el of answerKeyEls(w)) parts.push(el.textContent ?? '');
  return parts.map((p) => p.replace(/^(\d)(\D)/, '$1 $2')).join(' · ');
}
