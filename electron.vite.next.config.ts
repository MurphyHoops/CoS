import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

// The preserved Next local-only dashboard remains in src/next-renderer as a
// diagnostic experiment. User-facing v4 Classic runs CoS's *complete* mature
// workflow: chat, project sidebar, settings, Setup, Goal/Loop and agent UI.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-next/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/next/runtime/classic-main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-next/preload',
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [{
      name: 'cos-next-classic-branding',
      transformIndexHtml(html: string) {
        // Only the Next build is branded; the original renderer source and
        // installed CoS app remain completely unchanged.
        return html.replace('<title>Chat On Steroids</title>',
          '<title>Chat On Steroids Next</title>')
          .replace('<strong>Chat On Steroids</strong>',
            '<strong>Chat On Steroids Next</strong>');
      }
    }],
    build: {
      outDir: resolve(__dirname, 'out-next/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
});
