import type { CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { codexServerFailureText, type CodexServerBook } from '../world/codexServer';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Codex workers” section needs: the bridge's switch and the commands. */
export interface CodexServerSectionHost {
  book: CodexServerBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
}

let serial = 0;

/**
 * #155: the shared Codex server switch in the Settings window. Off by default. On, a Codex worker hired from then on
 * runs its usual terminal against a Codex server of its own, started from its pane, which herdr-world can join too;
 * workers already at their desks keep the way they were started. A bridge without the switch has no section; one
 * that cannot start such servers shows it, switched off and disabled, with why.
 */
export function codexServerSection(host: CodexServerSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-cx-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'A Codex worker can run its usual terminal against a Codex server of its own, so herdr-world can follow the same conversation beside you. It never answers for you: approvals stay in the terminal.',
    );
    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    const hint = el('p', 'settings-field-hint');
    hint.id = `${id}-hint`;
    box.setAttribute('aria-describedby', hint.id);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Give new Codex workers their own Codex server'));
    const riskBox = el('input');
    riskBox.type = 'checkbox';
    riskBox.id = `${id}-unverified`;
    const riskToggle = el('label', 'settings-switch');
    riskToggle.htmlFor = riskBox.id;
    riskToggle.append(riskBox, el('span', '', 'Allow unverified Codex versions'));
    const riskHint = el(
      'p',
      'settings-field-hint',
      'Keep using the terminal’s own server after Codex upgrades. I accept that transcript updates or question replies may stop working on an untested version. Saved for future upgrades; applies to new servers and reconnects.',
    );
    riskHint.id = `${id}-unverified-hint`;
    riskBox.setAttribute('aria-describedby', riskHint.id);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    // The shared look of a feature's switch: its hint under its words, a disabled switch dimmed.
    const controls = el('div', 'settings-act');
    controls.append(toggle, hint, riskToggle, riskHint, status);
    body.append(lede, controls);

    let busy = false;
    let wanted: CommandArgs['codex_server.set'] | null = null;
    let note: { text: string; error: boolean } | null = null;

    function sync(): void {
      const s = host.book.state;
      section.setHidden(!s);
      if (!s) return;
      box.checked = wanted?.enabled ?? s.enabled;
      riskBox.checked = wanted?.allow_unverified ?? s.allow_unverified ?? false;
      riskToggle.hidden = riskHint.hidden = s.allow_unverified === undefined;
      riskBox.disabled = busy || !s.available;
      box.disabled = busy || (!s.available && !s.enabled);
      hint.textContent = s.available
        ? 'Applies to Codex workers hired from now on. Workers already at their desks keep the way they were started.'
        : 'This bridge has no place for the servers’ sockets (its --codex-run directory is off), so it can’t start them.';
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
    }

    function save(control: HTMLInputElement, args: CommandArgs['codex_server.set'], success: string): void {
      const focused = document.activeElement === control;
      wanted = args;
      busy = true;
      note = { text: 'Saving…', error: false };
      sync();
      void host.send('codex_server.set', args).then((r) => {
        busy = false;
        wanted = null;
        if (r.ok) host.book.upsert(r.data);
        note = r.ok ? { text: success, error: false } : { text: codexServerFailureText(r.code, r.message), error: true };
        sync();
        const now = document.activeElement;
        if (focused && control.isConnected && !control.disabled && (!now || now === document.body)) control.focus({ preventScroll: true });
      });
    }

    box.addEventListener('change', () => {
      save(box, { enabled: box.checked }, box.checked
        ? 'On. The next Codex hire gets its own server.'
        : 'Off. New Codex workers use the server built into their terminal.');
    });
    riskBox.addEventListener('change', () => {
      save(riskBox, { allow_unverified: riskBox.checked }, riskBox.checked
        ? 'Saved. Unverified Codex versions are allowed, including future upgrades.'
        : 'Saved. New servers and reconnects require a verified Codex version.');
    });

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        sync();
      },
      dispose: off,
    };
  };
}
