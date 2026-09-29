import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M6 crew on the demo-m6 fixture (tools/gen-fixtures.mjs, from the synthetic
// run dirs in fixtures/runs): the `lab` floor on top of Work has the over-cap
// run in pod 0 (ORCH desk 0 at pass 3 waiting for you, CODE r3 reporting,
// REVIEW r3 CHANGES_REQUIRED with 2 blockers, UX r3 PASS) and the lobby run
// in pods 1-2 (ORCH desk 4 in review at pass 1; GROUND reporting, CODE
// reporting, REVIEW INCOMPLETE, UX blocked on input_required, CODE working,
// GROUND onboarding, CODE just hired), a plain employee at desk 12 and desk 13
// free. With `sim=1`, `sim.crew` walks a scripted freelancer in and out.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

type Crew = Awaited<ReturnType<Window['__h3d']['crew']>>;
type Member = Crew['members'][number];

const crew = (page: Page) => page.evaluate(() => window.__h3d.crew());
const member = async (page: Page, desk: number): Promise<Member> => {
  const m = (await crew(page)).members.find((x) => x.desk === desk);
  if (!m) throw new Error(`no crew member at desk ${desk}`);
  return m;
};

async function enter(page: Page, session = 'lab'): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 4);
}

/** Stands `dist` m from the middle of `desks`, on the side `side` (radians round it), looking at them from eye height. */
async function viewDesks(page: Page, desks: number[], dist: number, side = 0, pitch = -0.32): Promise<void> {
  await page.evaluate(
    ([ds, d, a, p]) => {
      const L = window.__h3d.layout('lab');
      if (!L) throw new Error('no layout');
      const seats = (ds as number[]).map((i) => L.slots[i]?.seat).filter((s): s is { x: number; z: number } => !!s);
      const cx = seats.reduce((t, s) => t + s.x, 0) / seats.length;
      const cz = seats.reduce((t, s) => t + s.z, 0) / seats.length;
      const x = cx + Math.sin(a as number) * (d as number);
      const z = cz + Math.cos(a as number) * (d as number);
      window.__h3d.setPose({ x, z, yaw: Math.atan2(-(cx - x), -(cz - z)), pitch: p as number });
    },
    [desks, dist, side, pitch] as const,
  );
  await frames(page, 4);
}

/** Stands `dist` m in front of a desk's worker, across its desk, facing it. */
async function faceFront(page: Page, desk: number, dist = 2.4, pitch = -0.12): Promise<void> {
  const yaw = await page.evaluate((d) => window.__h3d.layout('lab')?.slots[d]?.yaw ?? 0, desk);
  await viewDesks(page, [desk], dist, yaw, pitch);
}

