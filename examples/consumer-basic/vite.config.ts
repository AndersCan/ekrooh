import { defineConfig } from 'vite-plus';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: './',
  // The dev worklet allows exactly this page origin (scripts/boot-worklet.mjs).
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});
