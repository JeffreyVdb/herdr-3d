// Green since #175: a 100% view shows all rows, whatever the pane's width (it was red against the #74 width fit).
// Run from any directory after `make deps` at the repository root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const game = new URL('../../../game/', import.meta.url);
const require = createRequire(new URL('package.json', game));
const { createServer } = await import(require.resolve('vite'));
const server = await createServer({ configFile: false, root: fileURLToPath(game), server: { middlewareMode: true }, appType: 'custom' });
try {
  const { viewport } = await server.ssrLoadModule('/src/laptop/paint.ts');
  const cases = [120, 60, 40].map((cols) => {
    const shape = { cols, rows: 40, width: 1200, height: 600 };
    const view = viewport({ ...shape, zoom: 100 });
    return { cols, rows: shape.rows, cellHeight: view.ch, visibleRows: view.rows, visibleCols: view.cols };
  });
  console.log(JSON.stringify(cases, null, 2));
  for (const c of cases) assert.equal(c.visibleRows, c.rows, `${c.cols}-column pane at 100% enlarges text and crops rows`);
} finally {
  await server.close();
}
