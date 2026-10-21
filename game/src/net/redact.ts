import type { CommandName } from './protocol';

/** What stands in the command log for a secret. */
export const REDACTED = '[redacted]';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * #108: a reviewed prompt's text with every protected range as `•`, code unit for code unit (offsets and lengths
 * still line up for a test). A protected candidate without its range (the game always sends it; another client may
 * not) masks the whole text: the log cannot tell where it is.
 */
function maskReviewed(text: string, secrets: unknown): string {
  const decisions = isObj(secrets) && Array.isArray(secrets.decisions) ? (secrets.decisions as unknown[]) : null;
  if (!decisions) return '•'.repeat(text.length);
  const ranges: Array<[number, number]> = [];
  for (const d of decisions) {
    if (!isObj(d) || d.action === 'ignore') continue;
    if (!isInt(d.start) || !isInt(d.end)) return '•'.repeat(text.length);
    ranges.push([Math.max(0, d.start), Math.min(text.length, d.end)]);
  }
  const out = text.split('');
  for (const [s, e] of ranges) for (let i = s; i < e; i++) out[i] = '•';
  return out.join('');
}

/** #108 round 4: the field a single review is of, per command (`secrets` is a `SecretsReview` there). */
const REVIEWED: Partial<Record<CommandName, string>> = {
  'worker.prompt': 'text',
  'worker.paste': 'text', // #176 part 2
  'packup.detect': 'text',
  'hire.interpret': 'text',
  'worker.hire': 'prompt',
  'worker.wrapup': 'prompt',
  'worker.handoff': 'instruction',
  'schedule.create': 'prompt',
  'schedule.update': 'prompt',
  'hire_preset.create': 'prompt',
  'hire_preset.update': 'prompt',
  'hire_preset.check': 'prompt',
};

/** A review's path in the args (docs/protocol.md "One text, or a review per text"): `note`, or `answers[1].value`. */
const PATH = /^([a-z_]+)(?:\[(\d+)\]\.([a-z_]+))?$/;

/**
 * `args` with the text at `path` masked by `review` (a copy where it changed; the same object when the path holds no
 * text). An array's item is copied too, never changed in place.
 */
function maskPath(args: Record<string, unknown>, path: string, review: unknown): Record<string, unknown> {
  const m = PATH.exec(path);
  if (!m) return args;
  const [, field, index, sub] = m as unknown as [string, string, string | undefined, string | undefined];
  if (index === undefined) return typeof args[field] === 'string' ? { ...args, [field]: maskReviewed(args[field] as string, review) } : args;
  const list = args[field];
  const i = Number(index);
  if (!Array.isArray(list) || !isObj(list[i]) || typeof (list[i] as Record<string, unknown>)[sub as string] !== 'string') return args;
  const item = list[i] as Record<string, unknown>;
  const copy = [...list];
  copy[i] = { ...item, [sub as string]: maskReviewed(item[sub as string] as string, review) };
  return { ...args, [field]: copy };
}

/**
 * The args of a command as the game may keep and expose them (`App.sent`, `window.__h3d.sent()`): the API key of
 * an `ai.*` or (#184) `kaneo.*` command, and (#11) the Telegram bot token of `notify.token.set`, is replaced,
 * everything else is as sent. #108: a `prompt_secrets.scan` keeps only its text's length, and a command that carries a
 * review (`secrets`) each reviewed text with its protected ranges masked: the command's one text (round 4: `prompt`,
 * `text` or `instruction`), or each text a keyed review names (`answers[1].value`). The command itself goes out
 * unchanged (#92: a key lives on the bridge only, and nowhere in the page once it is typed).
 */
export function loggedArgs(t: CommandName, args: unknown): unknown {
  if (!isObj(args)) return args;
  if (t === 'prompt_secrets.scan' && typeof args.text === 'string') return { ...args, text: REDACTED, length: args.text.length };
  if (isObj(args.secrets)) {
    // One review (it has a revision) is of the command's one text; several are keyed by their texts' paths.
    const one = REVIEWED[t];
    if (typeof args.secrets.revision === 'string') return one ? maskPath(args, one, args.secrets) : args;
    let out = args;
    for (const [path, review] of Object.entries(args.secrets)) out = maskPath(out, path, review);
    return out;
  }
  if (!(t.startsWith('ai.') || t.startsWith('kaneo.') || t.startsWith('notify.')) || !('key' in args)) return args;
  return { ...args, key: REDACTED };
}
