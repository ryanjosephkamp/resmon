---
title: "Install and launch"
summary: "Prerequisites, the backend and frontend setup, installing a published build, opening an unsigned build, and starting the app."
order: 6
readmeLines:
  - "477-615"
---
## Installation

### Prerequisites

resmon is a hybrid Python + Electron application, so both runtimes must be available on the host machine before installation.

- **Python 3.10, 3.11, or 3.12** — required by the FastAPI backend (`resmon_scripts/resmon.py`) and its dependencies. Verify with `python3 --version`. All three are covered by CI on every push.
- **Node.js 22.13 or newer** — required to build the React renderer with Vite and to run the Electron shell; declared as `engines.node` in `resmon_scripts/frontend/package.json` and pinned for `nvm`/`fnm` in `.nvmrc`. Verify with `node --version`.
- **npm 10 or newer** — bundled with Node.js 22.13 and later; used to install frontend dependencies and invoke the build/start scripts. Verify with `npm --version`.
- **Git** — required to clone the repository.
- **Platform** — macOS, Linux, or Windows. The packaged desktop app is built with `electron-builder` and the headless-daemon split supports launchd (macOS), `systemd --user` (Linux), and Task Scheduler (Windows).

### Backend Setup

Clone the repository, create an isolated Python virtual environment at the project root, and install the pinned backend dependencies:

```bash
git clone <repository-url> resmon
cd resmon

python3 -m venv .venv
source .venv/bin/activate           # macOS / Linux
# .venv\Scripts\activate.bat        # Windows (cmd)
# .venv\Scripts\Activate.ps1        # Windows (PowerShell)

pip install --upgrade pip
pip install -r requirements.txt
```

Optionally, install NLTK's sentence-tokenizer data:

```bash
python -m nltk.downloader punkt_tab
```

This is only used by AI summarization, to split abstracts into sentences before chunking. resmon attempts the download automatically on first import and falls back to a simpler regex splitter if it is unavailable, so the step is not required — but installing it explicitly gives more accurate chunk boundaries, and is worth doing if the machine will be offline or behind a firewall.

The backend reads its SQLite database from `resmon.db` at the project root on first launch and creates the `resmon_reports/` subtree (`markdowns/`, `pdfs/`, `figures/`, `latex/`, `logs/`, `info_docs/`) automatically.

### Frontend Setup

Install the Node dependencies and produce the production renderer and Electron-main bundles:

```bash
cd resmon_scripts/frontend
npm install
npm run build
```

`npm run build` chains two steps: `vite build --config atlas/vite.config.ts` compiles the renderer into `resmon_scripts/frontend/dist/atlas/`, and `tsc --project tsconfig.electron.json` transpiles the Electron main process into `resmon_scripts/frontend/dist/electron/`. Re-run `npm run build` whenever frontend or Electron-main source files change.

## Installing the Application

To build an installable macOS app:

```bash
cd resmon_scripts/frontend
npm run dist
```

`npm run dist` builds for the platform it runs on:

- **macOS** — `release/resmon-<version>-arm64.dmg` (Apple Silicon) or
  `resmon-<version>-x64.dmg` (Intel), ~190 MB. Open it and drag **resmon** to the
  **Applications** shortcut inside. Local builds produce your machine's architecture;
  CI builds both.
- **Windows** — `release/resmon-<version>-setup-x64.exe`, a standard installer.
  SmartScreen will warn on an unsigned installer — choose **More info → Run anyway**.
- **Linux** — `release/resmon-<version>-x86_64.AppImage`. Mark it executable
  (`chmod +x`) and run it.

CI builds all three through `.github/workflows/release.yml` on every version tag.

**Auto-update:** Windows and Linux installs check GitHub Releases shortly after launch
and every six hours, download in the background, and apply on restart (a dialog offers
restart-now). macOS cannot self-update while builds are unsigned — Gatekeeper's update
machinery validates signatures — so macOS users install new versions manually until
code signing lands.

The bundle is self-contained: `scripts/prepare-backend.js` stages the Python sources and
builds a virtual environment inside `Contents/Resources/backend/`, so an installed resmon
does not depend on which Python the machine has, or on the user ever having run `pip`. It
also pre-fetches NLTK's `punkt_tab` data, so AI summarization works offline on first run.
The staged environment is roughly 900 MB and takes a few minutes on the first build; set
`RESMON_REUSE_VENV=1` to reuse an already-built environment on subsequent builds.

### Opening an unsigned build

Releases are currently **unsigned**, and on modern macOS a downloaded unsigned app is
blocked with **“resmon.app” is damaged and can’t be opened. You should move it to the
Trash.** The app is not damaged — this is the standard Gatekeeper refusal for unsigned
software downloaded from the internet, and for unsigned apps macOS often shows this
dead-end dialog rather than any “Open Anyway” option.

The reliable fix is one command after dragging resmon to Applications:

```bash
xattr -dr com.apple.quarantine /Applications/resmon.app
```

Then open resmon normally; macOS never asks again. (If your macOS version shows a
“cannot verify the developer” dialog instead, **System Settings → Privacy & Security →
Open Anyway**, or right-click → **Open** on macOS 14 and earlier, also works.)

## Launching the Application

The desktop experience is a three-process composition: the Electron main process spawns the Python FastAPI backend as a child process (or attaches to an already-running headless daemon), hosts the renderer window, and bridges OS-level capabilities through a contextBridge-exposed `window.resmonAPI` surface. All communication between the renderer and the backend is `fetch`-over-localhost JSON plus Server-Sent Events for live progress — there is no direct IPC from the renderer to Python.

To launch the app for local development or everyday use:

```bash
# From the project root, with the Python virtual environment active:
source .venv/bin/activate

# Launch Electron — it will spawn the Python backend and open the main window.
cd resmon_scripts/frontend
npm start
```

`npm start` runs `npm run build` followed by `electron .`, which loads `dist/electron/main.js` and opens the renderer at the `/` route. The backend binds to `127.0.0.1:8742` by default; the renderer discovers the port through `window.resmonAPI.getBackendPort()`.

The renderer uses a `HashRouter` (the packaged app is loaded from `file://`, where push-state history is unreliable), so every page is reachable under a `#/…` fragment:

| Path | Page |
|---|---|
| `#/` | Dashboard |
| `#/dive` | Deep Dive |
| `#/sweep` | Deep Sweep |
| `#/routines` | Routines |
| `#/calendar` | Calendar |
| `#/results` | Results & Logs |
| `#/configurations` | Configurations |
| `#/monitor` | Monitor |
| `#/repositories` | Repositories & API Keys |
| `#/settings/*` | Settings (nested router) |
| `#/about-resmon/*` | About resmon (Tutorials / Issues / Blog / About App) |

A `Sidebar` + `Header` + `MainContent` layout wraps every route, and a `FloatingWidget` monitor overlay sits outside `MainContent` so it survives route transitions and continues to pulse while any execution is running.
