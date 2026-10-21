// Intentionally red against the current renderer: a 100% view should show all rows.
// Run from any directory after `make deps` at the repository root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const game = new URL('../../../game/', import.meta.url);
const require = createRequire(new URL('package.json', game));
const { createServer } = await import(require.resolve('vite'));
const server = await createServer({ configFile: false, root: fileURLToPath(game), server: { middlewareMode: true }, appType: 'custom' });
try {
  const { viewport, widthFit } = await server.ssrLoadModule('/src/laptop/paint.ts');
  const cases = [120, 60, 40].map((cols) => {
    const shape = { cols, rows: 40, width: 1200, height: 600 };
    const view = viewport({ ...shape, fitWidth: true, zoom: 100 });
    const withoutWidthFit = viewport({ ...shape, fitWidth: false, zoom: 100 });
    return { cols, rows: shape.rows, multiplier: widthFit(shape), cellHeight: view.ch, visibleRows: view.rows, withoutWidthFitRows: withoutWidthFit.rows };
  });
  console.log(JSON.stringify(cases, null, 2));
  assert.equal(cases[1].visibleRows, 40, '60-column split at 100% unexpectedly enlarges text and crops rows');
} finally {
  await server.close();
}
