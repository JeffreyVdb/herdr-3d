import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import { creditsText, MANIFEST } from './src/audio/tracks.ts';
import { FONT_LICENSES_FILE, fontLicensesText } from './src/ui/fontCredits.ts';
import { fixtureUpgradeHandler } from './tools/fixture-server.ts';
import { logoRoute } from './tools/fixture-logo.ts';
import { uploadRoute } from './tools/fixture-upload.ts';
import { screenRoute } from './tools/fixture-share.ts';
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
      server.middlewares.use((req, res, next) => (logoRoute(req, res) || uploadRoute(req, res) || screenRoute(req, res) ? undefined : next()));
    },
    configurePreviewServer(server) {
      server.httpServer.on('upgrade', handler);
      // M3d: the bridge's /logo/<building> routes, for a simulated world (tools/fixture-logo.ts); #51: /upload (tools/fixture-upload.ts).
      server.middlewares.use((req, res, next) => (logoRoute(req, res) || uploadRoute(req, res) || screenRoute(req, res) ? undefined : next()));
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

/**
 * #59: `FONT_LICENSES.txt` next to the build output: every shipped font's licence file in full (src/ui/fontCredits.ts),
 * as the OFL and the Bitstream Vera licence ask of a copy of the fonts. The dev server serves it too, for the credits
 * panel's link.
 */
function fontLicenses(): Plugin {
  const dir = dirname(fileURLToPath(import.meta.url));
  const text = () => fontLicensesText((f) => readFileSync(join(dir, f), 'utf8'));
  return {
    name: 'h3d-font-licenses',
    configureServer(server) {
      server.middlewares.use(`/${FONT_LICENSES_FILE}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FONT_LICENSES_FILE, source: text() });
    },
  };
}

// Bind to loopback only. The port always comes from the CLI (`--port`), leased
// via portlease by the Makefile; never hardcode one here.
export default defineConfig({
  plugins: [fixtures(), musicCredits(), fontLicenses()],
  // The Makefile passes `git describe`; the badge above the debug overlay shows it (src/version.ts).
  define: { __H3D_VERSION__: JSON.stringify(process.env.H3D_VERSION ?? 'dev') },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  // three/webgpu alone is ~1 MB minified; one chunk is fine for now.
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
