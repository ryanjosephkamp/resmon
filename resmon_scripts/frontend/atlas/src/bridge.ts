/**
 * What the preload script hands the renderer: the backend's port and this
 * window's API token (`electron/preload.ts`). Read through one typed accessor
 * so nothing in the Atlas renderer reaches for `window` directly.
 */
export interface ResmonBridge {
  getBackendPort: () => string;
  getApiToken: () => string | null;
}

export function bridge(): ResmonBridge | null {
  const candidate = (window as unknown as { resmonAPI?: Partial<ResmonBridge> }).resmonAPI;
  if (candidate && typeof candidate.getBackendPort === 'function' && typeof candidate.getApiToken === 'function') {
    return candidate as ResmonBridge;
  }
  return null;
}
