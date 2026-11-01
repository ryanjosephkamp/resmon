import fs from 'fs';
import path from 'path';
import { CANVAS_BUDGET, MAX_CANVAS_PIXELS, MAX_DRAWN_PAGES, PDF_VERSION, RENDER_TIMEOUT, canvasScale, pdfAsset } from '../pdfjs';

const ATLAS = path.join(__dirname, '..', '..', '..', '..');

test('the bounds: 2^25 pixels a canvas, 2^26 for every drawn page together, 20 seconds a page, PDF.js 6.3.289', () => {
  expect([MAX_CANVAS_PIXELS, CANVAS_BUDGET, PDF_VERSION, RENDER_TIMEOUT]).toEqual([33_554_432, 67_108_864, '6.3.289', 20_000]);
  // Pages are drawn near the view only, so the page count bounds the layout rather than memory.
  expect(MAX_DRAWN_PAGES).toBe(5_000);
});

test('a page fitted to focus mode on a 1728-point 2× display is drawn at full resolution', () => {
  // The page column is the window less 16 pixels a side; Letter, A4 and Legal.
  for (const [w, h] of [[612, 792], [595.28, 841.89], [612, 1008]] as const) {
    const fit = (1728 - 32) / w;
    expect(canvasScale(w, h, fit * 2).reduced).toBe(false);
  }
  expect(canvasScale(595.28, 841.89, ((1920 - 32) / 595.28) * 2).reduced).toBe(false);
});

test('a canvas stays inside its ceiling and the longest side a canvas has, and says when it was reduced', () => {
  for (const [w, h, z] of [[612, 792, 1], [612, 792, 12], [100_000, 100_000, 3], [10, 200_000, 2]] as const) {
    const size = canvasScale(w, h, z);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(32_767);
    expect(size.scale).toBeLessThanOrEqual(z);
  }
  expect(canvasScale(612, 792, 1).reduced).toBe(false);
  expect(canvasScale(612, 792, 12).reduced).toBe(true);
  expect(canvasScale(612, 792, 2, 1_000_000).reduced).toBe(true);
  // Too thin to be a pixel wide once its length fits the longest side: not drawn, and said.
  for (const [w, h, z] of [[0, 5, 1], [5, Number.NaN, 1], [Number.POSITIVE_INFINITY, 5, 1], [5, 5, -1], [10, 900_000, 2]]) {
    expect(() => canvasScale(w, h, z)).toThrow();
  }
});

test('only files of the fixed copy beside the app are ever asked for', () => {
  expect(pdfAsset('build/pdf.min.js')).toBe(new URL('./pdfjs/6.3.289/build/pdf.min.js', document.baseURI).href);
  expect(() => pdfAsset('../../other.js')).toThrow();
  expect(() => pdfAsset('https://example.com/pdf.min.js')).toThrow();
});

test('the pages are drawn in a worker of their own, with every active part of a PDF switched off but its links', () => {
  const read = (name: string) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  const opening = read('pdfDocument.ts');
  expect(opening).toContain('new Worker(');
  expect(opening).toContain('port: native');
  expect(opening).toContain('native?.terminate()');
  for (const token of ['enableXfa: false', 'useWasm: false', 'useSystemFonts: false', 'useWorkerFetch: false',
    'stopAtErrors: true', 'disableAutoFetch: true', 'disableStream: true', 'disableRange: true']) {
    expect(opening).toContain(token);
  }
  // Every canvas, a page's or a thumbnail's, is drawn without annotations.
  for (const name of ['PdfPage.tsx', 'PdfGallery.tsx']) expect(read(name)).toContain('annotationMode: session.api.AnnotationMode.DISABLE');
  // Annotations are read only to find links, and only links are made from them.
  const page = read('PdfPage.tsx');
  expect(page).toContain("getAnnotations({ intent: 'display' })");
  expect(page).toContain('linkTarget(annotation, session.api.AnnotationType.LINK)');
  for (const name of ['pdfDocument.ts', 'PdfPage.tsx', 'PdfView.tsx', 'PdfGallery.tsx', 'PdfFind.tsx', 'readerModel.ts', 'findModel.ts']) {
    expect(read(name)).not.toMatch(/AnnotationLayer|getJSActions|getAttachments|isEvalSupported|unsafeUrl|renderForms|enableScripting/);
  }
});

test('the window may start a worker from its own origin, and may not evaluate strings', () => {
  const html = fs.readFileSync(path.join(ATLAS, 'index.html'), 'utf8');
  expect(html).toContain("worker-src 'self'");
  expect(html).not.toContain('unsafe-eval');
});

test('the build copies the fixed distribution pdfjsAssets.test.ts pins, and refuses any other count', () => {
  const config = fs.readFileSync(path.join(ATLAS, 'vite.config.ts'), 'utf8');
  expect(config).toContain("'vendor', 'pdfjs', '6.3.289'");
  expect(config).toContain('files.length !== 188');
});
