/**
 * From takes to media: each demo's GIF and still, and the tour video.
 *
 *   npx ts-node-transpile-only demos/media.ts [slug ...]
 *
 * A take (`recorder.ts`) is the frames Chromium drew, each with the moment it
 * was drawn, and the marks the demo named. Here they are laid on a 30 fps
 * timeline by those moments, with any stretch the demo marked faster played
 * faster, into one master per take at the window's device pixels. From the
 * master:
 *
 * - **the GIF**, from the moment the title card has lifted to the end: 960
 *   pixels wide, 15 frames a second (12 if 15 will not fit), looping, with
 *   ffmpeg's two passes: `palettegen` reads the whole clip for one palette,
 *   then `paletteuse` maps every frame to it, ordered dithering at a fine
 *   scale, which keeps text sharp and flat panels flat. Kept under 3 MB.
 * - **the still**, through the same palette: the frame the demo marked as its
 *   still, or the GIF's last. The Tutorials page shows it when motion is
 *   reduced and while a GIF is off screen.
 * - **the video segment**, title card included: 1920 x 1080 at 30 fps, the
 *   1440 x 900 window scaled to the full height and set on its own ground.
 *
 * With every take present, the segments are joined into the tour: H.264,
 * 1920 x 1080, 30 fps, no audio.
 *
 * Environment: `RESMON_DEMO_OUT` (where the takes are; also where the masters
 * and segments go), `RESMON_DEMO_GIFS` (where the GIFs and stills go; the
 * Tutorials page's folder by default), `RESMON_DEMO_TOUR` (the tour's path;
 * `$RESMON_DEMO_OUT/resmon-tour.mp4` by default), and `FFMPEG` (`ffmpeg` on the PATH by default).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEMOS } from './titles';
import { outputDir } from './paths';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
/** Beside `FFMPEG` when that is a path, as Homebrew and the static builds install them. */
const FFPROBE = process.env.FFPROBE || (FFMPEG.includes('/') ? path.join(path.dirname(FFMPEG), 'ffprobe') : 'ffprobe');
const FPS = 30;
const GIF_WIDTH = 960;
/** Three megabytes, counted in millions so no reading of "MB" finds one over. */
const GIF_LIMIT = 3_000_000;
/** How every film here is tagged, so a player and ffmpeg's own GIF pass read its colors alike. */
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
/** The window's ground in each theme, from `atlas/src/theme/tokens.css`, for the video's sides. */
const GROUND = { light: '#ffffff', dark: '#0a0a0b' } as const;

interface Frame { file: string; t: number }
interface Mark { name: string; t: number; speed?: number }
interface Take {
  title: { slug: string; number: number; title: string; line: string };
  frames: Frame[];
  marks: Mark[];
  stopped: number;
  theme?: 'light' | 'dark';
}

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function mark(take: Take, name: string): number {
  const found = take.marks.find((m) => m.name === name);
  if (!found) throw new Error(`${take.title.slug}: no "${name}" mark`);
  return found.t;
}

/** How fast the film plays at moment `t`: 1, or the speed of the stretch it falls in. */
function speedAt(marks: Mark[], t: number): number {
  let speed = 1;
  for (const m of marks) {
    if (m.t > t) break;
    if (m.name === 'fast') speed = m.speed ?? 1;
    if (m.name === 'normal') speed = 1;
  }
  return speed;
}

/**
 * The take laid on a 30 fps timeline from `from` to the end, as a numbered
 * sequence of links to its frames: each output frame shows the last frame
 * Chromium had drawn by that moment of the film. The film's clock runs slower
 * than the take's inside a stretch marked faster, so those stretches play
 * faster. Not a concat list of frames with their own durations: its image
 * demuxer rounds each frame up to a 25 fps tick, so a take drawn 40 frames a
 * second would run long.
 */
function timeline(take: Take, dir: string, from: number, sequence: string): number {
  const end = mark(take, 'end');
  const marks = [...take.marks].sort((a, b) => a.t - b.t);
  // Film time of a take moment, integrated in 10 ms steps.
  const film: number[] = [];
  let clock = from;
  let elapsed = 0;
  const filmAt = (t: number): number => {
    for (; clock < t; clock += 0.01) elapsed += Math.min(0.01, t - clock) / speedAt(marks, clock);
    return elapsed;
  };
  const frames = take.frames.filter((f) => f.t <= end);
  for (const f of frames) film.push(f.t <= from ? 0 : filmAt(f.t));
  const length = filmAt(end);
  fs.rmSync(sequence, { recursive: true, force: true });
  fs.mkdirSync(sequence, { recursive: true });
  const count = Math.floor(length * FPS);
  let at = 0;
  for (let k = 0; k < count; k++) {
    while (at + 1 < frames.length && film[at + 1]! <= k / FPS) at++;
    fs.symlinkSync(path.join(dir, frames[at]!.file), path.join(sequence, `${String(k).padStart(6, '0')}.jpg`));
  }
  return count;
}

