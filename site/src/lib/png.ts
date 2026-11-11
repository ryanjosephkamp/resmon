/**
 * A grayscale PNG as a data URL, written at build time.
 *
 * The plate's shading is a small field of densities (160 by 160). Drawn as an
 * SVG mask, each value lets the ink through in proportion, so one image serves
 * both color schemes: the ink it masks is the scheme's own.
 *
 * Its pixels are stored, not compressed. Node's zlib compresses the same bytes
 * differently from one release to the next, so a compressed image would make
 * `docs/` depend on which Node built it. The page is compressed in transit, and
 * the stored image costs about 0.6 KB more there.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zlib stream of stored (uncompressed) blocks, the same bytes on every Node. */
function stored(data: Uint8Array): Buffer {
  const BLOCK = 0xffff;
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let at = 0; at < data.length; at += BLOCK) {
    const block = data.subarray(at, at + BLOCK);
    const head = Buffer.alloc(5);
    head[0] = at + BLOCK >= data.length ? 1 : 0; // the last block
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, Buffer.from(block));
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  parts.push(adler);
  return Buffer.concat(parts);
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** `levels` is row-major, top row first, one byte (0 to 255) per pixel. */
export function pngDataUrl(width: number, height: number, levels: Uint8Array): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per sample
  header[9] = 0; // grayscale
  const rows = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) {
    rows[row * (width + 1)] = 0; // no filter
    rows.set(levels.subarray(row * width, (row + 1) * width), row * (width + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', stored(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
