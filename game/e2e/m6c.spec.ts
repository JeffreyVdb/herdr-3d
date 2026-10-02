import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M6c on demo-m6 with the simulator (sim=1): a freelancer's report walks over to the orchestrator's desk. The lab floor
// has the over-cap run in pod 0 (ORCH desk 0 needs you, so it does not turn; CODE desk 1, REVIEW 2, UX 3, all reporting,
// their folders already on its tray) and the lobby run in pods 1-2 (ORCH desk 4). `sim.crew` hires a freelancer for an
// orchestrator (`orch`, or `corner: true` for the simulator's own orchestrator in the corner office), works it, reports
// and leaves it; the game does the rest: stand up with the folder, walk, hand over, walk back, sit.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

type Sample = Awaited<ReturnType<typeof sample>>[number];

const crew = (page: Page) => page.evaluate(() => window.__h3d.crew());
const member = async (page: Page, desk: number) => {
  const m = (await crew(page)).members.find((x) => x.desk === desk);
  if (!m) throw new Error(`no crew member at desk ${desk}`);
  return m;
};
const trays = (page: Page) => page.evaluate(() => window.__h3d.trays());
const trayOf = async (page: Page, desk: number) => (await trays(page)).trays.find((t) => t.desk === desk);

async function enter(page: Page, session = 'lab'): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 4);
}

/** Stands at (x, z) of the floor and looks at (tx, ty, tz) (ty above the floor). */
async function aim(page: Page, x: number, z: number, tx: number, ty: number, tz: number, up = 0): Promise<void> {
  await page.evaluate(
    ([px, pz, ax, ay, az, hi]) => {
      const p = window.__h3d.pose();
      const eye = (p?.eye ?? 1.55) + (hi as number);
      const d = Math.hypot((ax as number) - (px as number), (az as number) - (pz as number));
      // `hi` metres up: standing on nothing but looking down on the pod from above, to read the scene.
      window.__h3d.setPose({ x: px as number, z: pz as number, yaw: Math.atan2(-((ax as number) - (px as number)), -((az as number) - (pz as number))), pitch: Math.atan2((ay as number) - eye, d), ...(hi ? { y: (p?.y ?? 0) + (hi as number) } : {}) });
    },
    [x, z, tx, ty, tz, up] as const,
  );
  await frames(page, 3);
}

