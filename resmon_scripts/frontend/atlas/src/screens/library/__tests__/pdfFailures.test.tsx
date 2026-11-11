import { render, screen, waitFor } from '@testing-library/react';
import { PdfPage } from '../PdfPage';
import { Drawer, TextLayers, type PdfSession } from '../pdfDocument';
import type { PdfPageProxy } from '../pdfjs';

const viewport = { width: 612, height: 792, scale: 1, rotation: 0,
  rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 },
  convertToViewportPoint: (x: number, y: number) => [x, y] };

for (const failure of ['text', 'annotations', 'drawing']) {
  test(`${failure} failure is separate from the page drawing`, async () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const page: PdfPageProxy = {
      userUnit: 1, getViewport: () => viewport,
      render: () => ({ promise: failure === 'drawing' ? Promise.reject(new Error('draw failure')) : Promise.resolve(), cancel: () => undefined }),
      getTextContent: async () => { if (failure === 'text') throw new Error('text failure'); return { items: [], styles: {}, lang: null }; },
      getAnnotations: async () => { if (failure === 'annotations') throw new Error('link failure'); return []; },
      cleanup: () => true,
    };
    const session = { doc: { getPage: async () => page }, pages: 5, drawer: new Drawer(), layers: new TextLayers(),
      api: { AnnotationMode: { DISABLE: 0 }, TextLayer: class {
        textDivs: HTMLElement[] = []; async render() {} cancel() {}
      } }, fail: jest.fn() } as unknown as PdfSession;
    const said = jest.fn();
    const mounted = render(<PdfPage session={session} index={1} scale={1} density={1}
      box={{ top: 0, left: 0, width: 612, height: 792 }} rank={() => 0} onSaid={said} onGo={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    if (failure === 'drawing') {
      expect(screen.getByRole('alert')).toHaveTextContent('Page 2 could not be drawn');
      expect(mounted.container.querySelector('canvas')).toBeNull();
    } else {
      expect(screen.getByRole('alert')).toHaveTextContent(failure === 'text'
        ? 'Page 2 is drawn, but its selectable text could not be read.'
        : 'Page 2 is drawn, but its links could not be read.');
      expect(mounted.container.querySelector('[data-drawn="true"] canvas')).not.toBeNull();
      expect(said.mock.calls.some(([, value]) => value && 'error' in value)).toBe(false);
    }
    mounted.unmount();
    jest.restoreAllMocks();
  });
}

test('an optional text-layer hang cannot stop a document whose page has already drawn', async () => {
  jest.useFakeTimers();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const page = { userUnit: 1, getViewport: () => viewport,
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    getTextContent: () => new Promise(() => undefined), cleanup: () => true };
  const session = { doc: { getPage: async () => page }, pages: 5, drawer: new Drawer(), layers: new TextLayers(),
    api: { AnnotationMode: { DISABLE: 0 } }, fail: jest.fn() } as unknown as PdfSession;
  const mounted = render(<PdfPage session={session} index={0} scale={1} density={1}
    box={{ top: 0, left: 0, width: 612, height: 792 }} rank={() => 0} onSaid={() => undefined} onGo={() => undefined} />);
  await waitFor(() => expect(mounted.container.querySelector('[data-drawn="true"] canvas')).not.toBeNull());
  jest.advanceTimersByTime(21_000);
  expect(session.fail).not.toHaveBeenCalled();
  mounted.unmount(); jest.restoreAllMocks(); jest.useRealTimers();
});
