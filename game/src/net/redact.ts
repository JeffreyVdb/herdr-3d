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

/**
 * The args of a command as the game may keep and expose them (`App.sent`, `window.__h3d.sent()`): the API key of
 * an `ai.*` or (#184) `kaneo.*` command, and (#11) the Telegram bot token of `notify.token.set`, is replaced,
 * everything else is as sent. #108: a `prompt_secrets.scan` keeps only its text's length, and a prompt that carries a
 * review (`secrets`) its text with the protected ranges masked. The command itself goes out
 * unchanged (#92: a key lives on the bridge only, and nowhere in the page once it is typed).
 */
export function loggedArgs(t: CommandName, args: unknown): unknown {
  if (!isObj(args)) return args;
  if (t === 'prompt_secrets.scan' && typeof args.text === 'string') return { ...args, text: REDACTED, length: args.text.length };
  if ('secrets' in args && typeof args.text === 'string') return { ...args, text: maskReviewed(args.text, args.secrets) };
  if (!(t.startsWith('ai.') || t.startsWith('kaneo.') || t.startsWith('notify.')) || !('key' in args)) return args;
  return { ...args, key: REDACTED };
}
