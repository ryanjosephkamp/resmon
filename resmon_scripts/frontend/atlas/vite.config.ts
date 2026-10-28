import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * The Atlas renderer, built beside the classic one.
 *
 * Electron's main process serves one directory of static files to the window
 * (`startRendererServer` in `electron/main.ts`); this build writes that
 * directory as `dist/atlas`, next to the classic `dist/renderer`, and
 * `RESMON_UI=atlas` picks it at launch. Relative asset URLs (`base: './'`)
 * because the files are served from whatever root the main process chooses.
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'atlas'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
});
