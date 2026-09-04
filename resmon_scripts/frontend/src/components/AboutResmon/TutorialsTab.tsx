import React, { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Tutorial demo videos are hosted on YouTube and embedded here via
// privacy-enhanced ``youtube-nocookie.com`` <iframe> elements. An
// earlier iteration bundled local ``.mp4`` files through webpack, but
// the resulting renderer bundle (~918 MiB across 17 videos) was
// untenable and two single files exceeded GitHub's 100 MB limit, so
// the embed model switched to per-section YouTube videos.

interface TutorialSection {
  /** DOM id used for in-page anchors (e.g. ``dashboard``). */
  anchor: string;
  /** Heading rendered in the section panel and used in the TOC list. */
  title: string;
  /** Short description rendered above the media. */
  blurb: string;
  /**
   * Caption rendered under the embedded YouTube player (or, when
   * ``youtubeId`` is unset, inside the placeholder card). Update 3 /
   * 4_27_26 follow-up: tutorial media are now per-section YouTube
   * embeds rather than bundled GIFs / ``.mp4`` files; GIFs hit
   * free-tier converter size limits and bundled ``.mp4`` files made
   * the renderer bundle too large to ship.
   */
  mediaCaption: string;
  /**
   * Optional YouTube video ID. When set, the tutorial section renders
   * a privacy-enhanced ``youtube-nocookie.com`` <iframe> in a 16:9
   * container. When unset, the dashed placeholder card is rendered so
   * deep-links keep working before the video is recorded.
   */
  youtubeId?: string;
  /** Step-by-step instructions for the page or sub-tab. */
  instructions: string[];
  /** Notable special features users should know about. */
  features: string[];
  /** Tips & tricks for using the page or sub-tab effectively. */
  tips: string[];
  /**
   * Optional destination route for the section's `Go to Page` /
   * `Go to Tab` button. Omitted on the full-app overview, which has no
   * single navigation target.
   */
  destination?: { path: string; label: string };
}

/**
 * Section list — order matters for the prev/next nav buttons. The
 * first entry is the full-app YouTube placeholder; the remaining
 * entries cover every existing top-level page (10) and every Settings
 * sub-tab (7), each with its own anchor.
 *
 * Every fact below is grounded in the corresponding ``*_info.md``
 * document under ``resmon_reports/info_docs/`` and in the matching
 * page / panel component. Keep this list in lock-step with those
 * sources; any drift is a documentation bug.
 */
const sections: TutorialSection[] = [
  {
    anchor: 'full-app',
    title: 'Full App Overview',
    blurb: 'A guided walk-through of resmon end-to-end, from launch to first scheduled fire.',
    mediaCaption: 'YouTube walk-through.',
    youtubeId: 'vOSICNFJW7I',
    instructions: [
      'Use the left sidebar to switch between the ten top-level pages: Dashboard, Deep Dive, Deep Sweep, Routines, Calendar, Results & Logs, Configurations, Monitor, Repositories & API Keys, and Settings.',
      'Configure your AI provider and API keys under Settings → AI, and add per-repository keys on the Repositories & API Keys page before running searches that require them.',
      'Run a one-off query with Deep Dive (single repository) or Deep Sweep (multiple repositories), or schedule recurring sweeps under Routines using a 5-field cron expression.',
      'Watch live progress on the Monitor page and review past runs on the Results & Logs page.',
    ],
    features: [
      'Local-first SQLite store, BYOK (bring-your-own-key) AI summarization, and optional Google Drive backup.',
      'Persistent APScheduler job store that keeps routines firing across restarts.',
      'A headless `resmon-daemon` that fires routines while the Electron UI is closed.',
    ],
    tips: [
      'Click the small Tutorial button next to any page header (or Settings sub-tab title) to jump straight to that section here.',
      'Restart the daemon after major upgrades so background features (notifications, scheduler changes) pick up the new code path.',
    ],
  },
  {
    anchor: 'dashboard',
    title: 'Dashboard',
    blurb: 'Active routines, recent activity, and per-execution exports at a glance.',
    mediaCaption: 'Dashboard demo.',
    youtubeId: 'O9v7-8IHZHw',
    instructions: [
      'Open the Dashboard from the sidebar (route `/`) to see the welcome hero, a feature grid, and two tables: Active Routines and Recent Activity.',
      'Click `View Report` on a Recent Activity row to open that execution on the Results & Logs page.',
      'Click `Export` on a Recent Activity row to zip that single execution; use `Reveal in Finder` / `Reveal in File Explorer` from the success banner to open the bundle.',
    ],
    features: [
      'When the row\'s execution is the currently focused active execution and is `running` or `cancelling`, the action cell swaps `View Report` / `Export` for `View Monitor` and a live `Cancel` button.',
      'The Active Routines table lists only routines whose `is_active` flag is truthy.',
    ],
    tips: [
      'The Recent Activity table shows the 10 most recent executions; older runs live on the Results & Logs page.',
      'The Dashboard never launches new executions — start them from Deep Dive, Deep Sweep, or Routines.',
    ],
    destination: { path: '/', label: 'Go to Page' },
  },
  {
    anchor: 'deep-dive',
    title: 'Deep Dive',
    blurb: 'Targeted single-repository query with optional AI summarization.',
    mediaCaption: 'Deep Dive demo.',
    youtubeId: 'C9F5H_-mzzY',
    instructions: [
      'Pick a single repository, optionally restrict the date range, enter one or more keywords, and adjust the Max Results slider (10–500).',
      'Optionally toggle Enable AI Summarization; expand the disclosure to override provider, model, length, tone, temperature, or extraction goals for this run only.',
      'Click `Run Deep Dive` to launch; progress streams to the floating widget and to the Monitor page.',
    ],
    features: [
      'Inline `ConfigLoader` (`manual_dive`) reapplies a previously saved configuration; the date range is deliberately not restored.',
      '`Save Configuration` stores the current form (repository, keywords, max results, AI toggle) under the `manual_dive` config type.',
      'After completion, an inline Execution result card shows status, result count, new count, elapsed seconds, and a `View Report` link.',
    ],
    tips: [
      'Per-execution AI overrides leave your app-wide Settings → AI defaults untouched; empty fields are dropped before posting so they never clobber persisted defaults.',
      'If a repository requires an API key, the inline `RepoKeyStatus` indicator surfaces presence so you can fix it before launching.',
    ],
    destination: { path: '/dive', label: 'Go to Page' },
  },
  {
    anchor: 'deep-sweep',
    title: 'Deep Sweep',
    blurb: 'Broad multi-repository query in parallel, deduplicated into one report.',
    mediaCaption: 'Deep Sweep demo.',
    youtubeId: 'SiNrU6os5AY',
    instructions: [
      'Select one or more repositories, enter keywords, optionally set a date range, and set the per-repository Max Results cap.',
      'Optionally enable AI summarization with the same per-execution overrides as Deep Dive.',
      'Click `Run Deep Sweep`; the backend queries each repository, deduplicates the combined set, and produces a single Markdown report.',
    ],
    features: [
      'Deduplication runs by DOI and by `(title + first-author)` across the combined result set.',
      '`ConfigLoader` and `Save Configuration` use the `manual_sweep` config type and skip the date range, mirroring Deep Dive.',
    ],
    tips: [
      'The Max Results slider is per repository, not aggregate — a 100-cap across 5 repositories can yield up to 500 raw rows before deduplication.',
      'Combine Deep Sweep with AI summarization for a fast cross-repository literature scan; per-document summaries are embedded in the report.',
    ],
    destination: { path: '/sweep', label: 'Go to Page' },
  },
  {
    anchor: 'routines',
    title: 'Routines',
    blurb: 'Create, edit, activate, deactivate, and migrate scheduled sweeps.',
    mediaCaption: 'Routines demo.',
    youtubeId: 'ZcR-eEw--ho',
    instructions: [
      'Click `Create Routine` to open the editor: pick repositories, keywords, optional date range, max results, flags (AI / Email / Results-in-Email / Notify-on-Completion), and a 5-field cron expression.',
      'Use `Edit` on any local row to reopen the editor pre-populated from the existing routine; saving issues `PUT /api/routines/{id}`.',
      'Toggle `Activate` / `Deactivate` to start or stop scheduling without deleting the row.',
    ],
    features: [
      'Per-row quick toggles for Email, AI, and Notify columns patch the matching flag in a single click.',
      'When a routine is currently firing, a `Cancel Run` button appears on its row and routes through the shared `ExecutionContext`.',
    ],
    tips: [
      'Routines fire via APScheduler in the local daemon.',
      'Deleting a routine preserves its historical execution rows on Results & Logs.',
    ],
    destination: { path: '/routines', label: 'Go to Page' },
  },
  {
    anchor: 'calendar',
    title: 'Calendar',
    blurb: 'Time-ordered view of past executions and upcoming scheduled fires.',
    mediaCaption: 'Calendar demo.',
    youtubeId: 'AcTF9d39BNA',
    instructions: [
      'Switch between Month, Week, and Day views via FullCalendar\'s header toolbar; use prev / next / today to navigate time.',
      'Narrow the displayed events with the Type filter (Deep Dive / Deep Sweep / Routine), Status filter, and per-routine visibility dropdown (with Select all / Select none).',
      'Click any event to open a popover showing type, status, query, result counts, and a link to the report.',
    ],
    features: [
      'The popover\'s `Edit Routine` button opens the shared `RoutineEditModal`; saves broadcast on both the routines and configurations buses so the Routines and Configurations pages refetch automatically.',
      'Activate / Deactivate the originating routine directly from the popover, or jump to the Routines page.',
    ],
    tips: [
      'Scheduled-fire expansion is capped at 200 fires per routine per request and clamped to a 12-month forward window; a horizon notice appears when upcoming fires would be clipped.',
      'Inactive routines and routines with blank or invalid cron expressions contribute no scheduled events.',
    ],
    destination: { path: '/calendar', label: 'Go to Page' },
  },
  {
    anchor: 'explorer',
    title: 'Explorer',
    blurb: 'Search and filter every paper resmon has ever collected, in one place.',
    mediaCaption: 'Explorer demo.',
    youtubeId: '',
    instructions: [
      'Search titles and abstracts together in the box at the top left. The last word you type is treated as a prefix, so results narrow as you go.',
      'Tick values under Source, Category, and Author to filter. The number beside each is how many papers carry it.',
      'Filters combine with AND: a paper must satisfy every filter you set. Ticking two sources widens across both; a source plus a category narrows to papers in both.',
      'Set a publication date range with the two date fields.',
      '`BibTeX`, `RIS`, and `CSV` export everything matching your filters — not only the papers currently on screen.',
      'The address bar always reflects your filters, so a filtered view can be bookmarked, reloaded, or shared, and the Back button works.',
      '`Why am I seeing this?` on any result shows which of the keywords from the runs that found it actually appear in the paper, and where — title, abstract, categories, or author list.',
      'Papers that have been retracted, corrected, published from a preprint, or superseded by a newer version carry a badge above their metadata, linking the notice. Run the check from the Watchdog page first; badges appear once a paper has been checked.',
    ],
    features: [
      'Searches your whole corpus across every execution and routine, rather than one execution at a time.',
      'Free text runs against a full-text index rather than a substring scan, so it stays fast on a large corpus.',
      'Facet counts update as you filter, and a facet never hides its own alternatives.',
      'Clicking a source or category on the Analytics page opens the Explorer already filtered to it.',
      'Per-result match transparency that states its own limits: resmon does not store full text, and it never claims to know why a relevance-ranked source returned something.',
    ],
    tips: [
      'Coming from Analytics is the intended route: notice something in a chart, click it, read the papers behind it.',
      'Click a category chip on any result to add it to the filters.',
      'Result totals above ten thousand are shown as "10,000+". The exact number changes no decision, and counting it exactly is the one query that cannot be bounded.',
      'Export applies to your filters, not your screen — filter down to a topic first, then export the whole set.',
      'Keywords are matched on whole words, so `AI` does not match `said`. A quoted phrase must appear as a phrase.',
      'A paper matching none of your keywords is normal, not a fault: most sources rank by relevance rather than filtering on literal terms, and the match may be in full text resmon does not store. The panel says so every time.',
    ],
    destination: { path: '/explorer', label: 'Go to Page' },
  },
  {
    anchor: 'analytics',
    title: 'Analytics',
    blurb: 'What your collected papers reveal about your sources and your routines.',
    mediaCaption: 'Analytics demo.',
    youtubeId: '',
    instructions: [
      'Everything on this page is computed from papers already stored on this machine — opening it makes no repository requests and costs no API quota.',
      '`Which sources earn their place` splits each repository into papers nothing else found and papers that also arrived elsewhere. A source with no unique contribution is slowing every sweep without adding anything.',
      '`How quickly each source surfaces a paper` is the median gap between publication and resmon first seeing it. Use it to pick a sensible routine schedule: a source with a two-week median will not deliver sooner because a routine runs hourly.',
      '`Routine health` marks a routine `Quiet` when it has returned nothing new for several runs — usually a sign its keywords are too narrow, or its field has gone still.',
      '`Which keywords earn their place` measures, for every keyword you have searched, how many papers it found that no other keyword of yours did. It reads every paper in your corpus, so it runs on request rather than automatically.',
      '`Publication volume over time` can be grouped by source or by subject category; a paper in two categories is counted in both.',
      'Source names and chart legend entries are links: click one to open the Explorer filtered to it, and read the papers behind the number.',
      'Figures that read `not enough data yet` are being withheld on purpose. Counts are always shown, but averages and percentages wait until there is enough data to mean something, and the sample size is always displayed.',
    ],
    features: [
      'Source contribution and overlap, so you can retire repositories that only duplicate others.',
      'Discovery lag per source, computed from when resmon itself first saw each paper — a figure no repository publishes about itself.',
      'Routine health, with an explicit signal when a routine has stopped finding anything new.',
      'Per-keyword marginal contribution — the measurement that turns query tuning from guesswork into arithmetic.',
      'Publication volume over time, grouped by source or by subject category.',
    ],
    tips: [
      'Papers are matched across sources by DOI, falling back to title when no DOI is present, so the same paper arriving from arXiv and OpenAlex counts as unique to neither.',
      'Discovery lag can be negative when a source dates a paper later than it posts it. Those values are kept rather than discarded, because dropping them would flatter the source.',
      'Undated papers stay in your corpus counts but are left off the timeline instead of being assigned a guessed date.',
      'A routine needs three completed runs before resmon will call it healthy or quiet; one empty run is not evidence.',
      'A keyword whose every paper another keyword also finds is contributing nothing on its own — it costs a slot in every query and buys nothing. That is what the unique count is for.',
      'A keyword\u2019s unique share is withheld until it has matched at least ten papers, because a percentage of nine swings on one paper.',
    ],
    destination: { path: '/analytics', label: 'Go to Page' },
  },
  {
    anchor: 'watchdog',
    title: 'Watchdog',
    blurb: 'Whether your monitoring is still working — because silence alone cannot tell you.',
    mediaCaption: 'Watchdog demo.',
    youtubeId: '',
    instructions: [
      'An empty week looks the same whether nothing was published or your sources stopped answering. This page interrogates that silence, using only runs resmon has already done on this machine — it makes no repository requests and costs no API quota.',
      '`Broken` means resmon recorded the failure: the source got no answer on several runs in a row, a required API key is missing, or an active routine did not fire when its own history says it should have. These are facts, not inferences.',
      'Since resmon 1.8.6 a source whose endpoint was unreachable counts as one that did not answer, even though nothing crashed — every source client degrades rather than failing a sweep, so an outage is recorded as a completed run with zero results. It also no longer counts as the last time that source answered successfully, and no run where a source did not answer can be part of the baseline of what it normally returns.',
      '`Looks unusual` means something departed from the pattern your history established — a source that reliably returned papers has returned none for several runs. There is often an innocent reason, so these are worded as prompts to check, never as faults.',
      '`Worth considering` is advice, not an alarm, and is never counted as one. It appears when a source takes far longer to index papers than your routine waits between runs.',
      '`Show the evidence` on any finding opens the numbers behind it — how many runs, the actual error text, when the source last answered.',
      '`Mute` acknowledges a finding you already know about. It stays listed but stops counting, and the mute is dropped automatically once the condition clears, so a recurrence is reported again.',
      '`Not enough history to judge yet` lists the sources and routines being watched that do not yet have enough runs on record. A watchdog silent because all is well and one silent because it has three data points are different things, and this section keeps them apart.',
      '`Papers that changed after you found them` unfreezes your corpus: retractions and expressions of concern via Crossref, preprints that have since reached a journal, and newer versions of what you hold. Press `Check for retractions and updates` to run it — it is the only part of resmon that makes outbound requests without you starting a search, so it never runs on its own.',
      'The check is bounded and resumable: it takes the least recently checked papers first and reports how many remain. `Check everything` keeps going until the whole corpus is covered, and `Stop` ends it after the current batch — whatever was checked keeps its results.',
    ],
    features: [
      'Per-source health from every run resmon has made, including runs recorded before this feature existed — the history is backfilled on first launch, so the watchdog is useful immediately rather than in three weeks.',
      'Two grades of alarm held deliberately apart: recorded facts and inferences from your own baseline.',
      'Routine overdue detection measured against each routine\u2019s own observed cadence rather than its schedule, which catches the background service being down.',
      'Cadence advice derived from discovery lag, with the caveat that lag is measured through your own polling interval stated in the finding itself.',
      'Per-finding muting that expires when the condition resolves.',
      'A one-line verdict on the Dashboard, so the health of your monitoring is visible without remembering to open this page.',
      'Retraction, expression-of-concern, correction, preprint-to-published and new-version tracking over the papers you have already collected — something no other literature monitor does.',
      'Every lifecycle entry links the notice behind it, and shows who registered it (Retraction Watch or the publisher). resmon never asserts a retraction on its own authority.',
    ],
    tips: [
      'The thresholds are printed at the bottom of the page. They are deliberately conservative — a watchdog that cries wolf gets muted, and then the real failure is missed too.',
      'A paused routine is never reported as overdue. Not firing is the point of pausing it.',
      'Runs you cancelled are not held against a source: stopping a sweep says nothing about whether the source was answering.',
      'A missing API key outranks the error it causes. If a source needs a key you have not set, the finding names the key rather than the HTTP 401 underneath it.',
      'Cadence advice never means anything is broken. A daily routine against a slow source still works — it just spends requests without finding anything sooner.',
      'A correction is not a retraction, and is not colored like one. Grading normal scholarly upkeep as an alarm would teach you to ignore the color, and then the real retraction goes unread too.',
      'An empty lifecycle list on an unchecked corpus is not a clean bill of health, and the page says so rather than implying otherwise. The coverage line tells you how many papers have actually been looked at.',
      'Papers with no DOI and no supported identifier cannot be checked at all. They are counted separately rather than silently treated as clean.',
    ],
    destination: { path: '/watchdog', label: 'Go to Page' },
  },
  {
    anchor: 'results',
    title: 'Results & Logs',
    blurb: 'Browse, filter, view, export, and delete every past execution.',
    mediaCaption: 'Results & Logs demo.',
    youtubeId: 'ckj7MByzhsg',
    instructions: [
      'The `Search record` tab on any execution builds the complete, dated account of that search — exact terms, publication window, per-database record counts, deduplication figures, date and software version — in the shape a PRISMA flow diagram needs. `Download as Markdown` saves it for a methods section.',
      'Browse executions in reverse-chronological order; filter by Type and Status.',
      'Click a row to open the viewer and switch between the Report, Log, Metadata, and Progress tabs.',
      'Select rows and click `Export Selected` to write a zip bundle, or `Delete Selected` to remove the selected local rows after a confirmation dialog.',
      'Use `BibTeX`, `RIS`, or `CSV` to export the papers themselves in a format a reference manager reads, rather than the report about them.',
      'A run whose sources did not all answer says so under its Results count — `n of m sources could not answer` — with a link straight to the Search record, where each one carries the recorded reason. A zero resmon did not observe the reason for is named as unrecorded rather than being folded in with the rest; every run from before resmon 1.8.6 is in that state, because nothing was recording it.',
    ],
    features: [
      'A reproducible search record per execution, mapped onto PRISMA 2020 identification-stage boxes — and explicitly labeled where resmon\u2019s figures have no honest PRISMA equivalent.',
      'Deep-link directly into a row and tab via URL hash, e.g. `#exec=42&tab=report`.',
    ],
    tips: [
      'resmon flags cross-source duplicates and keeps both copies rather than deleting either, so the record reports duplicates *found*, never duplicates *removed*. Saying otherwise would describe an operation that never happened.',
      '`Already held from an earlier run` has no PRISMA box. It is a consequence of monitoring the literature over time rather than running a single search, and the record says so instead of filing it under a heading it does not belong in.',
      'A figure that was never measured shows as `not recorded`, never as 0 — a reviewer reads 0 as a measurement.',
      'The record covers one execution. A review that searched on several dates needs the record from each.',
      'A source that was unreachable is recorded as a completed run with zero results, because every source client degrades rather than failing the sweep. The record no longer counts it among the sources that answered — a strategy listing it as searched would overstate its coverage.',
      'resmon records no screening decisions. Nothing in the record should be presented as an include/exclude outcome.',
      'Set Settings → Storage → Export directory to pin where exports land; otherwise a temporary file is used.',
    ],
    destination: { path: '/results', label: 'Go to Page' },
  },
  {
    anchor: 'configurations',
    title: 'Configurations',
    blurb: 'Manage saved manual-dive, manual-sweep, and routine parameter presets.',
    mediaCaption: 'Configurations demo.',
    youtubeId: 'KbDiioAaLA0',
    instructions: [
      'The page opens on the Routine Configs tab; switch to Manual Configs to view manual_dive and manual_sweep presets together.',
      'Use per-row checkboxes (or the header select-all) to choose rows; click `Export Selected` to write a ZIP archive of JSON files.',
      'Click `Import` to pick one or more `.json` files via the native file picker; each file is validated and inserted as a new configuration.',
      'Click `Delete Selected` to open a confirmation; routine configs cascade-delete the linked routine row when the parameters carry a valid `linked_routine_id`.',
    ],
    features: [
      'Editing a routine config dispatches to `PUT /api/routines/{linked_routine_id}` when present; otherwise it falls back to `PUT /api/configurations/{id}`.',
      'A success banner exposes `Reveal in Finder` / `Reveal in File Explorer` after exports on Electron.',
    ],
    tips: [
      'Date ranges are intentionally never persisted into configurations — they are picked fresh per run or per routine fire.',
      'Imports require the filename to end in `.json`; any non-JSON file short-circuits the entire batch.',
    ],
    destination: { path: '/configurations', label: 'Go to Page' },
  },
  {
    anchor: 'monitor',
    title: 'Monitor',
    blurb: 'Real-time pipeline-stage and per-repository progress for active runs.',
    mediaCaption: 'Monitor demo.',
    youtubeId: 'ASGeeTgzwjY',
    instructions: [
      'The page renders one tab per active execution. Click a tab — or focus it and press Enter / Space — to shift the detail pane.',
      'Toggle the toolbar\'s Verbose Logging checkbox to include INFO-level lines in the Live Activity Log; WARN and ERROR lines always show.',
      'Use the `Cancel` button in the execution header to issue a cooperative cancel on a running run.',
      'After a run terminates, dismiss it via the per-tab `×` button or the toolbar\'s Clear Page action.',
    ],
    features: [
      'Pipeline-stage view, per-repository progress grid, aggregate counters, and a live activity log.',
      'A 3-second safety-net poll attaches background-initiated routine fires and detects dropouts automatically.',
      'Once terminal, the toolbar exposes `View Report` to jump to the finalized report.',
    ],
    tips: [
      'Verbose Logging persists in `localStorage` under `resmon.verboseLogging`.',
      'Newly launched executions auto-focus, so a fresh Deep Dive or Deep Sweep is the active tab without needing to click.',
    ],
    destination: { path: '/monitor', label: 'Go to Page' },
  },
  {
    anchor: 'repositories',
    title: 'Repositories & API Keys',
    blurb: 'Inspect the catalog and manage per-repository API keys.',
    mediaCaption: 'Repositories & API Keys demo.',
    youtubeId: 'QIcgil9JNU8',
    instructions: [
      'Browse the catalog with one row per active repository; click a name (or caret) to expand a details panel showing subject coverage, endpoint, rate limit, credential requirement, and `Date Filtering`.',
      '`Date Filtering` is the finest date precision resmon\u2019s own query to that source can express. Most take exact dates; NASA ADS takes whole months; DataCite, DBLP, ERIC, Open Library and Semantic Scholar take whole years. ERIC and Open Library refuse a window shorter than one calendar year rather than widening it, so a short-window search of those two comes back empty by construction \u2014 and the run\u2019s Search record says exactly that.',
      'Use Expand All / Collapse All to reveal or hide every detail panel at once.',
      'For key-gated repositories, type a key into the inline input and press Enter to save it; click `Clear` on a row with a saved key to delete it.',
    ],
    features: [
      'Saved keys always render as a fixed 12-character mask (`************`); the backend never returns key values.',
      'A `Looking for AI API key settings?` button at the top of the page deep-links to Settings → AI for provider-level keys.',
    ],
    tips: [
      'Keys are stored in your OS keyring and never leave this device.',
    ],
    destination: { path: '/repositories', label: 'Go to Page' },
  },
  {
    anchor: 'settings',
    title: 'Settings (overview)',
    blurb: 'The seven Settings sub-tabs and what each one configures.',
    mediaCaption: 'Settings overview demo.',
    youtubeId: 'Jfvimo4t9bk',
    instructions: [
      'Open Settings from the sidebar; the route defaults to the Email panel.',
      'Click a tab — Email, Cloud Storage, AI, Storage, Notifications, or Advanced — to switch panels.',
      'Within a panel, edit fields and press `Save` (or the panel-specific action button) to persist through `PUT /api/settings/*` (or the corresponding credential / service endpoint).',
    ],
    features: [
      'Secrets (SMTP password, AI provider API keys) live in the OS keychain; the UI only sees presence booleans from `GET /api/credentials`.',
      'Test actions (test email, test API key, list models, link Google Drive, install service, refresh scheduler jobs) call their backend endpoints directly and surface an inline status line.',
    ],
    tips: [
      'About App now lives on the About resmon page (the tab next to Tutorials), not inside Settings.',
      'Each panel auto-clears its inline status line after a few seconds; errors are prefixed `Error:` or `Test failed`.',
    ],
    destination: { path: '/settings', label: 'Go to Page' },
  },
  {
    anchor: 'settings-email',
    title: 'Settings → Email',
    blurb: 'SMTP credentials, sender identity, and test-email delivery.',
    mediaCaption: 'Email settings demo.',
    youtubeId: 'tQnr38l_nEw',
    instructions: [
      'Set `smtp_server`, `smtp_port`, `smtp_username`, `smtp_from`, and `smtp_to`, then click `Save`.',
      'Type the SMTP password and click `Store password` to write it to the OS keychain under the `smtp_password` credential name.',
      'Click `Send test email` to verify the configuration end-to-end.',
      'Click `Remove password` to delete the keychain entry.',
    ],
    features: [
      'Whitespace is stripped from the password input on store, so a Gmail App Password (four space-separated groups) becomes the raw 16-character secret automatically.',
      'The UI fetches only a presence boolean for the password — the value is never returned by the backend.',
    ],
    tips: [
      'Use the Routines page\'s Email and Results-in-Email flags to control which routines actually send mail; this tab only configures the sender.',
      'If the test email fails, double-check the SMTP port (465 implicit TLS vs. 587 STARTTLS) and any provider-specific App Password requirement.',
    ],
    destination: { path: '/settings/email', label: 'Go to Tab' },
  },
  {
    anchor: 'settings-cloud',
    title: 'Settings → Cloud Storage',
    blurb: 'Optional Google Drive backup for execution artifacts.',
    mediaCaption: 'Cloud Storage demo.',
    youtubeId: '-o88hqQtcXQ',
    instructions: [
      'Click `Link Google Drive` to launch the installed-app OAuth flow (`drive.file` scope); follow the browser prompts to grant access.',
      'Toggle `Auto-backup` to push completed executions to Drive automatically (writes `cloud_auto_backup` via `PUT /api/settings/cloud`).',
      'Click `Back up now` to upload `resmon_reports/` immediately; the success line shows the created folder name and a Drive web link.',
      'Click `Unlink` to revoke the OAuth token and discard it locally.',
    ],
    features: [
      'Surfaces Drive-API error reasons via `API_REASON_HINTS` (`accessNotConfigured`, `insufficientPermissions`, `no_token`) so Google Cloud Console issues are diagnosable in-app.',
    ],
    tips: [
      'The `drive.file` scope limits access to files this app creates — it cannot read your existing Drive contents.',
    ],
    destination: { path: '/settings/cloud', label: 'Go to Tab' },
  },
  {
    anchor: 'settings-ai',
    title: 'Settings → AI',
    blurb: 'Multi-provider BYOK API keys plus default summarization parameters.',
    mediaCaption: 'AI settings demo.',
    youtubeId: 'AjE4jmMZ3og',
    instructions: [
      'Choose a Provider from the whitelist (Anthropic, OpenAI, Google, xAI, Meta, DeepSeek, Alibaba, Local, Custom) and pick a Model.',
      'Set the default `Summary length`, `Tone`, `Temperature`, and `Extraction goals` — each label has an `InfoTooltip` explaining valid values.',
      'Paste your provider API key and click `Test key` to validate; click `Load models` to populate the model dropdown from the live provider.',
      'Under `If that fails, try…` add optional fallback providers, in order. Leave it empty and resmon behaves exactly as it did before fallbacks existed.',
      'To use a plan you already pay for instead of a metered key, add `Claude Code (your Claude plan)` or `Codex (your ChatGPT plan)` as a lane. resmon shows whether it could find the command and where; if it cannot, paste the full path into the lane\'s command-path box.',
      'Click `Save` to persist app-wide AI settings; click `Save as default model` to pin the chosen model into `ai_default_models[provider]` so it survives provider switches.',
    ],
    features: [
      'Each provider has its own keyring slot (e.g. `openai_api_key`, `anthropic_api_key`, `custom_llm_api_key`) — switching providers no longer clobbers other providers\' keys.',
      'The Stored API Keys table lets you switch the active provider by clicking its row, clear a per-provider default model, or clear a stored API key.',
      'Fallback chains (1.8) try each provider in order. A rejected key, an exhausted quota or a missing model retires that provider for the rest of the run; one over-long abstract only falls through for that single paper, so a working provider is never abandoned over one difficult document.',
      'Every lane attempt is recorded on the execution — which provider was tried, how many papers it summarized, and why it stopped if it did. The report header names the provider that actually produced the summaries, not the one configured first.',
      'Subscription lanes (1.8c) drive the Claude Code or Codex command you already installed and signed into, so the work is billed to your existing plan. resmon never embeds provider sign-in and never sees your credential; if the CLI is not signed in, the lane says so and stands down.',
      'The command is located by an explicit path you set, then known install locations, then PATH last — because an app launched from the Finder inherits a PATH containing neither CLI, while a terminal finds both.',
      'A subscription lane sends ten papers per call rather than starting a session per paper (1.8.5). The call asks for one numbered summary per paper; a paper the batch did not answer for is re-sent on its own, and if the numbering is inconsistent the whole batch is re-sent one paper at a time rather than risking a summary attached to the wrong paper.',
      'Model and effort are chosen per subscription lane (1.8.5). Codex reports a real model catalog and the reasoning levels each model supports, so only those levels are offered for that model; Claude Code has no models command, so resmon offers the aliases its help documents and says that is what they are. Leaving either unset means the command\u2019s own default.',
      'No effort control is shown for API-key providers, because none of the eight has one. A control that silently did nothing for most providers would be worse than no control.',
    ],
    tips: [
      'A good chain puts your best provider first and Ollama last: the local lane needs no key and costs nothing, so it is the natural floor. resmon has no summarizer beyond the lanes you configure — if every lane fails, those papers simply have no AI summary and the execution records why.',
      'Subscription lanes are the recommended route as of 1.8.5, because batching made them affordable: a paper measured at 0.33× the cost and 0.23× the input tokens of a per-document call. They still spend your own usage window, so a lane is capped at 50 papers per run by default. Reaching the cap is not an error — the rest of the papers go to the next lane and the execution records the cap as the reason.',
      'For the Custom provider, Save is disabled unless the base URL is HTTPS — except for loopback hosts (`localhost`, `127.0.0.1`, `::1`). The backend `llm_factory` enforces the same rule.',
      'Per-execution AI overrides on Deep Dive, Deep Sweep, and Routines transparently override these defaults via per-field merge; empty override fields fall back to your saved defaults.',
    ],
    destination: { path: '/settings/ai', label: 'Go to Tab' },
  },
  {
    anchor: 'settings-storage',
    title: 'Settings → Storage',
    blurb: 'Export directory plus reserved PDF / TXT retention policies.',
    mediaCaption: 'Storage settings demo.',
    youtubeId: 'sfdtAVRp_rc',
    instructions: [
      'Set `export_directory` to pin where configuration / execution exports land; leaving it blank routes exports to a temporary file.',
      'Pick a `pdf_policy` and `txt_policy` (each constrained to `save`, `archive`, or `discard`) and an `archive_after_days` window.',
      'Click `Save` to persist via `PUT /api/settings/storage`.',
    ],
    features: [
      'Retention policy prunes reports older than the archive window on daemon startup.',
    ],
    tips: [
      'PDF and TXT policies are reserved for a future per-paper artifact download feature and have no effect on current Deep Dive / Deep Sweep output.',
      'Set the export directory to a synced folder (Drive, Dropbox, iCloud) to share exported reports across devices.',
    ],
    destination: { path: '/settings/storage', label: 'Go to Tab' },
  },
  {
    anchor: 'settings-notifications',
    title: 'Settings → Notifications',
    blurb: 'Desktop completion notification preferences.',
    mediaCaption: 'Notifications demo.',
    youtubeId: 'lH405JpsBd4',
    instructions: [
      'Toggle `notify_manual` to enable native desktop notifications when manual Deep Dive or Deep Sweep runs complete.',
      'Pick `notify_automatic_mode` — `all`, `selected`, or `none` — to control routine-fired completion notifications.',
      'Click `Request permission` to grant the browser-level notification permission if it is not already granted.',
    ],
    features: [
      'Native OS notifications fire on macOS, Linux, and Windows via the dispatcher.',
      'The dispatcher is invoked from both the foreground app and the headless `resmon-daemon`, so notifications fire even when the Electron UI is closed.',
    ],
    tips: [
      'Email notifications and Google Drive uploads are independent of this tab — toggle them on the Routines page and on Settings → Cloud Storage respectively.',
      'A stale daemon started before a notification-feature update silently drops the new code path until restarted; restart after upgrading.',
    ],
    destination: { path: '/settings/notifications', label: 'Go to Tab' },
  },
  {
    anchor: 'settings-advanced',
    title: 'Settings → Advanced',
    blurb: 'Concurrent-execution policy and APScheduler diagnostics.',
    mediaCaption: 'Advanced settings demo.',
    youtubeId: 'A1KCwF4nHEo',
    instructions: [
      'Background daemon section: click `Install service` to install the platform-specific service unit (launchd / systemd / Task Scheduler), or `Uninstall service` to remove it.',
      'Concurrent executions section: edit `max_concurrent_executions` and `routine_fire_queue_limit` and click Save to persist via `PUT /api/settings/execution`.',
      'Scheduler diagnostics section: review APScheduler jobs (id, name, next-run time, trigger); click `Refresh` to re-fetch.',
      'Danger Zone section (bottom of the tab): eight destructive actions, each affecting data on this device.',
      'Danger Zone — API-key wipes (`Erase all AI API keys`, `Erase all repo API keys`): click the button, then click the green `Confirm` (or red `Cancel`) in the simple confirmation modal. No typed confirmation is required.',
      'Danger Zone — destructive data/settings actions (`Erase all configs`, `Erase execution history`, `Erase all execution data`, `Erase all app data`, `Reset all settings`, `Factory reset`): click the button, read the irreversibility warning, type `CONFIRM` (case-sensitive, all caps) into the input, then click the red `Confirm` button (disabled until the typed value matches exactly).',
    ],
    features: [
      '`/api/health` is polled every 5 seconds to display PID, uptime, and version.',
      'Saved limits flow into the in-process `admission` controller (IMPL-R1 / R2) and into the scheduler\'s routine-fire queue (IMPL-R3 / R6).',
      'Danger Zone actions call dedicated `POST /api/admin/erase-*`, `POST /api/admin/reset-settings`, and `POST /api/admin/factory-reset` endpoints; on success the page broadcasts on `configurationsBus`, `routinesBus`, and the `resmon:execution-completed` window event so Dashboard, Configurations, Routines, Calendar, and Results & Logs all refresh.',
      '`Erase execution history` also resets the auto-incremented `Execution #N` counter (the executions `sqlite_sequence` row) so the next run starts back at `Execution #1`.',
      'Composite actions are exact supersets: `Erase all execution data` = configs + executions; `Erase all app data` = AI keys + repo keys + execution data (non-AI settings preserved); `Reset all settings` = settings reset + AI keys + repo keys (configs and executions preserved); `Factory reset` = app data + reset settings.',
    ],
    tips: [
      'Lower `max_concurrent_executions` to throttle resource bursts when many routines fire at once; the routine-fire queue limit guards APScheduler against backlog runaway.',
      'Installing the OS service unit is what lets routines fire while the Electron UI is closed.',
      'Danger Zone actions are irreversible. Export anything you want to keep first: configurations from the Configurations page, and reports / logs from Results & Logs.',
      'The typed-`CONFIRM` gate is case-sensitive and must be all caps — `confirm`, `Confirm`, and trailing whitespace are rejected. The red `Confirm` button stays disabled until the input matches exactly.',
      'Every action affects only this device.',
    ],
    destination: { path: '/settings/advanced', label: 'Go to Tab' },
  },
];

const TutorialsTab: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Whenever the location's hash changes (set by ``TutorialLinkButton``
  // navigation, by clicking a TOC entry, or by the prev/next buttons),
  // scroll the matching section's heading into view.
  useEffect(() => {
    const raw = location.hash;
    if (!raw) return;
    const id = raw.startsWith('#') ? raw.slice(1) : raw;
    if (!id) return;
    const el = document.getElementById(`tutorial-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  const goToAnchor = (anchor: string) => {
    navigate({ pathname: '/about-resmon/tutorials', hash: anchor });
  };

  return (
    <div className="tutorials-tab settings-panel" ref={containerRef}>
      <h2>Tutorials</h2>
      <p className="text-muted">
        Short walk-throughs for each page and each Settings sub-tab. Click any item in the table of
        contents below, or use the <strong>Tutorial</strong> button next to any page or
        Settings-tab title to jump straight to its section.
      </p>

      <nav className="tutorial-toc" aria-label="Tutorial table of contents">
        <h3>Table of contents</h3>
        <ol>
          {sections.map((s) => (
            <li key={s.anchor}>
              <button
                type="button"
                className="tutorial-toc-link"
                onClick={() => goToAnchor(s.anchor)}
                data-testid={`tutorial-toc-${s.anchor}`}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, idx) => {
        const prev = idx > 0 ? sections[idx - 1] : null;
        const next = idx < sections.length - 1 ? sections[idx + 1] : null;
        return (
          <section
            key={s.anchor}
            id={`tutorial-${s.anchor}`}
            className="tutorial-section"
            aria-labelledby={`tutorial-${s.anchor}-title`}
          >
            <div className="tutorial-section-header">
              <h3 id={`tutorial-${s.anchor}-title`}>{s.title}</h3>
              {s.destination ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary tutorial-goto-btn"
                  onClick={() => navigate(s.destination!.path)}
                  data-testid={`tutorial-goto-${s.anchor}`}
                >
                  {s.destination.label}
                </button>
              ) : null}
            </div>
            <p>{s.blurb}</p>
            {s.youtubeId ? (
              <figure className="tutorial-media" aria-label={s.mediaCaption}>
                <div className="tutorial-media-iframe">
                  <iframe
                    src={`https://www.youtube-nocookie.com/embed/${s.youtubeId}?rel=0&modestbranding=1&playsinline=1`}
                    title={s.mediaCaption}
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                    data-testid={`tutorial-iframe-${s.anchor}`}
                  />
                </div>
                <figcaption>
                  {s.mediaCaption}{' '}
                  <a
                    href={`https://www.youtube.com/watch?v=${s.youtubeId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const api = (window as unknown as { resmonAPI?: { openPath?: (p: string) => void } }).resmonAPI;
                      if (api?.openPath) {
                        api.openPath(`https://www.youtube.com/watch?v=${s.youtubeId}`);
                      }
                    }}
                  >
                    (Watch on YouTube)
                  </a>
                </figcaption>
              </figure>
            ) : (
              <div className="tutorial-media-placeholder" role="img" aria-label={s.mediaCaption}>
                <span>{s.mediaCaption}</span>
              </div>
            )}
            <div className="tutorial-details">
              <div className="tutorial-detail-block">
                <h4>How to use it</h4>
                <ol>
                  {s.instructions.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ol>
              </div>
              <div className="tutorial-detail-block">
                <h4>Special features</h4>
                <ul>
                  {s.features.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="tutorial-detail-block">
                <h4>Tips &amp; tricks</h4>
                <ul>
                  {s.tips.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="tutorial-nav">
              {prev ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToAnchor(prev.anchor)}
                  data-testid={`tutorial-prev-${s.anchor}`}
                >
                  ← {prev.title}
                </button>
              ) : (
                <span />
              )}
              {next ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => goToAnchor(next.anchor)}
                  data-testid={`tutorial-next-${s.anchor}`}
                >
                  {next.title} →
                </button>
              ) : (
                <span />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
};

export default TutorialsTab;
