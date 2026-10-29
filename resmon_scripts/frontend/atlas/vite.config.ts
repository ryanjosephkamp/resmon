import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

/**
 * The fixed PDF.js distribution the Evidence reader draws pages with, copied
 * byte for byte into `pdfjs/6.3.289/` beside the app, as the classic build
 * copies it. The source is `vendor/pdfjs/6.3.289`, whose 188 files are pinned
 * by hash in `src/__tests__/pdfjs.test.ts`; nothing is installed from npm or
 * rebuilt. Only the two module suffixes change, `.mjs` to `.js`, because the
 * main process's static server types `.js` as JavaScript and would serve
 * `.mjs` as bytes a worker refuses.
 */
function pdfjsDistribution(): Plugin {
  const root = path.resolve(__dirname, '..', 'vendor', 'pdfjs', '6.3.289');
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) files.push(name);
      else throw new Error(`Not a file in the fixed PDF.js distribution: ${name}`);
    }
  };
  return {
    name: 'resmon-pdfjs-distribution',
    apply: 'build',
    generateBundle() {
      visit('');
      if (files.length !== 188) throw new Error(`Expected exactly 188 fixed PDF.js files, found ${files.length}`);
      for (const name of files) {
        const output = name.replace(/^build\/(pdf(?:\.worker)?\.min)\.mjs$/, 'build/$1.js');
        this.emitFile({ type: 'asset', fileName: `pdfjs/6.3.289/${output}`, source: fs.readFileSync(path.join(root, name)) });
      }
    },
  };
}

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
  plugins: [react(), pdfjsDistribution()],
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'atlas'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
});
