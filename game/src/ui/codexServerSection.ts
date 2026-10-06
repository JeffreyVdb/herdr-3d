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
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    // The shared look of a feature's switch: its hint under its words, a disabled switch dimmed.
    const controls = el('div', 'settings-act');
    controls.append(toggle, hint, status);
    body.append(lede, controls);

    let busy = false;
    let wanted: boolean | null = null;
    let note: { text: string; error: boolean } | null = null;

    function sync(): void {
      const s = host.book.state;
      section.setHidden(!s);
      if (!s) return;
      box.checked = wanted ?? s.enabled;
      box.disabled = busy || (!s.available && !s.enabled);
      hint.textContent = s.available
        ? 'Applies to Codex workers hired from now on. Workers already at their desks keep the way they were started.'
        : 'This bridge has no place for the servers’ sockets (its --codex-run directory is off), so it can’t start them.';
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
    }

    box.addEventListener('change', () => {
      const on = box.checked;
      // Disabled while it is sent, the switch loses the focus: it gets it back after, unless it went elsewhere.
      const focused = document.activeElement === box;
      wanted = on;
      busy = true;
      note = { text: on ? 'Switching on…' : 'Switching off…', error: false };
      sync();
      void host.send('codex_server.set', { enabled: on }).then((r) => {
        busy = false;
        wanted = null;
        if (r.ok) host.book.upsert(r.data);
        note = r.ok
          ? { text: on ? 'On. The next Codex hire gets its own server.' : 'Off. New Codex workers use the server built into their terminal.', error: false }
          : { text: codexServerFailureText(r.code, r.message), error: true };
        sync();
        const now = document.activeElement;
        if (focused && box.isConnected && !box.disabled && (!now || now === document.body)) box.focus({ preventScroll: true });
      });
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
