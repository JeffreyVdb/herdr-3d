import { precheckUpload } from '../net/upload';
import { Draft, type Uploader } from '../ui/composer/draft';
import { MAX_IMAGES } from '../ui/composer/model';
import { MAX_PROMPT } from './keys';

/** What an image paste in the terminal view needs from the laptop controller (#64). */
export interface PasteImagesHost {
  /** The worker's name: in the messages and in the uploaded files' names (`h3d-terminal-<name>-<n>`). */
  name: string;
  /** The worker runs an agent (a plain shell cannot read a picture). */
  agent: boolean;
  /** One image to Drop Zone (none: this game has no upload door). */
  upload: Uploader | undefined;
  /** Queues the text as a paste behind what is already queued; false when it is over the cap. */
  paste(text: string): boolean;
  /** The seat bar's line (an error also stays a line the user reads; standing up turns it into a toast, the caller's call). */
  say(kind: 'ok' | 'error', msg: string): void;
}

/**
 * An image pasted into the terminal view (#64): a worker with an agent gets `[Image #n: <path>]` markers, in the order
 * the images came, as one paste (`worker.prompt`) once every image is uploaded. The composer's draft does the work
 * (the pre-check, the numbering, at most 2 uploads at once, the cap); it is all or nothing: a file that is refused, or
 * an upload that failed, sends nothing and the bar says why. A plain shell says it cannot take an image and types
 * nothing. Resolves when the paste was queued or given up.
 */
export async function pasteImages(files: readonly File[], h: PasteImagesHost): Promise<void> {
  if (!h.agent) {
    h.say('error', `${h.name} runs a plain shell, not an agent: an image can’t be pasted there. Nothing was typed.`);
    return;
  }
  if (!h.upload) {
    h.say('error', 'This game can’t upload images: nothing was pasted.');
    return;
  }
  // All or nothing, so every file is checked before the first one goes up (a draft starts uploading as it takes one).
  const refused = files.map((f) => precheckUpload(f)).filter((m): m is string => m !== null);
  if (files.length > MAX_IMAGES) refused.push(`You can paste up to ${MAX_IMAGES} images at once.`);
  if (refused.length > 0) {
    h.say('error', `${refused.join(' ')} Nothing was pasted.`);
    return;
  }
  const draft = new Draft({ upload: h.upload, label: `terminal-${h.name}`, maxPromptBytes: MAX_PROMPT });
  const added = draft.addImages(files);
  h.say('ok', `Uploading ${added.added === 1 ? 'the image' : `${added.added} images`} for ${h.name}…`);
  const r = await draft.resolve({ maxBytes: MAX_PROMPT });
  draft.dispose();
  if (!r.ok) {
    const why =
      r.reason === 'upload'
        ? `image ${r.failed.map((f) => `${f.numbers.join(' and ') || '?'} (${f.name})`).join(', ')} did not upload (${r.failed[0]?.message ?? 'unknown error'}). Paste again to retry.`
        : 'the prompt could not be made.';
    h.say('error', `Nothing was pasted into ${h.name}’s terminal: ${why}`);
    return;
  }
  if (!h.paste(r.text)) h.say('error', 'That paste is over 16 KiB: paste less at a time.');
  else h.say('ok', `Pasting ${r.images.length === 1 ? 'the image' : `${r.images.length} images`} into ${h.name}’s terminal…`);
}
