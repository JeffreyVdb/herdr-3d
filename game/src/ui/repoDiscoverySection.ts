import type { CommandArgs, CommandName, RepoDiscoveryRoot, RepoDiscoveryState } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { cleanRoot, DISCOVERY_DEFAULT_INTERVAL, intervalProblem, repoDiscoveryFailureText, rootProblem, type RepoDiscoveryBook } from '../world/repoDiscovery';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Repository discovery” section needs: the bridge's settings and status, and the commands. */
export interface RepoDiscoverySectionHost {
  book: RepoDiscoveryBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The clock (tests). */
  now?(): number;
}

let serial = 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function button(text: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/** A time of day (24-hour, like the limits plate's), with the date when it is not today. */
function when(ms: number, now: number): string {
  const d = new Date(ms);
  const t = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return d.toDateString() === new Date(now).toDateString() ? t : `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)} ${t}`;
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;

const seconds = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

/** One root's state tag: its count when fine, else what is wrong. */
const ROOT_BADGE: Record<RepoDiscoveryRoot['state'], { state: string; text: (r: RepoDiscoveryRoot) => string }> = {
  ok: { state: 'ready', text: (r) => plural(r.checkouts, 'checkout') },
  stale: { state: 'incomplete', text: () => 'Last scan failed' },
  error: { state: 'invalid', text: () => 'Not readable' },
  pending: { state: 'off', text: () => 'Not scanned yet' },
};

/**
 * #54: the “Repository discovery” section of the Settings window: the folders on the bridge host scanned for Git
 * checkouts, which a conversation's `@r:` then lists next to the other floors' repositories. Add and remove folders
 * (each change is saved at once and scans again), the refresh interval in minutes, Refresh now, and the scans' status:
 * the repositories found, the last scan, a scan's progress and each folder's own state (a folder whose last scan
 * failed keeps its previous repositories, marked). Kept on the bridge, so every client sees the same. A bridge without
 * discovery has no section.
 */
export function repoDiscoverySection(host: RepoDiscoverySectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-rd-${++serial}`;
    const now = () => host.now?.() ?? Date.now();
    const lede = el(
      'p',
      'settings-lede',
      'In a conversation, @r: also lists the Git repositories found in these folders. They are folders on the bridge host, the machine herdr-world runs on, not on this device.',
    );

    const block = el('div', 'settings-role settings-rd');
    block.setAttribute('role', 'group');
    const head = el('div', 'settings-role-head');
    const title = el('h4', 'settings-role-title', 'Scan folders');
    title.id = `${id}-h`;
    block.setAttribute('aria-labelledby', title.id);
    const badge = el('span', 'settings-badge');
    head.append(title, badge);
    const summary = el('p', 'settings-field-hint settings-used');
    summary.setAttribute('aria-live', 'polite');

    const list = el('ul', 'settings-rd-roots');
    list.setAttribute('aria-label', 'Scanned folders');
    const empty = el('p', 'settings-field-hint settings-rd-empty', 'No folders yet, so discovery is off. Add one to start.');

    const addField = el('div', 'settings-field');
    const addLabel = el('label', 'settings-field-label', 'Add a folder');
    const add = el('input');
    add.type = 'text';
    add.id = addLabel.htmlFor = `${id}-add`;
    add.placeholder = '/home/you/devel';
    add.spellcheck = false;
    add.autocomplete = 'off';
    add.setAttribute('autocapitalize', 'off');
    const addBtn = button('Add');
    const addRow = el('div', 'settings-row');
    addRow.append(add, addBtn);
    const addHint = el('p', 'settings-field-hint', 'An absolute path on the bridge host. Every folder inside it is searched, however deep.');
    addHint.id = `${id}-add-hint`;
    add.setAttribute('aria-describedby', addHint.id);
    addField.append(addLabel, addRow, addHint);

    const ivField = el('div', 'settings-field settings-field--short');
    const ivLabel = el('label', 'settings-field-label', 'Refresh every (minutes)');
    const iv = el('input');
    iv.type = 'number';
    iv.inputMode = 'numeric';
    iv.min = '1';
    iv.max = '1440';
    iv.step = '1';
    iv.id = ivLabel.htmlFor = `${id}-iv`;
    const ivBtn = button('Save');
    const ivRow = el('div', 'settings-row');
    ivRow.append(iv, ivBtn);
    const ivHint = el('p', 'settings-field-hint', `Default ${DISCOVERY_DEFAULT_INTERVAL}. The folders are also scanned when the bridge starts and whenever they change.`);
    ivHint.id = `${id}-iv-hint`;
    iv.setAttribute('aria-describedby', ivHint.id);
    ivField.append(ivLabel, ivRow, ivHint);

    const refresh = button('Refresh now');
    // Its own row: panels.css's `.settings-actions` is the floor settings' sticky footer.
    const actions = el('div', 'settings-rd-actions');
    actions.append(refresh);
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const policy = el('details', 'settings-advanced settings-rd-policy');
    const policyHead = el('summary', '', 'What is scanned');
    const policyText = el(
      'p',
      'settings-field-hint',
      'A checkout is a folder with a .git folder or file in it, so linked worktrees count. The search goes through every folder below a scan folder but stops at each checkout: a repository inside another one, such as a submodule, is found only when its own folder is added here. Symlinked folders are not followed, and bare repositories are not listed. Nothing is fetched: only local Git information is read.',
    );
    policy.append(policyHead, policyText);

    block.append(head, summary, list, empty, addField, ivField, actions, status, policy);
    body.append(lede, block);

    let busy = false;
    let ivDirty = false;
    let note: { text: string; error: boolean } | null = null;
    let addError: string | null = null;
    let ivError: string | null = null;

    const st = (): RepoDiscoveryState | null => host.book.state;

    function summaryText(s: RepoDiscoveryState): string {
      const t = s.status;
      if (t.state === 'off') return 'Off: no folders are scanned.';
      if (t.state === 'scanning') {
        const p = t.progress;
        const at = !p ? 'Scanning…' : p.phase === 'walking' ? `Scanning: looking through folder ${Math.min(p.done + 1, p.total)} of ${p.total}…` : `Scanning: checking ${p.done} of ${plural(p.total, 'checkout')} with Git…`;
        return t.last_scan_at === null ? at : `${at} Until it ends, @r: lists the ${plural(t.repositories, 'repository', 'repositories')} found before.`;
      }
      const found = `${plural(t.repositories, 'repository', 'repositories')} in ${plural(t.checkouts, 'checkout')}`;
      if (t.last_scan_at === null) return found;
      const took = t.last_duration_ms !== undefined ? ` in ${seconds(t.last_duration_ms)}` : '';
      return `${found}. Last scanned at ${when(t.last_scan_at, now())}${took}.`;
    }

    function badgeOf(s: RepoDiscoveryState): { state: string; text: string } {
      const t = s.status;
      if (t.state === 'off') return { state: 'off', text: 'Off' };
      if (t.state === 'scanning') return { state: 'incomplete', text: 'Scanning' };
      if (t.roots.some((r) => r.state === 'stale' || r.state === 'error')) return { state: 'invalid', text: 'Needs attention' };
      return { state: 'ready', text: 'Up to date' };
    }

    function rootItem(path: string, r: RepoDiscoveryRoot | undefined, s: RepoDiscoveryState): HTMLLIElement {
      const li = el('li', 'settings-rd-root');
      const line = el('div', 'settings-rd-line');
      const name = el('code', 'settings-rd-path', path);
      const tag = ROOT_BADGE[r?.state ?? 'pending'];
      const b = el('span', 'settings-badge', r ? tag.text(r) : 'Not scanned yet');
      b.dataset.state = tag.state;
      const rm = button('Remove');
      rm.setAttribute('aria-label', `Remove ${path}`);
      rm.disabled = busy;
      rm.addEventListener('click', () => void save({ roots: s.roots.filter((x) => x !== path) }, `Removed ${path}. Its repositories are gone from @r:.`));
      line.append(name, b, rm);
      li.append(line);
      const sub = (text: string, error = false) => li.append(el('p', `settings-field-hint${error ? ' settings-field-error' : ''}`, text));
      if (r?.canonical) sub(`Resolves to ${r.canonical}.`);
      if (r?.state === 'stale' && r.error) {
        const kept = r.last_success_at ? ` @r: keeps the ${plural(r.checkouts, 'checkout')} found at ${when(r.last_success_at, now())}.` : '';
        sub(`${sentence(r.error)}${kept}`, true);
      } else if (r?.state === 'error' && r.error) sub(sentence(r.error), true);
      if (r?.warning) sub(`Skipped: ${sentence(r.warning)}`);
      return li;
    }

    function sync(): void {
      const s = st();
      section.setHidden(!s);
      if (!s) return;
      const b = badgeOf(s);
      badge.dataset.state = b.state;
      badge.textContent = b.text;
      summary.textContent = summaryText(s);
      const byPath = new Map(s.status.roots.map((r) => [r.path, r]));
      list.replaceChildren(...s.roots.map((p) => rootItem(p, byPath.get(p), s)));
      list.hidden = s.roots.length === 0;
      empty.hidden = s.roots.length > 0;
      if (!ivDirty) iv.value = String(s.interval_minutes);
      add.disabled = addBtn.disabled = busy;
      iv.disabled = busy;
      ivBtn.disabled = busy || !ivDirty;
      refresh.disabled = busy || s.status.state !== 'idle';
      add.setAttribute('aria-invalid', String(!!addError));
      iv.setAttribute('aria-invalid', String(!!ivError));
      showHint(addHint, addError, 'An absolute path on the bridge host. Every folder inside it is searched, however deep.');
      showHint(ivHint, ivError, `Default ${DISCOVERY_DEFAULT_INTERVAL}. The folders are also scanned when the bridge starts and whenever they change.`);
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
    }

    function showHint(hint: HTMLElement, error: string | null, normal: string): void {
      hint.textContent = error ?? normal;
      hint.classList.toggle('settings-field-error', !!error);
    }

    /** Sends a change; the bridge's refusal goes to `field` (else the status line). */
    async function save(args: CommandArgs['repo_discovery.set'], done: string, field?: 'add' | 'iv'): Promise<boolean> {
      // Disabled while it is sent, a control loses the focus: it gets it back after, unless it went elsewhere.
      const focused = document.activeElement;
      busy = true;
      note = { text: 'Saving…', error: false };
      sync();
      const r = await host.send('repo_discovery.set', args);
      busy = false;
      if (r.ok) host.book.upsert(r.data);
      const why = r.ok ? null : repoDiscoveryFailureText(r.code, r.message);
      if (why && field === 'add') addError = why;
      else if (why && field === 'iv') ivError = why;
      note = why ? (field ? null : { text: why, error: true }) : { text: done, error: false };
      sync();
      const now = document.activeElement;
      if (focused instanceof HTMLElement && focused.isConnected && !(focused as HTMLInputElement).disabled && (!now || now === document.body)) focused.focus({ preventScroll: true });
      else if ((!now || now === document.body) && !focused?.isConnected) add.focus({ preventScroll: true });
      return r.ok;
    }

    async function addRoot(): Promise<void> {
      const s = st();
      if (!s || busy) return;
      addError = rootProblem(add.value, s.roots);
      if (addError) {
        note = null;
        sync();
        add.focus();
        return;
      }
      const path = cleanRoot(add.value.trim());
      if (await save({ roots: [...s.roots, path] }, `Added ${path}. Scanning it now.`, 'add')) add.value = '';
      sync();
    }

    async function saveInterval(): Promise<void> {
      if (busy || !ivDirty) return;
      ivError = intervalProblem(iv.value);
      if (ivError) {
        note = null;
        sync();
        return;
      }
      const minutes = Number(iv.value.trim());
      if (await save({ interval_minutes: minutes }, `Saved. The folders are scanned every ${plural(minutes, 'minute')}.`, 'iv')) ivDirty = false;
      sync();
    }

    add.addEventListener('input', () => {
      addError = null;
      sync();
    });
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void addRoot();
    });
    addBtn.addEventListener('click', () => void addRoot());
    iv.addEventListener('input', () => {
      ivDirty = true;
      ivError = null;
      sync();
    });
    iv.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void saveInterval();
    });
    ivBtn.addEventListener('click', () => void saveInterval());
    refresh.addEventListener('click', () => {
      if (refresh.disabled) return;
      busy = true;
      note = { text: 'Asking for a scan…', error: false };
      sync();
      void host.send('repo_discovery.refresh', {}).then((r) => {
        busy = false;
        if (r.ok) host.book.upsert(r.data);
        note = r.ok ? { text: 'Scanning now. New clones show up in @r: when it ends.', error: false } : { text: repoDiscoveryFailureText(r.code, r.message), error: true };
        sync();
      });
    });

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        addError = ivError = null;
        ivDirty = false;
        sync();
      },
      dispose: off,
    };
  };
}
