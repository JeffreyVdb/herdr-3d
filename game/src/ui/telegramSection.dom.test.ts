// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { NotifyBook } from '../world/notifySettings';
import { telegramDestination, telegramSection } from './telegramSection';

type View = Record<string, unknown>;

/** A bridge's notify state: off, no token, unless `o` says otherwise (`channel` merges). */
function view(o: View = {}): View {
  const { channel, ...rest } = o;
  return {
    enabled: false,
    state: 'off',
    env: [],
    tested: false,
    events: { needs_you: true, done: true },
    quiet: false,
    freelancers: false,
    ...rest,
    channel: { provider: 'telegram', key_set: false, ...(channel as View | undefined) },
  };
}

const TOKEN = { key_set: true, key_hint: 'Dsaw', bot: 'herdr3d_bot' };
const ADA = { ...TOKEN, paired: { name: 'Ada', at: 1 } };
const WAITING = { state: 'waiting', code: 'K7QM-4XPA', expires_at: Date.now() + 600_000 };

/**
 * The section in the page, against a book in state `v`. `answer` is the bridge: what each command acks with (a view,
 * which the book takes, or a failure); its acks wait for `release()` when `hold` is set.
 */
function mount(v: View, answer: (t: string) => CommandResult = () => ({ ok: true, data: null })) {
  document.body.replaceChildren();
  const book = new NotifyBook();
  book.reset(v);
  const sent: string[] = [];
  let pending: Array<() => void> = [];
  const rig = { hold: false };
  const body = document.createElement('div');
  document.body.append(body);
  const handle = telegramSection({
    book,
    send: (t) => {
      sent.push(t);
      const r = answer(t);
      if (!rig.hold) return Promise.resolve(r);
      return new Promise<CommandResult>((res) => pending.push(() => res(r)));
    },
  })(body);
  handle.open?.();
  const button = (text: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const box = (label: RegExp) => [...body.querySelectorAll('label')].find((l) => label.test(l.textContent ?? ''))!.querySelector('input')!;
  const dest = () => body.querySelector<HTMLElement>('.settings-tg-dest')!;
  const badge = () => body.querySelector<HTMLElement>('.settings-tg-dest-badge')!;
  const status = () => body.querySelector<HTMLElement>('.settings-status')!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const release = () => {
    const p = pending;
    pending = [];
    p.forEach((f) => f());
  };
  return { book, body, sent, rig, button, box, dest, badge, status, flush, release, handle };
}

describe('telegramDestination: the one destination status (#12)', () => {
  const cases: Array<[string, View, TelegramDestinationLike]> = [
    ['no token', view(), { kind: 'none', label: 'Not configured', text: /No bot token/ }],
    ['no token, switched on (env)', view({ enabled: true, state: 'incomplete' }), { kind: 'none', label: 'Not configured', text: /No bot token/ }],
    ['a token, no account', view({ channel: TOKEN }), { kind: 'none', label: 'Not configured', text: /pair your Telegram account/ }],
    ['a token, a code waiting', view({ channel: { ...TOKEN, pairing: WAITING } }), { kind: 'none', label: 'Not configured', text: /Waiting for the pairing code/ }],
    ['a token, the code expired', view({ channel: { ...TOKEN, pairing: { state: 'expired' } } }), { kind: 'none', label: 'Not configured', text: /pair your Telegram account/ }],
    [
      'pairing retrying: another program reads the bot',
      view({ channel: { ...TOKEN, pairing: { ...WAITING, state: 'conflict', message: 'Another program reads this bot’s updates: retrying.' } } }),
      { kind: 'error', label: 'Error', text: /Another program reads/ },
    ],
    ['pairing retrying, no message', view({ channel: { ...TOKEN, pairing: { ...WAITING, state: 'error' } } }), { kind: 'error', label: 'Error', text: /retrying/ }],
    ['paired, off', view({ channel: ADA }), { kind: 'paired', label: 'Paired', text: /^Alerts are off: nothing is sent to Ada\.$/ }],
    ['paired, on', view({ enabled: true, state: 'ready', tested: true, channel: ADA }), { kind: 'paired', label: 'Paired', text: /^Alerts are on: messages go to Ada through @herdr3d_bot\.$/ }],
    ['paired again: a code waiting while still paired', view({ channel: { ...ADA, pairing: WAITING } }), { kind: 'paired', label: 'Paired', text: /Alerts are off/ }],
    [
      'on, the bot blocked',
      view({ enabled: true, state: 'blocked', channel: ADA, last_error: { code: 'blocked', message: 'blocked', at: 1 } }),
      { kind: 'error', label: 'Error', text: /^Last message not delivered: Telegram will not deliver to you/ },
    ],
    [
      'off, a test bounced (the token revoked)',
      view({ channel: ADA, last_error: { code: 'unauthorized', message: 'nope', at: 1 } }),
      { kind: 'error', label: 'Error', text: /Telegram refused the bot token/ },
    ],
    [
      'on, a delivery failed (network)',
      view({ enabled: true, state: 'ready', channel: ADA, last_error: { code: 'unreachable', message: 'dial tcp', at: 1 } }),
      { kind: 'error', label: 'Error', text: /could not reach Telegram/ },
    ],
    [
      'the environment gives the token and the switch',
      view({ enabled: true, state: 'ready', env: ['enabled', 'token'], tested: true, channel: { ...ADA, key_env: true } }),
      { kind: 'paired', label: 'Paired', text: /Alerts are on/ },
    ],
  ];
  it.each(cases)('%s', (_, v, want) => {
    const book = new NotifyBook();
    book.reset(v);
    const d = telegramDestination(book.state!);
    expect(d.kind).toBe(want.kind);
    expect(d.label).toBe(want.label);
    expect(d.text).toMatch(want.text);
  });
});

interface TelegramDestinationLike {
  kind: string;
  label: string;
  text: RegExp;
}

describe('Settings → Telegram (#12)', () => {
  it('shows exactly one destination status, and keeps it current through notify.update', () => {
    const m = mount(view());
    expect(m.body.querySelectorAll('.settings-tg-dest')).toHaveLength(1);
    expect(m.badge().textContent).toBe('Not configured');
    expect(m.badge().dataset.state).toBe('off');
    expect(m.dest().dataset.dest).toBe('none');
    m.book.upsert(view({ channel: ADA }));
    expect(m.badge().textContent).toBe('Paired');
    expect(m.badge().dataset.state).toBe('ready');
    expect(m.dest().textContent).toContain('Alerts are off');
    m.book.upsert(view({ enabled: true, state: 'blocked', channel: ADA, last_error: { code: 'blocked', message: '', at: 1 } }));
    expect(m.badge().textContent).toBe('Error');
    expect(m.badge().dataset.state).toBe('invalid');
    expect(m.dest().textContent).toContain('Last message not delivered');
    // The status carries the reason: no other line about the last message (the status line only announces the change).
    const lines = [...m.body.querySelectorAll('p')].filter((p) => !p.hidden && p.textContent!.includes('Last message not delivered'));
    expect(lines.map((p) => p.className)).toEqual(['settings-tg-dest-text', 'settings-status settings-field-error']);
  });

  it('says a change it did not make in the one live region; an action’s own line stands', async () => {
    const m = mount(view({ channel: { ...TOKEN, pairing: WAITING } }), () => ({ ok: true, data: view({ channel: TOKEN }) }));
    expect(m.body.querySelectorAll('[aria-live]').length).toBe(2); // the code's expiry, and the status line
    expect(m.dest().getAttribute('aria-live')).toBeNull();
    expect(m.status().hidden).toBe(true); // opening says nothing
    m.book.upsert(view({ channel: ADA })); // the phone sent the code
    expect(m.status().hidden).toBe(false);
    expect(m.status().getAttribute('role')).toBe('status');
    expect(m.status().textContent).toBe('Paired. Alerts are off: nothing is sent to Ada.');
    // An action: its line says what happened, the status does not talk over it.
    m.button('Unpair').click();
    await m.flush();
    expect(m.badge().textContent).toBe('Not configured');
    expect(m.status().textContent).toBe('Unpaired. Nothing is sent until you pair again.');
  });

  it('the privacy note says what still talks to Telegram while it is off', () => {
    const m = mount(view());
    expect(m.body.querySelector('.settings-fu-privacy')!.textContent).toMatch(/Saving the token, Pair and Send test message still contact Telegram, even while it is off\./);
  });
});

describe('Settings → Telegram keeps the keyboard in the section (#12)', () => {
  it('token: Enter that Telegram refuses stays in the field; one it takes moves on to Pair', async () => {
    let ok = false;
    const m = mount(view(), () => (ok ? { ok: true, data: view({ channel: TOKEN }) } : { ok: false, code: 'unauthorized', message: 'no' }));
    const token = m.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    token.focus();
    token.value = '123:bad';
    token.dispatchEvent(new Event('input'));
    token.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await m.flush();
    expect(m.status().textContent).toContain('Telegram refused');
    expect(document.activeElement).toBe(token);
    ok = true;
    token.value = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    token.dispatchEvent(new Event('input'));
    token.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await m.flush();
    expect(token.value).toBe('');
    expect(document.activeElement).toBe(m.button('Pair'));
  });

  it('Save token, the button: on to Pair too', async () => {
    const m = mount(view(), () => ({ ok: true, data: view({ channel: TOKEN }) }));
    const token = m.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    token.value = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    token.dispatchEvent(new Event('input'));
    m.button('Save token').focus();
    m.button('Save token').click();
    await m.flush();
    expect(document.activeElement).toBe(m.button('Pair'));
  });

  it('Pair → Cancel pairing while the code waits; the phone pairs → Send test message', async () => {
    const m = mount(view({ channel: TOKEN }), () => ({ ok: true, data: view({ channel: { ...TOKEN, pairing: WAITING } }) }));
    m.button('Pair').focus();
    m.button('Pair').click();
    await m.flush();
    expect(document.activeElement).toBe(m.button('Cancel pairing'));
    m.book.upsert(view({ channel: ADA })); // notify.update: paired
    expect(m.button('Cancel pairing').hidden).toBe(true);
    expect(document.activeElement).toBe(m.button('Send test message'));
  });

  it('Cancel pairing → Pair, even when still paired from before', async () => {
    const m = mount(view({ channel: { ...ADA, pairing: WAITING } }), () => ({ ok: true, data: view({ channel: ADA }) }));
    m.button('Cancel pairing').focus();
    m.button('Cancel pairing').click();
    await m.flush();
    expect(document.activeElement).toBe(m.button('Pair again'));
  });

  it('Unpair → Pair; a failed Unpair stays put', async () => {
    let ok = false;
    const m = mount(view({ channel: ADA }), () => (ok ? { ok: true, data: view({ channel: TOKEN }) } : { ok: false, code: 'timeout', message: '' }));
    m.button('Unpair').focus();
    m.button('Unpair').click();
    await m.flush();
    expect(document.activeElement).toBe(m.button('Unpair'));
    ok = true;
    m.button('Unpair').click();
    await m.flush();
    expect(m.button('Unpair').hidden).toBe(true);
    expect(document.activeElement).toBe(m.button('Pair'));
  });

  it('Remove token, asked twice → the token field', async () => {
    const m = mount(view({ channel: ADA }), () => ({ ok: true, data: view() }));
    const remove = m.button('Remove token');
    remove.focus();
    remove.click();
    expect(remove.textContent).toBe('Click again to remove (unpairs too)');
    expect(document.activeElement).toBe(remove);
    remove.click();
    await m.flush();
    expect(remove.hidden).toBe(true);
    expect(m.badge().textContent).toBe('Not configured');
    expect(document.activeElement).toBe(m.body.querySelector('input[type="password"]'));
  });

  it('Send test message and the switches keep the keyboard, success or not, while disabled on the way', async () => {
    let ok = true;
    const m = mount(view({ channel: ADA }), (t) =>
      t === 'notify.test'
        ? ok
          ? { ok: true, data: { ok: true, latency_ms: 240 } }
          : { ok: false, code: 'blocked', message: '' }
        : { ok: true, data: view({ channel: ADA, events: { needs_you: true, done: false } }) },
    );
    m.rig.hold = true;
    const test = m.button('Send test message');
    test.focus();
    test.click();
    expect(test.disabled).toBe(true); // on its way
    m.release();
    await m.flush();
    expect(test.disabled).toBe(false);
    expect(document.activeElement).toBe(test);
    ok = false;
    test.click();
    m.release();
    await m.flush();
    expect(m.status().textContent).toContain('press Start');
    expect(document.activeElement).toBe(test);
    m.rig.hold = false;
    const done = m.box(/A worker finishes/);
    done.focus();
    done.click(); // unchecks, notify.set
    await m.flush();
    expect(m.sent.at(-1)).toBe('notify.set');
    expect(done.checked).toBe(false);
    expect(document.activeElement).toBe(done);
  });

  it('never pulls the keyboard back from where the user went meanwhile', async () => {
    const m = mount(view({ channel: ADA }), () => ({ ok: true, data: view({ channel: TOKEN }) }));
    const outside = document.createElement('button');
    document.body.append(outside);
    m.rig.hold = true;
    m.button('Unpair').focus();
    m.button('Unpair').click();
    outside.focus();
    m.release();
    await m.flush();
    expect(document.activeElement).toBe(outside);
  });
});
