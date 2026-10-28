/**
 * What the preload script hands the renderer: the backend's port, this
 * window's API token, and the platform (`electron/preload.ts`). Read through
 * one typed accessor so nothing in the Atlas renderer reaches for `window`
 * directly.
 */
export interface ResmonBridge {
  getBackendPort: () => string;
  getApiToken: () => string | null;
  platform?: string;
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
