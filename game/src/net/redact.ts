import type { CommandName } from './protocol';

/** What stands in the command log for a secret. */
export const REDACTED = '[redacted]';

/**
 * The args of a command as the game may keep and expose them (`App.sent`, `window.__h3d.sent()`): the API key of
 * an `ai.*` command is replaced, everything else is as sent. The command itself goes out unchanged (#92: a key
 * lives on the bridge only, and nowhere in the page once it is typed).
 */
export function loggedArgs(t: CommandName, args: unknown): unknown {
  if (!t.startsWith('ai.') || typeof args !== 'object' || args === null || !('key' in args)) return args;
  return { ...args, key: REDACTED };
}
