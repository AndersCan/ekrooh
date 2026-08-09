import { defineConfig, lazyPlugins } from 'vite-plus';
import { resolve } from 'path';
import { readdirSync, rmSync } from 'fs';
import tailwindcss from '@tailwindcss/vite';

const androidAssetChunkDir = resolve(
  import.meta.dirname,
  '../android-app/src/main/assets/assets',
);

function cleanAndroidHashedAssets() {
  return {
    name: 'clean-android-hashed-assets',
    buildStart() {
      try {
        for (const entry of readdirSync(androidAssetChunkDir, {
          withFileTypes: true,
        })) {
          if (!entry.isFile()) continue;
          if (!/^main-.*\.(js|css)$/.test(entry.name)) continue;
          rmSync(resolve(androidAssetChunkDir, entry.name), { force: true });
        }
      } catch {
        // Ignore missing assets directory on first build.
      }
    },
  };
}

export default defineConfig({
  root: '.',
  base: './',
  plugins: lazyPlugins(() => [tailwindcss(), cleanAndroidHashedAssets()]),
  build: {
    outDir: '../android-app/src/main/assets',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});
