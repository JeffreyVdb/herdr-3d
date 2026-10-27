import './filesDrawer.css';
import type { FileMatch, WorkerFiles } from '../net/protocol';
import { h } from '../ui/dom';
import { duotone } from '../ui/duotone';
import { DEBOUNCE_MS } from './fileSearch';

/**
 * #216: the seat's Files drawer. A 300 px slide-over above the stage (it never resizes the terminal: no grid flow, no
 * transform; it opens and closes by clip-path and opacity) with the worker's checkout as a tree, assembled here from
 * `worker.files` (the bridge's ranked list, at most 100 entries, no paging, no directory listing) and the worker's
 * Changes (`M` changed, `U` untracked; a folder holding a change gets a dot). Because the list is capped, the tree is
 * partial: the filter field asks the bridge again (debounced as the `@` completion is) and the tree is rebuilt from that
 * answer; at 100 entries or with the bridge's `reason` the footer says the list is partial, and it never claims a total.
 * A changed file always shows, in or out of the 100. Enter on a row inserts an @ reference (`insertRef`); Esc closes.
 * It does not open file contents (no bridge command reads a file).
 */

export interface FilesDrawerDeps {
  /** The checkout's folder name (the header). */
  rootLabel: string;
  /** `worker.files` with this query and limit 100; null when the bridge could not answer. */
  list(query: string): Promise<WorkerFiles | null>;
  /** The worker's Changes as path → `M` (changed, tracked) or `U` (untracked); null while there are none to show. */
  changes(): ReadonlyMap<string, 'M' | 'U'> | null;
  /** Puts an @ reference to `path` into the prompt box. */
  insertRef(path: string, kind: 'file' | 'dir'): void;
  /** After a close: the seat puts the keyboard back where it was. */
  closed(): void;
}

/** The bridge's cap on one `worker.files` answer. */
export const FILES_CAP = 100;

export interface TreeNode {
  name: string;
  /** Checkout-relative, `/`-separated ('' for the root). */
  path: string;
  kind: 'file' | 'dir';
  /** Its own change. */
  change: 'M' | 'U' | null;
  /** A folder with a change somewhere under it. */
  dirty: boolean;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The tree of `files` plus every changed path: folders made for each path's parents (a folder the bridge returned as
 * an entry is the same node), folders first, then by name (numbers in order). A change path with a trailing `/` (an
 * untracked folder) is a folder.
 */
