import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { timeline } from '../demos/media';

function take(): Parameters<typeof timeline>[0] {
  return {
    title: { slug: 'clock', number: 1, title: 'Clock', line: 'Ten seconds.' },
    frames: Array.from({ length: 601 }, (_, i) => ({ file: `f${i}.jpg`, t: 100 + i / 60 })),
    marks: [{ name: 'end', t: 110 }],
    stopped: 110,
  };
}

test.each([
  { name: 'ten seconds at normal speed', fast: false, count: 300 },
  { name: 'four seconds of waiting at four times speed', fast: true, count: 210 },
])('$name', ({ fast, count }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'resmon-demo-clock-'));
  try {
    const film = take();
    if (fast) film.marks.unshift({ name: 'fast', t: 104, speed: 4 }, { name: 'normal', t: 108 });
    const sequence = path.join(root, 'sequence');
    expect(timeline(film, root, 100, sequence)).toBe(count);
    expect(readdirSync(sequence)).toHaveLength(count);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
