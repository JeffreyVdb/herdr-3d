import raw from '../../voices/receptionist.json?raw';
import { parseLines, type VoiceLine } from './lines';

/** The receptionist's lines (`game/voices/receptionist.json`); clips are `public/voices/receptionist/<id>.mp3`. */
export const RECEPTIONIST_LINES: readonly VoiceLine[] = parseLines(JSON.parse(raw));

/** Clip key of a line for the audio module (`voices/<key>.mp3` under the site root). */
export const clipKey = (id: string) => `receptionist/${id}`;
