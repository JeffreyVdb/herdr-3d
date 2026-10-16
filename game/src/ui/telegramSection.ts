import type { CommandArgs, CommandName, NotifyState, NotifyTestAck } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { botLink, botName, notifyFailureText, pairingText, type NotifyBook } from '../world/notifySettings';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the Telegram section needs: the bridge's state, the commands, and a way to open a page outside the game. */
export interface TelegramSectionHost {
  book: NotifyBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Opens the bot's chat in Telegram (the helper's browser, or a new window). */
  openLink?(url: string): void;
  now?(): number;
}

/** What leaves the machine, shown above the switch: it is what the switch agrees to. */
export const TELEGRAM_PRIVACY =
  'Each message holds the worker’s name, why it needs you or that it finished, and one line of what it did: the floor overview’s line, else the last line it wrote, with anything shaped like a key or token removed. A question marked secret is never included. Messages go through Telegram’s servers to your account only; nothing is sent while this is off. Saving the token, Pair and Send test message still contact Telegram, even while it is off.';

/** #13: what Allow replies agrees to, shown above its switch. */
export const TELEGRAM_REPLIES =
  'Reply to a notification in Telegram and the bridge types your reply into that worker, as you would in the game. Only messages from your paired account count, and only replies to a notification; everything else the bot receives does nothing. A 👍 on your reply means it was sent; otherwise the bot says why not. This is separate from the notifications switch above.';

const BOTFATHER = 'https://t.me/BotFather';
const CONFIRM_MS = 4000;
const PAIR_BADGE: Record<string, { text: string; state: string }> = {
  waiting: { text: 'Waiting for the code', state: 'incomplete' },
  conflict: { text: 'Retrying', state: 'invalid' },
  error: { text: 'Retrying', state: 'invalid' },
  expired: { text: 'Code expired', state: 'invalid' },
};

/** #12: the destination's one status, at the top of the section. */
export interface TelegramDestination {
  kind: 'none' | 'paired' | 'error';
  /** The badge: Not configured, Paired, Error. */
  label: string;
  /** Why, and what comes next. */
  text: string;
}

const DEST_BADGE: Record<TelegramDestination['kind'], string> = { none: 'off', paired: 'ready', error: 'invalid' };

/**
 * #12: the destination's status, from the bridge's state alone. The first rule that matches:
 * 1. No bot token: Not configured. A token Telegram refused is never saved, so a failed check lands here too (the
 *    command's error says why, in the section's status line).
 * 2. `last_error`: Error, with Telegram's reason. The bridge keeps it until a message gets through or the token or the
 *    account changes, whatever the switch says (a failed test sets it too); `state` `blocked` is one of these.
 * 3. A pairing that is retrying (`conflict`, `error`): Error, with why.
 * 4. No paired account, a code waiting or not: Not configured.
 * 5. Paired, and whether alerts are on (`enabled`).
 */
export function telegramDestination(s: NotifyState): TelegramDestination {
  const c = s.channel;
  if (!c.key_set) return { kind: 'none', label: 'Not configured', text: 'No bot token yet: start with step 1.' };
  const err = s.last_error;
  if (err) return { kind: 'error', label: 'Error', text: `Last message not delivered: ${notifyFailureText(err.code, err.message)}` };
  const p = c.pairing;
  if (p?.state === 'conflict' || p?.state === 'error') {
    return { kind: 'error', label: 'Error', text: p.message || (p.state === 'conflict' ? notifyFailureText('conflict', '') : 'Telegram failed while pairing: retrying.') };
  }
  if (!c.paired) {
    return { kind: 'none', label: 'Not configured', text: p?.state === 'waiting' ? 'Waiting for the pairing code from your Telegram account.' : 'The bot token is saved: pair your Telegram account in step 2.' };
  }
  const who = c.paired.name || 'your account';
  return s.enabled
    ? { kind: 'paired', label: 'Paired', text: `Alerts are on: messages go to ${who} through ${botName(c)}.` }
    : { kind: 'paired', label: 'Paired', text: `Alerts are off: nothing is sent to ${who}.` };
}

const destLine = (d: TelegramDestination): string => `${d.label}. ${d.text}`;

let serial = 0;

const timeText = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);
const dayText = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

