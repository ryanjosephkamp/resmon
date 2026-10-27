/**
 * A PDF written for this suite, one line of text per page.
 *
 * J35 reads a PDF in Evidence, and J34 deliberately left that to it: J34's PDF
 * is an envelope with no page in it, because that row is about retention. A
 * journey that reads a page needs a document whose pages say something known,
 * so the spec can hold the reader's canonical text against the sentence it
 * wrote rather than against whatever the reader happened to produce.
 *
 * **Why it is built here and not copied from the repository's fixtures.**
 * `verification_scripts/fixtures/evidence/two-pages.pdf` would do, and the
 * e2e spec uses it. But a journey spec may import nothing but the driver, and
 * a file it names by path in somebody else's checkout is a file the candidate
 * build might not carry. So the bytes are generated, and every sentence in
 * them is invented for this suite, as `AUTHORED_RECORDS` next door is.
 *
 * **The shape is the smallest one the app's two readers both accept.** The
 * canonical text comes from pypdf in strict mode, which refuses on a parser
 * warning, so the cross-reference offsets and stream lengths are computed from
 * the bytes rather than typed. The page image comes from PDF.js, which needs a
 * font it holds locally — Helvetica is one of the fourteen standard fonts, and
 * the app ships them. One `Tj` per page, so the extracted text is the sentence
 * and nothing else.
 *
 * **ASCII only, and that is enforced.** The Library import writes what it is
 * handed as UTF-8 text, and for printable ASCII the UTF-8 bytes are the PDF's
 * bytes. A character outside that range would be re-encoded on the way to the
 * disk and the document the app retained would not be the document built here.
 */

/** Escape the three characters a PDF literal string treats specially. */
function literal(text: string): string {
  return text.replace(/[\\()]/g, (character) => `\\${character}`);
}

/** A document of `pages.length` pages, page N carrying `pages[N - 1]`. */
export function authoredPdf(pages: string[]): string {
  if (pages.length < 1) throw new Error('an authored PDF needs at least one page');
  for (const page of pages) {
    if (!/^[\x20-\x7e]+$/.test(page)) {
      throw new Error(`an authored PDF page must be printable ASCII; got ${JSON.stringify(page)}`);
    }
  }

  // Objects 1–3 are the catalog, the page tree and the font; then a content
  // stream and a page per page, so page N's page object is 5 + 2(N - 1).
  const pageObject = (index: number): number => 5 + 2 * index;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((page, index) => {
    const content = `BT /F1 12 Tf 72 720 Td (${literal(page)}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject(index) - 1} 0 R >>`);
  });

  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    // Every character is ASCII, so a string length is a byte offset.
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  // Each entry is exactly twenty bytes, trailing space included: the format
  // says so, and a strict reader counts.
  const entries = ['0000000000 65535 f \n', ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)];
  body += `xref\n0 ${objects.length + 1}\n${entries.join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
