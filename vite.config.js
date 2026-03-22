import { defineConfig } from 'vite';
import { resolve } from 'path';
import barePlugin from './vite-plugin-bare.js';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [
    // barePlugin(),
    // {
    //   name: 'direct-bare-bridge',
    //   apply: 'serve',
    //   transformIndexHtml(html) {
    //     return html.replace(
    //       '</head>',
    //       `<script>
    //         (function() {
    //           // Connect DIRECTLY to the Bare process (which will act as a server)
    //           // This is kept for compatibility or fallback, but the new HMR bridge is preferred for dev
    //           window.onBareEvent && console.log('✅ Legacy bridge ready');
    //         })();
    //       </script></head>`
    //     )
    //   }
    // }
  ],
  build: {
    outDir: '../android/app/src/main/assets',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'web/index.html'),
      },
    },
  },
});