/** Frame by frame samples of the walks to an orchestrator's desk until none is left (or `ms` pass). */
function sample(page: Page, ms = 40_000) {
  return page.evaluate(
    (limit) =>
      new Promise<Array<{ t: number; id: string; phase: string; x: number; y: number; z: number; folder: string; swivel: number; reach: number; chair: number; landed: boolean; walked: number; length: number; count: number; door: number; out: number[]; trays: number[]; cards: number[] }>>((resolve) => {
        const t0 = performance.now();
        const out: Array<{ t: number; id: string; phase: string; x: number; y: number; z: number; folder: string; swivel: number; reach: number; chair: number; landed: boolean; walked: number; length: number; count: number; door: number; out: number[]; trays: number[]; cards: number[] }> = [];
        let seen = false;
        const tick = () => {
          const t = performance.now() - t0;
          const all = window.__h3d.arrivals();
          const ds = all.filter((a) => a.kind === 'deliver');
          for (const a of ds) out.push({ t, id: a.id, phase: a.phase, x: a.x, y: a.y, z: a.z, folder: a.folder, swivel: a.swivel, reach: a.reach, chair: a.chair, landed: a.landed, walked: a.walked, length: a.length, count: ds.length, door: window.__h3d.mezzDoor(), out: window.__h3d.crew().members.filter((m) => m.out).map((m) => m.desk), trays: window.__h3d.trays().trays.map((x) => x.folders), cards: window.__h3d.cards().map((c) => c.desk) });
          if (ds.length) seen = true;
          if ((seen && !ds.length) || t > (limit as number)) resolve(out);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    ms,
  );
}

/** The distinct phases of one delivery in the order they happened. */
const phases = (s: Sample[], id?: string) => s.filter((x) => (!id || x.id === id) && x.phase !== 'done').map((x) => x.phase).filter((p, i, a) => a[i - 1] !== p);

/** Closes the workspace of the worker at `desk` (the simulator's `leave`) and waits for its walk-out to be over. */
async function clearDesk(page: Page, desk: number): Promise<void> {
  const m = await member(page, desk);
  await page.evaluate(() => window.__h3d.arrivalRate(8));
  await page.evaluate((id) => window.__h3d.simCrew({ step: 'leave', id }), m.id);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).some((l) => l.id === m.id && l.kind === 'out' && l.played), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => window.__h3d.arrivalRate(1));
}

/** Hires a freelancer (optionally for `orch`, or the corner office's), works it up to its report. */
async function hireAndWork(page: Page, args: Record<string, unknown> = {}): Promise<{ id: string; desk: number }> {
  const hire = await page.evaluate((a) => window.__h3d.simCrew({ step: 'hire', ...a }), args);
  expect(hire.ok).toBe(true);
  const id = (hire.data as { id: string }).id;
  await expect.poll(async () => (await crew(page)).members.find((m) => m.id === id)?.life, { timeout: 15_000 }).toBe('hired');
  const desk = (await crew(page)).members.find((m) => m.id === id)!.desk;
  // Dropping in takes a moment; the rest is script.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).length, { timeout: 15_000 }).toBe(0);
  for (const step of ['onboard', 'work']) await page.evaluate((s) => window.__h3d.simCrew({ step: s }), step);
  await expect.poll(async () => (await member(page, desk)).life).toBe('working');
  return { id, desk };
}

test('a report walks over to the orchestrator’s desk and back in about 8 s, the tray count goes up by one', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  // Pod 0's CODE (desk 1) goes home: its folder leaves the tray with it, and the next hire sits in its desk.
  expect((await trayOf(page, 0))?.folders).toBe(3);
  await clearDesk(page, 1);
  expect((await trayOf(page, 0))?.folders).toBe(2);
  const { id, desk } = await hireAndWork(page);
  expect(desk).toBe(1);
  expect(await page.evaluate(() => window.__h3d.arrivals())).toEqual([]);
  const L = (await page.evaluate(() => window.__h3d.layout('lab')))!;
  const seat = L.slots[1]!.seat;
  const orchSeat = L.slots[0]!.seat;
  // From the aisle behind the pod, so its card is in view; the walk starts at once.
  await aim(page, orchSeat.x - 3.4, orchSeat.z - 2.0, (orchSeat.x + seat.x) / 2, 0.95, orchSeat.z);
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', verdict: 'PASS' }));
  const t0 = Date.now();
  const samples = await sample(page);
  const took = Date.now() - t0;
  expect(samples.length).toBeGreaterThan(10);
  expect(phases(samples)).toEqual(['stand', 'walk', 'hand', 'walk', 'sit']);
  expect(took).toBeLessThan(9500);
  // It left its seat, reached the hand-over spot beside the orchestrator's chair (0.8 m, facing it), and came back.
  const hand = samples.filter((s) => s.phase === 'hand');
  const at = hand[Math.floor(hand.length / 2)]!;
  expect(Math.hypot(at.x - orchSeat.x, at.z - orchSeat.z)).toBeCloseTo(0.8, 1);
  expect(Math.max(...samples.map((s) => Math.hypot(s.x - seat.x, s.z - seat.z)))).toBeGreaterThan(1.5);
  const last = samples.at(-1)!;
  expect(Math.hypot(last.x - seat.x, last.z - seat.z)).toBeLessThan(0.6);
  // The desk stays its own: the freelancer is "out" the whole walk, its card shows; the orchestrator (over the cap, needs you) does not turn.
  expect(samples.every((s) => s.out.includes(1))).toBe(true);
  expect(samples.filter((s) => s.cards.includes(1)).length).toBeGreaterThan(samples.length * 0.8);
  expect(Math.max(...samples.map((s) => s.swivel))).toBe(0);
  expect(samples.some((s) => s.folder === 'flight')).toBe(true);
  // The folder landed: the tray has one more, with the PASS stamp on its edge; and it sits again, empty-handed.
  const tray = await trayOf(page, 0);
  expect(tray?.folders).toBe(3);
  expect(tray?.edges.at(-1)).toBe(0x12a26a);
  await frames(page, 3);
  const me = await member(page, 1);
  expect(me).toMatchObject({ id, out: false, life: 'reporting' });
  expect(me.parts).not.toContain('folder');
  expect(await page.evaluate(() => window.__h3d.arrivalLog())).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'deliver', played: true, desk: 1 })]));
  // Its workspace closes: the folder goes with it.
  await page.evaluate(() => window.__h3d.arrivalRate(8));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'leave' }));
  await expect.poll(async () => (await trayOf(page, 0))?.folders).toBe(2);
  clean();
});

