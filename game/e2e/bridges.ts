import type { Page } from '@playwright/test';

// #57: the Mac helper's bridge list, faked with `page.route` (the preview server has no helper): GET, POST, PUT,
// DELETE and activate on /api/bridges, kept in this process so it survives the page's reloads, refusing like
// h3d-helper does (its words). The page gets the helper token the way the helper hands it over (localStorage).

export interface FakeBridge {
  id: string;
  name: string;
  kind: 'ssh' | 'local';
  host?: string;
  remote_socket?: string;
  socket?: string;
  state: string;
  last_error?: string;
  version?: string;
}

export interface FakeHelper {
  state: { bridges: FakeBridge[]; active: string };
  calls: Array<{ method: string; path: string; token: string | undefined; body: unknown }>;
}

export const TOKEN = 'tok-57';

const address = (b: FakeBridge) => (b.kind === 'local' ? (b.socket ?? '') : b.remote_socket ? `${b.host}:${b.remote_socket}` : (b.host ?? ''));

export async function fakeHelper(page: Page, bridges: FakeBridge[], active: string, o: { activateMs?: number } = {}): Promise<FakeHelper> {
  const h: FakeHelper = { state: { bridges: bridges.map((b) => ({ ...b })), active }, calls: [] };
  let n = 0;
  const list = () => ({ active: h.state.active, bridges: h.state.bridges.map((b) => ({ ...b, address: address(b), active: b.id === h.state.active })) });
  await page.addInitScript((t) => localStorage.setItem('h3d.token', t), TOKEN);
  await page.route('**/api/bridges**', async (route) => {
    const r = route.request();
    const path = new URL(r.url()).pathname;
    const body = r.postData() ? (r.postDataJSON() as Record<string, string>) : null;
    h.calls.push({ method: r.method(), path, token: r.headers()['x-h3d-token'], body });
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const refuse = (status: number, message: string) => json(status, { t: 'error', code: 'invalid', message });
    if (r.headers()['x-h3d-token'] !== TOKEN) return refuse(403, 'the helper refused the request (bad token)');
    const m = /^\/api\/bridges(?:\/([0-9a-z]+))?(\/activate)?$/.exec(path);
    const id = m?.[1];
    const row = h.state.bridges.find((b) => b.id === id);
    if (r.method() === 'GET' && !id) return json(200, list());
    if (r.method() === 'POST' && !id && body) {
      const name = (body.name ?? '').trim();
      if (!name) return refuse(400, 'name is empty');
      if (h.state.bridges.some((b) => b.name.toLowerCase() === name.toLowerCase())) return refuse(400, `a bridge named "${name}" exists already: pick another name`);
      if (body.kind === 'ssh' && body.host?.startsWith('-')) return refuse(400, `host "${body.host}" starts with '-': want [user@]host`);
      const b: FakeBridge = { id: `e2e${++n}`.padEnd(10, '0'), name, kind: body.kind as 'ssh' | 'local', ...(body.kind === 'local' ? { socket: body.socket ?? '' } : { host: body.host ?? '', remote_socket: body.remote_socket ?? '' }), state: 'connecting' };
      h.state.bridges.push(b);
      if (!h.state.active) h.state.active = b.id;
      return json(200, list());
    }
    if (!row) return refuse(404, `no bridge ${id ?? ''}`);
    if (r.method() === 'PUT' && body) {
      Object.assign(row, { name: (body.name ?? '').trim(), kind: body.kind, host: body.host, remote_socket: body.remote_socket, socket: body.socket });
      return json(200, list());
    }
    if (r.method() === 'DELETE') {
      if (row.id === h.state.active) return refuse(409, `${row.name} is the bridge in use: switch to another bridge before removing it`);
      h.state.bridges = h.state.bridges.filter((b) => b !== row);
      return json(200, list());
    }
    if (r.method() === 'POST' && m?.[2]) {
      if (o.activateMs) await new Promise((res) => setTimeout(res, o.activateMs));
      h.state.active = row.id;
      return json(200, list());
    }
    return refuse(405, 'method not allowed');
  });
  return h;
}
