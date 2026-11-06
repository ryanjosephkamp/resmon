import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = path.resolve(__dirname, '../../../../public/pdfjs-compat.js');

function realm(native = false) {
  const context = vm.createContext({});
  vm.runInContext(`Math.sumPrecise = ${native ? '() => 42' : 'undefined'}`, context);
  if (fs.existsSync(source)) vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  return (expression: string) => vm.runInContext(expression, context);
}

test('PDF.js can sum font-table byte lengths in a worker without native Math.sumPrecise', () => {
  const run = realm();
  expect(run('typeof Math.sumPrecise')).toBe('function');
  expect(run('Math.sumPrecise([6, 24, 128, 256])')).toBe(414);
});

test('the compatibility sum preserves cancellation, rounding, overflow, and signed zero', () => {
  const run = realm();
  for (const [expression, expected] of [
    ['[1e20, 1, -1e20]', 1],
    ['[1, 2 ** -53, Number.MIN_VALUE]', 1 + Number.EPSILON],
    ['[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]', Number.MAX_VALUE],
    ['[Number.MAX_VALUE, Number.MAX_VALUE]', Infinity],
    ['[Number.MIN_VALUE, Number.MIN_VALUE]', 2 * Number.MIN_VALUE],
    ['[]', -0], ['[-0, -0]', -0], ['[-0, 0]', 0], ['[1, -1]', 0],
    ['[Infinity, -Infinity]', NaN], ['[NaN, 1]', NaN],
  ] as const) expect(run(`Math.sumPrecise(${expression})`)).toBe(expected);
  expect(() => run('Math.sumPrecise(["1"])')).toThrow();
});

test('a native precise sum is kept', () => {
  expect(realm(true)('Math.sumPrecise([1, 2])')).toBe(42);
});