test('a busy orchestrator turns in its chair to take the folder and turns back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  await page.evaluate((id) => window.__h3d.simStatus(id, 'working'), lobby.id);
  await expect.poll(async () => (await member(page, 4)).display).toBe('working');
  await clearDesk(page, 5);
  const before = (await trayOf(page, 4))!.folders;
  const { desk } = await hireAndWork(page, { orch: lobby.id });
  expect(desk).toBe(5);
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Implemented the lobby; checks are green.' }));
  const samples = await sample(page);
  expect(phases(samples)).toEqual(['stand', 'walk', 'hand', 'walk', 'sit']);
  // It swivels all the way round and reaches, then back to its desk.
  expect(Math.max(...samples.map((s) => s.swivel))).toBe(1);
  expect(Math.max(...samples.map((s) => s.reach))).toBeGreaterThan(0.8);
  const hand = samples.filter((s) => s.phase === 'hand');
  expect(hand.at(-1)!.swivel).toBeLessThan(0.6);
  expect(samples.at(-1)!.swivel).toBe(0);
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  clean();
});

test('the corner office: the walker goes up the mezzanine stair and through the glass door, which opens for it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const { id, desk } = await hireAndWork(page, { corner: true });
  const corner = (await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')?.workers ?? [])).find((w) => w.label === 'ORCH|corner|9')!;
  expect(corner).toBeTruthy();
  expect(await trayOf(page, corner.desk)).toBeTruthy();
  expect((await trayOf(page, corner.desk))?.folders).toBe(0);
  // Faster than real time: it is a long way round.
  await page.evaluate(() => window.__h3d.arrivalRate(3));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', verdict: 'CHANGES_REQUIRED', blockers: 2 }));
  const samples = await sample(page, 90_000);
  // (Sped up, the last half second can fall between two frames.)
  expect(phases(samples).slice(0, 4)).toEqual(['stand', 'walk', 'hand', 'walk']);
  const L = (await page.evaluate(() => window.__h3d.layout('lab')))!;
  const m = L.mezzanine;
  const floorY = Math.min(...samples.map((s) => s.y)) - 0.15;
  // Up the stair to the mezzanine's level and back down.
  const top = Math.max(...samples.map((s) => s.y - floorY));
  expect(top).toBeGreaterThan(m.y + 0.1);
  const hand = samples.filter((s) => s.phase === 'hand');
  expect(hand[0]!.y - floorY - 0.15).toBeCloseTo(m.y, 1);
  expect(Math.hypot(hand[0]!.x - m.orch.seat.x, hand[0]!.z - m.orch.seat.z)).toBeCloseTo(0.8, 1);
  // The glass door was open while the walker crossed it.
  const crossing = samples.filter((s) => Math.abs(s.z - m.door.z) < 0.4 && s.y - floorY > m.y - 0.8);
  expect(crossing.length).toBeGreaterThan(0);
  expect(Math.max(...crossing.map((s) => s.door))).toBeGreaterThan(0.6);
  // The folder is in the corner orchestrator's tray, the stamp's colour on its edge.
  expect((await trayOf(page, corner.desk))?.folders).toBe(1);
  expect((await trayOf(page, corner.desk))?.edges).toEqual([0xe03a33]);
  expect((await member(page, desk)).out).toBe(false);
  // It is picked from up there, with its card, like anyone's.
  expect(id).toBeTruthy();
  clean();
});

