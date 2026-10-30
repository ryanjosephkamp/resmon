/**
 * PDFs written byte for byte for the reader's specs: pages of Helvetica text,
 * link annotations to a web address and to a place on another page, and as
 * many pages as a spec asks for. The cross-reference table is computed from
 * the bytes, so pypdf reads them in strict mode, as the engine does, and its
 * text extraction gives back each line as written.
 */

export interface PdfLine { x: number; y: number; size: number; text: string }

/** A link: a web address, or a page of the same document (1-based) and the height on it to show. */
export interface PdfLink { rect: [number, number, number, number]; uri?: string; page?: number; top?: number }

export interface PdfPageSpec { lines: PdfLine[]; links?: PdfLink[]; width?: number; height?: number }

function literal(text: string): string {
  if (/[^\x20-\x7e]/.test(text)) throw new Error(`Only printable ASCII is written into fixture PDFs: ${JSON.stringify(text)}`);
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export function writePdf(pages: PdfPageSpec[]): Buffer {
  const objects: string[] = [];
  const pageObject = (index: number) => 4 + 2 * index;
  let annotation = 4 + 2 * pages.length;
  const annotations: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, i) => {
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    const content = page.lines.map((l) => `BT /F1 ${l.size} Tf ${l.x} ${l.y} Td ${literal(l.text)} Tj ET`).join('\n');
    const refs: string[] = [];
    for (const link of page.links ?? []) {
      const target = link.uri !== undefined
        ? `/A << /S /URI /URI ${literal(link.uri)} >>`
        : `/Dest [${pageObject((link.page ?? 1) - 1)} 0 R /XYZ 0 ${link.top ?? height} 0]`;
      annotations[annotation] = `<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(' ')}] /Border [0 0 0] ${target} >>`;
      refs.push(`${annotation} 0 R`);
      annotation += 1;
    }
    objects[pageObject(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> `
      + `/Contents ${pageObject(i) + 1} 0 R${refs.length ? ` /Annots [${refs.join(' ')}]` : ''} >>`;
    objects[pageObject(i) + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  annotations.forEach((value, n) => { objects[n] = value; });

  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A long document of plain prose, its pages numbered in their text, for scrolling and memory measurements. */
export function longPdf(pages: number): Buffer {
  const words = 'evidence passage reader page drawn scroll document version exact canonical text layer selected line'.split(' ');
  return writePdf(Array.from({ length: pages }, (_, p) => ({
    lines: [
      { x: 72, y: 740, size: 16, text: `Page ${p + 1} of the long fixture` },
      ...Array.from({ length: 46 }, (_, l) => ({
        x: 72, y: 712 - l * 14, size: 10,
        text: Array.from({ length: 13 }, (_, w) => words[(p * 7 + l * 3 + w) % words.length]).join(' '),
      })),
    ],
  })));
}
