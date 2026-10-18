import './secretChips.css';
import { secretRefs } from '../world/secretRefs';
import { h, icon, ICON } from './dom';

/**
 * #108 round 4: masked inline file chips. Where the game shows a text the bridge sent back with its references to
 * protected files (`[secret in file <path>]`: a sent prompt in the transcript, the pending row once the bridge said
 * what it sent, a stored handoff instruction, pack up's prompt), each exact reference reads as a chip: the review's
 * "Protected" tape where the value stood, saying a protected file is there. The path is there on demand (its tooltip,
 * and a press: the transcript's file popover with "Copy file path", or a copy of it in a dialog); nobody needs it to
 * read the prompt. Text that only looks like a reference stays text (`world/secretRefs.ts`).
 *
 * A selection copied across a chip copies the reference as it was sent: the chip holds it as text the eye does not
 * see (the tape's words are not selectable), so a copied prompt still points at its file. Code blocks are left as
 * typed (the highlighter redraws them from their text).
 */

export const SECRET_CHIP = 'secret-chip';

/** How a chip gives its path. */
export type SecretChipAction =
  /** Inside another control (a section header's summary): the tape only, its path in the tooltip. */
  | { kind: 'inert' }
  /** The transcript: an inert reference its file popover opens (#31: `data-tx-file`, the class `cls`, keys and clicks delegated). */
  | { kind: 'popover'; cls: string }
  /** A dialog: a button that copies the path; `copied` says how it went (the dialog's status line). */
  | { kind: 'copy'; copy(text: string): Promise<boolean>; copied?(ok: boolean, path: string): void };

export interface SecretChipOptions {
  /** The bridge's directory of files (`World.prompt_secrets.dir`); null: the shape alone (an older bridge). */
  dir: string | null;
  action: SecretChipAction;
}

/** The bridge's directory of protected files, from a store that has the switch (null: unknown, or none to read). */
export function secretsDirOf(store: { readonly promptSecrets?: { readonly state: { dir?: string } | null } }): string | null {
  return store.promptSecrets?.state?.dir ?? null;
}

/** How long a dialog chip shows its check after a copy. */
const COPIED_MS = 1600;
const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';