export function buildTree(files: readonly FileMatch[], changes: ReadonlyMap<string, 'M' | 'U'> | null): TreeNode {
  const root: TreeNode = { name: '', path: '', kind: 'dir', change: null, dirty: false, children: [] };
  const index = new Map<string, TreeNode>([['', root]]);
  const add = (path: string, kind: 'file' | 'dir'): TreeNode | null => {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      let node = index.get(p);
      if (!node) {
        node = { name: parts[i]!, path: p, kind: last ? kind : 'dir', change: null, dirty: false, children: [] };
        index.set(p, node);
        parent.children.push(node);
      } else if (!last && node.kind === 'file') node.kind = 'dir'; // a path under it says it is a folder
      parent = node;
    }
    return parent;
  };
  for (const f of files) add(f.path, f.kind);
  for (const [path, change] of changes ?? []) {
    const node = add(path, path.endsWith('/') ? 'dir' : 'file');
    if (!node) continue;
    node.change = change;
    for (let p = node.path; p.includes('/'); ) {
      p = p.slice(0, p.lastIndexOf('/'));
      const up = index.get(p);
      if (up) up.dirty = true;
    }
    if (node.kind === 'dir') node.dirty = true;
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

interface Row {
  node: TreeNode;
  level: number;
  parent: TreeNode | null;
  pos: number;
  size: number;
}

const CHANGE_WORDS = { M: 'changed', U: 'untracked' } as const;

export class FilesDrawer {
  readonly el: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly tree: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly partial: HTMLElement;
  private open_ = false;
  /** The query of the answer shown (the field may be newer). */
  private query = '';
  /** The query of the latest request, answered or not. */
  private asked = '';
  private result: WorkerFiles | null | undefined; // undefined: not asked yet
  private loading = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private root: TreeNode = buildTree([], null);
  private readonly expanded = new Set<string>();
  /** Folders opened for the changes once (the user's collapse then sticks). */
  private readonly autoOpened = new Set<string>();
  /** A filtered tree starts open; the folders the user collapsed in it (until an answer for another query). */
  private readonly collapsedInFilter = new Set<string>();
  private active = '';
  private rows: Row[] = [];
  private disposed = false;

  constructor(private readonly deps: FilesDrawerDeps) {
    const close = h('button', { class: 'btn btn--ghost fdr-close', 'aria-label': 'Close files', title: 'Close (Esc)', onclick: () => this.close() }, duotone('x'));
    this.filter = h('input', { class: 'fdr-input', type: 'search', 'aria-label': 'Filter files', placeholder: 'Filter files', autocomplete: 'off', spellcheck: 'false' });
    this.tree = h('ul', { class: 'fdr-tree', role: 'tree', 'aria-label': `Files of ${deps.rootLabel}` });
    this.msg = h('p', { class: 'fdr-msg', role: 'status' });
    this.partial = h('p', { class: 'fdr-partial' });
    this.el = h('aside', { class: 'fdr', 'aria-label': 'Files', 'data-open': 'false', inert: true },
      h('header', { class: 'fdr-head' }, duotone('files', 'fdr-head-icon'), h('h2', { class: 'fdr-title', title: deps.rootLabel }, deps.rootLabel), close),
      h('label', { class: 'fdr-filter' }, duotone('search'), this.filter),
      h('div', { class: 'fdr-body' }, this.tree, this.msg),
      h('footer', { class: 'fdr-foot' }, h('p', { class: 'fdr-keys' }, 'Enter inserts an @ reference · Esc closes'), this.partial));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.filter.addEventListener('input', () => this.schedule());
    this.tree.addEventListener('click', (e) => this.onClick(e));
    this.tree.addEventListener('dblclick', (e) => {
      const row = this.rowOf(e.target);
      if (row?.node.kind === 'file') this.insert(row.node);
    });
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.disposed || this.open_) return;
    this.open_ = true;
    this.el.dataset.open = 'true';
    this.el.toggleAttribute('inert', false);
    // A filter typed and then closed before its debounce fired is asked for now.
    if (this.result === undefined || this.result === null || this.filter.value.trim() !== this.asked) this.ask();
    else this.refreshChanges();
    this.filter.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.el.dataset.open = 'false';
    this.el.toggleAttribute('inert', true);
    this.cancelTimer();
    this.deps.closed();
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /** The worker's Changes changed: badges and dots again (the bridge is not asked). */
  refreshChanges(): void {
    if (this.disposed) return;
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.seq++;
    this.cancelTimer();
    this.el.remove();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ask();
    }, DEBOUNCE_MS);
  }

  private ask(): void {
    const q = this.filter.value.trim();
    const n = ++this.seq;
    this.asked = q;
    this.loading = true;
    this.tree.setAttribute('aria-busy', 'true');
    this.render();
    void this.deps.list(q).then(
      (r) => this.answer(n, q, r),
      () => this.answer(n, q, null),
    );
  }

  private answer(n: number, q: string, r: WorkerFiles | null): void {
    if (n !== this.seq || this.disposed) return;
    this.loading = false;
    this.tree.removeAttribute('aria-busy');
    if (q !== this.query) this.collapsedInFilter.clear();
    this.query = q;
    this.result = r;
    this.rebuild();
  }

  private rebuild(): void {
    const changes = this.deps.changes();
    // A filtered answer shows the changed files that match it too, not every change.
    const q = this.query.toLowerCase();
    const shown = q && changes ? new Map([...changes].filter(([p]) => p.toLowerCase().includes(q))) : changes;
    this.root = buildTree(this.result?.files ?? [], this.result ? shown : null);
    if (!this.query) {
      // The first time a changed file shows, the folders down to it open (once: a collapse sticks).
      const open = (n: TreeNode) => {
        for (const c of n.children) {
          if (c.kind === 'dir' && c.dirty && !this.autoOpened.has(c.path)) {
            this.autoOpened.add(c.path);
            this.expanded.add(c.path);
          }
          open(c);
        }
      };
      open(this.root);
    }
    this.render();
  }

  /** Whether a folder shows its children: a filtered tree is open all the way down (its answer is small) until collapsed. */
  private opened(n: TreeNode): boolean {
    return n.kind === 'dir' && (this.query ? !this.collapsedInFilter.has(n.path) : this.expanded.has(n.path));
  }

  /** The rows a person can see. */
  private flatten(): Row[] {
    const out: Row[] = [];
    const walk = (n: TreeNode, level: number, parent: TreeNode | null) => {
      n.children.forEach((c, i) => {
        out.push({ node: c, level, parent, pos: i + 1, size: n.children.length });
        if (this.opened(c)) walk(c, level + 1, c);
      });
    };
    walk(this.root, 1, null);
    return out;
  }

  private render(): void {
    const r = this.result;
    this.rows = r ? this.flatten() : [];
    if (!this.rows.some((x) => x.node.path === this.active)) this.active = this.rows[0]?.node.path ?? '';
    const hadFocus = this.tree.contains(document.activeElement);
    this.tree.replaceChildren(...this.rows.map((row) => this.item(row)));
    this.tree.hidden = !this.rows.length;
    this.tree.classList.toggle('is-stale', this.loading && r !== undefined);
    if (hadFocus) this.focusActive();
    this.msg.replaceChildren();
    let text = '';
    if (r === undefined) text = this.loading ? 'Loading the files…' : '';
    else if (r === null) {
      text = 'Could not list the files.';
      if (!this.loading) this.msg.append(text, ' ', h('button', { class: 'btn btn--ghost fdr-retry', onclick: () => this.ask() }, 'Try again'));
    } else if (r.source === 'none') {
      // Said from the answer, not the rows: changed files can fill the tree without a listing.
      text = `No file list for this checkout${r.reason ? `: ${r.reason}` : ''}${this.rows.length ? ' — only the changed files are shown' : r.reason ? '' : '.'}`;
    } else if (!this.rows.length) text = this.query ? `No files match “${this.query}”` : 'No files';
    if (!this.msg.firstChild) this.msg.textContent = text;
    this.msg.hidden = !this.msg.textContent;
    // The answer is capped and ranked, or the bridge says it is incomplete: say so (the reason only here); never a total.
    const capped = !!r && r.files.length >= FILES_CAP;
    const reason = r && r.source !== 'none' ? r.reason : null;
    const search = this.query ? 'type more to narrow' : 'type to search';
    const note = capped ? `Showing the first ${FILES_CAP}${this.query ? ' matches' : ''} — ${search}` : reason ? `This list may be incomplete — ${search}` : '';
    this.partial.textContent = [note, reason].filter(Boolean).join(' · ');
    this.partial.hidden = !this.partial.textContent;
  }

  private item(row: Row): HTMLElement {
    const n = row.node;
    const dir = n.kind === 'dir';
    const open = this.opened(n);
    const words = [n.name, dir ? 'folder' : null, n.change ? CHANGE_WORDS[n.change] : dir && n.dirty ? 'has changes' : null].filter(Boolean).join(', ');
    return h('li', {
      class: `fdr-row${dir ? ' fdr-row--dir' : ''}`,
      role: 'treeitem',
      'data-path': n.path,
      'data-kind': n.kind,
      'aria-level': row.level,
      'aria-setsize': row.size,
      'aria-posinset': row.pos,
      'aria-expanded': dir ? String(open) : null,
      'aria-selected': String(n.path === this.active),
      'aria-label': words,
      tabindex: n.path === this.active ? 0 : -1,
      style: `--lvl: ${row.level - 1}`,
      title: n.path,
    },
      dir ? duotone(open ? 'chevronDown' : 'chevronRight', 'fdr-tw') : h('span', { class: 'fdr-tw' }),
      duotone(dir ? 'folder' : 'file', 'fdr-ic'),
      h('span', { class: 'fdr-name' }, n.name),
      n.change ? h('span', { class: `fdr-badge fdr-badge--${n.change.toLowerCase()}`, 'aria-hidden': 'true' }, n.change) : dir && n.dirty ? h('span', { class: 'fdr-dot', 'aria-hidden': 'true' }) : null);
  }

  private rowOf(t: EventTarget | null): Row | null {
    const li = t instanceof Element ? t.closest<HTMLElement>('.fdr-row') : null;
    return li ? (this.rows.find((r) => r.node.path === li.dataset.path) ?? null) : null;
  }

  private onClick(e: MouseEvent): void {
    const row = this.rowOf(e.target);
    if (!row) return;
    this.setActive(row.node.path);
    if (row.node.kind === 'dir') this.setOpen(row.node, !this.opened(row.node));
  }

  private focusActive(): void {
    this.tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(this.active)}"]`)?.focus({ preventScroll: false });
  }

  private setActive(path: string, focus = true): void {
    this.active = path;
    for (const li of this.tree.querySelectorAll<HTMLElement>('.fdr-row')) {
      const on = li.dataset.path === path;
      li.tabIndex = on ? 0 : -1;
      li.setAttribute('aria-selected', String(on));
    }
    if (focus) this.focusActive();
  }

  private setOpen(n: TreeNode, open: boolean): void {
    if (this.query) {
      if (open) this.collapsedInFilter.delete(n.path);
      else this.collapsedInFilter.add(n.path);
    } else if (open) this.expanded.add(n.path);
    else this.expanded.delete(n.path);
    this.render();
    this.focusActive();
  }

  private insert(n: TreeNode): void {
    this.deps.insertRef(n.path, n.kind);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.target === this.filter) {
      if ((e.key === 'ArrowDown' || e.key === 'Enter') && this.rows.length) {
        e.preventDefault();
        if (this.timer || this.filter.value.trim() !== this.asked) {
          // The newest text first, then into its answer.
          this.cancelTimer();
          this.ask();
        }
        this.setActive(this.active || this.rows[0]!.node.path);
      }
      return;
    }
    const row = this.rowOf(e.target);
    if (!row || e.ctrlKey || e.altKey || e.metaKey) return;
    const i = this.rows.indexOf(row);
    const go = (j: number) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))];
      if (r) this.setActive(r.node.path);
    };
    const n = row.node;
    const open = this.opened(n);
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(this.rows.length - 1); break;
      case 'ArrowRight':
        if (n.kind !== 'dir') break;
        if (!open) this.setOpen(n, true);
        else if (n.children.length) go(i + 1);
        break;
      case 'ArrowLeft':
        if (open) this.setOpen(n, false);
        else if (row.parent) this.setActive(row.parent.path);
        break;
      case 'Enter':
        this.insert(n);
        break;
      case ' ':
        if (n.kind === 'dir') this.setOpen(n, !open);
        break;
      default:
        // Typing in the tree types into the filter.
        if ([...e.key].length === 1) {
          e.preventDefault();
          this.filter.focus();
          this.filter.value += e.key;
          this.schedule();
        }
        return;
    }
    e.preventDefault();
  }
}
