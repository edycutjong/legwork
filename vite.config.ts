import { defineConfig } from 'vite';

// Relative base so the same dist/ serves from legwork.edycu.dev (GitHub Pages) and from any static host.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
