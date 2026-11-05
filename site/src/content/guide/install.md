---
title: "Install and launch"
summary: "The downloads and their status, the first launch, updates, the resmon command, the background service, and running from source."
order: 3
---
Download a build from [Releases](https://github.com/ryanjosephkamp/resmon/releases). Each build carries its own Python runtime and everything resmon needs, so installing needs no Python, Node, or `pip`.

## The downloads

| Platform | File | Status |
|---|---|---|
| macOS, Apple Silicon | DMG | Tested: installed and used daily |
| macOS, Intel | DMG | Built by the release workflow, and launched once by its check; not used daily |
| Windows (x64) | Installer (`.exe`) | Built by the release workflow, and launched once by its check; not used daily |
| Linux (x64) | AppImage | Built by the release workflow, and launched once by its check; not used daily |

The release workflow builds each file, runs the bundled Python runtime and the `resmon` command line that ships inside the app, and launches the packaged app against an isolated instance. It publishes the release only if all four builds pass. Only the Apple Silicon build is used daily, so a problem specific to one of the other three may not have been seen yet. If you meet one, [open an issue](https://github.com/ryanjosephkamp/resmon/issues) with your operating system and what happened.

## macOS

Open the DMG and drag **resmon** to **Applications**. Open it from Applications, not from the disk image or from Downloads.

### The first launch

The macOS builds are not signed, so macOS blocks the first launch of a downloaded copy. It often says **"resmon.app" is damaged and can't be opened. You should move it to the Trash.** The app is not damaged; this is the refusal macOS gives to unsigned software downloaded from the internet. After you move resmon to Applications, remove the download mark with one command, then open resmon normally:

```bash
xattr -dr com.apple.quarantine /Applications/resmon.app
```

macOS does not ask again. If your macOS version shows a "cannot verify the developer" dialog instead, open **System Settings › Privacy & Security** and choose **Open Anyway**.

An unsigned app opened from Downloads or from the disk image runs from a temporary copy that is gone later. resmon refuses to install the background service or the `resmon` command from such a copy and tells you to move it to Applications first.

### Updates

macOS builds do not update themselves: an update needs a signed app. To update, download the new DMG and replace the app in Applications.

## Windows

Run the installer. It lets you choose the install folder. The installer is not signed, so Windows SmartScreen may warn; choose **More info**, then **Run anyway**.

**The Library is unavailable on Windows.** **Library › Your files** and **Library › Evidence** (which includes the PDF reader and cited answers) keep and read files with operations that do not follow symbolic links and that work relative to an open folder. Python on Windows does not offer them, so the engine refuses with "Safe descriptor-relative Library access is unavailable on this platform." The rest of the app works.

## Linux

Mark the AppImage executable and run it:

```bash
chmod +x resmon-*.AppImage
./resmon-*.AppImage
```

## Updates on Windows and Linux

An installed copy checks GitHub Releases about 15 seconds after it opens, and every 6 hours after that. It downloads a newer version in the background and then asks whether to **Restart now** or install **On next quit**. A failed check, such as an offline laptop, is logged and not shown. There is no setting that turns the check off. On Linux this works only when you run the AppImage itself, not an unpacked copy.

## The `resmon` command

resmon carries a command line inside the app. It asks the running resmon what it has collected and how its watches are doing: Today, a search of the whole collection, recent runs, the Source wall, reference exports, and whether anything will run your watches. It never opens the database and never starts resmon itself.

To put it on your `PATH`, choose **Install "resmon" Command in PATH**, then open a new terminal:

| Platform | Where the menu item is | What it writes |
|---|---|---|
| macOS | the **resmon** menu | a shell launcher at `/usr/local/bin/resmon`; the system asks for your administrator password only when that folder is not writable |
| Windows | the **Help** menu | `resmon.cmd` in `%LOCALAPPDATA%\resmon\bin`, and that folder on your user `PATH` |
| Linux | the **Help** menu | `~/.local/bin/resmon` and a copy of the command line in `~/.local/share/resmon/`, refreshed each time the app starts |

```bash
resmon --version
resmon today            # papers first collected since you last marked all read, by watch
resmon wall             # every source's answer to each recent run
resmon service status   # which resmon it reached, and whether your watches will run
```

**Uninstall "resmon" Command** removes only a launcher resmon wrote. From a clone of the repository you can instead install it with [pipx](https://pipx.pypa.io/); it needs Python 3.10 or later and nothing else:

```bash
pipx install ./resmon_scripts/cli
```

Both can be installed at once, and whichever comes first on your `PATH` answers. `resmon --version` says which one it is. Every command takes `--json`. The other commands are `search`, `runs`, `export`, and `watch list` and `watch add`. [`resmon_scripts/cli/README.md`](resmon_scripts/cli/README.md) covers each one, and how the command finds a running resmon. With nothing running, it says where it looked and exits with status 3.

## The background service

A resmon window does not run your watches. The background service does, and it runs them whether or not a window is open. Turn it on in **Settings › In the background** with **Run resmon in the background**.

- On **macOS and Windows** the service is the app itself, started with `--service`: no window, no Dock icon, and the engine as its child. The unit is a launch agent on macOS and a scheduled task on Windows.
- On **Linux** the service is the engine alone, started by a systemd user unit, because a user unit has no display for the app to open on.

Only one copy of resmon runs at a time: a second launch exits, and the running one brings its window forward, or opens one on its own engine if none is open. A launch that finds the service still starting waits for it, without stopping it; after a moment it shows a small window saying resmon is starting, since the first start after an update updates your database and can take a few minutes, and that window closes when the service opens resmon's. A window opened while the service runs uses the service's engine when their versions match. If they do not, **Settings › In the background** tells you, and **Health › This engine** says which engine a window is using. The service writes its logs to a `logs` folder in resmon's state directory, each capped at 5 MB with two older copies kept.

## Running from source

You need Python 3.10, 3.11, or 3.12, Node.js 22.13 or newer (it brings npm), and Git.

```bash
git clone https://github.com/ryanjosephkamp/resmon.git
cd resmon
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd resmon_scripts/frontend && npm install && npm start
```

`npm start` builds the renderer and the Electron main process, then opens the app. Start it with the virtual environment active, or set `RESMON_PYTHON` to the environment's interpreter; the app uses `python3` from your `PATH` otherwise.

A source run keeps its database in `resmon.db` and its reports in `resmon_reports/` at the root of the clone. An installed app keeps both in resmon's state directory: `~/Library/Application Support/resmon` on macOS, `%LOCALAPPDATA%\resmon` on Windows, and `$XDG_STATE_HOME/resmon` (or `~/.local/state/resmon`) on Linux. Summaries optionally use NLTK's sentence data. resmon tries to download it, and falls back to a simpler splitter if it cannot; to fetch it yourself, run `python -m nltk.downloader punkt_tab`.

To build an installer for the platform you are on, run `npm run dist` in `resmon_scripts/frontend`. The result is in `release/`. Add `CSC_IDENTITY_AUTO_DISCOVERY=false` (or run `npm run dist:unsigned`) to build without signing.

The window talks to the engine only over HTTP on `127.0.0.1`, on a port chosen when it starts. [Architecture](/resmon/guide/architecture/) describes the pieces, and [Contributing](/resmon/guide/contributing/) covers the tests.
