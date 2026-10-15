import { h } from './dom';

/**
 * #57: "<name> is offline. Switch anyway?" before switching to a bridge that is not up: the game would reload onto a
 * world it cannot reach, and the switch back is another reload. The Buildings panel's confirmation sheet (`dialog.confirm`):
 * Cancel has the keyboard, Esc cancels, the backdrop does nothing. Resolves true for Switch anyway.
 */
export function confirmSwitch(parent: HTMLElement, name: string): Promise<boolean> {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = h('dialog', { class: 'confirm confirm--bridge', 'aria-labelledby': 'bridge-confirm-title', 'aria-describedby': 'bridge-confirm-body' });
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const end = (ok: boolean) => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (!ok && back?.isConnected) back.focus();
      resolve(ok);
    };
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => end(false) }, 'Cancel');
    const ok = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => end(true) }, 'Switch anyway');
    dialog.append(
      h(
        'div',
        { class: 'sheet-body' },
        h('h2', { id: 'bridge-confirm-title' }, `${name} is offline. Switch anyway?`),
        h('p', { id: 'bridge-confirm-body' }, 'The game reloads on its world and keeps trying to reach it. Your drafts and seats for this bridge stay here for when you switch back.'),
        h('div', { class: 'sheet-actions' }, cancel, ok),
      ),
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      end(false);
    });
    // What is pressed here is the dialog's: the game and the palette under it must not see it.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    parent.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
