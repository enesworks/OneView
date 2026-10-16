import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron'],
            },
          },
          plugins: [
            {
              name: 'copy-preload-cjs',
              closeBundle() {
                const src = path.resolve(__dirname, 'src/main/preload.cjs');
                const dest = path.resolve(__dirname, 'dist-electron/main/preload.cjs');
                if (fs.existsSync(src)) {
                  fs.copyFileSync(src, dest);
                  console.log('[OneView] Copied preload.cjs');
                }
              },
            },
          ],
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
