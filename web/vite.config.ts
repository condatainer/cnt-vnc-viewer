import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: resolve(__dirname, '../cmd/server/dist'),
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 4096,
  },
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8080',
      },
    },
  },
});

