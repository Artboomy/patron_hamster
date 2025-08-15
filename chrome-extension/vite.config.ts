import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  cacheDir: resolve(__dirname, '../.cache/vitest'),
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: resolve(__dirname, 'src/options/setupTests.ts')
  },
  build: {
    outDir: resolve(__dirname, '../dist/extension-bridge-v2'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        options: resolve(__dirname, 'options.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'content-script': resolve(__dirname, 'src/content/content-script.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
