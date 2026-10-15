// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { RepoDiscoveryState } from '../net/protocol';
import { cleanRoot, RepoDiscoveryBook } from '../world/repoDiscovery';
import { repoDiscoverySection } from './repoDiscoverySection';
import { SettingsDialog } from './settings';

const NOW = new Date(2026, 9, 15, 10, 30).getTime();
const AT = new Date(2026, 9, 15, 10, 24).getTime();

const state = (o: Partial<RepoDiscoveryState> = {}, status: Partial<RepoDiscoveryState['status']> = {}): RepoDiscoveryState => ({
  roots: [],
  interval_minutes: 10,
  ...o,
  status: { state: 'off', revision: 0, repositories: 0, checkouts: 0, last_scan_at: null, last_success_at: null, roots: [], ...status },
});

/** A bridge that keeps the settings and answers like herdr-world (its refusals given by `refuse`). */
function mount(s: RepoDiscoveryState | null, refuse?: (args: Record<string, unknown>) => CommandResult | null) {
  document.body.replaceChildren();
  const book = new RepoDiscoveryBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'repo-discovery',
    'Repository discovery',
    repoDiscoverySection({
      book,
      now: () => NOW,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        const no = refuse?.(args);
        if (no) return Promise.resolve(no);
        const cur = book.state as RepoDiscoveryState;
        const roots = (args.roots as string[] | undefined) ?? cur.roots;
        const next = state(
          { roots, interval_minutes: (args.interval_minutes as number | undefined) ?? cur.interval_minutes },
          { ...cur.status, state: roots.length ? 'scanning' : 'off', roots: roots.map((path) => cur.status.roots.find((r) => r.path === path) ?? { path, state: 'pending', checkouts: 0, last_success_at: null }) },
        );
        return Promise.resolve({ ok: true, data: next });
      }) as never,
    }),
    { store: 'bridge', group: 'integrations' },
  );
  const root = document.querySelector<HTMLElement>('[data-section="repo-discovery"]')!;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const text = (sel: string) => root.querySelector<HTMLElement>(sel)?.textContent ?? '';
  const btn = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)!;
  const add = () => q<HTMLInputElement>('input[type="text"]');
  const iv = () => q<HTMLInputElement>('input[type="number"]');
  const type = (i: HTMLInputElement, v: string) => {
    i.value = v;
    i.dispatchEvent(new Event('input'));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, text, btn, add, iv, type, flush };
}

