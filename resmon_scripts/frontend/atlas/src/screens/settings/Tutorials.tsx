/**
 * The recorded walk-throughs, as links that open in the person's own browser.
 *
 * Links, never embeds: an embedded player is a request to somebody else's
 * server made by the act of opening this place. And the recordings are of
 * the earlier interface, which this says, because a video that shows other
 * screens than the ones on yours would otherwise read as a mistake.
 *
 * Each entry keeps two things apart: what the recording shows, which is the
 * earlier interface and is said in the past tense of that interface, and
 * where that part of resmon is now, which must be true of the screens here.
 * Where the two differ (the earlier calendar had day and week views and drew
 * past runs; the month ahead draws only what is due), the second says so.
 */
const WALKTHROUGHS: readonly { id: string; title: string; shows: string; now: string }[] = [
  {
    id: 'vOSICNFJW7I', title: 'The whole app',
    shows: 'From the first launch to a watch’s first scheduled run.',
    now: 'Every section. A watch runs on schedule only with the background service on, in Settings › In the background.',
  },
  {
    id: 'O9v7-8IHZHw', title: 'The dashboard',
    shows: 'Active routines, recent runs, and their exports, on one page.',
    now: 'Today shows the papers new since you last looked, by watch, beside a map of your whole collection where any '
      + 'paper opens beside it; Watches lists every watch; and every run, with its exports, is listed beside '
      + 'Search › Ask the sources.',
  },
  {
    id: 'C9F5H_-mzzY', title: 'A Deep Dive',
    shows: 'One source asked in depth, with an optional summary of each paper.',
    now: 'Search › Ask the sources, with Deep Dive chosen; for summaries, tick Summarize each paper. A finished run’s '
      + 'Map tab draws its papers on a map of their own.',
  },
  {
    id: 'SiNrU6os5AY', title: 'A Deep Sweep',
    shows: 'Several sources asked at once, their papers deduplicated into one report.',
    now: 'Search › Ask the sources, with Deep Sweep chosen. A finished run’s Map tab draws its papers on a map of '
      + 'their own.',
  },
  {
    id: 'ZcR-eEw--ho', title: 'Routines',
    shows: 'Making, changing, starting, and stopping a scheduled search, which the earlier interface called a routine.',
    now: 'Watches, where a routine is a watch: New watch, then Change, Pause, Resume, and Run now on the watch’s own page.',
  },
  {
    id: 'AcTF9d39BNA', title: 'The calendar',
    shows: 'Past runs and scheduled ones, by day, week, and month.',
    now: 'Watches › The month ahead draws only what is due, five weeks from the start of this one, with no day or week '
      + 'view. Past runs are on each watch’s own page, and every run is listed beside Search › Ask the sources.',
  },
];

export function Tutorials() {
  return (
    <section className="settings-group tutorials" aria-labelledby="tutorials-title" aria-busy={false}>
      <h2 id="tutorials-title" className="group-title">Tutorials</h2>
      <p className="group-lede">
        Walk-throughs on YouTube, recorded in the earlier interface: the screens in them are not the ones here, and
        some of what they show works differently now. Under each, what the recording shows, then where that part of
        resmon is now.
      </p>
      <ol className="tutorial-list">
        {WALKTHROUGHS.map((w) => (
          <li key={w.id} data-tutorial={w.id}>
            <div>
              <p className="tutorial-title">{w.title}</p>
              <p className="tutorial-covers">In the recording: {w.shows}</p>
              <p className="tutorial-covers" data-tutorial-now="">Now: {w.now}</p>
            </div>
            <a className="btn sm" href={`https://www.youtube.com/watch?v=${w.id}`} target="_blank" rel="noreferrer noopener">
              Watch on YouTube
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
