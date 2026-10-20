/**
 * #134 R1: the orderings of a worktree hire refused with `fetch_failed` (its recheck fetches origin) and a folder
 * change after it (a preview), shared by the Hire and Hire Review DOM tests. A preview never drops or hides a fetch for
 * the repository it is about; another repository's preview is a fresh start.
 */

import type { HireGit } from '../net/protocol';

export const ORIGIN_GIT: HireGit = { repo_root: '/home/test', default_branch: 'main', base_sha: '1234567abc', base_time: 1, fetched: false };

/** What the recheck's fetch finds. */
export const fetchedGit = (origin: 'down' | 'up'): HireGit => (origin === 'down' ? { ...ORIGIN_GIT, fetch_error: 'offline' } : { ...ORIGIN_GIT, fetched: true });

/** A preview of `folder`'s repository (`/home/other…`: another one). */
export const previewGit = (folder: string): HireGit => ({ ...ORIGIN_GIT, repo_root: folder.startsWith('/home/other') ? '/home/other' : ORIGIN_GIT.repo_root, preview: true });

export interface FetchOrdering {
  name: string;
  /** The folder typed after the refusal. */
  folder: string;
  origin: 'down' | 'up';
  /** The answers in the order they come back: the recheck first means before the folder was changed. */
  order: Array<'recheck' | 'preview'>;
  /** The recheck answered before the folder changed (else both are on their way when the folder changes). */
  before: boolean;
  /** What the dialog ends with: the worktree offered (no fetch note, no Fetch again), or off with both. */
  usable: boolean;
}

export const FETCH_ORDERINGS: FetchOrdering[] = [
  { name: 'fetch failed, then a folder of the same repository', folder: '/home/test/subdir', origin: 'down', before: true, order: ['preview'], usable: false },
  { name: 'fetch on its way, the same repository previewed, then the fetch fails', folder: '/home/test/subdir', origin: 'down', before: false, order: ['preview', 'recheck'], usable: false },
  { name: 'fetch on its way, the same repository previewed, the fetch fails before the preview answers', folder: '/home/test/subdir', origin: 'down', before: false, order: ['recheck', 'preview'], usable: false },
  { name: 'fetch on its way, the same repository previewed, then the fetch finds origin', folder: '/home/test/subdir', origin: 'up', before: false, order: ['preview', 'recheck'], usable: true },
  { name: 'fetch on its way, the same repository previewed, the fetch finds origin before the preview answers', folder: '/home/test/subdir', origin: 'up', before: false, order: ['recheck', 'preview'], usable: true },
  { name: 'fetch failed, then a folder of another repository', folder: '/home/other', origin: 'down', before: true, order: ['preview'], usable: true },
  { name: 'fetch on its way, another repository previewed, then the fetch fails', folder: '/home/other', origin: 'down', before: false, order: ['preview', 'recheck'], usable: true },
  { name: 'fetch on its way, another repository previewed, the fetch fails before the preview answers', folder: '/home/other', origin: 'down', before: false, order: ['recheck', 'preview'], usable: true },
];