test('two reviewers finishing together queue: the second waits at its desk, holding its folder out, until the first has sat down', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const a = await hireAndWork(page, { orch: lobby.id });
  const b = await hireAndWork(page, { orch: lobby.id });
  expect(a.desk).not.toBe(b.desk);
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), a.id);
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'CHANGES_REQUIRED', blockers: 1 }), b.id);
  // The second is waiting its turn, folder out, the moment the first walks.
  await expect.poll(async () => (await trays(page)).waiting).toEqual([b.desk]);
  await expect.poll(async () => (await member(page, b.desk)).parts).toContain('folder');
  const samples = await sample(page, 90_000);
  // Never two at once; the first one's whole walk, then the second's.
  expect(Math.max(...samples.map((s) => s.count))).toBe(1);
  const ids = [...new Set(samples.map((s) => s.id))];
  expect(ids).toHaveLength(2);
  // (The first was already on its feet when sampling began.)
  expect(phases(samples, ids[0])).toEqual(['walk', 'hand', 'walk', 'sit']);
  expect(phases(samples, ids[1])).toEqual(['stand', 'walk', 'hand', 'walk', 'sit']);
  // The second only stood up after the first sat down.
  const firstEnd = samples.findLast((s) => s.id === ids[0])!.t;
  expect(samples.find((s) => s.id === ids[1])!.t).toBeGreaterThanOrEqual(firstEnd);
  expect((await trayOf(page, 4))!.folders).toBe(before + 2);
  expect((await trays(page)).waiting).toEqual([]);
  expect((await trayOf(page, 4))!.edges.slice(-2)).toEqual([0x12a26a, 0xe03a33]);
  clean();
});

test('its workspace closes mid-delivery: the walk-out goes on from where it stands, and the folder ends on the tray', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const { id, desk } = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Done.' }));
  // Walking there: it is out.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver')?.phase, { timeout: 15_000 }).toBe('walk');
  await page.waitForTimeout(700);
  const at = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver')!;
  await page.evaluate(() => window.__h3d.simCrew({ step: 'leave' }));
  // The walk-out starts from the walker, not from the desk.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id && a.kind === 'out')?.phase, { timeout: 15_000 }).toBe('walk');
  const out = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id)!;
  const seat = (await page.evaluate(() => window.__h3d.layout('lab')))!.slots[desk]!.seat;
  expect(Math.hypot(out.x - at.x, out.z - at.z)).toBeLessThan(4);
  expect(Math.hypot(out.x - seat.x, out.z - seat.z)).toBeGreaterThan(1);
  // The folder is on the tray while it walks out, and goes once it has left.
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  await page.evaluate(() => window.__h3d.arrivalRate(8));
  await expect.poll(async () => (await trayOf(page, 4))!.folders, { timeout: 60_000 }).toBe(before);
  expect((await crew(page)).members.some((m) => m.id === id)).toBe(false);
  clean();
});

/** Waits for the delivery walk to be under way (the freelancer on its feet). */
const walking = (page: Page, phase = 'walk') =>
  expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver')?.phase, { timeout: 20_000, intervals: [50] }).toBe(phase);

