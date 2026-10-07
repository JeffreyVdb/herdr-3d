import type { CommandArgs, CommandName, KaneoState, KaneoTestAck, KaneoWorkspace } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { hostOf, kaneoFailureText, kaneoStatusText, type KaneoBook } from '../world/kaneo';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** What the Kaneo section needs: the bridge's connection, the commands, and a way to open a page outside the game. */
export interface KaneoSectionHost {
  book: KaneoBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Opens Kaneo's own help page (the helper's browser, or a new window). */
  openLink?(url: string): void;
  now?(): number;
}

/** Kaneo's page on making an API key (Settings → Account → API Keys; a key is shown once). */
export const KANEO_KEY_DOCS = 'https://kaneo.app/docs/api-reference/authentication';
const BADGE: Record<KaneoState['state'], string> = { off: 'Not connected', ready: 'Connected', paused: 'Paused' };
const CONFIRM_MS = 4000;

let serial = 0;

const timeText = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

function field(id: string, label: string, control: HTMLElement, hint: HTMLElement): HTMLElement {
  const f = el('div', 'settings-field');
  const l = el('label', 'settings-field-label', label);
  l.htmlFor = id;
  control.id = id;
  control.setAttribute('aria-describedby', (hint.id = `${id}-hint`));
  f.append(l, control, hint);
  return f;
}

/**
 * #184: the “Kaneo” section of the Settings window: the bridge-wide connection a floor's Kaneo board uses. The
 * instance address and an API key, Test (a read-only workspace list, of exactly what the fields hold, saved or not),
 * the default workspace from that test, Save (only what passed the test; the bridge insists too) and Disconnect. A
 * key is typed here, sent with Test and Save and never shown again: blank means the saved key, and only for the saved
 * instance: a new address needs its key typed. Editing the address or the key undoes the test; closing the window
 * keeps what is saved.
 */
