/**
 * What the preload script hands the renderer: the backend's port, this
 * window's API token, the platform, the desktop's file choosers and opener,
 * a relaunch, the app menu's commands, the trackpad's swipe between pages,
 * and the windows (`electron/preload.ts`). Read through
 * one typed accessor so nothing in the Atlas renderer reaches for `window`
 * directly.
 */
export interface ResmonBridge {
  getBackendPort: () => string;
  getApiToken: () => string | null;
  platform?: string;
  /** The desktop's own folder and file choosers, and its opener: absent outside the app. */
  chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
  chooseFile?: (defaultPath?: string) => Promise<string | null>;
  openPath?: (targetPath: string) => Promise<string>;
  revealPath?: (targetPath: string) => Promise<boolean>;
  /** Send a file the Library holds as removed to the system's Trash; '' when it went, else why not. */
  trashPath?: (targetPath: string) => Promise<string>;
  /** Quit and open the app again; false where the main process refuses. Absent outside the app. */
  relaunch?: () => Promise<boolean>;
  /** The app menu's commands (New Deep Dive and the rest, `shell/shortcuts.ts`); returns the way to stop listening. */
  onCommand?: (callback: (command: string) => void) => () => void;
  /** Whether a two-finger swipe moves between pages here, by the system's own trackpad setting. */
  swipeNavigation?: () => Promise<boolean>;
  /** Go back or forward for a two-finger swipe; false where there is no page that way. */
  swipeHistory?: (direction: 'back' | 'forward') => Promise<boolean>;
  /** This window: the collection it shows (null, the only one) and the room to leave for macOS's tab bar. */
  windowState?: () => WindowState;
  onWindowState?: (callback: (state: WindowState) => void) => () => void;
  /** Another window at a page of the app (null: the start page), or on macOS a tab of this one. */
  openWindow?: (route: string | null, tab?: boolean) => void;
  /** A run this window started, so the run's notification shows it here. */
  runStarted?: (executionId: number) => void;
  /** A run this window asked for that waits in the queue: by its ticket, or by its watch for a watch's Run now. */
  runQueued?: (what: { ticket?: string; routineId?: number }) => void;
  /** The theme the app shows, which the system's own parts of a window (its tab bar, its dialogs) then follow. */
  setThemeSource?: (theme: 'system' | 'light' | 'dark') => void;
}

/** What the main process says about this window (`electron/preload.ts`). */
export interface WindowState {
  /** The collection this window shows; null is the only one, until there are several. */
  collection: string | null;
  /** Pixels to leave above the top bar for macOS's tab bar; 0 when the windows are not in tabs. */
  tabStrip: number;
}

export function bridge(): ResmonBridge | null {
  const candidate = (window as unknown as { resmonAPI?: Partial<ResmonBridge> }).resmonAPI;
  if (candidate && typeof candidate.getBackendPort === 'function' && typeof candidate.getApiToken === 'function') {
    return candidate as ResmonBridge;
  }
  return null;
}

/** The platform as Node names it (`darwin`, `win32`, `linux`), or null outside the app. */
export function platform(): string | null {
  return bridge()?.platform ?? null;
}

/** macOS: ⌘ rather than Ctrl, and window controls inset in the top bar. */
export function isMac(): boolean {
  const named = platform();
  return named ? named === 'darwin' : /Mac/.test(navigator.userAgent);
}

/** What to call the system a "follow the system" theme follows. */
export function systemName(): string {
  switch (platform()) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'the desktop';
    default: return 'the system';
  }
}
