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

describe('#108: prompt secrets never stay in the command log', () => {
  it('keeps no text of a scan, only its length', () => {
    const args = { text: 'export TOKEN=ghp_0123456789abcdef' };
    const out = loggedArgs('prompt_secrets.scan', args);
    expect(out).toEqual({ text: REDACTED, length: args.text.length });
    expect(JSON.stringify(out)).not.toContain('ghp_');
    expect(args.text).toContain('ghp_'); // what is sent is untouched
  });

  it('masks every protected range of a reviewed prompt, code unit for code unit; ignored ones stay as typed', () => {
    const text = 'a=s3cr3t😀 b=s3cr3t😀 c=plain';
    const args = {
      id: 'w1',
      text,
      secrets: {
        revision: 'r',
        decisions: [
          { candidate: 'c1', action: 'protect' as const, start: 2, end: 10 },
          { candidate: 'c2', action: 'ignore' as const },
          { action: 'protect' as const, start: 24, end: 29 },
        ],
      },
    };
    const out = loggedArgs('worker.prompt', args) as typeof args;
    expect(out.text).toBe('a=•••••••• b=s3cr3t😀 c=•••••');
    expect(out.text).toHaveLength(text.length);
    expect(out.secrets).toBe(args.secrets);
    expect(args.text).toBe(text);
  });

  it('masks the whole text when a protected candidate carries no range (the log cannot know where it is)', () => {
    const out = loggedArgs('worker.prompt', { id: 'w1', text: 'pw=x1', secrets: { revision: 'r', decisions: [{ candidate: 'c1', action: 'protect' as const }] } }) as { text: string };
    expect(out.text).toBe('•••••');
  });

  it('leaves a prompt without a review as it is', () => {
    const args = { id: 'w1', text: 'hello' };
    expect(loggedArgs('worker.prompt', args)).toBe(args);
  });
});
