/**
 * #108 round 4: removing a worker's protected files now (`prompt_secrets.revoke`, round 5's bridge command). Pure.
 *
 * A worker holds the files of the secrets protected in the prompts it was sent (and any a handoff leased to it) until
 * it really ends; `Worker.secret_files` says how many (absent: none, or a bridge without the count). Revoking removes
 * them all at once and the worker keeps running: a reference in one of its earlier prompts then points at nothing.
 */

import type { Worker } from '../net/protocol';

/** How many protected files `w` holds now (0: none, unknown, or not a count). */
export function secretFilesOf(w: Pick<Worker, 'secret_files'> | null | undefined): number {
  const n = w?.secret_files;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

const files = (n: number) => `${n} protected ${n === 1 ? 'file' : 'files'}`;

/** The count as a control says it: "1 protected file", "3 protected files". */
export const secretFilesText = (n: number): string => files(n);

/** What the confirmation says it does (`n`: the files `name` holds as it opens). */
export function revokeWhat(name: string, n: number): string[] {
  const one = n === 1;
  return [
    `${name} holds ${files(n)} on the bridge host: the values protected in prompts sent to ${name}, and any a handoff passed on to it.`,
    `Remove deletes ${one ? 'it' : 'them'} at once. ${name} keeps running, but the references in its earlier prompts will point at nothing: whatever it still needs from ${one ? 'that file' : 'them'} it can no longer read.`,
    'This cannot be undone. Send a value again (and protect it) if the work still needs it.',
  ];
}

/** The answer, as the toast says it. */
export function revokedText(name: string, removed: number): string {
  if (removed <= 0) return `${name} held no protected files any more: nothing was removed.`;
  return `Removed ${files(removed)} from ${name}. ${name} keeps working.`;
}
