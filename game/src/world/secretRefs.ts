/**
 * #108 round 4: the bridge's own references to protected files in a text, found exactly. Pure.
 *
 * A protected value is sent as `[secret in file <path>]` (docs/protocol.md "Prompt secrets", docs/decisions.md #108
 * row 6), the path `<dir>/<owner>/<file>`: the bridge's private directory, then an owner directory and a file, both
 * named as `secretfiles` names them (26 to 64 of `A-Z2-7`). The directory may only hold `A-Z a-z 0-9 . _ -` and `/`.
 * With the directory known (`World.prompt_secrets.dir`, round 5) the path must be under exactly it; an older bridge does
 * not say it, and then the shape alone decides. Anything else that looks like one (another shape, a missing bracket,
 * a mention of it) stays text: the game shows a reference as a masked chip only when it is the bridge's.
 */

/** One reference: `[start, end)` in UTF-16 code units of the text, and the file's path. */
export interface SecretRef {
  start: number;
  end: number;
  path: string;
}

const NAME = '[A-Z2-7]{26,64}';
const OPEN = '[secret in file ';
/** The shape without a known directory: an absolute directory of the bridge's characters (no `.` or `..` part). */
const SHAPE = new RegExp(`\\[secret in file (\\/(?:(?!\\.\\.?\\/)[A-Za-z0-9._-]+\\/)+${NAME}\\/${NAME})\\]`, 'g');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const byDir = new Map<string, RegExp>();

function pattern(dir: string | null | undefined): RegExp {
  if (!dir) return SHAPE;
  let re = byDir.get(dir);
  if (!re) {
    re = new RegExp(`\\[secret in file (${escape(dir)}\\/${NAME}\\/${NAME})\\]`, 'g');
    byDir.set(dir, re);
  }
  return re;
}

/** The references in `text`, in order (`dir`: the bridge's directory; null or absent: the shape alone). */
export function secretRefs(text: string, dir: string | null | undefined): SecretRef[] {
  if (!text.includes(OPEN)) return [];
  const re = pattern(dir);
  re.lastIndex = 0;
  const out: SecretRef[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A mention of one (`@[secret in file …]`) is not the bridge's reference.
    if (m.index > 0 && text[m.index - 1] === '@') continue;
    out.push({ start: m.index, end: m.index + m[0].length, path: m[1] as string });
  }
  return out;
}

/** `text` holds at least one reference. */
export const hasSecretRef = (text: string, dir: string | null | undefined): boolean => secretRefs(text, dir).length > 0;
