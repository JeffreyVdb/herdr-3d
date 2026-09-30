import { defineConfig } from '@playwright/test';

// The preview port is leased by `make shot` / `make e2e` (portlease run --name preview).
const port = process.env.PORTLEASE_PREVIEW_PORT;
if (!port) {
  throw new Error('PORTLEASE_PREVIEW_PORT unset: run the e2e tests via `make shot` or `make e2e`');
}

// Every test opens its own page against the shared preview server, so specs run in parallel.
// H3D_WORKERS overrides the count (a positive integer); anything else falls back to the default.
const DEFAULT_WORKERS = 6;
const asked = process.env.H3D_WORKERS;
const workers = asked !== undefined && /^[1-9]\d*$/.test(asked.trim()) ? Number(asked) : DEFAULT_WORKERS;
const baseURL = `http://127.0.0.1:${port}`;
// H3D_DIST: another build directory (agents building side by side in one checkout); default dist.
const dist = /^[\w.-]+$/.test(process.env.H3D_DIST ?? '') ? (process.env.H3D_DIST as string) : 'dist';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/artifacts',
  timeout: 120_000,
  retries: 0,
  workers,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // No GPU on the server: WebGL2 through ANGLE -> Vulkan -> mesa (lavapipe/llvmpipe).
      args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `pnpm exec vite preview --outDir ${dist} --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