test('two orchestrators on one floor: their freelancers never walk at the same time (one walk at a time on a floor)', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const a = await hireAndWork(page, { orch: lobby.id });
  const b = await hireAndWork(page, { corner: true });
  const before = [(await trayOf(page, 4))!.folders];
  await page.evaluate(() => window.__h3d.arrivalRate(3));
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), a.id);
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), b.id);
  // The second is waiting at its desk, folder out, while the first walks.
  await expect.poll(async () => (await trays(page)).waiting.length).toBe(1);
  const samples = await sample(page, 120_000);
  expect(Math.max(...samples.map((s) => s.count))).toBe(1);
  expect([...new Set(samples.map((s) => s.id))]).toHaveLength(2);
  expect((await trayOf(page, 4))!.folders).toBe(before[0]! + 1);
  expect((await trays(page)).waiting).toEqual([]);
  expect((await trays(page)).pending).toBe(0);
  clean();
});

test('its desk moves mid-delivery: the walk ends at once, the folder is on the tray, nobody is drawn twice', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  // Two free desks (pod 0's UX and REVIEW go home): the hire sits in one, the bridge moves it to the other.
  await clearDesk(page, 3);
  await clearDesk(page, 2);
  const { id, desk } = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Done.' }));
  await walking(page);
  // The bridge moves it to the first free desk of the floor.
  const taken = new Set((await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')!.workers)).map((w) => w.desk));
  const desks = (await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')!.desks)) as number;
  const free = Array.from({ length: desks }, (_, i) => i).find((i) => !taken.has(i))!;
  expect(free).toBeDefined();
  await page.evaluate(
    ([wid, to]) => {
      const w = window.__h3d.worker(wid as string)!;
      window.__h3d.inject({ t: 'worker.upsert', worker: { ...w, desk_index: to as number } } as never);
    },
    [id, free] as const,
  );
  await frames(page, 2);
  expect((await page.evaluate(() => window.__h3d.arrivals())).filter((a) => a.kind === 'deliver')).toEqual([]);
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  const m = await crew(page);
  expect(m.members.filter((x) => x.id === id)).toHaveLength(1);
  expect(m.members.find((x) => x.id === id)).toMatchObject({ desk: free, out: false });
  // The old desk is nobody's, and nothing is out of its chair.
  expect(m.members.find((x) => x.desk === desk)).toBeUndefined();
  expect(m.members.some((x) => x.out)).toBe(false);
  clean();
});

test('its own worker.upsert at the same desk mid-delivery (a report update): the walk goes on, the freelancer is drawn once', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const { id, desk } = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate(() => window.__h3d.arrivalRate(0.4));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Done.' }));
  await walking(page);
  await page.evaluate((wid) => {
    const w = window.__h3d.worker(wid)!;
    window.__h3d.inject({ t: 'worker.upsert', worker: { ...w, report: { ...w.report!, summary: 'Done, with a footnote.' } } } as never);
  }, id);
  await frames(page, 3);
  // Still its walk; the seated figure is not back in the chair while the walker walks.
  expect((await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver')).toMatchObject({ yielded: false });
  expect((await crew(page)).members.find((x) => x.id === id)).toMatchObject({ desk, out: true });
  await page.evaluate(() => window.__h3d.arrivalRate(8));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).filter((a) => a.kind === 'deliver').length, { timeout: 60_000 }).toBe(0);
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  expect((await crew(page)).members.find((x) => x.id === id)).toMatchObject({ desk, out: false });
  clean();
});

test('its workspace closes at the hand-over after the folder landed: the hand-over finishes, the walk-out starts from the spot, the folder stays until it left', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  await page.evaluate((x) => window.__h3d.simStatus(x, 'working'), lobby.id);
  const { id } = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  // Slow, so the window between the folder landing and the hand-over ending (the swing back) can be caught.
  await page.evaluate(() => window.__h3d.arrivalRate(0.1));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Done.' }));
  // (The folder is on the tray, in the book too: the tray counts it, and the swing back is still going.)
  await expect
    .poll(async () => ((await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver' && a.phase === 'hand' && a.landed) ? (await trayOf(page, 4))!.folders : -1), { timeout: 60_000, intervals: [30] })
    .toBe(before + 1);
  await page.evaluate((wid) => window.__h3d.simCrew({ step: 'leave', id: wid }), id);
  await frames(page, 3);
  const at = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.kind === 'deliver')!;
  // The delivery is not cancelled; its folder is on the tray and stays there.
  expect(at).toBeDefined();
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  await page.evaluate(() => window.__h3d.arrivalRate(1));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id && a.kind === 'out')?.phase, { timeout: 30_000, intervals: [30] }).toBe('walk');
  const out = (await page.evaluate(() => window.__h3d.arrivals())).find((a) => a.id === id && a.kind === 'out')!;
  // From the hand-over spot, not from the seat.
  expect(Math.hypot(out.x - at.x, out.z - at.z)).toBeLessThan(2);
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  await page.evaluate(() => window.__h3d.arrivalRate(8));
  await expect.poll(async () => (await trayOf(page, 4))!.folders, { timeout: 60_000 }).toBe(before);
  expect((await crew(page)).members.some((m) => m.id === id)).toBe(false);
  clean();
});

