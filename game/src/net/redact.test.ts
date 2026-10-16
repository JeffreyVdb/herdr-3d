import { describe, expect, it } from 'vitest';
import { loggedArgs, REDACTED } from './redact';

describe('loggedArgs (#92: a typed key is never kept in the command log)', () => {
  it('replaces the key of every ai command and keeps the rest', () => {
    for (const t of ['ai.models', 'ai.test', 'ai.set'] as const) {
      const args = { role: 'llm', base_url: 'https://x/v1', model: 'm', key: 'sk-secret-0123456789' };
      const out = loggedArgs(t, args) as typeof args;
      expect(out).toEqual({ role: 'llm', base_url: 'https://x/v1', model: 'm', key: REDACTED });
      expect(JSON.stringify(out)).not.toContain('secret');
      expect(args.key).toBe('sk-secret-0123456789'); // what is sent is untouched
    }
  });

  it('leaves a command without a key, and every other command, as it is', () => {
    const noKey = { role: 'classifier', model: 'jev-latest' };
    expect(loggedArgs('ai.test', noKey)).toBe(noKey);
    const other = { session: 's', key: 'not a secret here' };
    expect(loggedArgs('issue.get', other)).toBe(other);
    expect(loggedArgs('ai.get', {})).toEqual({});
  });

  it('#184: replaces a Kaneo key too', () => {
    expect(loggedArgs('kaneo.test', { url: 'https://k.test', key: 'secret' })).toEqual({ url: 'https://k.test', key: REDACTED });
    expect(loggedArgs('kaneo.set', { key: 'secret', default_workspace: null })).toEqual({ key: REDACTED, default_workspace: null });
  });

  it('#11: replaces the Telegram bot token', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const out = loggedArgs('notify.token.set', { key: token });
    expect(out).toEqual({ key: REDACTED });
    expect(JSON.stringify(out)).not.toContain('AAHdq');
  });
});
