import type { CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { promptSecretsFailureText, type PromptSecretsBook } from '../world/promptSecrets';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the "Prompt secrets" section needs: the bridge's switch and the command. */
export interface PromptSecretsSectionHost {
  book: PromptSecretsBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
}

/** What it cannot do, said where it is switched on (docs/decisions.md, #108 row 15). */
export const SECRETS_LIMIT =
  'It protects the prompt, not what comes after: the agent can still read a protected file and print it in its conversation, and a value the scan misses is sent as typed unless you mark it in the review.';

let serial = 0;

/**
 * #108: the shared "Review prompt secrets before sending" switch in the Settings window. Off by default: prompts go as
 * typed. On: a prompt is scanned on the bridge host on Send, and anything found opens the review of the whole prompt
 * (`secretsReview.ts`) before it goes. Kept on the bridge, so every client sees the same; a bridge without it has no
 * section; one without a private runtime directory for the files says so (a review that protects anything is refused).
 */
export function promptSecretsSection(host: PromptSecretsSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-ps-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'On Send, the bridge looks for passwords, tokens and keys in the prompt. Anything it finds opens your whole prompt for review: each value you protect goes to a private file on the bridge host, and the prompt says where instead. Nothing is sent before you confirm.',
    );
    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Review prompt secrets before sending'));
    const hint = el('p', 'settings-field-hint', 'Off: prompts are sent as typed, nothing is scanned.');
    hint.id = `${id}-hint`;
    const away = el('p', 'settings-field-hint settings-ps-away', 'This bridge host has no private runtime directory for the files: a prompt that protects anything is refused (nothing is sent) until it has one.');
    away.id = `${id}-away`;
    box.setAttribute('aria-describedby', `${hint.id} ${away.id}`);
    const limit = el('p', 'settings-act-privacy', SECRETS_LIMIT);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const controls = el('div', 'settings-act');
    controls.append(limit, toggle, hint, away, status);
    body.append(lede, controls);

    let busy = false;
    let wanted: boolean | null = null;
    let note: { text: string; error: boolean } | null = null;

    function sync(): void {
      const s = host.book.state;
      section.setHidden(!s);
      if (!s) return;
      const on = wanted ?? s.enabled;
      box.checked = on;
      box.disabled = busy;
      hint.textContent = on ? 'On: every prompt you send a worker is scanned first; a review opens when it holds a possible secret.' : 'Off: prompts are sent as typed, nothing is scanned.';
      away.hidden = s.available;
      // Off, it is only a fact about the bridge host; on, it refuses every prompt that protects anything.
      away.classList.toggle('settings-field-error', on);
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
      void host.send('prompt_secrets.set', { enabled: on }).then((r) => {
        busy = false;
        wanted = null;
        if (r.ok) host.book.upsert(r.data);
        note = r.ok ? { text: on ? 'On. Prompts are reviewed for secrets before they go.' : 'Off. Prompts are sent as typed.', error: false } : { text: promptSecretsFailureText(r.code, r.message), error: true };
        sync();
        const now = document.activeElement;
        if (focused && box.isConnected && !box.disabled && (!now || now === document.body)) box.focus({ preventScroll: true });
      });
    });

    // Another client changed it: what this one last said of its own change no longer holds.
    const off = host.book.onChange(() => {
      if (!busy) note = null;
      sync();
    });
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