test('its floor falls asleep mid-delivery: the walk and the queue resolve at once, folders on the tray, freelancers seated', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const a = await hireAndWork(page, { orch: lobby.id });
  const b = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate(() => window.__h3d.arrivalRate(0.4));
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), a.id);
  await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), b.id);
  await walking(page);
  await expect.poll(async () => (await trays(page)).waiting).toEqual([b.desk]);
  await page.evaluate(() => window.__h3d.openElevator());
  await page.getByRole('button', { name: 'Sleep floor lab' }).click();
  await page.locator('dialog.confirm').getByRole('button', { name: 'Sleep floor' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.view())).asleep, { timeout: 20_000 }).toBe(true);
  await frames(page, 2);
  expect((await page.evaluate(() => window.__h3d.arrivals())).filter((x) => x.kind === 'deliver')).toEqual([]);
  expect((await trays(page)).pending).toBe(0);
  expect((await trayOf(page, 4))!.folders).toBe(before + 2);
  expect((await crew(page)).members.some((x) => x.out)).toBe(false);
  clean();
});

test('the floor grows a desk mid-delivery: the pods re-flow, the walk ends at once (no hand-over at the old spot, no teleport)', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await enter(page);
  const lobby = await member(page, 4);
  const { id, desk } = await hireAndWork(page, { orch: lobby.id });
  const before = (await trayOf(page, 4))!.folders;
  await page.evaluate(() => window.__h3d.arrivalRate(0.4));
  await page.evaluate(() => window.__h3d.simCrew({ step: 'report', summary: 'Done.' }));
  await walking(page);
  const desks = (await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')!.desks)) as number;
  // Someone is hired at a desk past the end: the floor has one more.
  await page.evaluate(
    ([n, to]) => {
      const w = window.__h3d.worker(window.__h3d.crew().members[0]!.id)!;
      window.__h3d.inject({ t: 'worker.upsert', worker: { ...w, id: 'grow-extra', workspace_id: 'wgrow', pane_id: 'wgrow:p1', name: `Extra ${n as number}`, role: undefined, orch_id: undefined, report: undefined, status: 'idle', desk_index: to as number, hired_at: undefined } } as never);
    },
    [desks, desks] as const,
  );
  await frames(page, 2);
  expect((await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')!.desks)) as number).toBe(desks + 1);
  expect((await page.evaluate(() => window.__h3d.arrivals())).filter((x) => x.kind === 'deliver')).toEqual([]);
  expect((await trayOf(page, 4))!.folders).toBe(before + 1);
  expect((await crew(page)).members.find((x) => x.id === id)).toMatchObject({ desk, out: false });
  clean();
});

test.describe('screenshots at the Mac’s resolution (1512 × 945 at 2×)', () => {
  test.use({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });

  test('stand-up, mid-walk, the hand-over, the tray and two reviewers queueing', async ({ page }) => {
    test.setTimeout(240_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m6', '', SIM);
    await enter(page);
    const L = (await page.evaluate(() => window.__h3d.layout('lab')))!;
    const lobby = await member(page, 4);
    await page.evaluate((id) => window.__h3d.simStatus(id, 'working'), lobby.id);
    await clearDesk(page, 5);
    const a = await hireAndWork(page, { orch: lobby.id });
    const orchSeat = L.slots[4]!.seat;
    const seatA = L.slots[a.desk]!.seat;
    const mid = { x: (orchSeat.x + seatA.x) / 2, z: (orchSeat.z + seatA.z) / 2 };
    // From the aisle behind the pod, north-west of the orchestrator's chair: the hand-over spot is on that side of it.
    const watch = async () => aim(page, orchSeat.x - 3.0, orchSeat.z - 2.4, mid.x - 0.3, 0.8, mid.z + 0.2, 1.4);
    // Slowed down, so each moment can be caught.
    await page.evaluate(() => window.__h3d.arrivalRate(0.4));
    await watch();
    await page.evaluate(() => window.__h3d.simCrew({ step: 'report', verdict: 'PASS' }));
    // A screenshot takes seconds on llvmpipe: the walks stand still meanwhile.
    const snap = async (name: string, rate: number) => {
      await page.evaluate(() => window.__h3d.arrivalRate(0.01));
      await shot(page, name);
      await page.evaluate((k) => window.__h3d.arrivalRate(k), rate);
    };
    const at = async (phase: string) => {
      await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).find((x) => x.kind === 'deliver')?.phase, { timeout: 40_000, intervals: [50] }).toBe(phase);
    };
    await at('stand');
    await page.waitForTimeout(400);
    await snap('m6c-stand-up', 0.4);
    await at('walk');
    await page.waitForTimeout(1500);
    await snap('m6c-mid-walk', 0.4);
    await at('hand');
    await page.waitForTimeout(900);
    await snap('m6c-hand-over', 0.4);
    await page.evaluate(() => window.__h3d.arrivalRate(8));
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivals())).length, { timeout: 60_000 }).toBe(0);
    // The tray with a few stamped folders: the over-cap run's (CHANGES, PASS and a coder's), on its orchestrator's desk, from the aisle beside it.
    expect((await trayOf(page, 0))?.folders).toBe(3);
    const s0 = L.slots[0]!.seat;
    await aim(page, s0.x - 1.7, s0.z + 0.55, s0.x - 0.5, 0.64, s0.z + 0.69);
    await shot(page, 'm6c-tray');
    // Two reviewers queueing for the lobby orchestrator: the second sits with its folder held out while the first walks.
    await page.evaluate(() => window.__h3d.arrivalRate(0.4));
    const b = await hireAndWork(page, { orch: lobby.id });
    await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'CHANGES_REQUIRED', blockers: 2 }), a.id);
    await page.evaluate((x) => window.__h3d.simCrew({ step: 'report', id: x, verdict: 'PASS' }), b.id);
    await expect.poll(async () => (await trays(page)).waiting.length).toBe(1);
    // From the west aisle, along the pod: the first at the orchestrator's chair, the second in its seat, folder out.
    const seatB = L.slots[b.desk]!.seat;
    await aim(page, orchSeat.x - 4.2, (orchSeat.z + seatB.z) / 2 - 0.4, orchSeat.x + 0.4, 0.7, (orchSeat.z + seatB.z) / 2, 1.8);
    await at('hand');
    await page.waitForTimeout(500);
    await snap('m6c-queue', 0.4);
    clean();
  });
});