/** One chip for the file at `path` (the reference was `[secret in file <path>]`). */
export function secretChip(path: string, o: SecretChipOptions): HTMLElement {
  const ref = `[secret in file ${path}]`;
  const ic = h('span', { class: 'secret-chip-ic', 'aria-hidden': 'true' }, icon(ICON.lock));
  const a = o.action;
  // Inside a control's label: its words are the label's, and nothing in a button is selected for a copy.
  if (a.kind === 'inert') return h('span', { class: `${SECRET_CHIP} secret-chip--inert`, 'data-secret-ref': path, title: path }, h('span', { class: 'secret-chip-tape' }, ic, h('span', { class: 'secret-chip-word' }, 'protected file')));
  const parts = [h('span', { class: 'secret-chip-tape', 'aria-hidden': 'true' }, ic, h('span', { class: 'secret-chip-word' }, 'protected file')), h('span', { class: 'secret-chip-ref', 'aria-hidden': 'true' }, ref)];
  if (a.kind === 'popover') {
    return h(
      'span',
      {
        class: `${SECRET_CHIP} ${a.cls}`,
        role: 'button',
        tabindex: '0',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-label': `Protected file: ${path}`,
        'data-tx-file': path,
        'data-secret-ref': path,
        title: path,
      },
      ...parts,
    );
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const btn = h(
    'button',
    {
      type: 'button',
      class: SECRET_CHIP,
      'aria-label': `Protected file: ${path}. Copy its path`,
      'data-secret-ref': path,
      title: `${path}\nPress to copy the path`,
      onclick: async () => {
        const ok = await a.copy(path);
        if (timer) clearTimeout(timer);
        btn.dataset.copied = ok ? 'true' : 'false';
        ic.replaceChildren(icon(ok ? CHECK : ICON.lock));
        timer = setTimeout(() => {
          delete btn.dataset.copied;
          ic.replaceChildren(icon(ICON.lock));
          timer = null;
        }, COPIED_MS);
        a.copied?.(ok, path);
      },
    },
    ...parts,
  );
  return btn;
}

/** Puts text on the clipboard; false when the browser refused (no permission, not a secure context, no clipboard). */
async function clipboardWrite(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A dialog's chips: `say` tells its status line how a copy went (refused: the path itself, there to select); `copy` puts
 * a path on the clipboard (the browser's, by default).
 */
export function dialogChips(dir: string | null, say: (msg: string, error: boolean) => void, copy: (text: string) => Promise<boolean> = clipboardWrite): SecretChipOptions {
  return { dir, action: { kind: 'copy', copy, copied: (ok, path) => say(ok ? 'Path copied.' : `The browser did not allow copying. The file’s path: ${path}`, !ok) } };
}

/** `text` as nodes: its text, and a chip for each reference in it. */
export function secretTextNodes(text: string, o: SecretChipOptions): Node[] {
  const refs = secretRefs(text, o.dir);
  if (!refs.length) return [document.createTextNode(text)];
  const out: Node[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(document.createTextNode(text.slice(at, r.start)));
    out.push(secretChip(r.path, o));
    at = r.end;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** Stands for a reference while a preview cuts the text (a private-use character: never typed, never cut in half). */
const HOLD = '\uE000';

/**
 * A short preview of `text` (`preview` shortens it: collapsed white space, an ellipsis) with each whole reference as an
 * inert chip: a reference counts as one character of it, so a cut never leaves half a path showing.
 */
export function secretPreviewNodes(text: string, dir: string | null, preview: (text: string) => string): Node[] {
  const refs = secretRefs(text, dir);
  if (!refs.length || text.includes(HOLD)) return [document.createTextNode(preview(text))];
  let held = '';
  let at = 0;
  for (const r of refs) {
    held += text.slice(at, r.start) + HOLD;
    at = r.end;
  }
  const cut = preview(held + text.slice(at));
  const out: Node[] = [];
  let i = 0;
  for (const piece of cut.split(HOLD)) {
    if (i > 0) out.push(secretChip((refs[i - 1] as { path: string }).path, { dir, action: { kind: 'inert' } }));
    if (piece) out.push(document.createTextNode(piece));
    i++;
  }
  return out;
}

/** Each reference in the text under `root` as a chip (code blocks and chips left alone). How many it made. */
export function chipSecretRefs(root: Node, o: SecretChipOptions): number {
  if (!(root.textContent ?? '').includes('[secret in file ')) return 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    const p = t.parentElement;
    if (p?.closest('pre') || p?.closest(`.${SECRET_CHIP}`)) continue;
    if (t.data.includes('[secret in file ')) texts.push(t);
  }
  let n = 0;
  for (const t of texts) {
    const nodes = secretTextNodes(t.data, o);
    const made = nodes.filter((x) => x instanceof HTMLElement).length;
    if (!made) continue;
    n += made;
    t.replaceWith(...nodes);
  }
  return n;
}

/**
 * The line under a plain text box whose text holds references (a task the bridge sent back, editable): the box keeps
 * them as written (the agent reads its value from that path), the line names the files they point at, as chips. Hidden
 * while the text holds none; `update` redraws it from the box's text.
 */
export function secretRefLine(id: string, options: () => SecretChipOptions): { el: HTMLElement; update(text: string): void } {
  const el = h('p', { class: 'secret-chip-line', id, 'data-hook': 'secret-refs', hidden: true });
  let last = '';
  return {
    el,
    update(text: string) {
      const o = options();
      const refs = secretRefs(text, o.dir);
      const key = [o.dir ?? '', ...refs.map((r) => r.path)].join('\n');
      if (key === last) return;
      last = key;
      el.hidden = !refs.length;
      if (!refs.length) return el.replaceChildren();
      const n = refs.length;
      el.replaceChildren(
        `${n === 1 ? 'It refers to a protected file' : `It refers to ${n} protected files`}: `,
        ...refs.map((r) => secretChip(r.path, o)),
        ` Keep each “[secret in file …]” as it is: the agent reads the value from ${n === 1 ? 'that file' : 'those files'}.`,
      );
    },
  };
}