function check(id: string, text: string): { label: HTMLLabelElement; box: HTMLInputElement } {
  const box = el('input');
  box.type = 'checkbox';
  box.id = id;
  const label = el('label', 'settings-switch');
  label.htmlFor = id;
  label.append(box, el('span', '', text));
  return { label, box };
}

/**
 * #11: the “Telegram” section of the Settings window (Integrations): the bridge messages your Telegram account when a
 * worker needs you or finishes. Three steps in order, each its own block with its state: the bot token (typed once,
 * checked by the bridge with Telegram, never shown again), the account (a one-time code you send the bot; whoever
 * sends it is paired, every other message is ignored), and a test message. Then the switch (off until a test
 * reached you with this bot and account; the bridge's environment can set it, and then it is read-only here), the
 * two events, quiet delivery and freelancers' finished work. #13: then Allow replies, a block of its own: a reply to a
 * notification is typed into its worker (off by default, needs a paired account, no test).
 */
export function telegramSection(host: TelegramSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-tg-${++serial}`;
    const now = () => host.now?.() ?? Date.now();
    const lede = el('p', 'settings-lede', 'Get a Telegram message when a worker needs you or finishes, wherever you are. The bridge sends them itself, through a bot of your own.');
    const missing = el('p', 'settings-field-hint', 'This bridge has no Telegram notifications. Update it to use this.');
    const root = el('div', 'settings-tg');

    // The destination's status (#12). Not a live region: the status line below is the section's one (see sync).
    const dest = el('div', 'settings-tg-dest');
    const destBadge = el('span', 'settings-tg-dest-badge');
    const destText = el('p', 'settings-tg-dest-text');
    dest.append(destBadge, destText);

    // 1. The bot token.
    const tokenBlock = el('div', 'settings-role settings-tg-step');
    tokenBlock.setAttribute('role', 'group');
    const tokenHead = el('div', 'settings-role-head');
    const tokenTitle = el('h4', 'settings-role-title', '1. Bot token');
    tokenTitle.id = `${id}-token-h`;
    tokenBlock.setAttribute('aria-labelledby', tokenTitle.id);
    const tokenBadge = el('span', 'settings-badge');
    tokenHead.append(tokenTitle, tokenBadge);
    const token = el('input');
    token.type = 'password';
    token.id = `${id}-token`;
    token.autocomplete = 'new-password';
    token.spellcheck = false;
    token.placeholder = '123456789:AAH…';
    token.setAttribute('data-lpignore', 'true');
    const tokenHint = el('p', 'settings-field-hint');
    tokenHint.id = `${id}-token-hint`;
    token.setAttribute('aria-describedby', tokenHint.id);
    const tokenField = el('div', 'settings-field');
    const tokenLabel = el('label', 'settings-field-label', 'Token from @BotFather');
    tokenLabel.htmlFor = token.id;
    const botFather = el('a', 'settings-link', 'Make a bot with @BotFather');
    botFather.href = BOTFATHER;
    botFather.target = '_blank';
    botFather.rel = 'noopener noreferrer';
    botFather.addEventListener('click', (e) => {
      if (!host.openLink) return;
      e.preventDefault();
      host.openLink(BOTFATHER);
    });
    tokenField.append(tokenLabel, token, tokenHint, botFather);
    const saveToken = button('Save token', 'btn btn--sm btn--primary');
    const clearToken = button('Remove token');
    const tokenActions = el('div', 'settings-fu-actions');
    tokenActions.append(saveToken, clearToken);
    tokenBlock.append(tokenHead, tokenField, tokenActions);

    // 2. The account: the pairing code.
    const pairBlock = el('div', 'settings-role settings-tg-step');
    pairBlock.setAttribute('role', 'group');
    const pairHead = el('div', 'settings-role-head');
    const pairTitle = el('h4', 'settings-role-title', '2. Your Telegram account');
    pairTitle.id = `${id}-pair-h`;
    pairBlock.setAttribute('aria-labelledby', pairTitle.id);
    const pairBadge = el('span', 'settings-badge');
    pairHead.append(pairTitle, pairBadge);
    const pairLine = el('p', 'settings-field-hint settings-tg-line');
    const codeBox = el('div', 'settings-tg-code');
    const code = el('output', 'settings-tg-code-value');
    code.setAttribute('aria-label', 'Pairing code');
    const codeHint = el('p', 'settings-field-hint settings-tg-code-hint');
    codeHint.setAttribute('aria-live', 'polite');
    const openBot = el('a', 'btn btn--sm settings-tg-open', 'Open the bot in Telegram');
    openBot.target = '_blank';
    openBot.rel = 'noopener noreferrer';
    openBot.addEventListener('click', (e) => {
      if (!host.openLink || !openBot.href) return;
      e.preventDefault();
      host.openLink(openBot.href);
    });
    codeBox.append(code, codeHint, openBot);
    const pair = button('Pair', 'btn btn--sm btn--primary');
    const cancelPair = button('Cancel pairing');
    const unpair = button('Unpair');
    const pairActions = el('div', 'settings-fu-actions');
    pairActions.append(pair, cancelPair, unpair);
    pairBlock.append(pairHead, pairLine, codeBox, pairActions);

    // 3. The test message.
    const testBlock = el('div', 'settings-role settings-tg-step');
    testBlock.setAttribute('role', 'group');
    const testHead = el('div', 'settings-role-head');
    const testTitle = el('h4', 'settings-role-title', '3. Test message');
    testTitle.id = `${id}-test-h`;
    testBlock.setAttribute('aria-labelledby', testTitle.id);
    const testBadge = el('span', 'settings-badge');
    testHead.append(testTitle, testBadge);
    const testLine = el('p', 'settings-field-hint settings-tg-line');
    const test = button('Send test message');
    const testActions = el('div', 'settings-fu-actions');
    testActions.append(test);
    testBlock.append(testHead, testLine, testActions);

    // The switch and what it sends.
    const opts = el('div', 'settings-fu settings-tg-opts');
    const privacy = el('p', 'settings-fu-privacy', TELEGRAM_PRIVACY);
    privacy.id = `${id}-privacy`;
    const on = check(`${id}-on`, 'Send Telegram notifications');
    on.box.setAttribute('aria-describedby', `${id}-privacy ${id}-on-hint`);
    const onHint = el('p', 'settings-field-hint');
    onHint.id = `${id}-on-hint`;
    const events = el('fieldset', 'settings-tg-events');
    events.append(el('legend', 'settings-field-label', 'Send a message when'));
    const needs = check(`${id}-needs`, 'A worker needs you (a question, a block, a follow-up)');
    const done = check(`${id}-done`, 'A worker finishes (after 5 seconds, if it is still done)');
    events.append(needs.label, done.label);
    const quiet = check(`${id}-quiet`, 'Quiet: deliver without a sound');
    const freelancers = check(`${id}-freelancers`, 'Also when a freelancer (coder, reviewer) finishes');
    // #13: replies, their own block: they type into workers, which the notifications switch never does.
    const replyBlock = el('div', 'settings-tg-replies');
    replyBlock.setAttribute('role', 'group');
    const replyTitle = el('h4', 'settings-role-title', 'Replies from Telegram');
    replyTitle.id = `${id}-replies-h`;
    replyBlock.setAttribute('aria-labelledby', replyTitle.id);
    const replyNote = el('p', 'settings-fu-privacy', TELEGRAM_REPLIES);
    replyNote.id = `${id}-replies-note`;
    const replies = check(`${id}-replies`, 'Allow replies');
    replies.box.setAttribute('aria-describedby', `${id}-replies-note ${id}-replies-hint`);
    const repliesHint = el('p', 'settings-field-hint');
    repliesHint.id = `${id}-replies-hint`;
    replyBlock.append(replyTitle, replyNote, replies.label, repliesHint);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    opts.append(privacy, on.label, onHint, events, quiet.label, freelancers.label, replyBlock, status);

    root.append(dest, tokenBlock, pairBlock, testBlock, opts);
    body.append(lede, missing, root);

    let busy = false;
    /** An action of this section is under way, from its click to where the keyboard lands after it. */
    let acting = false;
    /** What the destination's status said last (null: not shown yet). */
    let destSaid: string | null = null;
    let note: { text: string; error: boolean } | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    /** A switch's position while its notify.set is on its way (null: the bridge's). */
    const wanted = new Map<HTMLInputElement, boolean>();

    const st = (): NotifyState | null => host.book.state;
    const envHas = (f: string) => st()?.env.includes(f) ?? false;

    const say = (text: string, error = false) => {
      note = text ? { text, error } : null;
      sync();
    };

    function badge(b: HTMLElement, text: string, state: string): void {
      b.textContent = text;
      b.dataset.state = state;
    }

    const usable = (e: Element | null): e is HTMLElement =>
      e instanceof HTMLElement && e.isConnected && !(e as HTMLButtonElement).disabled && !e.closest('[hidden]');

    /**
     * #12: where the keyboard goes once an action is done. Its control is disabled while the command is on its way
     * (the browser drops the focus then), and some go away after it (Pair while a code waits, Unpair, Remove token):
     * so `next`, else the control used, else the section's first control. Only while the focus is still on that
     * control or nowhere (the page's body): never pulled from where the user went meanwhile.
     */
    function land(from: Element | null, next: HTMLElement | null): void {
      if (!from) return;
      const a = document.activeElement;
      if (a && a !== from && a !== document.body) return;
      const to = [next, from].find(usable) ?? [...root.querySelectorAll('input, button, a[href]')].find(usable);
      to?.focus();
    }

    /** The control with the keyboard, when it is in this section. */
    const focused = (): Element | null => (root.contains(document.activeElement) ? document.activeElement : null);

    function sync(): void {
      const f = focused();
      const s = st();
      missing.hidden = host.book.known;
      root.hidden = !s;
      if (!s) return;
      const c = s.channel;
      const pairing = c.pairing && c.pairing.state !== 'expired' ? c.pairing : null;

      // The destination. A change no action here made (the phone sent the code, a message bounced) is said in the
      // status line, the section's one live region: an action's own line already says what it changed, and one that
      // comes while an action is on its way is said after that line (see finish).
      const d = telegramDestination(s);
      badge(destBadge, d.label, DEST_BADGE[d.kind]);
      dest.dataset.dest = d.kind;
      destText.textContent = d.text;
      if (!acting) {
        const said = destLine(d);
        if (destSaid !== null && said !== destSaid) note = { text: said, error: d.kind === 'error' };
        destSaid = said;
      }

      // 1. Token.
      badge(tokenBadge, c.key_set ? (c.key_env ? 'Set by the bridge' : 'Saved') : 'Not set', c.key_set ? 'ready' : 'off');
      token.disabled = busy || !!c.key_env;
      saveToken.disabled = busy || !!c.key_env || !token.value.trim();
      clearToken.hidden = !c.key_set || !!c.key_env;
      clearToken.disabled = busy;
      tokenHint.textContent = c.key_env
        ? `The bridge environment gives the token (HERDR_WORLD_TELEGRAM_KEY_FILE)${c.bot ? ` for ${botName(c)}` : ''}.`
        : c.key_set
          ? `Saved on the bridge${c.key_hint ? `, ending ${c.key_hint}` : ''}${c.bot ? `, for ${botName(c)}` : ''}. Paste another to replace it.`
          : 'In Telegram, send /newbot to @BotFather, pick a name, and paste the token it gives you. The bridge checks it with Telegram and keeps it; it is never shown again.';
      botFather.hidden = c.key_set;

      // 2. Account.
      if (pairing) badge(pairBadge, PAIR_BADGE[pairing.state]!.text, PAIR_BADGE[pairing.state]!.state);
      else if (c.paired) badge(pairBadge, 'Paired', 'ready');
      else if (c.pairing?.state === 'expired') badge(pairBadge, PAIR_BADGE.expired!.text, PAIR_BADGE.expired!.state);
      else badge(pairBadge, 'Not paired', 'off');
      codeBox.hidden = !pairing?.code;
      code.textContent = pairing?.code ?? '';
      codeHint.textContent = pairingText(c, now());
      const link = botLink(c);
      openBot.hidden = !link;
      if (link) openBot.href = link;
      else openBot.removeAttribute('href');
      pairLine.textContent = !c.key_set
        ? 'Save the bot token first.'
        : pairing
          ? 'Only the account that sends this code is paired; anything else the bot receives is ignored.'
          : c.pairing?.state === 'expired'
            ? pairingText(c, now())
            : c.paired
              ? `Paired with ${c.paired.name || 'your account'}${c.paired.at ? ` on ${dayText(c.paired.at)}` : ''}. Pair again to move the messages to another account.`
              : `Pair shows a one-time code; send it to ${botName(c)} from your Telegram account. It is good for 10 minutes.`;
      pair.textContent = c.paired ? 'Pair again' : 'Pair';
      pair.hidden = !!pairing;
      pair.disabled = busy || !c.key_set;
      cancelPair.hidden = !pairing;
      cancelPair.disabled = busy;
      unpair.hidden = !c.paired || !!pairing;
      unpair.disabled = busy;

      // 3. Test.
      const ready = c.key_set && !!c.paired;
      badge(testBadge, s.tested ? 'Delivered' : 'Not sent', s.tested ? 'ready' : 'off');
      testLine.textContent = !ready
        ? 'Pair your account first.'
        : s.tested
          ? 'The test reached you: notifications can be switched on.'
          : `Sends one message to ${c.paired?.name || 'your account'} now, so you know it arrives.`;
      test.disabled = busy || !ready;

      // The switch.
      const locked = envHas('enabled');
      on.box.checked = wanted.get(on.box) ?? s.enabled;
      on.box.disabled = busy || locked || (!s.enabled && (!ready || !s.tested));
      onHint.textContent = locked
        ? `Set by the bridge environment (HERDR_WORLD_NOTIFY_ENABLED).${s.enabled && s.state === 'incomplete' ? ' Paused until a token and an account are set up.' : ''}`
        : s.enabled
          ? s.state === 'incomplete'
            ? 'On, but paused: no token or no paired account. Nothing is sent.'
            : s.state === 'blocked'
              ? 'On, but Telegram refused the last message: see the status at the top.'
              : 'On: the bridge messages you when a worker needs you or finishes.'
          : !ready
            ? 'Set up the bot and pair your account first.'
            : s.tested
              ? 'The test reached you: you can switch it on.'
              : 'Send the test message first: it has to reach you.';
      // #13: replies. Switching them on needs a paired account (no test); on, they pause while there is none.
      replies.box.checked = wanted.get(replies.box) ?? s.replies;
      replies.box.disabled = busy || (!s.replies && !ready);
      repliesHint.textContent = s.replies
        ? ready
          ? `On: a reply to a notification from ${c.paired?.name || 'your account'} is typed into its worker.`
          : 'On, but paused: no paired account. Nothing reaches a worker.'
        : !ready
          ? 'Pair your account first.'
          : 'Off: nothing you send the bot reaches a worker.';
      for (const [box, v] of [
        [needs.box, s.events.needs_you],
        [done.box, s.events.done],
        [quiet.box, s.quiet],
        [freelancers.box, s.freelancers],
      ] as const) {
        box.checked = wanted.get(box) ?? v;
        box.disabled = busy;
      }
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
      // The code's expiry counts down while it shows.
      if (pairing && tick === null) tick = setInterval(sync, 15_000);
      if (!pairing && tick !== null) {
        clearInterval(tick);
        tick = null;
      }
      // The keyboard was on something the bridge's news took away (the phone paired while it was on Cancel pairing or
      // the bot's link; the account went elsewhere): on to what comes next.
      if (!acting && f && !usable(f)) {
        const next = f === cancelPair || f === openBot ? (c.paired ? test : pair) : f === unpair || f === test ? pair : f === clearToken ? token : null;
        land(f, next);
      }
    }

    /**
     * Says how an action went, and then the destination when it changed since it was last said: the action's or not
     * (another window switched alerts off during a test, a worker's message bounced), one message in the one live
     * region. Which change was the action's is not guessed: a missed change costs more than a repeated one.
     */
    function finish(text: string, error: boolean): void {
      const s = st();
      if (s) {
        const d = telegramDestination(s);
        const said = destLine(d);
        if (destSaid !== null && said !== destSaid && !text.includes(d.text)) {
          text = `${text} ${said}`;
          error ||= d.kind === 'error';
        }
        destSaid = said;
      }
      say(text, error);
    }

    async function run(work: () => Promise<CommandResult>): Promise<CommandResult> {
      busy = true;
      sync();
      try {
        return await work();
      } finally {
        busy = false;
      }
    }

    /**
     * Sends a command whose ack is the new state, says how it went, and puts the keyboard on `next(ok)` (else back
     * on the control used: see land).
     */
    async function act<T extends CommandName>(
      t: T,
      args: CommandArgs[T],
      pending: string,
      ok: string,
      next?: (ok: boolean) => HTMLElement | null,
    ): Promise<boolean> {
      const from = focused();
      acting = true;
      try {
        note = { text: pending, error: false };
        const r = await run(() => host.send(t, args));
        if (!r.ok) {
          finish(notifyFailureText(r.code, r.message), true);
        } else {
          host.book.upsert(r.data); // the ack is the state: show it even before notify.update
          finish(ok, false);
        }
        land(from, next?.(r.ok) ?? null);
        return r.ok;
      } finally {
        acting = false;
      }
    }

    async function runSaveToken(): Promise<void> {
      const v = token.value.trim();
      if (saveToken.disabled || !v) return;
      // Accepted: on to the next step's Pair, whether it was Enter in the field or the button.
      if (await act('notify.token.set', { key: v }, 'Checking the token with Telegram…', 'Token saved. Now pair your account.', (ok) => (ok ? pair : null))) token.value = '';
      sync();
    }

    function disarm(): void {
      if (clearTimer !== null) clearTimeout(clearTimer);
      clearTimer = null;
      clearToken.textContent = 'Remove token';
    }

    /** Removing the token asks twice: it unpairs too. */
    function runClearToken(): void {
      if (clearTimer === null) {
        clearToken.textContent = 'Click again to remove (unpairs too)';
        clearTimer = setTimeout(() => {
          disarm();
          sync();
        }, CONFIRM_MS);
        return;
      }
      disarm();
      void act('notify.token.clear', {}, 'Removing…', 'Token removed and account unpaired. Nothing is sent.', (ok) => (ok ? token : null));
    }

    function set(box: HTMLInputElement, args: CommandArgs['notify.set'], ok: string): void {
      wanted.set(box, box.checked);
      void act('notify.set', args, 'Saving…', ok).then(() => {
        wanted.delete(box);
        sync();
      });
    }

    token.addEventListener('input', () => {
      note = null;
      sync();
    });
    token.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void runSaveToken();
    });
    saveToken.addEventListener('click', () => void runSaveToken());
    clearToken.addEventListener('click', runClearToken);
    pair.addEventListener('click', () => void act('notify.pair.start', {}, 'Asking Telegram for the bot…', 'Send the code to the bot from your phone.', (ok) => (ok ? cancelPair : null)));
    cancelPair.addEventListener('click', () => void act('notify.pair.cancel', {}, 'Cancelling…', 'Pairing cancelled.', (ok) => (ok ? pair : null)));
    unpair.addEventListener('click', () => void act('notify.unpair', {}, 'Unpairing…', 'Unpaired. Nothing is sent until you pair again.', (ok) => (ok ? pair : null)));
    test.addEventListener('click', () => {
      const from = focused();
      acting = true;
      note = { text: 'Sending the test message…', error: false };
      void run(() => host.send('notify.test', {}))
        .then((r) => {
          if (!r.ok) return finish(notifyFailureText(r.code, r.message), true);
          const d = r.data as Partial<NotifyTestAck>;
          finish(`Test message delivered in ${timeText(typeof d.latency_ms === 'number' ? d.latency_ms : 0)}. Check your phone, then switch notifications on.`, false);
        })
        .finally(() => {
          land(from, test);
          acting = false;
        });
    });
    on.box.addEventListener('change', () => set(on.box, { enabled: on.box.checked }, on.box.checked ? 'On. You will get a message when a worker needs you or finishes.' : 'Off. Nothing is sent.'));
    needs.box.addEventListener('change', () => set(needs.box, { events: { needs_you: needs.box.checked } }, 'Saved.'));
    done.box.addEventListener('change', () => set(done.box, { events: { done: done.box.checked } }, 'Saved.'));
    quiet.box.addEventListener('change', () => set(quiet.box, { quiet: quiet.box.checked }, quiet.box.checked ? 'Saved: messages arrive without a sound.' : 'Saved: messages arrive with a sound.'));
    freelancers.box.addEventListener('change', () => set(freelancers.box, { freelancers: freelancers.box.checked }, 'Saved.'));
    replies.box.addEventListener('change', () =>
      set(
        replies.box,
        { replies: replies.box.checked },
        replies.box.checked ? 'Replies on. Reply to a notification in Telegram to type into its worker.' : 'Replies off. Nothing you send the bot reaches a worker.',
      ),
    );

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        token.value = '';
        disarm();
        sync();
      },
      dispose() {
        off();
        disarm();
        if (tick !== null) clearInterval(tick);
      },
    };
  };
}
