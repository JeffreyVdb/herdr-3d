import raw from '../../voices/receptionist.json?raw';
import lockRaw from '../../voices/receptionist.lock.json?raw';
import { parseLines, type VoiceLine } from './lines';

/** The receptionist's lines (`game/voices/receptionist.json`); clips are `public/voices/receptionist/<id>.mp3`. */
export const RECEPTIONIST_LINES: readonly VoiceLine[] = parseLines(JSON.parse(raw));

/** Clip key of a line for the audio module (`voices/<key>.mp3` under the site root). */
export const clipKey = (id: string) => `receptionist/${id}`;

/** Clip lengths (ms) from the generator's lock file: the bubble's timing without decoding anything. */
export const CLIP_MS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries((JSON.parse(lockRaw) as { lines?: Record<string, { ms?: number }> }).lines ?? {}).map(([id, e]) => [id, typeof e.ms === 'number' ? e.ms : 0]),
);
