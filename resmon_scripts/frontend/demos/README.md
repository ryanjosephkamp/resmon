# `demos/` — the Atlas recordings

Seven short GIFs of Atlas in use, one task each, shown in Settings › Tutorials and later in
the README, and one full-length video of all seven for YouTube. Everything here makes them
again after a change to the screens they show.

| File | What it does |
|---|---|
| `build_collection.py` | Builds the collection the demos are recorded over, from scratch, in a folder of its own. |
| `atlas.demo.ts` | The seven demos, one Playwright case each, at a person's pace. |
| `recorder.ts` | Launches resmon over a copy of the collection, draws the pointer and keycaps, and films the window. |
| `media.ts` | Turns the takes into the GIFs, their stills, and the tour video. |
| `titles.ts` | The tour's order, titles, and the line on each title card. |

## Re-recording

From `resmon_scripts/frontend`, with the engine's interpreter (the repository's `.venv`) and
ffmpeg on hand:

```bash
npm run build                                   # the demos launch the built app

# 1. The collection: about 1,700 public papers, most from arXiv, three watches and their runs,
#    two searches, a library of three PDFs, and the map. Needs the network; about
#    half an hour, most of it waiting on arXiv's rate limit while the library's
#    papers are checked for their licenses. The folder must not exist.
../../.venv/bin/python demos/build_collection.py ~/resmon-demo-collection

# 2. The takes. Each case copies the collection, so a case can be run again alone.
RESMON_PYTHON=$PWD/../../.venv/bin/python \
RESMON_DEMO_COLLECTION=~/resmon-demo-collection \
RESMON_DEMO_OUT=~/resmon-demo-takes \
  npm run demos                                 # or: npm run demos -- -g "Deep Dive"

# 3. The GIFs and stills (into atlas/src/screens/settings/tutorials/) and the tour.
RESMON_DEMO_OUT=~/resmon-demo-takes FFMPEG=$(which ffmpeg) \
RESMON_DEMO_TOUR=~/resmon-tour.mp4 \
  npm run demos:media                           # or: npm run demos:media -- today
```

Record soon after building the collection: its runs are dated around the day it was
built, and Today counts from the moment the build marked it read.

Then look at every GIF and at the video before committing them. `media.ts` prints each
GIF's length and size and says when one is over 3 MB; together they stay under 15 MB.

## What the collection reconstructs

The papers are real, and so is most of what is done with them; one part is laid out
rather than run, and the recordings show it.

- **Real:** every paper, fetched from arXiv's public API (titles, authors and abstracts
  are arXiv's metadata, which arXiv releases under CC0); today's run of each watch; the
  Deep Sweep and the Deep Dive made during the build; and every source outcome those
  runs recorded. CORE has no key here, and today's run of the protein watch recorded
  that, so the Watchdog's "CORE has no API key configured" is the engine's own finding.
- **Reconstructed:** the watches' daily runs before today. Each topic's papers are laid
  out as the runs that would have collected them, by each paper's own publication date:
  the times are made up, the papers are not, and CORE is recorded on each as the engine
  records a source with no key. The Source wall draws those runs, and the Watchdog's
  "'Protein structure' has found nothing new in its last 5 runs" is drawn from them: the
  newest arXiv papers on that topic were several days old when the collection was built,
  so the reconstructed runs of the days since found nothing.

## The papers in the Library recording

The Library demo shows a paper's own pages, and the recordings are public, so the build
takes the library's PDFs only from papers whose license allows that: CC BY 4.0,
CC BY-SA 4.0 or CC0, as arXiv's OAI-PMH metadata records it. arXiv's default license lets
arXiv distribute a paper and nobody else, so a paper under it is passed over. Papers whose
filmed pages show no email address come first. The build writes what it chose to
`library.json` beside the collection. The recordings committed here show:

| Paper | Authors | License |
|---|---|---|
| [Difficulty Calibration Across Time for Membership Inference in Diffusion Models](https://arxiv.org/abs/2610.40616) (arXiv:2610.40616), the one the demo opens | Michael Joseph, Yedid Hoshen | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [Localizing Concepts in Visual Autoregressive Models](https://arxiv.org/abs/2610.40061) (arXiv:2610.40061), named in the file list only | Nanxiang Jiang, Yang Liu, Yuanhao Wang, Min Xu | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [PROTEAN: Beyond De Novo Generation - Can LLM Agents Perform Text-Guided Protein Structure Editing?](https://arxiv.org/abs/2610.17765) (arXiv:2610.17765), named in the file list only | Encheng Su and 13 others | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

The filmed pages of the first show its authors and affiliation and no email address. The
pages are shown unchanged; the recording adds the app's pointer and a text selection.
The tour video shows the same paper, so its description on YouTube should credit it the
same way.

## What to know

- **Nothing here touches anybody's resmon.** The build and every recording use their own
  state directory, database, reports, port file and Chromium profile, the null keyring
  (so no source has a key and none is stored), no AI command, and no scheduler. The
  engine refuses any connection to the background service's port, 8742.
- **The searches are live.** The Deep Dive and the Deep Sweep ask the real sources. A run
  that does not complete fails its case rather than being filmed: record it again, later
  if a source is refusing requests. arXiv answers a burst with HTTP 429 for some minutes.
- **A wait is shown faster, and says so.** While a search waits on its sources the film
  runs 3 or 8 times faster, with a label in the corner saying so; a person's own pointer
  and typing are never sped up.
- **The pointer and keys are drawn in the page,** since a screencast has neither, and the
  title cards are drawn in Atlas's own type and colors.
- **Ask has no demo** until it can be recorded with a real signed-in model: a demo never
  shows an answer from the test runtime as if a model wrote it.
- Today is recorded in the dark theme and the rest in light, at a 1440 × 900 window. The
  GIFs are 960 pixels wide at 15 frames a second (12 when 15 will not fit); the video is
  H.264, 1920 × 1080, 30 fps, with no audio.
