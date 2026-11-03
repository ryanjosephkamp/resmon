/**
 * A grayscale PNG as a data URL, written at build time with Node's own zlib.
 *
 * The plate's shading is a small field of densities (160 by 160). Drawn as an
 * SVG mask, each value lets the ink through in proportion, so one image serves
 * both color schemes: the ink it masks is the scheme's own.
 */
import { deflateSync } from 'node:zlib';

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
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
