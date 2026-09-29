import { answerable, answerKeys } from '../world/answer';
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
  return [usageText(w.worker.usage).line, q?.hash ?? ''];
}

export function usageChip(w: WorkerView): HTMLElement | null {
  const u = usageText(w.worker.usage);
  if (!u.line) return null;
  return h('span', { class: `prompt-usage${u.flagged ? ' prompt-usage--flagged' : ''}`, title: u.title }, u.line);
}

/** Approve / Deny on a blocked worker's question (none when it has no question); `off` says why they can't be used. */
export function answerKeyEls(w: WorkerView, off: { live: boolean; why?: string } | undefined = undefined): HTMLElement[] {
  const q = w.display === 'needs_you' ? answerable(w.worker.question) : null;
  if (!q) return [];
  const k = answerKeys(q);
  const no = off && !off.live ? (off.why ?? 'Not available') : null;
  const key = (kbd: string, label: string, title: string, kind: string) =>
    h('span', { class: `key key--answer key--${kind}`, title: no ?? title, 'aria-disabled': no ? 'true' : null }, h('kbd', {}, kbd), label);
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
  for (const el of answerKeyEls(w)) parts.push(el.textContent ?? '');
  return parts.map((p) => p.replace(/^(\d)(\D)/, '$1 $2')).join(' · ');
}
