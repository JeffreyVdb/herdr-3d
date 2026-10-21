import { defineConfig } from '@playwright/test';

// #42: which tests a run selects, by the tags in their source (`test(title, { tag: '@smoke' }, ...)`). H3D_E2E_PROFILE:
//   smoke     (the default) the essential journeys tagged @smoke: what `make e2e` and `pnpm e2e` run
//   extended  every test but the @visual and @perf ones (smoke included): broader functional coverage
//   visual    @visual and @theme: the theme captures, every per-surface theme audit and all 8 theme combinations (@theme:
//             the representatives extended runs too), screenshot tours: what CSS / theme work runs
//   perf      @perf: frame benches and long-task measurements (the H3D_PERF / H3D_BENCH ones need those set too)
//   component @component: the browser component host (/?composer-demo), no 3D scene
//   all       every test of the files named (what `make e2e SPEC=...` uses)
// The profile filters the files named on the command line too; a CLI --grep narrows it further (both must match).
// docs/research/e2e-selection.md maps what moved where.
const PROFILES = {
  smoke: { grep: /@smoke\b/ },
  extended: { grepInvert: /@(visual|perf)\b/ },
  visual: { grep: /@(visual|theme)\b/ },
  perf: { grep: /@perf\b/ },
  component: { grep: /@component\b/ },
  all: {},
} as const satisfies Record<string, { grep?: RegExp; grepInvert?: RegExp }>;
const profileName = process.env.H3D_E2E_PROFILE || 'smoke';
if (!Object.hasOwn(PROFILES, profileName)) {
  throw new Error(`H3D_E2E_PROFILE=${profileName}: one of ${Object.keys(PROFILES).join(', ')}`);
}
const profile: { grep?: RegExp; grepInvert?: RegExp } = PROFILES[profileName as keyof typeof PROFILES];

// The preview port is leased by `make shot` / `make e2e` (portlease run --name preview). Listing (`make e2e-list`,
// `playwright test --list`) starts no server and runs no test, so it needs none.
const listing = process.argv.includes('--list');
const port = process.env.PORTLEASE_PREVIEW_PORT;
if (!port && !listing) {
  throw new Error('PORTLEASE_PREVIEW_PORT unset: run the e2e tests via `make shot` or `make e2e`');
}

// Every test opens its own page against the shared preview server and depends on no other test, so tests run in
// parallel, one at a time per worker (fullyParallel: a heavy spec file is spread over the workers, not one long pole).
// H3D_WORKERS overrides the count (a positive integer); anything else falls back to the default.
const DEFAULT_WORKERS = 6;
const asked = process.env.H3D_WORKERS;
const workers = asked !== undefined && /^[1-9]\d*$/.test(asked.trim()) ? Number(asked) : DEFAULT_WORKERS;
const baseURL = `http://127.0.0.1:${port ?? 0}`;
// H3D_DIST: another build directory (agents building side by side in one checkout); default dist.
const dist = /^[\w.-]+$/.test(process.env.H3D_DIST ?? '') ? (process.env.H3D_DIST as string) : 'dist';
const report = process.env.H3D_E2E_REPORT || 'test-results/e2e-report.json';
// H3D_E2E_TMPDIR: TMPDIR for this run's processes only (Playwright workers, so each browser's profile, and the preview
// server). Set here, not around make: portlease keeps its shared lease state under TMPDIR.
if (process.env.H3D_E2E_TMPDIR) process.env.TMPDIR = process.env.H3D_E2E_TMPDIR;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  ...profile,
  outputDir: 'test-results/artifacts',
  timeout: 120_000,
  // Parallel renderers can dispatch completed bridge work after 5s (hire/run, secret scans, schedule preparation).
  // Wait for the expected state; passing assertions return immediately. Latency contracts set their own budgets.
  expect: { timeout: 20_000 },
  retries: 0,
  fullyParallel: true,
  workers,
  // list for the terminal; the JSON report (per-test status, durations, stats) for the bench harness and for reading a
  // failed run afterwards. H3D_E2E_REPORT moves it (docs/research/e2e-bench). Kept out of outputDir, which Playwright
  // empties at the start of a run.
  reporter: [['list'], ['json', { outputFile: report }]],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // WebGL2 through ANGLE -> Vulkan: use the host GPU, or Mesa's software Vulkan on CPU-only runners.
      args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    },
  },
  ...(port && {
    webServer: {
      command: `pnpm exec vite preview --outDir ${dist} --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  }),
});