export function kaneoSection(host: KaneoSectionHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-kaneo-${++serial}`;
    const now = () => host.now?.() ?? Date.now();
    const lede = el('p', 'settings-lede', 'Connect a Kaneo instance so a floor can use one of its projects as its issue board. The bridge keeps the key; nothing is sent to Kaneo until you press Test.');
    const missing = el('p', 'settings-field-hint', 'This bridge has no Kaneo support. Update it to use this.');

    const form = el('div', 'settings-role settings-kaneo');
    form.setAttribute('role', 'group');
    const head = el('div', 'settings-role-head');
    const title = el('h4', 'settings-role-title', 'Connection');
    title.id = `${id}-h`;
    form.setAttribute('aria-labelledby', title.id);
    const badge = el('span', 'settings-badge');
    head.append(title, badge);
    const line = el('p', 'settings-field-hint settings-used');

    const url = el('input');
    url.type = 'url';
    url.inputMode = 'url';
    url.placeholder = 'https://kaneo.example.com';
    const urlHint = el('p', 'settings-field-hint', 'The address you open Kaneo at, or its /api address.');
    const key = el('input');
    key.type = 'password';
    key.autocomplete = 'new-password';
    key.setAttribute('data-lpignore', 'true');
    const keyHint = el('p', 'settings-field-hint');
    const keyHelp = el('a', 'settings-link', 'How to make an API key');
    keyHelp.href = KANEO_KEY_DOCS;
    keyHelp.target = '_blank';
    keyHelp.rel = 'noopener noreferrer';
    keyHelp.addEventListener('click', (e) => {
      if (!host.openLink) return;
      e.preventDefault();
      host.openLink(KANEO_KEY_DOCS);
    });
    for (const i of [url, key]) i.spellcheck = false;
    url.autocomplete = 'off';

    const ws = el('select');
    const wsHint = el('p', 'settings-field-hint');
    const keyField = field(`${id}-key`, 'API key', key, keyHint);
    keyField.append(keyHelp);

    const test = button('Test connection');
    const save = button('Save', 'btn btn--sm btn--primary');
    const clear = button('Disconnect');
    const actions = el('div', 'settings-actions');
    actions.append(test, save, clear);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    form.append(head, line, field(`${id}-url`, 'Instance address', url, urlHint), keyField, field(`${id}-ws`, 'Default workspace', ws, wsHint), actions, status);
    body.append(lede, missing, form);

    // What the fields held when a test passed, and what it found.
    let tested: { sig: string; res: KaneoTestAck } | null = null;
    let busy = false;
    let dirty = false;
    let note: { text: string; error: boolean } | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    /** The default the select holds (kept while its list is rebuilt). */
    let pick = '';

    const st = (): KaneoState | null => host.book.state;
    const sig = () => JSON.stringify({ url: url.value.trim(), key: key.value.trim() });
    /** The address differs from the saved one: the saved key is never sent there, a key must be typed. */
    const newAddress = (s: KaneoState): boolean => {
      const u = url.value.trim().replace(/\/+$/, '');
      return !s.key_set || (u !== s.url.replace(/\/+$/, '') && u !== s.api_base && u !== s.web_origin);
    };

    function fillWorkspaces(list: KaneoWorkspace[] | null, s: KaneoState): void {
      const opts: Array<[string, string]> = [['', 'No default']];
      if (list) for (const w of list) opts.push([w.id, w.name]);
      else if (s.default_workspace) opts.push([s.default_workspace.id, s.default_workspace.name]);
      ws.replaceChildren(...opts.map(([v, l]) => Object.assign(el('option', '', l), { value: v })));
      ws.value = opts.some(([v]) => v === pick) ? pick : '';
    }

    function fill(): void {
      const s = st();
      if (!s) return;
      url.value = s.url;
      key.value = '';
      pick = s.default_workspace?.id ?? '';
      tested = null;
    }

    function refresh(force = false): void {
      const s = st();
      missing.hidden = host.book.known;
      form.hidden = !s;
      if (!s) return;
      if (force || !dirty) fill();
      badge.dataset.state = s.state === 'ready' ? 'ready' : s.state === 'paused' ? 'invalid' : 'off';
      badge.textContent = s.available || s.state !== 'off' ? BADGE[s.state] : 'Unavailable';
      line.textContent = kaneoStatusText(s, now());
      const passed = tested !== null && tested.sig === sig();
      const needKey = newAddress(s) && !key.value.trim();
      fillWorkspaces(passed ? tested!.res.workspaces : null, s);
      ws.disabled = busy || !passed;
      url.disabled = key.disabled = !s.available;
      test.disabled = busy || !s.available || !url.value.trim() || needKey;
      save.disabled = busy || !passed;
      clear.disabled = busy || s.state === 'off';
      keyHint.textContent = !s.key_set
        ? 'Kept on the bridge and never shown again. Make one in Kaneo under Settings → Account → API Keys (it is shown once).'
        : newAddress(s)
          ? `A new address needs its own key: the saved one is only ever sent to ${hostOf(s.web_origin || s.api_base)}.`
          : 'A key is saved on the bridge. Leave blank to keep it.';
      wsHint.textContent = passed
        ? tested!.res.workspaces.length
          ? 'New Kaneo floors start in this workspace. Floors you already linked keep theirs.'
          : 'This key reaches no workspace yet, so no floor can be linked. Ask for access in Kaneo, then test again.'
        : 'Test the connection to choose from its workspaces.';
      let text = '';
      let error = false;
      if (note) ({ text, error } = note);
      else if (tested && !passed) text = 'Changed since the test: test again before saving.';
      else if (s.state === 'paused') ({ text, error } = { text: kaneoStatusText(s, now()), error: true });
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('settings-field-error', error);
    }

    const say = (text: string, error = false) => {
      note = text ? { text, error } : null;
      refresh();
    };

    async function run<T>(work: () => Promise<T>): Promise<T> {
      busy = true;
      refresh();
      try {
        return await work();
      } finally {
        busy = false;
      }
    }

    async function runTest(): Promise<void> {
      if (test.disabled) return;
      const s = st();
      if (!s) return;
      const at = sig();
      const args: CommandArgs['kaneo.test'] = { url: url.value.trim() };
      if (key.value.trim()) args.key = key.value.trim();
      tested = null;
      note = { text: 'Testing…', error: false };
      const r = await run(() => host.send('kaneo.test', args));
      if (!r.ok) return say(kaneoFailureText(r.code, r.message), true);
      const d = r.data as Partial<KaneoTestAck>;
      const res: KaneoTestAck = {
        ok: true,
        latency_ms: typeof d.latency_ms === 'number' ? d.latency_ms : 0,
        url: typeof d.url === 'string' ? d.url : '',
        api_base: typeof d.api_base === 'string' ? d.api_base : '',
        web_origin: typeof d.web_origin === 'string' ? d.web_origin : '',
        workspaces: Array.isArray(d.workspaces) ? d.workspaces.filter((w): w is KaneoWorkspace => typeof w?.id === 'string' && typeof w?.name === 'string') : [],
        ...(typeof d.user === 'string' && d.user ? { user: d.user } : {}),
      };
      dirty = true;
      if (at !== sig()) return say('Changed while testing: test again.', true);
      tested = { sig: at, res };
      if (!res.workspaces.some((w) => w.id === pick)) pick = '';
      const who = res.user ? ` as ${res.user}` : '';
      say(
        res.workspaces.length
          ? `Connected${who} in ${timeText(res.latency_ms)}: ${plural(res.workspaces.length, 'workspace')}. Pick a default if you like, then Save.`
          : `The key works${who}, but it reaches no workspace: no floor can be linked yet. You can still Save it.`,
      );
    }

    async function runSave(): Promise<void> {
      if (save.disabled) return;
      const args: CommandArgs['kaneo.set'] = { url: url.value.trim(), default_workspace: ws.value || null };
      if (key.value.trim()) args.key = key.value.trim();
      note = { text: 'Saving…', error: false };
      const r = await run(() => host.send('kaneo.set', args));
      if (!r.ok) {
        if (r.code === 'test_required') tested = null;
        return say(kaneoFailureText(r.code, r.message), true);
      }
      host.book.upsert(r.data); // the ack is the saved state: show it even before kaneo.update
      dirty = false;
      note = { text: 'Saved. Floors can now use Kaneo as their issue board.', error: false };
      refresh(true);
    }

    function disarm(): void {
      if (clearTimer !== null) clearTimeout(clearTimer);
      clearTimer = null;
      clear.textContent = 'Disconnect';
    }

    /** Disconnect asks twice: the first click arms it for a few seconds. */
    function runClear(): void {
      if (clearTimer === null) {
        clear.textContent = 'Click again to disconnect';
        clearTimer = setTimeout(() => {
          disarm();
          refresh();
        }, CONFIRM_MS);
        return;
      }
      disarm();
      note = { text: 'Disconnecting…', error: false };
      void run(() => host.send('kaneo.clear', {})).then((r) => {
        if (!r.ok) return say(kaneoFailureText(r.code, r.message), true);
        host.book.upsert(r.data);
        dirty = false;
        note = { text: 'Disconnected. Kaneo floors show no board until it is connected again.', error: false };
        refresh(true);
      });
    }

    const edited = () => {
      dirty = true;
      note = null;
      refresh();
    };
    for (const i of [url, key]) {
      i.addEventListener('input', edited);
      i.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        void runTest();
      });
    }
    ws.addEventListener('change', () => {
      pick = ws.value;
      dirty = true;
    });
    test.addEventListener('click', () => void runTest());
    save.addEventListener('click', () => void runSave());
    clear.addEventListener('click', runClear);
    const off = host.book.onChange(() => refresh());
    refresh(true);

    return {
      open() {
        dirty = false;
        note = null;
        disarm();
        refresh(true);
      },
      dispose() {
        off();
        disarm();
      },
    };
  };
}
