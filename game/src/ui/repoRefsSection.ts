import type { CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { repoRefsFailureText, type RepoRefsBook } from '../world/repoRefs';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Repositories” section needs: the bridge's switch and the commands. */
export interface RepoRefsSectionHost {
  book: RepoRefsBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
}

let serial = 0;

/**
 * #247: the shared “Repositories from other buildings” switch in the Settings window. Off by default: a conversation's
 * `@r:` lists the repositories and folders of the other floors of the worker's building. On: every building's
 * floors, after its own. Kept on the bridge, so every client sees the same. A bridge without it has no section.
 */
export function repoRefsSection(host: RepoRefsSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-rr-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'In a conversation, type @r: to put in the folder or GitHub address of a repository set up on another floor of the same building.',
    );
    const box = el('input');
    box.type = 'checkbox';
    box.id = `${id}-on`;
    const hint = el('p', 'settings-field-hint', 'Their floors come after the ones in the worker’s own building.');
    hint.id = `${id}-hint`;
    box.setAttribute('aria-describedby', hint.id);
    const toggle = el('label', 'settings-switch');
    toggle.htmlFor = box.id;
    toggle.append(box, el('span', '', 'Repositories from other buildings'));
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
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
      box.checked = wanted ?? s.all_buildings;
      box.disabled = busy;
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
      void host.send('repo_refs.set', { all_buildings: on }).then((r) => {
        busy = false;
        wanted = null;
        if (r.ok) host.book.upsert(r.data);
        note = r.ok
          ? { text: on ? 'On. @r: lists every building’s floors.' : 'Off. @r: lists the floors of the worker’s own building.', error: false }
          : { text: repoRefsFailureText(r.code, r.message), error: true };
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