test('freelancer looks, model cues, stamps, the input_required bubble and the over-cap orchestrator', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const c = await crew(page);
  // Twelve crew members (two runs); the plain employee is not one.
  expect(c.members).toHaveLength(12);
  expect(c.members.some((m) => m.desk === 12)).toBe(false);

  // Role looks: each role's wear, its desk item, the run badge, freelancers' briefcases.
  const orch = await member(page, 0);
  expect(orch).toMatchObject({ role: 'orch', overCap: true, display: 'needs_you' });
  expect(orch.parts).toEqual(expect.arrayContaining(['headset', 'badge', 'passBoard', 'pips', 'clock', 'clockHands', 'sweat']));
  expect(orch.parts).not.toContain('briefcase');
  const code = await member(page, 1);
  expect(code).toMatchObject({ role: 'code', life: 'reporting' });
  expect(code.parts).toEqual(expect.arrayContaining(['hood', 'badge', 'briefcase', 'folder']));
  expect(code.parts).not.toContain('stamp');
  const review = await member(page, 2);
  expect(review).toMatchObject({ role: 'review', life: 'reporting', stamp: 'CHANGES · 2 BLOCKERS' });
  expect(review.parts).toEqual(expect.arrayContaining(['bowtie', 'clipboard', 'folder', 'stamp', 'briefcase']));
  const ux = await member(page, 3);
  expect(ux).toMatchObject({ role: 'ux', life: 'reporting', stamp: 'PASS' });
  expect(ux.parts).toEqual(expect.arrayContaining(['scarf', 'tablet', 'folder', 'stamp']));
  // One run, one badge colour; the other run has another.
  const runs = new Set(c.members.map((m) => m.run));
  expect(runs.size).toBe(2);

  // Model cues stay: coders on Opus (claude beanie), reviewers on Sol (codex cap), via the world the store keeps.
  const world = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')?.workers ?? []);
  expect(world.find((w) => w.desk === 1)?.label).toBe('CODE|overcap|3|r3');

  // The pod of the over-cap run, from the aisle: cards show the tags, the stamps and the orchestrator's call.
  await viewDesks(page, [0, 1, 2, 3], 3.6, Math.PI / 2, -0.22);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.cards())).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  const cards = await page.evaluate(() => window.__h3d.cards());
  const byDesk = (d: number) => cards.find((x) => x.desk === d) as (typeof cards)[number] & { tag?: { text: string }; stamp?: { text: string; tone: string } };
  expect(byDesk(0)).toMatchObject({ display: 'needs_you', ask: { text: 'Past the review cap (pass 3 of 3). It needs your call.' }, tag: { text: 'ORCH · waiting for you · 3/3' } });
  expect(byDesk(2)).toMatchObject({ tag: { text: 'REVIEW r3' }, stamp: { tone: 'changes', text: 'CHANGES · 2 BLOCKERS' } });
  expect(byDesk(3)).toMatchObject({ stamp: { tone: 'pass', text: 'PASS' } });
  await shot(page, 'm6-overcap-pod');
  // The over-cap orchestrator up close: sweating under its red alarm clock, hand up, the red "needs you" bubble.
  await faceFront(page, 0);
  await shot(page, 'm6-overcap-orch');

  // The over-cap orchestrator counts for "N need you": N goes to it.
  const needs = await page.evaluate(() => window.__h3d.needs().filter((n) => n.session === 'lab').map((n) => n.desk));
  expect(needs).toEqual(expect.arrayContaining([0, 8]));

  // The lobby run: INCOMPLETE, the input_required bubble, working / onboarding / hired.
  expect(await member(page, 7)).toMatchObject({ role: 'review', stamp: 'INCOMPLETE' });
  const blocked = await member(page, 8);
  expect(blocked).toMatchObject({ role: 'ux', life: 'blocked', display: 'needs_you' });
  expect(blocked.parts).not.toContain('folder');
  expect(await member(page, 9)).toMatchObject({ role: 'code', life: 'working' });
  const onboarding = await member(page, 10);
  expect(onboarding).toMatchObject({ role: 'ground', life: 'onboarding' });
  expect(onboarding.parts).toEqual(expect.arrayContaining(['backpack', 'magnifier', 'scroll']));
  expect(await member(page, 11)).toMatchObject({ role: 'code', life: 'hired' });
  const lobbyOrch = await member(page, 4);
  expect(lobbyOrch).toMatchObject({ role: 'orch', overCap: false, display: 'idle' });
  expect(lobbyOrch.parts).toEqual(expect.arrayContaining(['headset', 'passBoard', 'pips']));
  expect(lobbyOrch.parts).not.toContain('clock');

  await viewDesks(page, [8, 9, 10, 11], 3.6, Math.PI / 2, -0.22);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.cards())).some((x) => x.desk === 8), { timeout: 10_000 }).toBe(true);
  const lobby = await page.evaluate(() => window.__h3d.cards());
  expect(lobby.find((x) => x.desk === 8)).toMatchObject({ display: 'needs_you', ask: { text: 'Which port should the demo use? 5173 is taken by another worktree.' } });
  await shot(page, 'm6-lobby-pod');
  await viewDesks(page, [4, 5, 6, 7], 3.6, -Math.PI / 2, -0.22);
  await shot(page, 'm6-lobby-reports');
  clean();
});

test('phase and pass: the pass board, the card tag and the look-at bar', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  // Look at the lobby orchestrator (desk 4) from beside its chair.
  const id = (await member(page, 4)).id;
  expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
  await frames(page, 4);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.lookAt()))?.kind).toBe('worker');
  const bar = page.locator('.prompt .prompt-crew');
  await expect(bar.locator('.crew-tag')).toHaveText('ORCH · in review · 1/3');
  await expect(bar.locator('.crew-issue')).toHaveText('JeffreyVdb/lab#4');
  await expect(bar.locator('.crew-phase')).toHaveText('in review · pass 1 of 3');
  const card = (await page.evaluate(() => window.__h3d.cards())).find((x) => x.desk === 4) as { tall: boolean; crew?: string[] };
  expect(card.tall).toBe(true);
  expect(card.crew).toEqual(['JeffreyVdb/lab#4 · run 20260928-1500-lobby', 'In review · pass 1 of 3']);
  await shot(page, 'm6-phase-pass');
  // A reviewer's bar: its stamp and its issue.
  const rid = (await member(page, 2)).id;
  expect(await page.evaluate((w) => window.__h3d.face(w), rid)).toBe(true);
  await frames(page, 4);
  await expect(bar.locator('.crew-tag')).toHaveText('REVIEW r3');
  await expect(bar.locator('.crew-stamp')).toHaveText('CHANGES · 2 BLOCKERS');
  await expect(bar.locator('.crew-issue')).toHaveText('JeffreyVdb/lab#3');
  clean();
});

