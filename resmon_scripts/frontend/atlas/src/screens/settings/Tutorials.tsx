// The imported GIFs' and stills' types: Vite's, named here as well as in
// `vite-env.d.ts` because the unit tests' compiler reads only this file's own.
/// <reference types="vite/client" />
import { useEffect, useRef, useState, type RefObject } from 'react';
import { isMac } from '../../bridge';
import { Icon } from '../../shell/Icon';
import { keysText, shortcut, type ShortcutId } from '../../shell/shortcuts';
import deepDiveGif from './tutorials/deep-dive.gif';
import deepDiveStill from './tutorials/deep-dive.png';
import deepSweepGif from './tutorials/deep-sweep.gif';
import deepSweepStill from './tutorials/deep-sweep.png';
import gettingAroundGif from './tutorials/getting-around.gif';
import gettingAroundStill from './tutorials/getting-around.png';
import healthGif from './tutorials/health.gif';
import healthStill from './tutorials/health.png';
import libraryGif from './tutorials/library.gif';
import libraryStill from './tutorials/library.png';
import todayGif from './tutorials/today.gif';
import todayStill from './tutorials/today.png';
import watchesGif from './tutorials/watches.gif';
import watchesStill from './tutorials/watches.png';

/**
 * Short recordings of Atlas in use, one task each, from start to finish.
 *
 * They come with the app: each GIF and its still is imported, so the build
 * bundles and fingerprints them, and opening this place asks nothing of any
 * server. `frontend/demos/` records them again after a change to the screens
 * they show.
 *
 * A GIF cannot be paused, so playing is a choice of picture: the GIF while it
 * plays, and otherwise its still, which is its last frame. A recording plays
 * only while it is on screen. With reduced motion asked for, it waits on its
 * still until Play is pressed; Pause stops it either way, and it stays stopped.
 *
 * Ask has no recording yet. It will be recorded with a signed-in model, so
 * that an answer shown is one a model wrote, and the page says it is missing.
 */
interface Recording {
  slug: string;
  title: string;
  /** What the recording shows, in a sentence; the keys are this platform's. */
  shows: (keys: (id: ShortcutId) => string) => string;
  gif: string;
  still: string;
}

const RECORDINGS: readonly Recording[] = [
  {
    slug: 'today', title: 'Today', gif: todayGif, still: todayStill,
    shows: () => 'The map draws in with the papers new since you last looked; a paper opens beside it, and a filter '
      + 'lights one watch’s papers. In the dark theme.',
  },
  {
    slug: 'deep-dive', title: 'A Deep Dive', gif: deepDiveGif, still: deepDiveStill,
    shows: (keys) => `Started with ${keys('new-dive')}: one source asked, the run as it goes, then its own map and the `
      + 'papers it found.',
  },
  {
    slug: 'deep-sweep', title: 'A Deep Sweep', gif: deepSweepGif, still: deepSweepStill,
    shows: (keys) => `Started with ${keys('new-sweep')}: four sources asked at once, how each one answered, and the `
      + 'run’s report.',
  },
  {
    slug: 'watches', title: 'Watches', gif: watchesGif, still: watchesStill,
    shows: () => 'A new watch named, given a term and two sources, and saved; then the calendar of what is due.',
  },
  {
    slug: 'library', title: 'Library', gif: libraryGif, still: libraryStill,
    shows: () => 'A PDF from your library opened in focus mode and scrolled, every page in the gallery, and a '
      + 'sentence selected. The paper is “Difficulty Calibration Across Time for Membership Inference in Diffusion '
      + 'Models” by Michael Joseph and Yedid Hoshen (arXiv:2610.40616), shown under CC BY 4.0.',
  },
  {
    slug: 'health', title: 'Health', gif: healthGif, still: healthStill,
    shows: () => 'The Source wall, where each mark is what a source did on one run, then a finding on the Watchdog.',
  },
  {
    slug: 'getting-around', title: 'Getting around', gif: gettingAroundGif, still: gettingAroundStill,
    shows: (keys) => `The command palette (${keys('palette')}), the keyboard shortcuts (?), and back again with a `
      + `two-finger swipe and ${keys('back')}.`,
  },
];

const REDUCE = '(prefers-reduced-motion: reduce)';

/** Whether the person has asked for less motion, kept current while the page is open. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCE).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCE);
    const follow = () => setReduced(query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return reduced;
}

/** Whether `node` is on screen enough to be watched; always, where there is no observer to ask. */
function useOnScreen(node: RefObject<HTMLElement | null>): boolean {
  const observing = typeof IntersectionObserver !== 'undefined';
  const [seen, setSeen] = useState(!observing);
  useEffect(() => {
    const target = node.current;
    if (!observing || !target) return undefined;
    const watch = new IntersectionObserver(([entry]) => setSeen(!!entry?.isIntersecting), { threshold: 0.35 });
    watch.observe(target);
    return () => watch.disconnect();
  }, [node, observing]);
  return seen;
}

function RecordingItem({ recording, reduced, keys }: {
  recording: Recording; reduced: boolean; keys: (id: ShortcutId) => string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const seen = useOnScreen(frame);
  // Null until Play or Pause is pressed: until then, motion decides.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const wanted = chosen ?? !reduced;
  const playing = wanted && seen;
  const titleId = `tutorial-${recording.slug}`;
  const showsId = `${titleId}-shows`;
  return (
    <li data-tutorial={recording.slug} data-playing={playing}>
      <div className="tutorial-head">
        <div>
          <h3 className="tutorial-title" id={titleId}>{recording.title}</h3>
          <p className="tutorial-covers" id={showsId}>{recording.shows(keys)}</p>
        </div>
        <button type="button" className="btn sm tutorial-play" aria-pressed={wanted}
          aria-label={`${wanted ? 'Pause' : 'Play'} ${recording.title}`} onClick={() => setChosen(!wanted)}>
          <Icon name={wanted ? 'pause' : 'play'} size={14} />
          {wanted ? 'Pause' : 'Play'}
        </button>
      </div>
      <div className="tutorial-frame" ref={frame}>
        <img src={playing ? recording.gif : recording.still} data-picture={playing ? 'gif' : 'still'} width={960} height={600}
          alt={`Recording: ${recording.title}`} aria-describedby={showsId} decoding="async" />
      </div>
    </li>
  );
}

export function Tutorials() {
  const reduced = useReducedMotion();
  const mac = isMac();
  const keys = (id: ShortcutId) => keysText(shortcut(id).chord, mac);
  return (
    <section className="settings-group tutorials" aria-labelledby="tutorials-title" aria-busy={false}>
      <h2 id="tutorials-title" className="group-title">Tutorials</h2>
      <p className="group-lede">
        Short recordings of Atlas in use, one task each, from start to finish. They come with the app, so this page
        fetches nothing. Each plays while it is on screen; with reduced motion turned on, each waits on a still until
        you press Play.
      </p>
      <p className="group-lede">
        They were made on a collection of public papers, most of them from arXiv, and the searches in them asked the
        real sources. A wait for a source is shown faster, and says so. Ask has no recording yet: it will be made with
        a signed-in model, so that the answer you see is one a model wrote.
      </p>
      <ol className="tutorial-list">
        {RECORDINGS.map((r) => <RecordingItem key={r.slug} recording={r} reduced={reduced} keys={keys} />)}
      </ol>
    </section>
  );
}
