import { defineConfig } from '@playwright/test';

// The preview port is leased by `make shot` (portlease run --name preview).
const port = process.env.PORTLEASE_PREVIEW_PORT;
if (!port) {
  throw new Error('PORTLEASE_PREVIEW_PORT unset: run the screenshot test via `make shot`');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/artifacts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
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
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