/** The take's film, title card first, at the window's own pixels. */
function master(take: Take, dir: string, out: string): { master: string; gifStart: number } {
  const from = mark(take, 'title');
  const sequence = path.join(out, `${take.title.slug}-frames`);
  timeline(take, dir, from, sequence);
  const file = path.join(out, `${take.title.slug}-master.mp4`);
  // Chromium's frames are full-range JPEG in the SD matrix; video is limited range in BT.709.
  ffmpeg(['-framerate', String(FPS), '-i', path.join(sequence, '%06d.jpg'),
    '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv444p',
    ...BT709, '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', '-an', file]);
  fs.rmSync(sequence, { recursive: true, force: true });
  return { master: file, gifStart: mark(take, 'demo') - from };
}

function seconds(file: string): number {
  return Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }).trim());
}

/** The frame the still is made from: the one on screen at the demo's `still` mark, or none for the last. */
function stillFrame(take: Take, dir: string): string | null {
  const at = take.marks.find((m) => m.name === 'still')?.t;
  if (at === undefined) return null;
  const shown = take.frames.filter((f) => f.t <= at).pop();
  return shown ? path.join(dir, shown.file) : null;
}

/** The GIF and its still: two passes, the palette first. */
function gif(slug: string, file: string, start: number, out: string, gifs: string, still: string | null): { gif: string; fps: number; bytes: number } {
  const palette = path.join(out, `${slug}-palette.png`);
  const target = path.join(gifs, `${slug}.gif`);
  let made = { gif: target, fps: 0, bytes: Infinity };
  for (const fps of [15, 12]) {
    const scale = `fps=${fps},scale=${GIF_WIDTH}:-1:flags=lanczos`;
    ffmpeg(['-ss', start.toFixed(3), '-i', file, '-vf', `${scale},palettegen=max_colors=256:stats_mode=full`, palette]);
    ffmpeg(['-ss', start.toFixed(3), '-i', file, '-i', palette, '-lavfi',
      `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', target]);
    made = { gif: target, fps, bytes: fs.statSync(target).size };
    if (made.bytes <= GIF_LIMIT) break;
  }
  // The still, through the same palette: the frame the demo chose, or the GIF's last.
  const stillTarget = path.join(gifs, `${slug}.png`);
  ffmpeg([...(still ? ['-i', still] : ['-sseof', '-0.2', '-i', file]), '-i', palette, '-lavfi',
    `scale=${GIF_WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, '-frames:v', '1', '-update', '1', stillTarget]);
  return made;
}

/** The take as a 1920 x 1080 segment of the tour. */
function segment(slug: string, file: string, theme: 'light' | 'dark', out: string): string {
  const target = path.join(out, `${slug}-1080p.mp4`);
  ffmpeg(['-i', file, '-vf',
    `scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=${GROUND[theme]},fps=${FPS},format=yuv420p`,
    ...BT709, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-an', '-movflags', '+faststart', target]);
  return target;
}

function main(): void {
  const out = outputDir();
  const gifs = path.resolve(process.env.RESMON_DEMO_GIFS || path.join(__dirname, '..', 'atlas', 'src', 'screens', 'settings', 'tutorials'));
  fs.mkdirSync(gifs, { recursive: true });
  const media = path.join(out, 'media');
  fs.mkdirSync(media, { recursive: true });
  const asked = process.argv.slice(2);
  const segments: string[] = [];
  for (const d of DEMOS) {
    const dir = path.join(out, 'takes', d.slug);
    const takeFile = path.join(dir, 'take.json');
    const existing = path.join(media, `${d.slug}-1080p.mp4`);
    if (asked.length && !asked.includes(d.slug)) {
      if (fs.existsSync(existing)) segments.push(existing);
      continue;
    }
    if (!fs.existsSync(takeFile)) {
      console.log(`${d.slug}: no take`);
      continue;
    }
    const take = JSON.parse(fs.readFileSync(takeFile, 'utf8')) as Take;
    const { master: film, gifStart } = master(take, dir, media);
    const made = gif(d.slug, film, gifStart, media, gifs, stillFrame(take, dir));
    segments.push(segment(d.slug, film, take.theme ?? 'light', media));
    const length = seconds(film) - gifStart;
    console.log(`${d.slug}: GIF ${length.toFixed(1)} s at ${made.fps} fps, ${(made.bytes / 1024 / 1024).toFixed(2)} MB`
      + (made.bytes > GIF_LIMIT ? ' — OVER 3 MB' : ''));
  }
  if (segments.length !== DEMOS.length) {
    console.log(`The tour needs all ${DEMOS.length} segments; ${segments.length} are made.`);
    return;
  }
  const tour = path.resolve(process.env.RESMON_DEMO_TOUR || path.join(out, 'resmon-tour.mp4'));
  const list = path.join(media, 'tour.txt');
  fs.writeFileSync(list, segments.map((s) => `file '${s}'`).join('\n') + '\n');
  // Every segment was encoded with the same settings, so they join without re-encoding.
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-movflags', '+faststart', tour]);
  console.log(`tour: ${seconds(tour).toFixed(1)} s, ${(fs.statSync(tour).size / 1024 / 1024).toFixed(1)} MB → ${tour}`);
}

main();
