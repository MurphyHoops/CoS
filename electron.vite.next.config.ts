import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-next/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/next/runtime/electron-main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-next/preload',
      rollupOptions: { input: resolve(__dirname, 'src/preload/next.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/next-renderer'),
    build: {
      outDir: resolve(__dirname, 'out-next/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/next-renderer/index.html') }
    }
  }
});
