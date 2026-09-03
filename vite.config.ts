/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /*
   * GitHub Pages serves a project site from /<repo>/, not from the root, so the
   * built asset URLs need that prefix. It is set by the deploy workflow rather
   * than hardcoded, because `npm run dev` and every other host serve from `/`
   * and a baked-in prefix would break all of them.
   *
   * Routing needs no server rewrite: the selected dataset lives in the URL
   * hash, so there is only ever one document to serve.
   */
  base: process.env.PUBLIC_BASE_PATH ?? '/',

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
