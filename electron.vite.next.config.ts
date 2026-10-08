import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-next/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/next/runtime/electron-main.ts') }
    }
  }
});
