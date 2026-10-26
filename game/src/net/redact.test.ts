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

describe('#108 round 4: every reviewed field of every route is masked in the command log', () => {
  const VALUE = 'Zq9-SECRET-77';
  /** A text with VALUE in it, and a review protecting exactly that range. */
  const reviewed = (before: string) => {
    const text = `${before}${VALUE} after`;
    return { text, review: { revision: 'r', decisions: [{ candidate: 'c1', action: 'protect' as const, start: before.length, end: before.length + VALUE.length }] } };
  };
  const clean = (v: unknown) => expect(JSON.stringify(v)).not.toContain(VALUE);

  it('a command with one text: its own field (prompt, text, instruction)', () => {
    const one: Array<[Parameters<typeof loggedArgs>[0], string, Record<string, unknown>]> = [
      ['worker.hire', 'prompt', { floor: 'f1', desk_index: 0, harness: 'claude', model: 'm', effort: 'high' }],
      ['worker.wrapup', 'prompt', { id: 'w1' }],
      ['packup.detect', 'text', { id: 'w1' }],
      ['hire.interpret', 'text', {}],
      ['worker.handoff', 'instruction', { worker: 'w1', mode: 'agent', op: 'o1' }],
      ['schedule.create', 'prompt', { floor: 'f1', title: 't' }],
      ['schedule.update', 'prompt', { id: 's1' }],
      ['hire_preset.create', 'prompt', { name: 'p' }],
      ['hire_preset.update', 'prompt', { id: 'p1' }],
      ['hire_preset.check', 'prompt', {}],
    ];
    for (const [t, field, rest] of one) {
      const { text, review } = reviewed(`${field}: `);
      const args = { ...rest, [field]: text, secrets: review };
      const out = loggedArgs(t, args) as Record<string, string>;
      clean(out);
      expect(out[field], t).toBe(`${field}: ${'•'.repeat(VALUE.length)} after`);
      expect(args[field]).toBe(text); // what is sent is untouched
    }
  });

  it('a command with several texts: each keyed text masked by its own review, the others as typed', () => {
    const t1 = reviewed('ticket ');
    const t2 = reviewed('extra ');
    const run = loggedArgs('run.start', { floor: 'f1', text: t1.text, extra: t2.text, secrets: { text: t1.review, extra: t2.review } }) as Record<string, string>;
    clean(run);
    expect(run.text).toBe(`ticket ${'•'.repeat(VALUE.length)} after`);
    const a = reviewed('other ');
    const p = reviewed('then ');
    const ask = loggedArgs('worker.answer_ask', {
      id: 'w1',
      tool_use_id: 'tu',
      answers: [{ question: 0, choices: [1] }, { question: 1, other: a.text }],
      prompt: p.text,
      secrets: { 'answers[1].other': a.review, prompt: p.review },
    }) as { answers: Array<{ other?: string; choices?: number[] }>; prompt: string };
    clean(ask);
    expect(ask.answers[0]).toEqual({ question: 0, choices: [1] });
    expect(ask.answers[1]?.other).toBe(`other ${'•'.repeat(VALUE.length)} after`);
    const v = reviewed('value ');
    const n = reviewed('note ');
    const fu = loggedArgs('worker.answer_followup', { id: 'w1', turn_id: 't', answers: [{ id: 'q1', value: v.text, note: n.text }], note: 'plain note', secrets: { 'answers[0].value': v.review, 'answers[0].note': n.review } });
    clean(fu);
    expect((fu as { note: string }).note).toBe('plain note');
    const as = reviewed('answer ');
    const async = loggedArgs('worker.answer_async', { id: 'w1', thread: 't', batch: 'b', answers: [{ index: 0, answer: 'fine' }, { index: 3, answer: as.text }], secrets: { 'answers[1].answer': as.review } });
    clean(async);
    expect((async as { answers: Array<{ answer: string }> }).answers[0]?.answer).toBe('fine');
  });

  it('a keyed review of a text the args do not hold, or a path of another shape, changes nothing (and never throws)', () => {
    const r = reviewed('x ');
    const args = { id: 'w1', turn_id: 't', answers: [], secrets: { 'answers[4].value': r.review, 'nonsense[': r.review } };
    expect(loggedArgs('worker.answer_followup', args)).toEqual(args);
    // A stored prompt's all-ignore review: stored as typed, logged as typed.
    const stored = { floor: 'f1', title: 't', prompt: 'pw=hunter2', secrets: { revision: 'r', decisions: [{ candidate: 'c1', action: 'ignore' }] } };
    expect(loggedArgs('schedule.create', stored)).toEqual(stored);
    // A hand-over carries references, never a value: as sent.
    const hand = { id: 'w1', text: 'TOKEN=[secret in file /run/x/AAAA/BBBB]', secrets_pending: 'tok' };
    expect(loggedArgs('worker.prompt', hand)).toBe(hand);
  });
});

describe('manual process input redaction', () => {
  it('does not retain credentials or terminal input in the command log', () => {
    expect(JSON.stringify(loggedArgs('manual_process.credential', { id: 'p', request: 'r', secret: 'H3D-MARKER' }))).not.toContain('H3D-MARKER');
    expect(JSON.stringify(loggedArgs('terminal.input', { id: 'mp:p', text: 'H3D-MARKER' }))).not.toContain('H3D-MARKER');
  });
});
