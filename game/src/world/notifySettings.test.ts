import { describe, expect, it } from 'vitest';
import { botLink, expiresIn, NotifyBook, notifyFailureText, notifyStateOf, pairingText } from './notifySettings';

const full = {
  enabled: true,
  state: 'ready',
  env: ['enabled'],
  tested: true,
  events: { needs_you: true, done: false },
  quiet: true,
  freelancers: false,
  channel: { provider: 'telegram', key_set: true, key_hint: 'Dsaw', bot: 'herdr3d_bot', paired: { name: 'Ada', at: 5 }, pairing: { state: 'waiting', code: 'K7QM-4XPA', expires_at: 600_000 }, token: 'leak?' },
  last_error: { code: 'blocked', message: 'no', at: 9 },
  dropped: 2,
  extra: 1,
};

describe('notifyStateOf (#11)', () => {
  it('keeps the known fields only', () => {
    const s = notifyStateOf(full);
    expect(s).toEqual({
      enabled: true,
      state: 'ready',
      env: ['enabled'],
      tested: true,
      events: { needs_you: true, done: false },
      quiet: true,
      freelancers: false,
      channel: { provider: 'telegram', key_set: true, key_hint: 'Dsaw', bot: 'herdr3d_bot', paired: { name: 'Ada', at: 5 }, pairing: { state: 'waiting', code: 'K7QM-4XPA', expires_at: 600_000 } },
      last_error: { code: 'blocked', message: 'no', at: 9 },
      dropped: 2,
    });
    expect(JSON.stringify(s)).not.toContain('leak');
  });

  it('refuses what is not a state', () => {
    expect(notifyStateOf(null)).toBeNull();
    expect(notifyStateOf({ enabled: true, state: 'odd', channel: {} })).toBeNull();
    expect(notifyStateOf({ enabled: true, state: 'off' })).toBeNull();
  });

  it('the book: known once a state came', () => {
    const b = new NotifyBook();
    let n = 0;
    b.onChange(() => n++);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.upsert({ nope: 1 })).toBe(false);
    expect(b.upsert(full)).toBe(true);
    expect(b.known && n === 2).toBe(true);
  });
});

describe('the words (#11)', () => {
  const c = notifyStateOf(full)!.channel;
  it('says where to send the code and when it expires', () => {
    expect(pairingText(c, 0)).toBe('Send this code to @herdr3d_bot on Telegram, from the account that should get the messages. The code expires in 10 min.');
    expect(expiresIn(600_000, 599_000)).toBe('under a minute');
    expect(expiresIn(600_000, 600_000)).toBeNull();
    expect(pairingText({ ...c, pairing: { state: 'expired' } }, 0)).toContain('expired');
  });

  it('links to the bot only by a well-formed name', () => {
    expect(botLink(c)).toBe('https://t.me/herdr3d_bot');
    expect(botLink({ bot: 'x/../evil' })).toBeNull();
    expect(botLink({})).toBeNull();
  });

  it('names the failure and the way out', () => {
    expect(notifyFailureText('blocked', '')).toContain('press Start');
    expect(notifyFailureText('unauthorized', '')).toContain('@BotFather');
    expect(notifyFailureText('bad_request', 'that is not a bot token')).toBe('that is not a bot token');
    expect(notifyFailureText('weird', '')).toContain('weird');
  });
});
