// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { NotifyBook, notifyFailureText } from '../world/notifySettings';
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
    replies: false,
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
  const args: unknown[] = [];
  let pending: Array<() => void> = [];
  const rig = { hold: false };
  const body = document.createElement('div');
  document.body.append(body);
  const handle = telegramSection({
    book,
    send: (t, a) => {
      sent.push(t);
      args.push(a);
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
  return { book, body, sent, args, rig, button, box, dest, badge, status, flush, release, handle };
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

  it('says a change it did not make in the one live region; after an action, its line then the destination', async () => {
    const m = mount(view({ channel: { ...TOKEN, pairing: WAITING } }), () => ({ ok: true, data: view({ channel: TOKEN }) }));
    expect(m.body.querySelectorAll('[aria-live]').length).toBe(2); // the code's expiry, and the status line
    expect(m.dest().getAttribute('aria-live')).toBeNull();
    expect(m.status().hidden).toBe(true); // opening says nothing
    m.book.upsert(view({ channel: ADA })); // the phone sent the code
    expect(m.status().hidden).toBe(false);
    expect(m.status().getAttribute('role')).toBe('status');
    expect(m.status().textContent).toBe('Paired. Alerts are off: nothing is sent to Ada.');
    // An action: its line says what happened, then where the destination is now, in one message.
    m.button('Unpair').click();
    await m.flush();
    expect(m.badge().textContent).toBe('Not configured');
    expect(m.status().textContent).toBe('Unpaired. Nothing is sent until you pair again. Not configured. The bot token is saved: pair your Telegram account in step 2.');
  });

  it('a change it did not make while an action is on its way is said after the action’s line', async () => {
    const PAIRED_ON = { enabled: true, state: 'ready', tested: true, channel: ADA };
    // Send test message: another window switches alerts off before Telegram answers.
    const m = mount(view(PAIRED_ON), (t) =>
      t === 'notify.test'
        ? { ok: true, data: { ok: true, latency_ms: 240 } }
        : { ok: true, data: view({ ...PAIRED_ON, enabled: false, channel: { ...ADA, pairing: WAITING } }) },
    );
    m.rig.hold = true;
    const test = m.button('Send test message');
    test.focus();
    test.click();
    m.book.upsert(view({ ...PAIRED_ON, enabled: false }));
    expect(m.dest().textContent).toContain('Alerts are off');
    m.release();
    await m.flush();
    expect(m.status().textContent).toBe('Test message delivered in 240 ms. Check your phone, then switch notifications on. Paired. Alerts are off: nothing is sent to Ada.');
    expect(document.activeElement).toBe(test);
    // Later news that changes nothing says nothing more.
    m.book.upsert(view({ ...PAIRED_ON, enabled: false }));
    expect(m.status().textContent).toContain('Test message delivered');

    // Pair again: its ack already holds the other window's change; still said, it is not Pair's.
    m.book.upsert(view(PAIRED_ON));
    m.button('Pair again').focus();
    m.button('Pair again').click();
    m.book.upsert(view({ ...PAIRED_ON, enabled: false }));
    m.release();
    await m.flush();
    expect(m.status().textContent).toBe('Send the code to the bot from your phone. Paired. Alerts are off: nothing is sent to Ada.');
    expect(document.activeElement).toBe(m.button('Cancel pairing'));
  });

  it('the action’s own change, published before its ack: its line, then the destination once, in one message', async () => {
    const PAIRED_ON = { enabled: true, state: 'ready', tested: true, channel: ADA };
    const OFF = 'Paired. Alerts are off: nothing is sent to Ada.';
    const m = mount(view(PAIRED_ON), () => ({ ok: true, data: view({ ...PAIRED_ON, enabled: false }) }));
    const said: string[] = [];
    new MutationObserver(() => {
      const t = m.status().textContent!;
      if (t !== said.at(-1)) said.push(t); // sync rewrites the same text: not a new message
    }).observe(m.status(), { childList: true, characterData: true, subtree: true });
    m.rig.hold = true;
    const on = m.box(/Send Telegram notifications/);
    on.focus();
    on.click(); // off
    m.book.upsert(view({ ...PAIRED_ON, enabled: false })); // its notify.update: shown, not said
    expect(m.dest().textContent).toContain('Alerts are off');
    expect(m.status().textContent).toBe('Saving…');
    m.release();
    await m.flush();
    await m.flush();
    expect(m.status().textContent).toBe(`Off. Nothing is sent. ${OFF}`);
    // One message: the region went from the pending line to the whole of it, never the destination alone.
    expect(said.filter((t) => t !== 'Saving…')).toEqual([`Off. Nothing is sent. ${OFF}`]);
    // Said, it is not said again.
    m.book.upsert(view({ ...PAIRED_ON, enabled: false }));
    expect(m.status().textContent).toBe(`Off. Nothing is sent. ${OFF}`);
    // A test that fails sets the error itself: its line says why, the destination's Error follows.
    const m2 = mount(view(PAIRED_ON), () => ({ ok: false, code: 'blocked', message: '' }));
    m2.rig.hold = true;
    m2.button('Send test message').click();
    m2.book.upsert(view({ ...PAIRED_ON, state: 'blocked', last_error: { code: 'blocked', message: '', at: 1 } }));
    m2.release();
    await m2.flush();
    expect(m2.status().textContent).toBe(`${notifyFailureText('blocked', '')} Error. Last message not delivered: ${notifyFailureText('blocked', '')}`);
    expect(m2.status().textContent!.split('Last message not delivered')).toHaveLength(2);
  });

  it('the privacy note says what still talks to Telegram while it is off', () => {
    const m = mount(view());
    expect(m.body.querySelector('.settings-fu-privacy')!.textContent).toMatch(/Saving the token, Pair, Send test message and Allow replies \(below\) still contact Telegram, even while it is off\./);
  });
});

describe('Settings → Telegram says a change made elsewhere during an action (#12, review R1)', () => {
  const PAIRED_ON = { enabled: true, state: 'ready', tested: true, channel: ADA };

  it('an external switch change while a test is on its way', async () => {
    const m = mount(view(PAIRED_ON), () => ({ ok: true, data: { ok: true, latency_ms: 240 } }));
    m.rig.hold = true;
    const test = m.button('Send test message');
    test.focus();
    test.click();
    m.book.upsert(view({ ...PAIRED_ON, enabled: false }));
    expect(m.dest().textContent).toContain('Alerts are off');
    m.release();
    await m.flush();
    expect(m.status().textContent).toContain('Alerts are off');
  });

  it('an external switch change during an event-only save, its ack holding it too', async () => {
    const updated = view({ ...PAIRED_ON, enabled: false, state: 'off', events: { needs_you: true, done: false } });
    const m = mount(view(PAIRED_ON), () => ({ ok: true, data: updated }));
    m.rig.hold = true;
    const done = m.box(/A worker finishes/);
    done.focus();
    done.click();
    m.book.upsert(updated);
    m.release();
    await m.flush();
    expect(document.activeElement).toBe(done);
    expect(m.dest().textContent).toContain('Alerts are off');
    expect(m.status().textContent).toBe('Saved. Paired. Alerts are off: nothing is sent to Ada.');
  });

  it('a worker’s delivery failure after the test’s success, before its ack', async () => {
    const m = mount(view(PAIRED_ON), () => ({ ok: true, data: { ok: true, latency_ms: 240 } }));
    m.rig.hold = true;
    const test = m.button('Send test message');
    test.focus();
    test.click();
    m.book.upsert(view(PAIRED_ON)); // the test's own success
    m.book.upsert(view({ ...PAIRED_ON, state: 'blocked', last_error: { code: 'blocked', message: '', at: 1 } })); // a worker's message bounced
    m.release();
    await m.flush();
    expect(document.activeElement).toBe(test);
    expect(m.dest().textContent).toContain('Last message not delivered');
    expect(m.status().textContent).toBe(
      `Test message delivered in 240 ms. Check your phone, then switch notifications on. Error. Last message not delivered: ${notifyFailureText('blocked', '')}`,
    );
    expect(m.status().classList.contains('settings-field-error')).toBe(true);
  });

  it('an action that fails while an external change lands', async () => {
    const m = mount(view(PAIRED_ON), () => ({ ok: false, code: 'timeout', message: '' }));
    m.rig.hold = true;
    const needs = m.box(/A worker needs you/);
    needs.focus();
    needs.click();
    m.book.upsert(view({ ...PAIRED_ON, enabled: false, state: 'off' }));
    m.release();
    await m.flush();
    expect(document.activeElement).toBe(needs);
    expect(needs.checked).toBe(true); // the bridge's
    expect(m.status().textContent).toBe(`${notifyFailureText('timeout', '')} Paired. Alerts are off: nothing is sent to Ada.`);
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

describe('Settings → Telegram: Allow replies (#13)', () => {
  const hint = (body: HTMLElement) => body.querySelector<HTMLElement>('.settings-tg-replies .settings-field-hint')!.textContent;

  it('is off by default, its own block apart from the notifications switch, and waits for a paired account', () => {
    const m = mount(view({ channel: TOKEN }));
    const box = m.box(/^Allow replies$/);
    const block = m.body.querySelector<HTMLElement>('.settings-tg-replies')!;
    expect(block.getAttribute('role')).toBe('group');
    expect(block.contains(m.box(/Send Telegram notifications/))).toBe(false);
    expect(block.textContent).toContain('Only messages from your paired account count');
    expect(block.textContent).toContain('types your reply into that worker');
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(hint(m.body)).toBe('Pair your account first.');
    // Described by what it agrees to and its state.
    const ids = box.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((i) => document.getElementById(i)?.textContent ?? '')).toEqual([expect.stringContaining('paired account'), 'Pair your account first.']);
  });

  it('paired: switched on and off with notify.set {replies}, its state said, the keyboard kept on it', async () => {
    let replies = false;
    const m = mount(view({ channel: ADA }), (t) => (t === 'notify.set' ? { ok: true, data: view({ channel: ADA, replies }) } : { ok: true, data: null }));
    const box = m.box(/^Allow replies$/);
    expect(box.disabled).toBe(false);
    expect(hint(m.body)).toBe('Off: nothing you send the bot reaches a worker.');
    box.focus();
    replies = true;
    box.click();
    await m.flush();
    expect(m.sent.at(-1)).toBe('notify.set');
    expect(m.args.at(-1)).toEqual({ replies: true });
    expect(box.checked).toBe(true);
    expect(m.status().textContent).toContain('Replies on.');
    expect(hint(m.body)).toBe("On: your reply to a worker's notification is typed into that worker.");
    expect(document.activeElement).toBe(box);
    replies = false;
    box.click();
    await m.flush();
    expect(m.args.at(-1)).toEqual({ replies: false });
    expect(m.status().textContent).toContain('Replies off.');
    // The notifications switch is untouched by it.
    expect(m.args.some((a) => typeof a === 'object' && a !== null && 'enabled' in a)).toBe(false);
  });

  it('on while unpaired: paused, and can still be switched off', () => {
    const m = mount(view({ replies: true, channel: TOKEN }));
    const box = m.box(/^Allow replies$/);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(hint(m.body)).toBe('On, but paused: no paired account. Nothing reaches a worker.');
  });

  it('a refusal says why and puts the switch back', async () => {
    const m = mount(view({ channel: ADA }), (t) => (t === 'notify.set' ? { ok: false, code: 'not_paired', message: 'pair your Telegram account first' } : { ok: true, data: null }));
    const box = m.box(/^Allow replies$/);
    box.click();
    await m.flush();
    await m.flush();
    expect(m.status().textContent).toBe(notifyFailureText('not_paired', ''));
    expect(box.checked).toBe(false);
  });
});
