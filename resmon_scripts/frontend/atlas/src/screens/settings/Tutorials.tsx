/**
 * The recorded walk-throughs, as links that open in the person's own browser.
 *
 * Links, never embeds: an embedded player is a request to somebody else's
 * server made by the act of opening this place. And the recordings are of
 * the earlier interface, which this says, because a video that shows other
 * screens than the ones on yours would otherwise read as a mistake.
 */
const WALKTHROUGHS: readonly { id: string; title: string; covers: string; atlas: string }[] = [
  { id: 'vOSICNFJW7I', title: 'The whole app', covers: 'From launch to a watch’s first scheduled run.', atlas: 'Every section' },
  { id: 'O9v7-8IHZHw', title: 'The dashboard', covers: 'Active watches, recent runs and their exports.', atlas: 'Today' },
  { id: 'C9F5H_-mzzY', title: 'A Deep Dive', covers: 'One source in depth, with an optional summary of each paper.', atlas: 'Search › Ask the sources' },
  { id: 'SiNrU6os5AY', title: 'A Deep Sweep', covers: 'Several sources at once, deduplicated into one report.', atlas: 'Search › Ask the sources' },
  { id: 'ZcR-eEw--ho', title: 'Routines', covers: 'Making, changing, starting and stopping a scheduled search.', atlas: 'Watches' },
  { id: 'AcTF9d39BNA', title: 'The calendar', covers: 'Past runs and scheduled ones, by day, week and month.', atlas: 'Watches › the month ahead' },
];

export function Tutorials() {
  return (
    <section className="settings-group tutorials" aria-labelledby="tutorials-title" aria-busy={false}>
      <h2 id="tutorials-title" className="group-title">Tutorials</h2>
      <p className="group-lede">
        Walk-throughs on YouTube, recorded in the earlier interface. The steps are the same; the screens look different,
        and each says where its part of the app is now.
      </p>
      <ol className="tutorial-list">
        {WALKTHROUGHS.map((w) => (
          <li key={w.id}>
            <div>
              <p className="tutorial-title">{w.title}</p>
              <p className="tutorial-covers">{w.covers} Now in: {w.atlas}.</p>
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
