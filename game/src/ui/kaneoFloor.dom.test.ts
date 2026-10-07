// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { KaneoBook } from '../world/kaneo';
import { KaneoPicker } from './kaneoFloor';

const connected = { state: 'ready', available: true, url: 'https://k.test', api_base: 'https://k.test/api', web_origin: 'https://k.test', key_set: true, default_workspace: { id: 'ws1', name: 'Studio' }, generation: 1 };
const WORKSPACES = [{ id: 'ws1', name: 'Studio' }, { id: 'ws2', name: 'Home' }, { id: 'ws3', name: 'Empty' }];
const PROJECTS: Record<string, { id: string; name: string; workspace_id: string }[]> = {
  ws1: [{ id: 'p1', name: 'Herdr', workspace_id: 'ws1' }],
  ws2: [{ id: 'p2', name: 'Garden', workspace_id: 'ws2' }],
  ws3: [],
};

type Pending = { t: string; args: Record<string, unknown>; resolve(r: CommandResult): void };

/** A picker whose bridge answers only when the test says so (`answer`), in any order. */
function mount(state: unknown = connected, saved: { ws: string; project: string } | null = null) {
  document.body.replaceChildren();
  const book = new KaneoBook();
  book.reset(state);
  const pending: Pending[] = [];
  const send = (t: string, args: Record<string, unknown>) => new Promise<CommandResult>((resolve) => pending.push({ t, args, resolve }));
  let changes = 0;
  const p = new KaneoPicker(
    { book, send: send as never, debounceMs: 0 },
    saved ? { workspace_id: saved.ws, workspace_name: 'Studio', project_id: saved.project, project_name: 'Herdr' } : null,
    saved?.ws ?? book.state?.default_workspace?.id ?? '',
    saved?.project ?? '',
    () => changes++,
  );
  document.body.append(p.el);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const take = (t: string, ws?: string) => {
    const i = pending.findLastIndex((x) => x.t === t && (ws === undefined || x.args.workspace_id === ws));
    if (i < 0) throw new Error(`no pending ${t} ${ws ?? ''}: ${pending.map((x) => x.t).join(', ')}`);
    return pending.splice(i, 1)[0]!;
  };
  const answer = async (t: string, ws?: string, r?: CommandResult) => {
    const x = take(t, ws);
    x.resolve(r ?? (t === 'kaneo.workspaces' ? { ok: true, data: { workspaces: WORKSPACES, generation: 1 } } : { ok: true, data: { workspace_id: x.args.workspace_id, projects: PROJECTS[x.args.workspace_id as string] ?? [], generation: 1 } }));
    await flush();
  };
  const pick = (ws: string) => {
    p.workspaceSelect.value = ws;
    p.workspaceSelect.dispatchEvent(new Event('change'));
  };
  const options = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);
  return { book, p, pending, answer, pick, options, flush, changes: () => changes };
}

describe('a floor’s Kaneo pickers (#184)', () => {
  it('asks nothing until the floor is switched to Kaneo, then starts at the default workspace and never picks a project', async () => {
    const m = mount();
    expect(m.pending).toHaveLength(0);
    m.p.activate();
    expect(m.options(m.p.workspaceSelect)).toEqual(['Loading workspaces…']);
    await m.answer('kaneo.workspaces');
    expect(m.p.workspace).toBe('ws1');
    expect(m.p.workspaceHint.textContent).toContain('default workspace');
    await m.answer('kaneo.projects', 'ws1');
    expect(m.options(m.p.projectSelect)).toEqual(['Choose a project', 'Herdr']);
    expect(m.p.projectId).toBe('');
  });

  it('switching workspaces quickly: the earlier workspace’s late list never lands, and the project is cleared', async () => {
    const m = mount(connected, { ws: 'ws1', project: 'p1' });
    m.p.activate();
    await m.answer('kaneo.workspaces');
    expect(m.p.projectSelect.value).toBe('p1'); // still loading: the saved one held
    m.pick('ws2');
    expect(m.p.projectId).toBe('');
    m.pick('ws1');
    m.pick('ws2');
    // The answers come back oldest last: only ws2's newest counts.
    await m.answer('kaneo.projects', 'ws2');
    expect(m.options(m.p.projectSelect)).toEqual(['Choose a project', 'Garden']);
    for (const x of [...m.pending]) {
      x.resolve({ ok: true, data: { workspace_id: x.args.workspace_id, projects: PROJECTS[x.args.workspace_id as string], generation: 1 } });
    }
    await m.flush();
    expect(m.options(m.p.projectSelect)).toEqual(['Choose a project', 'Garden']);
    expect(m.p.workspace).toBe('ws2');
    expect(m.p.projectId).toBe('');
  });

  it('says when a workspace has no projects, and when the key may not see them (with Retry)', async () => {
    const m = mount();
    m.p.activate();
    await m.answer('kaneo.workspaces');
    await m.answer('kaneo.projects', 'ws1');
    m.pick('ws3');
    await m.answer('kaneo.projects', 'ws3');
    expect(m.p.projectSelect.disabled).toBe(true);
    expect(m.p.projectHint.textContent).toContain('no projects');
    m.pick('ws2');
    await m.answer('kaneo.projects', 'ws2', { ok: false, code: 'forbidden', message: '' });
    expect(m.p.projectHint.textContent).toContain('may not see');
    const retry = m.p.el.querySelector<HTMLButtonElement>('[data-key="kaneo-retry"]')!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await m.answer('kaneo.projects', 'ws2');
    expect(m.options(m.p.projectSelect)).toEqual(['Choose a project', 'Garden']);
    expect(retry.hidden).toBe(true);
  });

  it('a saved project that is gone is cleared and named; a saved workspace out of reach is marked', async () => {
    const m = mount(connected, { ws: 'ws1', project: 'p-deleted' });
    m.p.activate();
    await m.answer('kaneo.workspaces');
    await m.answer('kaneo.projects', 'ws1');
    expect(m.p.projectId).toBe('');
    expect(m.p.projectHint.textContent).toContain('Herdr is gone or archived');
    const n = mount(connected, { ws: 'ws-gone', project: 'p1' });
    n.p.activate();
    await n.answer('kaneo.workspaces');
    expect(n.options(n.p.workspaceSelect)).toContain('Studio (no access)');
    expect(n.p.workspaceHint.textContent).toContain('does not reach');
  });

  it('without a connection it says where to connect and asks nothing', () => {
    const m = mount({ ...connected, state: 'off', key_set: false, default_workspace: null });
    m.p.activate();
    expect(m.pending).toHaveLength(0);
    expect(m.p.el.textContent).toContain('Settings → Kaneo');
    expect(m.p.workspaceSelect.disabled).toBe(true);
  });

  it('a failed workspace list says why and retries', async () => {
    const m = mount();
    m.p.activate();
    await m.answer('kaneo.workspaces', undefined, { ok: false, code: 'unauthorized', message: '' });
    expect(m.p.workspaceHint.textContent).toContain('quota');
    m.p.el.querySelector<HTMLButtonElement>('[data-key="kaneo-retry"]')!.click();
    await m.answer('kaneo.workspaces');
    expect(m.p.workspaceSelect.disabled).toBe(false);
  });
});
