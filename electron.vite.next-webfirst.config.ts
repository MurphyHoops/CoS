import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
// Standalone Web-First preview: bundle MCP SDK as well as the native host.
// Electron's normal SSR build externalizes node_modules unless noExternal is set.
export default defineConfig({
  main:{ssr:{noExternal:true},build:{outDir:'out-webfirst/main',
    rollupOptions:{input:resolve(__dirname,'src/main/next/web-first/web-first-main.ts')}}}
});
