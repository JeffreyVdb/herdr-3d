import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Opt-in live latency check, driven by tools/live-latency.ts (`pnpm test:live`).
export default defineConfig({
  ...base,
  testDir: 'e2e-live',
  outputDir: 'test-results/live/artifacts',
});
