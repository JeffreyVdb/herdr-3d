import { defineConfig } from 'vitest/config';

// Bind to loopback only. The port always comes from the CLI (`--port`), leased
// via portlease by the Makefile; never hardcode one here.
export default defineConfig({
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  // three/webgpu alone is ~1 MB minified; one chunk is fine for now.
  build: { target: 'es2023', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
    environment: 'node',
  },
});
