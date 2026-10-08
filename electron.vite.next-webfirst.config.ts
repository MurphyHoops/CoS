import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
// Isolated Web-First experiment: intentionally no legacy Classic/Chrome entrypoint.
export default defineConfig({
  main: {plugins:[externalizeDepsPlugin()],build:{outDir:'out-webfirst/main',
    rollupOptions:{input:resolve(__dirname,'src/main/next/web-first/web-first-main.ts')}}}
});
