import { defineConfig, type Plugin } from 'vitest/config';
import { creditsText, MANIFEST } from './src/audio/tracks.ts';
import { fixtureUpgradeHandler } from './tools/fixture-server.ts';
import { holdRows } from './tools/music.ts';

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

/**
 * M15: `MUSIC_CREDITS.txt` next to the build output, generated from
 * music/manifest.json (the credits panel reads the same file). With
 * `H3D_RELEASE=1` the build fails while any track is on claim hold.
 */
function musicCredits(): Plugin {
  return {
    name: 'h3d-music-credits',
    buildStart() {
      const hold = process.env.H3D_RELEASE ? holdRows(MANIFEST.tracks) : [];
      if (hold.length) this.error(`release build: ${hold.length} music track(s) are not claim-cleared:\n${hold.join('\n')}`);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'MUSIC_CREDITS.txt', source: `${creditsText(MANIFEST.tracks, MANIFEST.targetLufs)}\n` });
    },
  };
}

// Bind to loopback only. The port always comes from the CLI (`--port`), leased
// via portlease by the Makefile; never hardcode one here.
export default defineConfig({
  plugins: [fixtures(), musicCredits()],
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  // three/webgpu alone is ~1 MB minified; one chunk is fine for now.
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
