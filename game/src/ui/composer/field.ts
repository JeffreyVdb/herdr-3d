/**
 * What every prompt field that mounts the composer shares (#64), pure: the text a form reads back from a draft, and
 * the words for an image that did not go up. The hire dialog, the start-run fields, the transcript's prompt box and
 * the P overlay differ in what they send and when; how a draft is read and how a failure is said is the same.
 */

import type { DraftSnapshot, FailedImage, ImageInfo, ResolveResult } from './draft';
import { pathProblem, serializeErrorText } from './model';

/** The line every field says under itself. */
export const PASTE_HINT = 'paste a screenshot to add it';

/**
 * The draft as text with each image a marker: `[Image #n: <path>]` once it is uploaded (and its path fit for a
 * marker), a bare `[Image #n]` until then. For what a form shows or previews while typing; what is *sent* comes from
 * `Draft.resolve()`, which waits for the uploads and never returns a bare marker.
 */
export function markedText(s: DraftSnapshot): string {
  const byOcc = new Map<string, ImageInfo>(s.images.map((i) => [i.occ, i]));
  return s.segments
    .map((g) => {
      if (g.kind === 'text') return g.text;
      const im = byOcc.get(g.occ);
      if (!im) return '';
      return im.status === 'ready' && im.path !== null && pathProblem(im.path) === null ? `[Image #${im.n}: ${im.path}]` : `[Image #${im.n}]`;
    })
    .join('');
}

const names = (failed: FailedImage[]): string => failed.map((f) => `image ${f.numbers.join(' and ') || '?'} (${f.name})`).join(', ');

/** Why a prompt with images that did not upload is not sent (each chip also says why, with its Retry). */
export function uploadFailedText(failed: FailedImage[], o: { nothing: string; again: string }): string {
  const one = failed.length === 1;
  return `Nothing was ${o.nothing}: ${names(failed)} did not upload (${failed[0]?.message ?? 'unknown error'}). Retry ${one ? 'it' : 'them'} on the picture, or remove ${one ? 'it' : 'them'}, then ${o.again} again. Your prompt is kept.`;
}

/** Why a prompt is held back by a file the composer refused (the field shows the refusal with its dismiss button). */
export function refusedText(message: string, o: { nothing: string; again: string }): string {
  return `Nothing was ${o.nothing}: ${message} Dismiss that message (the × under the box) to ${o.again} without it. Your prompt is kept.`;
}

/** The refusal a draft holds, in words for a Send that was pressed anyway; null when none is held. */
export function heldRefusalText(s: DraftSnapshot, o: { nothing: string; again: string }): string | null {
  return s.refusal === null ? null : refusedText(s.refusal, o);
}

/** Why `resolve()` gave nothing to send, in words for the field ('' when the draft is gone: nothing to say). */
export function notSentText(r: Exclude<ResolveResult, { ok: true }>, o: { nothing: string; again: string }): string {
  if (r.reason === 'upload') return uploadFailedText(r.failed, o);
  if (r.reason === 'serialize') return serializeErrorText(r.error);
  if (r.reason === 'refused') return refusedText(r.message, o);
  return '';
}

/** The images of a draft that have failed, as one line for a Send button's reason; null when none has. */
export function failedImagesText(s: DraftSnapshot): string | null {
  const bad = s.images.filter((i) => i.status === 'error');
  if (bad.length === 0) return null;
  const list = bad.map((i) => `image ${i.n} (${i.name})`).join(', ');
  return `${list} did not upload${bad[0]?.error ? ` (${bad[0].error})` : ''}: retry ${bad.length === 1 ? 'it' : 'them'} on the picture, or remove ${bad.length === 1 ? 'it' : 'them'}.`;
}

/** A prompt is worth sending: some text, or at least one image. */
export const hasContent = (s: DraftSnapshot): boolean => s.text.trim() !== '' || s.images.length > 0;

/**
 * The files a clipboard or a drag carries: file items first, the file list only if there were none (never both:
 * browsers list one screenshot in both). The composer's paste and drop, and the terminal view's paste, read it here.
 */
export function filesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  if (out.length === 0) out.push(...Array.from(dt.files ?? []));
  return out;
}
