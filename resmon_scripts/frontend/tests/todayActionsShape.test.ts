import { readFileSync } from 'fs';
import { resolve } from 'path';

test('Today uses the shared paper actions without the former single-save callback', () => {
  const today = readFileSync(resolve(__dirname, '../atlas/src/screens/Today.tsx'), 'utf8');
  const index = readFileSync(resolve(__dirname, '../atlas/src/screens/today/TodayIndex.tsx'), 'utf8');
  expect(today).not.toMatch(/const save = useMutation/);
  expect(today + index).not.toContain('onToggleSave');
});
