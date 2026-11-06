/**
 * PDF.js 6.3 builds font tables with Math.sumPrecise. Electron 41's worker
 * lacks it; a failed conversion otherwise silently substitutes a text face.
 * Keep this compatibility code in the PDF worker, before the fixed bundle.
 */
if (typeof Math.sumPrecise !== 'function') {
  Object.defineProperty(Math, 'sumPrecise', {
    configurable: true,
    writable: true,
    value: function sumPrecise(items) {
      // Every finite double is an integer multiple of 2^-1074. Accumulate
      // those integers exactly, then round once to nearest, ties to even.
      // Ordinary addition loses small terms between canceling large ones.
      const bits = new DataView(new ArrayBuffer(8));
      let total = 0n;
      let negativeZero = true;
      let positiveInfinity = false;
      let negativeInfinity = false;
      let nan = false;
      for (const item of items) {
        if (typeof item !== 'number') throw new TypeError('Math.sumPrecise requires numbers');
        if (!Object.is(item, -0)) negativeZero = false;
        if (Number.isNaN(item)) { nan = true; continue; }
        if (item === Infinity) { positiveInfinity = true; continue; }
        if (item === -Infinity) { negativeInfinity = true; continue; }
        bits.setFloat64(0, item);
        const word = bits.getBigUint64(0);
        const exponent = Number((word >> 52n) & 0x7ffn);
        const fraction = word & 0xfffffffffffffn;
        const significand = exponent ? fraction | 0x10000000000000n : fraction;
        const units = significand << BigInt(Math.max(0, exponent - 1));
        total += word >> 63n ? -units : units;
      }
      if (nan || (positiveInfinity && negativeInfinity)) return NaN;
      if (positiveInfinity) return Infinity;
      if (negativeInfinity) return -Infinity;
      if (total === 0n) return negativeZero ? -0 : 0;
      const sign = total < 0n ? -1 : 1;
      if (total < 0n) total = -total;
      const shift = Math.max(0, total.toString(2).length - 53);
      let rounded = total >> BigInt(shift);
      if (shift) {
        const remainder = total - (rounded << BigInt(shift));
        const halfway = 1n << BigInt(shift - 1);
        if (remainder > halfway || (remainder === halfway && (rounded & 1n))) rounded += 1n;
      }
      return sign * Number(rounded) * 2 ** (shift - 1074);
    },
  });
}
