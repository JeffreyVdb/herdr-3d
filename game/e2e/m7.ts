import { expect, type Page } from '@playwright/test';
import { frames } from './game';

// Helpers of the M7 specs (boards on demo-m6 with the simulating fixture server).

export type Wall = NonNullable<Awaited<ReturnType<Window['__h3d']['boards']>>>;

export const wall = (page: Page): Promise<Wall | null> => page.evaluate(() => window.__h3d.boards());
export const board = (page: Page) => page.evaluate(() => window.__h3d.board());

export async function enter(page: Page, session = 'lab'): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 4);
}

/** Stands south of the board wall, `dist` m from a board, looking at it. */
export async function faceBoard(page: Page, session: string, which: 'issues' | 'prs', dist = 2.6, pitch = 0.04): Promise<void> {
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

export async function waitNotes(page: Page, issues: number, prs?: number): Promise<void> {
  await expect
    .poll(async () => {
      const w = await wall(page);
      return w ? [w.issues.filter((n) => !n.leaving).length, w.prs.filter((n) => !n.leaving).length] : null;
    }, { message: 'notes on the wall', timeout: 10_000 })
    .toEqual([issues, prs ?? expect.any(Number)]);
}

export const columns = async (page: Page) => Object.fromEntries(((await board(page))?.columns ?? []).map((c) => [c.name, c.keys]));
