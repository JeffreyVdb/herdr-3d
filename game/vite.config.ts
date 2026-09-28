import { defineConfig, type Plugin } from 'vitest/config';
import { fixtureUpgradeHandler } from './tools/fixture-server';

/**
 * Serves the recorded bridge streams in fixtures/ at `/fixture/<name>` on the
 * dev and preview servers (open the game with `?ws=/fixture/demo`). Test and
 * dev only: the helper serves the built bundle and proxies the real `/ws`.
 */
function fixtures(): Plugin {
  const handler = fixtureUpgradeHandler();
  return {
    name: 'h3d-fixtures',
    configureServer(server) {
      server.httpServer?.on('upgrade', handler);
    },
    configurePreviewServer(server) {
      server.httpServer.on('upgrade', handler);
    },
  };
}

// Bind to loopback only. The port always comes from the CLI (`--port`), leased
// via portlease by the Makefile; never hardcode one here.
export default defineConfig({
  plugins: [fixtures()],
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  // three/webgpu alone is ~1 MB minified; one chunk is fine for now.
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
