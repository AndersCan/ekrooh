import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // The dev backend allows exactly this origin (scripts/dev.mjs).
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist/web', emptyOutDir: true },
});