describe('the “Repository discovery” section (#54)', () => {
  it('is not there for a bridge without discovery; off by default, kept on the bridge, the paths the bridge host’s', () => {
    const m = mount(null);
    expect(m.root.hidden).toBe(true);
    m.book.upsert(state());
    expect(m.root.hidden).toBe(false);
    expect(m.text('.settings-store')).toBe('Bridge');
    expect(m.text('.settings-lede')).toContain('bridge host');
    expect(m.text('.settings-role-head .settings-badge')).toBe('Off');
    expect(m.text('.settings-rd-empty')).toContain('discovery is off');
    expect(m.iv().value).toBe('10');
    expect(m.btn('Refresh now').disabled).toBe(true);
    expect(m.text('.settings-rd-policy')).toContain('stops at each checkout');
  });

  it('adds folders (checked first, as the bridge would), removes them, saves the interval', async () => {
    const m = mount(state());
    m.btn('Add').click();
    expect(m.sent).toEqual([]);
    expect(m.add().getAttribute('aria-invalid')).toBe('true');
    expect(m.text(`#${m.add().getAttribute('aria-describedby')}`)).toMatch(/Type the folder/);
    m.type(m.add(), 'devel');
    m.btn('Add').click();
    expect(m.text(`#${m.add().getAttribute('aria-describedby')}`)).toMatch(/absolute path/);
    expect(m.sent).toEqual([]);
    m.type(m.add(), '/home/me/my devel ü/');
    expect(m.add().getAttribute('aria-invalid')).toBe('false');
    m.add().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await m.flush();
    expect(m.sent).toEqual([{ t: 'repo_discovery.set', args: { roots: ['/home/me/my devel ü'] } }]);
    expect(m.add().value).toBe('');
    expect(m.text('.settings-status')).toBe('Added /home/me/my devel ü. Scanning it now.');
    expect(m.text('.settings-rd-path')).toBe('/home/me/my devel ü');
    expect(m.text('.settings-rd-root .settings-badge')).toBe('Not scanned yet');
    expect(m.text('.settings-role-head .settings-badge')).toBe('Scanning');
    // The same folder again, spelled another way.
    m.type(m.add(), '/home/me/./my devel ü');
    m.btn('Add').click();
    expect(m.text(`#${m.add().getAttribute('aria-describedby')}`)).toMatch(/already scanned/);
    // The bridge refuses: its words, under the field.
    const r = mount(state({ roots: ['/a'] }), () => ({ ok: false, code: 'bad_request', message: 'At most 32 scan folders can be set; remove one first.' }));
    r.type(r.add(), '/b');
    r.btn('Add').click();
    await r.flush();
    expect(r.text(`#${r.add().getAttribute('aria-describedby')}`)).toBe('At most 32 scan folders can be set; remove one first.');
    expect(r.add().value).toBe('/b');

    m.btn('Remove /home/me/my devel ü').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'repo_discovery.set', args: { roots: [] } });
    expect(m.text('.settings-status')).toBe('Removed /home/me/my devel ü. Its repositories are gone from @r:.');
    expect(m.root.querySelectorAll('.settings-rd-root')).toHaveLength(0);

    expect(m.btn('Save').disabled).toBe(true);
    m.type(m.iv(), '0');
    m.btn('Save').click();
    expect(m.iv().getAttribute('aria-invalid')).toBe('true');
    expect(m.text(`#${m.iv().getAttribute('aria-describedby')}`)).toMatch(/1 to 1440/);
    m.type(m.iv(), '25');
    m.btn('Save').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'repo_discovery.set', args: { interval_minutes: 25 } });
    expect(m.text('.settings-status')).toBe('Saved. The folders are scanned every 25 minutes.');
    expect(m.iv().value).toBe('25');
  });

  it('shows the scans: progress, what was found and when, each folder’s state; Refresh now', async () => {
    const roots = ['/home/me/dev', '/mnt/usb', '/nope'];
    const m = mount(
      state(
        { roots },
        {
          state: 'idle',
          revision: 3,
          repositories: 61,
          checkouts: 134,
          last_scan_at: AT,
          last_success_at: null,
          last_duration_ms: 152,
          roots: [
            { path: '/home/me/dev', canonical: '/data/dev', state: 'ok', checkouts: 134, last_success_at: AT, warning: '1 folder could not be read (permission denied)' },
            { path: '/mnt/usb', state: 'stale', error: 'the folder does not exist on the bridge host', checkouts: 4, last_success_at: AT },
            { path: '/nope', state: 'error', error: 'the bridge may not read this folder (permission denied)', checkouts: 0, last_success_at: null },
          ],
        },
      ),
    );
    // No scan without a failing folder yet: said so, with the latest attempt.
    expect(m.text('.settings-used')).toBe('61 repositories in 134 checkouts. No scan has succeeded yet: the latest, at 10:24 in 152 ms, failed for some folders (see below).');
    expect(m.text('.settings-role-head .settings-badge')).toBe('Needs attention');
    const items = [...m.root.querySelectorAll('.settings-rd-root')];
    expect(items.map((i) => i.querySelector('.settings-badge')?.textContent)).toEqual(['134 checkouts', 'Last scan failed', 'Not readable']);
    expect(items[0]?.textContent).toContain('Resolves to /data/dev.');
    expect(items[0]?.textContent).toContain('Skipped: 1 folder could not be read (permission denied).');
    expect(items[1]?.querySelector('.settings-field-error')?.textContent).toBe('The folder does not exist on the bridge host. @r: keeps the 4 checkouts found at 10:24.');
    expect(items[2]?.querySelector('.settings-field-error')?.textContent).toBe('The bridge may not read this folder (permission denied).');

    expect(m.btn('Refresh now').disabled).toBe(false);
    m.btn('Refresh now').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'repo_discovery.refresh', args: {} });
    expect(m.text('.settings-status')).toBe('Scanning now. New clones show up in @r: when it ends.');

    // The last successful scan, and a later one that failed for a folder.
    const idle = { state: 'idle' as const, revision: 3, repositories: 61, checkouts: 134, last_duration_ms: 152, roots: [] };
    m.book.upsert(state({ roots }, { ...idle, last_scan_at: AT, last_success_at: AT - 12 * 60_000 }));
    expect(m.text('.settings-used')).toBe('61 repositories in 134 checkouts. Last scanned successfully at 10:12. The latest scan, at 10:24 in 152 ms, failed for some folders (see below).');
    m.book.upsert(state({ roots }, { ...idle, last_scan_at: AT, last_success_at: AT }));
    expect(m.text('.settings-used')).toBe('61 repositories in 134 checkouts. Last scanned successfully at 10:24 in 152 ms.');

    // A scan in flight, after an earlier one: what is listed meanwhile.
    m.book.upsert(state({ roots }, { state: 'scanning', revision: 3, repositories: 61, checkouts: 134, last_scan_at: AT, progress: { phase: 'checking', done: 40, total: 135 }, roots: [] }));
    expect(m.text('.settings-used')).toBe('Scanning: checking 40 of 135 checkouts with Git… Until it ends, @r: lists the 61 repositories found before.');
    expect(m.btn('Refresh now').disabled).toBe(true);
    m.book.upsert(state({ roots }, { state: 'scanning', progress: { phase: 'walking', done: 0, total: 3 }, roots: [] }));
    expect(m.text('.settings-used')).toBe('Scanning: looking through folder 1 of 3…');
  });

  it('cleans a typed root the way the bridge does', () => {
    expect(cleanRoot('/home/me/dev/')).toBe('/home/me/dev');
  });
});
