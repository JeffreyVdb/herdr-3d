/**
 * #31: file references in transcript markdown. An agent writes `[handoff document](/tmp/handoff.md)`: the friendly label
 * shows, and its destination is a path on the worker's machine, never a URL for this browser. The transcript keeps it as
 * inert metadata (no `href`, so nothing navigates or resolves against the page's origin) and offers it to copy.
 *
 * What counts as a file reference (the destination as the markdown wrote it):
 * - an absolute path (`/tmp/a.md`), a home one (`~/notes.md`), a Windows drive path (`C:\x\a.md`, `C:/x/a.md`, also with its
 *   backslashes percent-encoded, as markdown hands them over: `C:%5Cx%5Ca.md`);
 * - a relative one (`./a.md`, `../a.md`, `docs/a.md`, `README.md`): relative to the worker's checkout;
 * - a `file:` URL with no host or `localhost` (`file:///tmp/a%20b.md` is `/tmp/a b.md`).
 * Not: any other scheme (`http:`, `mailto:`, `javascript:`, `data:`…), a network path (`//host/x`, `\\host\x`, a `file:` URL
 * with another host), an in-page `#anchor` or `?query`, a relative path whose first segment has a colon (a URL scheme to a
 * browser), or anything with a control character.
 *
 * A destination is a URL to markdown: percent escapes are decoded (`%20` is a space; a malformed `%` stays as written),
 * and a `#fragment` (`src/app.ts#L42`) is not part of the path (`%23` is a literal `#`).
 */

/** A file reference's path as written, decoded (relative or not). */
export type FileRefPath = string;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[a-z]:[\\/]/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Longer than any path a system takes: not a file reference. */
const MAX = 4096;

/** Percent escapes decoded, each run of them as UTF-8; a run that is not valid UTF-8 stays as written. Never throws. */
export function decodePercent(s: string): string {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** An absolute path (POSIX, home or a Windows drive): one the worker's checkout does not change. */
export const isAbsolutePath = (p: string): boolean => p.startsWith('/') || p === '~' || p.startsWith('~/') || DRIVE.test(p);

/** The path a link destination (as the sanitiser sees it: after markdown) refers to, or null when it is not a file reference. */
export function fileRefPath(href: string): FileRefPath | null {
  const raw = href.trim();
  if (!raw || raw.length > MAX) return null;
  let path: string;
  if (/^file:/i.test(raw)) {
    const m = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)/i.exec(raw);
    if (!m || (m[1] && m[1].toLowerCase() !== 'localhost')) return null;
    path = decodePercent(m[2] ?? '');
    // file:///C:/x is the drive path C:/x.
    if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  } else {
    // A drive path after markdown has its backslashes encoded (`C:%5Cx`): it is one once decoded. Only a drive letter, a
    // colon and a slash pass this way, so no other scheme does.
    if (!DRIVE.test(decodePercent(raw)) && SCHEME.test(raw)) return null;
    if (/^(?:\/\/|\\\\|[#?])/.test(raw)) return null;
    path = decodePercent(raw.replace(/#.*$/s, ''));
    if (!isAbsolutePath(path) && (path.split('/')[0] ?? '').includes(':')) return null;
  }
  if (!path || CONTROL.test(path) || /^(?:\/\/|\\\\)/.test(path)) return null;
  return path;
}

/**
 * The path to copy: an absolute one as it is; a relative one joined to the worker's checkout (`.` and `..` resolved, never
 * above the root), or as written when the checkout is not known (null).
 */
export function resolveFileRef(path: FileRefPath, cwd: string | null | undefined): string {
  if (isAbsolutePath(path) || !cwd || !isAbsolutePath(cwd)) return path;
  const root = cwd.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const seg of `${cwd}/${path}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > (root ? 0 : 1)) out.pop();
    } else out.push(seg);
  }
  const joined = root + out.join('/');
  // A trailing slash (a directory) stays.
  return path.endsWith('/') && !joined.endsWith('/') ? `${joined}/` : joined;
}