test('a freelancer walks in with its briefcase, onboards, works, reports and leaves waving', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  await page.evaluate(() => window.__h3d.arrivalRate(4));
  const hire = await page.evaluate(() => window.__h3d.simCrew({ step: 'hire' }));
  expect(hire.ok).toBe(true);
  const id = (hire.data as { id: string }).id;
  // Walks in with the briefcase in hand, no box.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id)?.briefcase, { timeout: 10_000 }).toBe('hand');
  const walkIn = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id);
  expect(walkIn).toMatchObject({ kind: 'in', carry: 'briefcase', box: 'none', laptop: 'none', desk: 13 });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).some((l) => l.id === id && l.played), { timeout: 60_000 }).toBe(true);
  await frames(page, 3);
  expect(await member(page, 13)).toMatchObject({ id, role: 'code', life: 'hired' });
  expect((await member(page, 13)).parts).toContain('briefcase');

  await page.evaluate(() => window.__h3d.simCrew({ step: 'onboard' }));
  await expect.poll(async () => (await member(page, 13)).life).toBe('onboarding');
  await expect.poll(async () => (await member(page, 13)).parts).toContain('scroll');
  await page.evaluate(() => window.__h3d.simCrew({ step: 'work' }));
  await expect.poll(async () => (await member(page, 13)).life).toBe('working');
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', verdict: 'CHANGES_REQUIRED', blockers: 1 }));
  await expect.poll(async () => (await member(page, 13)).stamp).toBe('CHANGES · 1 BLOCKER');
  await expect.poll(async () => (await member(page, 13)).parts).toEqual(expect.arrayContaining(['folder', 'stamp']));

  // Leaving: waves with the briefcase, walks out (not the M4 cardboard box).
  await faceFront(page, 13, 2.8, -0.1);
  await page.evaluate(() => window.__h3d.arrivalRate(1));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'leave' }));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id)?.phase, { timeout: 10_000 }).toBe('wave');
  const waving = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id);
  expect(waving).toMatchObject({ kind: 'out', carry: 'briefcase', wave: true, briefcase: 'hand', box: 'none', laptop: 'none' });
  await shot(page, 'm6-leave-wave');
  await page.evaluate(() => window.__h3d.arrivalRate(4));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id)?.phase, { timeout: 10_000 }).toBe('walk');
  expect((await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id)).toMatchObject({ briefcase: 'hand', box: 'none', wave: false });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).some((l) => l.id === id && l.kind === 'out' && l.played), { timeout: 60_000 }).toBe(true);
  expect((await crew(page)).members.some((m) => m.id === id)).toBe(false);
  clean();
});

test('frame budget: crew parts are instanced, and a floor without a run draws none of them', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page, 'pastry');
  expect((await crew(page)).shown).toEqual([]);
  await enter(page);
  const shown = (await crew(page)).shown;
  // One InstancedMesh per part for the whole floor: at most one per crew part kind.
  expect(shown.length).toBeGreaterThan(10);
  expect(shown.length).toBeLessThanOrEqual(18);
  // The draw-call delta: the same view, benched with the crews and with every crew member made a plain worker.
  await viewDesks(page, [0, 1, 2, 3, 4, 5, 6, 7], 6, Math.PI / 2, -0.3);
  const withCrew = await page.evaluate(() => window.__h3d.bench({ frames: 20 }));
  const ids = (await crew(page)).members.map((m) => m.id);
  await page.evaluate((list) => {
    let seq = 9_000_000;
    for (const f of window.__h3d.world()) {
      for (const w of f.workers) {
        if (!list.includes(w.id)) continue;
        // A role the game does not know: no crew look (the label says nothing either).
        window.__h3d.inject({ t: 'worker.upsert', seq: seq++, worker: { id: w.id, session: f.session, workspace_id: `x${seq}`, label: 'plain', status: w.status, name: w.name, desk_index: w.desk, role: 'none' } } as never);
      }
    }
  }, ids);
  await frames(page, 4);
  expect((await crew(page)).shown).toEqual([]);
  const plain = await page.evaluate(() => window.__h3d.bench({ frames: 20 }));
  console.log(`m6 draw calls: ${JSON.stringify({ withCrew: withCrew.drawCalls, plain: plain.drawCalls, delta: withCrew.drawCalls - plain.drawCalls, crewParts: shown.length, crewMembers: ids.length })}`);
  // Instanced: the delta is per part kind (and its shadow), never per worker.
  expect(withCrew.drawCalls - plain.drawCalls).toBeLessThanOrEqual(2 * 18);
  clean();
});
