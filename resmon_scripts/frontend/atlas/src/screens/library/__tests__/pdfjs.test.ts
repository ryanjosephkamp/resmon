import fs from 'fs';
import path from 'path';
import { MAX_CANVAS_BYTES, MAX_PIXELS, PDF_VERSION, RENDER_TIMEOUT, canvasScale, pdfAsset } from '../pdfjs';

const ATLAS = path.join(__dirname, '..', '..', '..', '..');

test('the bounds are the classic reader’s: 4 million pixels, 16 MiB, 20 seconds, PDF.js 6.3.289', () => {
  expect([MAX_PIXELS, MAX_CANVAS_BYTES, PDF_VERSION, RENDER_TIMEOUT]).toEqual([4_000_000, 16 * 1024 * 1024, '6.3.289', 20_000]);
});

test('a canvas stays inside both budgets whatever the page size or zoom, and says when it was reduced', () => {
  for (const [w, h, z] of [[612, 792, 1], [612, 792, 6], [100_000, 100_000, 3], [10, 900_000, 2]] as const) {
    const size = canvasScale(w, h, z);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PIXELS);
    expect(size.width * size.height * 4).toBeLessThanOrEqual(MAX_CANVAS_BYTES);
    expect(size.scale).toBeLessThanOrEqual(z);
  }
  expect(canvasScale(612, 792, 1).reduced).toBe(false);
  expect(canvasScale(612, 792, 6).reduced).toBe(true);
  for (const [w, h, z] of [[0, 5, 1], [5, Number.NaN, 1], [Number.POSITIVE_INFINITY, 5, 1], [5, 5, -1]]) {
    expect(() => canvasScale(w, h, z)).toThrow();
  }
});

test('only files of the fixed copy beside the app are ever asked for', () => {
  expect(pdfAsset('build/pdf.min.js')).toBe(new URL('./pdfjs/6.3.289/build/pdf.min.js', document.baseURI).href);
  expect(() => pdfAsset('../../other.js')).toThrow();
  expect(() => pdfAsset('https://example.com/pdf.min.js')).toThrow();
});

test('the page is drawn in a worker of its own, with every active part of a PDF switched off', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'PdfPage.tsx'), 'utf8');
  expect(source).toContain('new Worker(');
  expect(source).toContain('port: native');
  expect(source).toContain('native?.terminate()');
  expect(source).toContain('annotationMode: api.AnnotationMode.DISABLE');
  for (const token of ['enableXfa: false', 'useWasm: false', 'useSystemFonts: false', 'useWorkerFetch: false',
    'stopAtErrors: true', 'disableAutoFetch: true', 'disableStream: true', 'disableRange: true']) {
    expect(source).toContain(token);
  }
  expect(source).not.toMatch(/getAnnotations|AnnotationLayer|getJSActions|getAttachments|isEvalSupported/);
});

test('the window may start a worker from its own origin, and may not evaluate strings', () => {
  const html = fs.readFileSync(path.join(ATLAS, 'index.html'), 'utf8');
  expect(html).toContain("worker-src 'self'");
  expect(html).not.toContain('unsafe-eval');
});

test('the build copies the fixed distribution the classic test pins, and refuses any other count', () => {
  const config = fs.readFileSync(path.join(ATLAS, 'vite.config.ts'), 'utf8');
  expect(config).toContain("'vendor', 'pdfjs', '6.3.289'");
  expect(config).toContain('files.length !== 188');
});
