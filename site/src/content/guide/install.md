---
title: "Install and Launch"
summary: "The downloads and their status, the first launch, updates, the browser extension, the resmon command, the background service, and running from source."
order: 3
---
Download a build from [Releases](https://github.com/ryanjosephkamp/resmon/releases). Each build carries its own Python runtime and everything resmon needs, so installing needs no Python, Node, or `pip`.

## The Downloads

| Platform | File | Status |
|---|---|---|
| macOS, Apple Silicon | DMG | Tested: installed and used daily |
| macOS, Intel | DMG | Built by the release workflow, and launched once by its check; not used daily |
| Windows (x64) | Installer (`.exe`) | Built by the release workflow, and launched once by its check; not used daily |
| Linux (x64) | AppImage | Built by the release workflow, and launched once by its check; not used daily |

The release workflow builds each file, runs the bundled Python runtime and the `resmon` command line that ships inside the app, and launches the packaged app against an isolated instance. It publishes the release only if all four builds pass. Only the Apple Silicon build is used daily, so a problem specific to one of the other three may not have been seen yet. If you meet one, [open an issue](https://github.com/ryanjosephkamp/resmon/issues) with your operating system and what happened.

## macOS

Open the DMG and drag **resmon** to **Applications**. Open it from Applications, not from the disk image or from Downloads.

### The First Launch

The macOS builds are not signed, so macOS blocks the first launch of a downloaded copy. It often says **"resmon.app" is damaged and can't be opened. You should move it to the Trash.** The app is not damaged; this is the refusal macOS gives to unsigned software downloaded from the internet. After you move resmon to Applications, remove the download mark with one command, then open resmon normally:

```bash
xattr -dr com.apple.quarantine /Applications/resmon.app
```

macOS does not ask again. If your macOS version shows a "cannot verify the developer" dialog instead, open **System Settings › Privacy & Security** and choose **Open Anyway**.

An unsigned app opened from Downloads or from the disk image runs from a temporary copy that is gone later. resmon refuses to install the background service or the `resmon` command from such a copy and tells you to move it to Applications first.

### Updates

macOS builds do not update themselves: an update needs a signed app. To update, replace the app by hand. The background service runs from inside the app, so turn it off first: while it runs, Finder refuses to replace the app and says the item is in use.

1. In **Settings › In the Background**, turn off **Run resmon in the background** and confirm. resmon may close and open again by itself.
2. Quit resmon (⌘Q).
3. Open the new DMG, drag **resmon** to **Applications**, and choose **Replace**.
4. Run the `xattr` command above again, because the new copy is a new download.
5. Open resmon, and turn **Run resmon in the background** back on.

Your collection, settings, and keys live outside the app, so replacing it keeps them. If Finder still says the item is in use after the first two steps, stop the service from Terminal, then drag again:

```bash
launchctl bootout gui/$(id -u)/com.resmon.daemon
```

## Windows

Run the installer. It lets you choose the install folder. The installer is not signed, so Windows SmartScreen may warn; choose **More info**, then **Run anyway**.

**Library files and Evidence are unavailable on Windows.** **Library › Your Files** and Evidence (which includes the PDF reader and cited answers) keep and read files with operations that do not follow symbolic links and that work relative to an open folder. Python on Windows does not offer them, so the engine refuses with "Safe descriptor-relative Library access is unavailable on this platform." **To Read** and **Read**, the reading queue, still work; Get the PDF needs the unavailable file storage.

## Linux

Mark the AppImage executable and run it:

```bash
chmod +x resmon-*.AppImage
./resmon-*.AppImage
```

## Updates on Windows and Linux

An installed copy checks GitHub Releases about 15 seconds after it opens, and every 6 hours after that. It downloads a newer version in the background and then asks whether to **Restart Now** or install **On Next Quit**. A failed check, such as an offline laptop, is logged and not shown. There is no setting that turns the check off. On Linux this works only when you run the AppImage itself, not an unpacked copy.

## Save to resmon, the Browser Extension

**Save to resmon** is a Chrome extension, `resmon-extension-1.0.0.zip`, on the release page. It adds **Save to resmon** (on a page) and **Save Link to resmon** (on a link) to the right-click menu, and each opens Look Up a Paper in resmon with the paper filled in. To install it, unzip the file, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped folder. Other Chromium browsers load it the same way. resmon must be installed, because an installed copy is what answers the browser's `resmon://` links. [From Your Browser](/resmon/guide/search/#from-your-browser) has what it fills in and what it never does.

## The `resmon` Command

resmon carries a command line inside the app. It asks the running resmon what it has collected and how its watches are doing: Today, a search of a collection, recent runs, the Source Wall, reference exports, your collections, and whether anything will run your watches. It never opens the database and never starts resmon itself.

To put it on your `PATH`, choose **Install "resmon" Command in PATH**, then open a new terminal:

| Platform | Where the menu item is | What it writes |
|---|---|---|
| macOS | the **resmon** menu | a shell launcher at `/usr/local/bin/resmon`; the system asks for your administrator password only when that folder is not writable |
| Windows | the **Help** menu | `resmon.cmd` in `%LOCALAPPDATA%\resmon\bin`, and that folder on your user `PATH` |
| Linux | the **Help** menu | `~/.local/bin/resmon` and a copy of the command line in `~/.local/share/resmon/`, refreshed each time the app starts |

```bash
resmon --version
resmon today            # papers that arrived since you last marked all read, by watch
resmon collections      # every collection, with its papers and watches
resmon wall             # every source's answer to each recent run
resmon service status   # which resmon it reached, and whether your watches will run
```

**Uninstall "resmon" Command** removes only a launcher resmon wrote. From a clone of the repository you can instead install it with [pipx](https://pipx.pypa.io/); it needs Python 3.10 or later and nothing else:

```bash
pipx install ./resmon_scripts/cli
```

Both can be installed at once, and whichever comes first on your `PATH` answers. `resmon --version` says which one it is. Every command takes `--json`. The other commands are `search`, `runs`, `export`, and `watch list` and `watch add`. `--collection`, by a collection's name or number, chooses the one `today`, `search`, `export`, and `watch add` read or file into; without it they use the default collection. [`resmon_scripts/cli/README.md`](resmon_scripts/cli/README.md) covers each one, and how the command finds a running resmon. With nothing running, it says where it looked and exits with status 3.

## The Background Service

A resmon window does not run your watches. The background service does, and it runs them whether or not a window is open. Turn it on in **Settings › In the Background** with **Run resmon in the background**.

- On **macOS and Windows** the service is the app itself, started with `--service`: no window, no Dock icon, and the engine as its child. The unit is a launch agent on macOS and a scheduled task on Windows.
- On **Linux** the service is the engine alone, started by a systemd user unit, because a user unit has no display for the app to open on.

On macOS, each packaged launch checks an installed service before opening a window. It starts one that is not loaded, starts one waiting to restart, and replaces one running another build of this copy once it has no runs in progress; while runs are going, the service is replaced at the first launch after they finish. It leaves a service pointing at another copy still on disk alone. If macOS has disabled it, Settings names **System Settings › General › Login Items & Extensions › Allow in the Background** as the place to turn it on.

Only one copy of resmon runs at a time: a second launch exits, and the running one brings its window forward, or opens one on its own engine if none is open. A launch that finds the service still starting waits for it, without stopping it; after a moment it shows a small window saying resmon is starting, since the first start after an update keeps a copy of your database, if the disk has room, and then updates it, which can take a few minutes. That window closes when the service opens resmon's. A window opened while the service runs uses the service's engine when their versions match. If they do not, **Settings › In the Background** tells you, and **Health › This Engine** says which engine a window is using. The service writes its logs to a `logs` folder in resmon's state directory, each capped at 5 MB with two older copies kept.

## Running from Source

You need Python 3.10, 3.11, or 3.12, Node.js 22.13 or newer (it brings npm), and Git.

```bash
git clone https://github.com/ryanjosephkamp/resmon.git
cd resmon
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd resmon_scripts/frontend && npm install && npm start
```

`npm start` builds the renderer and the Electron main process, then opens the app. Start it with the virtual environment active, or set `RESMON_PYTHON` to the environment's interpreter; the app uses `python3` from your `PATH` otherwise.

A source run keeps its database in `resmon.db` and its reports in `resmon_reports/` at the root of the clone. An installed app keeps both in resmon's state directory: `~/Library/Application Support/resmon` on macOS, `%LOCALAPPDATA%\resmon` on Windows, and `$XDG_STATE_HOME/resmon` (or `~/.local/state/resmon`) on Linux.

To build an installer for the platform you are on, run `npm run dist` in `resmon_scripts/frontend`. The result is in `release/`. Add `CSC_IDENTITY_AUTO_DISCOVERY=false` (or run `npm run dist:unsigned`) to build without signing.

The window talks to the engine only over HTTP on `127.0.0.1`, on a port chosen when it starts. [Architecture](/resmon/guide/architecture/) describes the pieces, and [Contributing](/resmon/guide/contributing/) covers the tests.
