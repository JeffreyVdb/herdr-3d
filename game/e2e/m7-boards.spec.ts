import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M7: the issues corkboard, the pull request board and the merge gong, on demo-m6 with the simulating fixture server
// (tools/fixture-boards.ts): the `lab` floor (repo JeffreyVdb/lab, a project: Todo / Doing / QA / Done) and `herdr-3d`
// (repo JeffreyVdb/herdr-3d) have boards; `pastry` has no repo. `open=none` keeps window.open quiet.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';

const wall = (page: Page) => page.evaluate(() => window.__h3d.boards());
const board = (page: Page) => page.evaluate(() => window.__h3d.board());

async function enter(page: Page, session = 'lab'): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 4);
}

/** Stands south of the board wall, `dist` m from a board, looking at it. */
async function faceBoard(page: Page, session: string, which: 'issues' | 'prs', dist = 2.6, pitch = 0.04): Promise<void> {
  await page.evaluate(
    ([s, w, d, p]) => {
      const L = window.__h3d.layout(s as string);
      const prop = L?.props.find((x) => x.id === (w === 'issues' ? 'board.issues' : 'board.prs'));
      if (!L || !prop) throw new Error('no board');
      const cx = (prop.box.min[0] + prop.box.max[0]) / 2;
      const z = prop.box.max[2] + (d as number);
      window.__h3d.setPose({ x: cx, z, yaw: 0, pitch: p as number });
    },
    [session, which, dist, pitch] as const,
  );
  await frames(page, 4);
}

test('the corkboard shows the provider’s columns and cards, and the look-at prompt opens the overlay', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await expect.poll(async () => (await wall(page))?.issues.length).toBeGreaterThan(0);
  await faceBoard(page, 'lab', 'issues');
  await shot(page, 'm7-corkboard-lab');
  await faceBoard(page, 'lab', 'prs');
  await shot(page, 'm7-prboard-lab');
  clean();
});
