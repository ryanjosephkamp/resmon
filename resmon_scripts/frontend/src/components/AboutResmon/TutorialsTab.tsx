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
      'Local-first SQLite store, BYOK (bring-your-own-key) AI summarization, optional Google Drive backup, and an optional closed-beta resmon-cloud mirror.',
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
      'Open the Dashboard from the sidebar (route `/`) to see the welcome hero, a feature grid, the cloud sign-in card, and two tables: Active Routines and Recent Activity.',
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
      'Click `Create Routine` to open the editor: pick repositories, keywords, optional date range, max results, flags (AI / Email / Results-in-Email / Notify-on-Completion), a 5-field cron expression, and the execution location (Local or Cloud).',
      'Use `Edit` on any local row to reopen the editor pre-populated from the existing routine; saving issues `PUT /api/routines/{id}`.',
      'Toggle `Activate` / `Deactivate` to start or stop scheduling without deleting the row.',
    ],
    features: [
      'Per-row quick toggles for Email, AI, and Notify columns patch the matching flag in a single click.',
      '`Move to Cloud` and `Move to Local` perform a confirmation-gated, destination-first create / source-delete migration.',
      'When a routine is currently firing, a `Cancel Run` button appears on its row and routes through the shared `ExecutionContext`.',
    ],
    tips: [
      'Local routines fire via APScheduler in the local daemon; cloud routines require sign-in and fire on the resmon-cloud scheduler.',
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
    anchor: 'results',
    title: 'Results & Logs',
    blurb: 'Browse, filter, view, export, and delete every past execution.',
    mediaCaption: 'Results & Logs demo.',
    youtubeId: 'ckj7MByzhsg',
    instructions: [
      'Browse executions in reverse-chronological order; filter by Type, Status, and (when signed in) Local / Cloud / All.',
      'Click a row to open the viewer and switch between the Report, Log, Metadata, and Progress tabs.',
      'Select rows and click `Export Selected` to write a zip bundle, or `Delete Selected` to remove the selected local rows after a confirmation dialog.',
    ],
    features: [
      'Deep-link directly into a row and tab via URL hash, e.g. `#exec=42&tab=report`.',
      'The Local / Cloud / All filter chip is rendered only when signed in.',
    ],
    tips: [
      'Cloud rows are read-only on this page; selection skips them and the row click opens an informational cloud card.',
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
    blurb: 'Inspect the catalog and manage per-repository API keys (local or cloud).',
    mediaCaption: 'Repositories & API Keys demo.',
    youtubeId: 'QIcgil9JNU8',
    instructions: [
      'Browse the catalog with one row per active repository; click a name (or caret) to expand a details panel showing subject coverage, endpoint, rate limit, and credential requirement.',
      'Use Expand All / Collapse All to reveal or hide every detail panel at once.',
      'For key-gated repositories, type a key into the inline input and press Enter to save it; click `Clear` on a row with a saved key to delete it.',
      'Toggle the scope selector between `This device (keyring)` and `Cloud account` to choose which credential store reads and writes target.',
    ],
    features: [
      'Saved keys always render as a fixed 12-character mask (`************`); the backend never returns key values.',
      'A `Looking for AI API key settings?` button at the top of the page deep-links to Settings → AI for provider-level keys.',
    ],
    tips: [
      'The cloud scope requires sign-in; signing out while viewing it snaps the selector back to local automatically.',
      'Use the local (keyring) scope for personal devices and the cloud scope to share a key set across signed-in devices.',
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
      'Click a tab — Email, Cloud Account, Cloud Storage, AI, Storage, Notifications, or Advanced — to switch panels.',
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
    anchor: 'settings-account',
    title: 'Settings → Cloud Account',
    blurb: 'Sign-in / sign-out for the closed-beta resmon-cloud mirror.',
    mediaCaption: 'Cloud Account demo.',
    youtubeId: 'kpT3gL0C4Lo',
    instructions: [
      'Read the in-panel `PageHelp` block to understand what cloud sign-in unlocks (cloud routines, cloud-scoped credentials, cloud-executed reports).',
      'Treat this panel as informational in this build — no sign-in control is rendered because no hosted identity provider is wired yet.',
    ],
    features: [
      'The backend cloud-auth routes (`/api/cloud-auth/session`, `/status`, `/refresh`, `/sync`) already exist and are JWKS-verified per IMPL-29 / 30; they are simply not consumed by this panel today.',
    ],
    tips: [
      'Local executions never depend on cloud sign-in — all on-device features work fully without signing in.',
      'Watch for future updates that wire a hosted identity provider into this panel.',
    ],
    destination: { path: '/settings/account', label: 'Go to Tab' },
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
      'Cloud Storage (Drive) and Cloud Account (resmon-cloud) are independent — linking one does not affect the other.',
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
      'Click `Save` to persist app-wide AI settings; click `Save as default model` to pin the chosen model into `ai_default_models[provider]` so it survives provider switches.',
    ],
    features: [
      'Each provider has its own keyring slot (e.g. `openai_api_key`, `anthropic_api_key`, `custom_llm_api_key`) — switching providers no longer clobbers other providers\' keys.',
      'The Stored API Keys table lets you switch the active provider by clicking its row, clear a per-provider default model, or clear a stored API key.',
    ],
    tips: [
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
      'The on-disk cloud-execution cache (`CLOUD_CACHE_MAX_BYTES_DEFAULT`) is capped independently of these policies.',
    ],
    tips: [
      'PDF and TXT policies are reserved for a future per-paper artifact download feature and have no effect on current Deep Dive / Deep Sweep output.',
      'Set the export directory to a synced folder (Drive, Dropbox, iCloud) to share exported reports across devices without enabling cloud sync.',
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
      'Danger Zone section (bottom of the tab): two columns — `Local device` (active) and `Cloud account` (scaffolding, disabled until cloud sign-in lands). Each column exposes the same eight destructive actions.',
      'Danger Zone — API-key wipes (`Erase all AI API keys`, `Erase all repo API keys`): click the button, then click the green `Confirm` (or red `Cancel`) in the simple confirmation modal. No typed confirmation is required.',
      'Danger Zone — destructive data/settings actions (`Erase all configs`, `Erase execution history`, `Erase all execution data`, `Erase all app data`, `Reset all settings`, `Factory reset`): click the button, read the irreversibility warning, type `CONFIRM` (case-sensitive, all caps) into the input, then click the red `Confirm` button (disabled until the typed value matches exactly).',
    ],
    features: [
      '`/api/health` is polled every 5 seconds to display PID, uptime, and version.',
      'Saved limits flow into the in-process `admission` controller (IMPL-R1 / R2) and into the scheduler\'s routine-fire queue (IMPL-R3 / R6).',
      'Danger Zone actions call dedicated `POST /api/admin/erase-*`, `POST /api/admin/reset-settings`, and `POST /api/admin/factory-reset` endpoints; on success the page broadcasts on `configurationsBus`, `routinesBus`, and the `resmon:execution-completed` window event so Dashboard, Configurations, Routines, Calendar, and Results & Logs all refresh.',
      '`Erase execution history` also resets the auto-incremented `Execution #N` counter (the executions `sqlite_sequence` row) so the next run starts back at `Execution #1`.',
      'Composite actions are exact supersets: `Erase all execution data` = configs + executions; `Erase all app data` = AI keys + repo keys + execution data (non-AI settings preserved); `Reset all settings` = settings reset + AI keys + repo keys (configs and executions preserved); `Factory reset` = app data + reset settings.',
      'Cloud-column buttons are scaffolding only — they are rendered disabled with a "Coming soon — requires cloud sign-in" tooltip until the cloud-account feature lands.',
    ],
    tips: [
      'Lower `max_concurrent_executions` to throttle resource bursts when many routines fire at once; the routine-fire queue limit guards APScheduler against backlog runaway.',
      'Installing the OS service unit is what lets routines fire while the Electron UI is closed.',
      'Danger Zone actions are irreversible. Export anything you want to keep first: configurations from the Configurations page, and reports / logs from Results & Logs.',
      'The typed-`CONFIRM` gate is case-sensitive and must be all caps — `confirm`, `Confirm`, and trailing whitespace are rejected. The red `Confirm` button stays disabled until the input matches exactly.',
      'Local-column actions only affect this device; Cloud-column actions (once enabled) only affect data stored in your resmon-cloud account.',
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
