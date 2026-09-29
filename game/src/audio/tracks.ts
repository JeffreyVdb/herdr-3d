import manifest from '../../music/manifest.json' with { type: 'json' };

/**
 * The radio's music catalogue: `game/music/manifest.json`, one row per
 * recording, with its license, attribution and claim status. The game reads it
 * for the playlists and the credits panel; `tools/music.ts` reads it to fetch,
 * transcode and audit the files (`public/music/<genre>/<id>.ogg`, not committed).
 */

/** The radio's genres, in the order E cycles through them (after Off). */
export const GENRES = [
  { id: 'house', name: 'Melodic house' },
  { id: 'jazz', name: 'Soft jazz' },
  { id: 'rock', name: 'Rock' },
  { id: 'pop', name: 'Pop' },
  { id: 'rap', name: 'Rap' },
] as const;

export type Genre = (typeof GENRES)[number]['id'];
/** What the radio is tuned to: a genre, or off. */
export type RadioGenre = Genre | 'off';

export const RADIO_OFF_NAME = 'Off';

export const genreName = (g: RadioGenre): string => (g === 'off' ? RADIO_OFF_NAME : (GENRES.find((x) => x.id === g)?.name ?? g));

export const isGenre = (v: unknown): v is Genre => GENRES.some((g) => g.id === v);

/** The genre E goes to from `g`: Off → Melodic house → Soft jazz → Rock → Pop → Rap → Off. */
export function nextGenre(g: RadioGenre): RadioGenre {
  if (g === 'off') return GENRES[0].id;
  const i = GENRES.findIndex((x) => x.id === g);
  return GENRES[i + 1]?.id ?? 'off';
}

export type License = 'CC0-1.0' | 'CC-BY-3.0' | 'CC-BY-4.0' | 'custom';
export type ClaimStatus = 'cleared' | 'hold';

/** One manifest row: a recording and the evidence that lets the game ship it. */
export interface MusicRow {
  id: string;
  genre: Genre;
  title: string;
  artist: string;
  /** The track's own page (its license and download are stated there). */
  sourceUrl: string;
  /** The file to fetch. Empty when the source needs a sign-in: put the file in `music/incoming/` instead. */
  downloadUrl: string;
  license: License;
  licenseUrl: string;
  /** The exact credit string the artist or license asks for; null for CC0. */
  attribution: string | null;
  /** `cleared`: the publisher says in writing the track is not registered for fingerprinting. `hold`: license fine, claim status unverified (dev builds only). */
  claimStatus: ClaimStatus;
  /** Date (YYYY-MM-DD) the track page and the claim statement were last checked. */
  verifiedAt: string;
  /** Archived copy of `sourceUrl`, relative to `game/`. */
  proof: string;
  /** Cleared rows: where the publisher's "not registered" statement is (a listing page), and its archived copy. */
  claimUrl?: string;
  claimProof?: string;
  /** sha256 of the downloaded source file. */
  sha256: string;
  /** Length of the transcoded file, seconds. */
  durationSec: number;
  /** Integrated loudness of the transcoded file (EBU R128, LUFS). */
  loudnessLufs: number;
  /** Why a row is on hold, or anything a reviewer should know. */
  note?: string;
}

export interface Manifest {
  /** Loudness every file is normalised to (LUFS). */
  targetLufs: number;
  tracks: MusicRow[];
}

export const MANIFEST = manifest as unknown as Manifest;
export const ROWS: readonly MusicRow[] = MANIFEST.tracks;

/** What the player needs of a row. */
export interface Track {
  id: string;
  genre: Genre;
  title: string;
  artist: string;
  durationSec: number;
}

export const trackOf = (r: MusicRow): Track => ({ id: r.id, genre: r.genre, title: r.title, artist: r.artist, durationSec: r.durationSec });

export const tracksOf = (rows: readonly MusicRow[], genre: Genre): Track[] => rows.filter((r) => r.genre === genre).map(trackOf);

export const LICENSE_NAME: Record<License, string> = {
  'CC0-1.0': 'CC0 1.0',
  'CC-BY-3.0': 'CC BY 3.0',
  'CC-BY-4.0': 'CC BY 4.0',
  custom: 'Custom license',
};

/** Where a file lives, relative to the site's base: `music/<genre>/<id>.ogg`. */
export const trackPath = (t: Pick<Track, 'genre' | 'id'>): string => `music/${t.genre}/${t.id}.ogg`;

/** What was done to every file, for the credits (CC BY asks for a change notice). */
export const CHANGES = 'transcoded to Ogg Opus, loudness-normalised';

/**
 * `MUSIC_CREDITS.txt`: for every row its title, creator, source, license with
 * its link, the credit string to reproduce, and the changes made.
 */
export function creditsText(rows: readonly MusicRow[], targetLufs = MANIFEST.targetLufs): string {
  const out: string[] = [
    'Music credits',
    '=============',
    '',
    `The office radio plays the recordings below. Each file was ${CHANGES} (${targetLufs} LUFS); nothing else was changed.`,
    '',
  ];
  for (const g of GENRES) {
    const list = rows.filter((r) => r.genre === g.id);
    if (!list.length) continue;
    out.push(g.name, '-'.repeat(g.name.length), '');
    for (const r of list) {
      out.push(`"${r.title}" by ${r.artist}`);
      out.push(`  Source: ${r.sourceUrl}`);
      out.push(`  License: ${LICENSE_NAME[r.license]} (${r.licenseUrl})`);
      out.push(`  Credit: ${r.attribution ?? 'none required'}`);
      out.push(`  Changes: ${CHANGES}`);
      out.push('');
    }
  }
  return out.join('\n');
}
