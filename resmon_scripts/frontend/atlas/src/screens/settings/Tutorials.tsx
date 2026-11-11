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
import askGif from './tutorials/ask.gif';
import askStill from './tutorials/ask.png';
import libraryGif from './tutorials/library.gif';
import libraryStill from './tutorials/library.png';
import lookUpGif from './tutorials/look-up.gif';
import lookUpStill from './tutorials/look-up.png';
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
 * Ask's recording was answered by a real Codex sign-in, so the answer shown
 * is one a model wrote.
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
    shows: (keys) => `Started with ${keys('new-sweep')}: three sources asked at once, how each one answered, and the `
      + 'run’s report.',
  },
  {
    slug: 'look-up', title: 'Look Up a Paper', gif: lookUpGif, still: lookUpStill,
    shows: () => 'A DOI typed in, what it reads as and which sources can be asked by one, each source’s answer, '
      + 'and the paper they hold.',
  },
  {
    slug: 'watches', title: 'Watches', gif: watchesGif, still: watchesStill,
    shows: () => 'A new watch named, given a term and two sources, and saved; then the calendar of what is due.',
  },
  {
    slug: 'library', title: 'Library', gif: libraryGif, still: libraryStill,
    shows: () => 'A PDF from your library opened in focus mode and scrolled, every page in the gallery, and a '
      + 'sentence selected. The paper is “Analog quantum approximate optimization algorithm for solving the weighted '
      + 'MaxCut problem on three-dimensional single-atom Rydberg array” by Junxi Chen and I. I. Beterov '
      + '(arXiv:2611.13796), shown under CC BY 4.0.',
  },
  {
    slug: 'ask', title: 'Ask', gif: askGif, still: askStill,
    shows: () => 'A question about the collection, sent to Codex with resmon’s read-only tools; the answer is the '
      + 'model’s own, with the model and tokens it reported.',
  },
  {
    slug: 'health', title: 'Health', gif: healthGif, still: healthStill,
    shows: () => 'The Source Wall, where each mark is what a source did on one run, then a finding on the Watchdog.',
  },
  {
    slug: 'getting-around', title: 'Getting Around', gif: gettingAroundGif, still: gettingAroundStill,
    shows: (keys) => `The command palette (${keys('palette')}), the keyboard shortcuts (?), and back again with a `
      + `two-finger swipe and ${keys('back')}. Web links open with a loading line and Open in Your Browser.`,
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
        real sources. A wait for a source is shown faster, and says so. Ask’s answer was written by Codex, signed in
        on the machine that made the recording.
      </p>
      <ol className="tutorial-list">
        {RECORDINGS.map((r) => <RecordingItem key={r.slug} recording={r} reduced={reduced} keys={keys} />)}
      </ol>
      <p className="form-hint">
        Today’s Open Its Page goes straight to a paper without saving it. Deep Sweeps and watch editors offer
        Select All and Deselect All for sources. Source Limits and Keys opens their longer notes and remembers
        the choice in this window. When a site refuses a PDF download, Open the Copy in Your Browser opens its address.
      </p>
      <p className="form-hint">
        On a running Deep Sweep, Stop This Source stops one slow source, and Stop Unfinished Sources stops the
        rest once one has answered; the run keeps what they returned and finishes. Its map fills in as each
        source answers, colored by source. Stop still cancels the whole run and keeps the papers already stored.
      </p>
      <p className="form-hint">
        Paper Actions, on a search result, a run’s papers, a paper on the map or Today, and a Library card,
        saves a paper to read, gets or reads its PDF, or adds it to a project, getting the PDF first. A
        paper’s page shows where it already is: its reading shelf, its files, and its projects, each a link.
        Right-click a link to a paper’s page for Save to Read.
      </p>
      <p className="form-hint">
        Each term you add in Ask the Sources or a watch’s editor offers up to six related terms from the papers in
        this collection that use it; choose one to add it. Match, under the terms, keeps a paper with any one of
        them (Any Term) or only a paper with every one (All Terms). Ask About This Paper, on a paper’s page and in the reader,
        prepares a question about it in Ask, which you edit and send; sending attaches the paper’s Library file, and
        Ask can read that file in the conversation and no other. Shared Wording’s two charts filter its pairs by
        how much they share and by kind.
      </p>
      <p className="form-hint">In Evidence, Hide Files and Hide Notes fold the columns; Shift+⌘+\ (Ctrl+Shift+\ off macOS) folds or unfolds both. PDF drawing and each page’s canonical text are checked separately. Shared Wording offers CSV and Markdown exports and a Standard Statements group. Regions on the map can be sorted, found, and selected; neighboring regions use distinct colors. A run’s partial source answers each have their own paragraph.</p>
    </section>
  );
}
