import { type BridgeBook, type BridgeEntry, type BridgeFields, type BridgeKind, type BridgeList, type BridgeResult } from '../net/bridges';
import { keyName } from '../input/shortcuts';
import { bridgeDot, bridgeStateText } from './bridgeState';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What Settings → Bridges needs: the helper's list, and the game's switch. */
export interface BridgesSectionHost {
  book: BridgeBook;
  /** Puts `b` in use (the game asks first when it is offline, then reloads). */
  switchTo(b: BridgeEntry): void;
  /** The bridge in use now has another address: the game reconnects through it. */
  reconnect(b: BridgeEntry): void;
}

let serial = 0;

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;

interface Form {
  root: HTMLFormElement;
  name: HTMLInputElement;
  kind: HTMLSelectElement;
  host: HTMLInputElement;
  remote: HTMLInputElement;
  socket: HTMLInputElement;
  error: HTMLElement;
  submit: HTMLButtonElement;
  read(): BridgeFields;
  fill(b: Partial<BridgeFields>): void;
}

/** The fields of an add, an edit or (`nameOnly`) a rename. */
function bridgeForm(id: string, submitText: string, nameOnly: boolean, cancel: (() => void) | null): Form {
  const root = el('form', 'settings-br-form');
  root.noValidate = true;
  const field = (key: string, label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string) => {
    const f = el('div', 'settings-field');
    input.id = `${id}-${key}`;
    const l = el('label', 'settings-field-label', label);
    l.htmlFor = input.id;
    f.append(l, input);
    if (hint) {
      const h = el('p', 'settings-field-hint', hint);
      h.id = `${input.id}-hint`;
      input.setAttribute('aria-describedby', h.id);
      f.append(h);
    }
    return f;
  };
  const text = (placeholder: string, code = false) => {
    const i = el('input', code ? 'settings-br-code' : '');
    i.type = 'text';
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.setAttribute('autocapitalize', 'off');
    return i;
  };
  const name = text('Laptop');
  name.maxLength = 40;
  const kind = el('select');
  for (const [value, label] of [
    ['ssh', 'Over ssh: another machine'],
    ['local', 'On this machine: its socket'],
  ] as const) {
    const o = el('option', '', label);
    o.value = value;
    kind.append(o);
  }
  const host = text('you@devbox', true);
  const remote = text('Asked over ssh', true);
  const socket = text('/run/user/1000/herdr-world/bridge.sock', true);
  const fName = field('name', 'Name', name, nameOnly ? undefined : 'What the game calls it: in the palette, the connection chip and About.');
  const fKind = field('kind', 'Where it runs', kind);
  const fHost = field('host', 'ssh destination', host, 'As you would pass it to ssh: [user@]host, or a Host from ~/.ssh/config.');
  const fRemote = field('remote', 'Bridge socket on that host (optional)', remote, 'Empty: $XDG_RUNTIME_DIR/herdr-world/bridge.sock, as the host reports it.');
  const fSocket = field('socket', 'Bridge socket', socket, 'The herdr-world socket on this machine, an absolute path.');
  const error = el('p', 'settings-field-hint settings-field-error settings-br-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = el('button', 'btn btn--sm', submitText);
  submit.type = 'submit';
  const actions = el('div', 'settings-br-actions');
  actions.append(submit);
  if (cancel) {
    const c = button('Cancel');
    c.addEventListener('click', cancel);
    actions.append(c);
  }
  const syncKind = () => {
    const local = kind.value === 'local';
    fHost.hidden = fRemote.hidden = nameOnly || local;
    fSocket.hidden = nameOnly || !local;
  };
  kind.addEventListener('change', syncKind);
  fKind.hidden = nameOnly;
  const grid = el('div', 'settings-br-fields');
  grid.append(fName, fKind, fHost, fRemote, fSocket);
  root.append(grid, error, actions);
  syncKind();
  return {
    root,
    name,
    kind,
    host,
    remote,
    socket,
    error,
    submit,
    read: () => {
      const k: BridgeKind = kind.value === 'local' ? 'local' : 'ssh';
      return k === 'local' ? { name: name.value, kind: k, socket: socket.value.trim() } : { name: name.value, kind: k, host: host.value.trim(), remote_socket: remote.value.trim() };
    },
    fill: (b) => {
      name.value = b.name ?? '';
      kind.value = b.kind ?? 'ssh';
      host.value = b.host ?? '';
      remote.value = b.remote_socket ?? '';
      socket.value = b.socket ?? '';
      syncKind();
    },
  };
}

/** Which field a helper refusal is about, from its words (the helper names the field it refuses). */
function fieldOf(message: string): 'name' | 'host' | 'remote' | 'socket' | null {
  const m = message.toLowerCase();
  if (m.startsWith('name') || m.includes('a bridge named')) return 'name';
  if (m.startsWith('host')) return 'host';
  if (m.startsWith('remote socket')) return 'remote';
  if (m.startsWith('socket')) return 'socket';
  return null;
}

/**
 * #57: Settings → Bridges. The bridges this helper can tunnel to, kept by the helper (`/api/bridges`), so every browser
 * it serves sees the same list. One row per bridge: its state dot, name, "In use", address and state in words, and Use,
 * Rename, Edit and Remove; the bridge in use cannot be removed (the helper refuses too). Under the list, a form adds an
 * ssh bridge (a host, an optional remote socket) or a local one (a socket on this machine). What the helper refuses is
 * shown under the form in its own words. The states are read every two seconds while Settings is open; nothing here
 * waits on a bridge. A page no helper serves has no section.
 */
export function bridgesSection(host: BridgesSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-br-${++serial}`;
    const book = host.book;
    const lede = el(
      'p',
      'settings-lede',
      `The machines whose office this game shows: each runs herdr-world. Switch with Use here, or from the command palette (${keyName('palette')}): Switch bridge. Drafts and seats are kept per bridge.`,
    );
    const block = el('div', 'settings-role settings-br');
    block.setAttribute('role', 'group');
    const head = el('div', 'settings-role-head');
    const title = el('h4', 'settings-role-title', 'Bridges');
    title.id = `${id}-h`;
    block.setAttribute('aria-labelledby', title.id);
    head.append(title);
    const list = el('ul', 'settings-br-list');
    list.setAttribute('aria-label', 'Bridges');
    const empty = el('p', 'settings-field-hint settings-br-empty', 'No bridge configured: add the machine that runs herdr-world below.');
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    const addTitle = el('h4', 'settings-role-title settings-br-add-title', 'Add a bridge');
    const add = bridgeForm(`${id}-add`, 'Add bridge', false, null);
    add.root.setAttribute('aria-label', 'Add a bridge');
    block.append(head, list, empty, status, addTitle, add.root);
    body.append(lede, block);

    let busy = false;
    let note: { text: string; error: boolean } | null = null;
    /** The row being renamed or edited, and its form. */
    let editing: { id: string; nameOnly: boolean; form: Form } | null = null;
    let stopWatch: (() => void) | null = null;

    const api = () => book.api;

    function say(form: Form, message: string | null): void {
      const which = message ? fieldOf(message) : null;
      for (const [k, input] of [
        ['name', form.name],
        ['host', form.host],
        ['remote', form.remote],
        ['socket', form.socket],
      ] as const)
        input.setAttribute('aria-invalid', String(which === k));
      form.error.textContent = message ? sentence(message) : '';
      form.error.hidden = !message;
    }

    /** A bridge's line and state, without its form (a redraw replaces only this). */
    function info(b: BridgeEntry): HTMLElement {
      const box = el('div', 'settings-br-info');
      const line = el('div', 'settings-br-line');
      const name = el('span', 'settings-br-name', b.name);
      const who = el('span', 'settings-br-who');
      who.append(bridgeDot(b), name);
      if (b.active) {
        const tag = el('span', 'settings-badge', 'In use');
        tag.dataset.state = 'ready';
        who.append(tag);
      }
      const acts = el('div', 'settings-br-buttons');
      if (!b.active) {
        const use = button('Use');
        use.setAttribute('aria-label', `Use ${b.name}`);
        use.disabled = busy;
        use.addEventListener('click', () => host.switchTo(b));
        acts.append(use);
      }
      const rename = button('Rename');
      rename.setAttribute('aria-label', `Rename ${b.name}`);
      const edit = button('Edit');
      edit.setAttribute('aria-label', `Edit ${b.name}`);
      const rm = button('Remove');
      rm.setAttribute('aria-label', `Remove ${b.name}`);
      for (const x of [rename, edit, rm]) x.disabled = busy;
      if (b.active) {
        // Focusable, so it can say why: the bridge in use stays until another one is.
        rm.setAttribute('aria-disabled', 'true');
        rm.title = 'In use: switch to another bridge first';
      }
      rename.addEventListener('click', () => startEdit(b, true));
      edit.addEventListener('click', () => startEdit(b, false));
      rm.addEventListener('click', () => void remove(b));
      acts.append(rename, edit, rm);
      line.append(who, acts);
      const st = bridgeStateText(b);
      const meta = el('p', 'settings-field-hint settings-br-meta');
      const addr = el('code', 'settings-br-addr', b.address || (b.kind === 'local' ? (b.socket ?? '') : (b.host ?? '')));
      const state = el('span', `settings-br-state settings-br-state--${st.tone}`, st.text + (b.version && st.tone === 'up' ? ` · ${b.version}` : ''));
      meta.append(addr, ' · ', state);
      box.append(line, meta);
      if (st.tone !== 'up' && b.last_error) box.append(el('p', 'settings-field-hint settings-br-why', sentence(b.last_error)));
      return box;
    }

    /**
     * The rows for `l`. A row keeps its element, and its form when one is open, so the field being typed in keeps the
     * keyboard through a redraw; only its line and state are replaced.
     */
    function drawRows(l: BridgeList): void {
      const old = new Map([...list.children].map((li) => [(li as HTMLElement).dataset.id ?? '', li as HTMLLIElement]));
      const rows = l.bridges.map((b) => {
        let li = old.get(b.id);
        if (!li) {
          li = el('li', 'settings-br-row');
          li.dataset.id = b.id;
        }
        // Unchanged (most polls): the row is left alone, so a button never moves from under the pointer.
        const sig = `${busy}|${JSON.stringify(b)}`;
        const was = li.querySelector<HTMLElement>(':scope > .settings-br-info');
        if (was?.dataset.sig !== sig) {
          const next = info(b);
          next.dataset.sig = sig;
          if (was) was.replaceWith(next);
          else li.prepend(next);
        }
        const form = li.querySelector(':scope > form');
        if (editing?.id === b.id) {
          if (form !== editing.form.root) {
            form?.remove();
            li.append(editing.form.root);
          }
        } else form?.remove();
        return li;
      });
      for (const [k, li] of old) if (!l.bridges.some((b) => b.id === k)) li.remove();
      rows.forEach((li, i) => {
        if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
      });
    }

    function startEdit(b: BridgeEntry, nameOnly: boolean): void {
      if (busy) return;
      const form = bridgeForm(`${id}-edit-${b.id}`, nameOnly ? 'Save name' : 'Save', nameOnly, () => {
        editing = null;
        sync();
        list.querySelector<HTMLElement>(`li[data-id="${b.id}"] .btn`)?.focus();
      });
      form.root.classList.add('settings-br-form--edit');
      form.root.setAttribute('aria-label', nameOnly ? `Rename ${b.name}` : `Edit ${b.name}`);
      form.fill(b);
      form.root.addEventListener('submit', (e) => {
        e.preventDefault();
        void saveEdit(b, form, nameOnly);
      });
      form.name.addEventListener('input', () => say(form, null));
      editing = { id: b.id, nameOnly, form };
      note = null;
      sync();
      form.name.focus();
      form.name.select();
    }

    async function run(change: () => Promise<BridgeResult>, done: (l: BridgeList) => string, form?: Form): Promise<BridgeList | null> {
      const focused = document.activeElement;
      busy = true;
      note = { text: 'Saving…', error: false };
      if (form) say(form, null);
      sync();
      const r = await change();
      busy = false;
      if (r.ok) {
        book.set(r.list);
        note = { text: done(r.list), error: false };
      } else if (form) {
        note = null;
        say(form, r.message);
      } else note = { text: sentence(r.message), error: true };
      sync();
      if (focused instanceof HTMLElement && focused.isConnected && !(focused as HTMLButtonElement).disabled && (document.activeElement === document.body || !document.activeElement)) focused.focus({ preventScroll: true });
      return r.ok ? r.list : null;
    }

    async function saveEdit(b: BridgeEntry, form: Form, nameOnly: boolean): Promise<void> {
      const a = api();
      if (!a || busy) return;
      const fields: BridgeFields = nameOnly ? { name: form.name.value, kind: b.kind, ...(b.kind === 'local' ? { socket: b.socket ?? '' } : { host: b.host ?? '', remote_socket: b.remote_socket ?? '' }) } : form.read();
      const moved = !nameOnly && (fields.kind !== b.kind || (fields.host ?? '') !== (b.host ?? '') || (fields.remote_socket ?? '') !== (b.remote_socket ?? '') || (fields.socket ?? '') !== (b.socket ?? ''));
      const l = await run(() => a.update(b.id, fields), () => (nameOnly ? `Renamed to ${fields.name.trim()}.` : `Saved ${fields.name.trim()}.`), form);
      if (!l) return;
      editing = null;
      sync();
      const now = l.bridges.find((x) => x.id === b.id);
      if (now && now.active && moved) host.reconnect(now);
    }

    async function remove(b: BridgeEntry): Promise<void> {
      const a = api();
      if (!a || busy) return;
      if (b.active) {
        // The helper refuses it as well; no need to ask.
        note = { text: `${b.name} is the bridge in use: switch to another bridge before removing it.`, error: true };
        sync();
        return;
      }
      if (editing?.id === b.id) editing = null;
      await run(() => a.remove(b.id), () => `Removed ${b.name}.`);
    }

    add.root.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = api();
      if (!a || busy) return;
      const fields = add.read();
      void run(() => a.add(fields), (l) => `Added ${fields.name.trim()}.${l.bridges.length === 1 ? ' It is the bridge in use.' : ` Use it here or from the command palette (${keyName('palette')}): Switch bridge.`}`, add).then((l) => {
        if (!l) return;
        add.fill({ kind: fields.kind });
        sync();
        // The first bridge of an empty helper: connect to it at once.
        if (l.bridges.length === 1 && l.bridges[0]) host.reconnect(l.bridges[0]);
      });
    });
    for (const input of [add.name, add.host, add.remote, add.socket]) input.addEventListener('input', () => say(add, null));

    function sync(): void {
      const l = book.list;
      section.setHidden(!book.available);
      if (!l) return;
      if (editing && !l.bridges.some((b) => b.id === editing?.id)) editing = null;
      drawRows(l);
      list.hidden = l.bridges.length === 0;
      empty.hidden = l.bridges.length > 0;
      add.submit.disabled = busy;
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
    }

    const off = book.onChange(() => {
      // A poll redraws the rows: keep the keyboard where it was.
      const f = document.activeElement;
      const key = f instanceof HTMLElement && list.contains(f) ? { id: (f.closest('li') as HTMLElement | null)?.dataset.id, label: f.getAttribute('aria-label'), inForm: !!f.closest('form') } : null;
      sync();
      if (key && !key.inForm && key.label) list.querySelector<HTMLElement>(`li[data-id="${key.id}"] [aria-label="${CSS.escape(key.label)}"]`)?.focus({ preventScroll: true });
    });
    sync();
    return {
      open() {
        note = null;
        editing = null;
        say(add, null);
        sync();
        stopWatch?.();
        stopWatch = book.watch();
        const dialog = body.closest('dialog');
        dialog?.addEventListener(
          'close',
          () => {
            stopWatch?.();
            stopWatch = null;
          },
          { once: true },
        );
      },
      dispose() {
        off();
        stopWatch?.();
      },
    };
  };
}
