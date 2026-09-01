/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { '@': path.join(root, 'src') },
  },

  // duckdb-wasm resolves its own worker + .wasm assets at runtime from the jsDelivr
  // bundle set. Pre-bundling rewrites those URLs and breaks worker instantiation,
  // so it must stay out of the optimizer.
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },

  worker: {
    format: 'es',
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // DuckDB-Wasm instantiation in the integration suite is genuinely slow on a
    // cold start; the default 5s timeout is not enough.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
