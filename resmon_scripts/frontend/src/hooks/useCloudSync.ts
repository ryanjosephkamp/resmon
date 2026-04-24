/**
 * useCloudSync — desktop cursor-sync hook (IMPL-36, §12.2).
 *
 * Contract:
 *
 * - When the user is signed in and the renderer window is focused, poll
 *   the cloud service's ``GET /api/v2/sync?since=<last_synced_version>``
 *   on a 60-second interval. On every page, POST the rows to the local
 *   daemon (``/api/cloud-sync/ingest``) which upserts them into the
 *   ``cloud_routines`` / ``cloud_executions`` mirror tables and advances
 *   ``sync_state.last_synced_version`` atomically.
 * - On a focus-gain transition (``visibilitychange`` → visible or
 *   ``window.focus``), trigger an immediate sync once per transition.
 * - If a page reports ``has_more: true`` the hook drains the cursor in a
 *   chained loop inside the same tick so the renderer catches up to head
 *   before the next scheduled poll.
 * - On sign-out, the hook calls ``/api/cloud-sync/clear`` once so the
 *   mirror + cache + cursor are wiped in one transaction (V-G3).
 *
 * Errors are swallowed by design — a transient cloud outage must not
 * propagate an uncaught exception to the renderer. Every failure is
 * surfaced via ``state.lastError`` so the Dashboard "Last cloud sync"
 * card can show a human-readable status.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { cloudClient, CloudUnauthorizedError } from '../api/cloudClient';
import { useAuth } from '../context/AuthContext';

const POLL_INTERVAL_MS = 60_000;
const MAX_PAGES_PER_TICK = 50;
const DEFAULT_PAGE_LIMIT = 200;

export interface CloudSyncPage {
  routines: any[];
  executions: any[];
  credentials_presence: Record<string, boolean>;
  next_version: number;
  has_more: boolean;
}

export interface LocalSyncState {
  last_synced_version: number;
  cache_bytes: number;
  schema_version: number;
}

export interface CloudSyncStatus {
  lastSyncAt: string | null;
  lastSyncedVersion: number;
  cacheBytes: number;
  inFlight: boolean;
  lastError: string | null;
}

const initialStatus: CloudSyncStatus = {
  lastSyncAt: null,
  lastSyncedVersion: 0,
  cacheBytes: 0,
  inFlight: false,
  lastError: null,
};

export interface UseCloudSyncResult {
  status: CloudSyncStatus;
  syncNow: () => Promise<void>;
}

export function useCloudSync(): UseCloudSyncResult {
  const { isSignedIn } = useAuth();
  const [status, setStatus] = useState<CloudSyncStatus>(initialStatus);
  const inFlightRef = useRef(false);
  const prevSignedInRef = useRef(isSignedIn);

  const drainOnce = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus((s) => ({ ...s, inFlight: true, lastError: null }));
    try {
      const local = await apiClient.get<LocalSyncState>('/api/cloud-sync/state');
      let cursor = local.last_synced_version || 0;
      let totalRoutines = 0;
      let totalExecutions = 0;
      for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages++) {
        const page = await cloudClient.get<CloudSyncPage>(
          `/api/v2/sync?since=${cursor}&limit=${DEFAULT_PAGE_LIMIT}`,
        );
        if (
          (page.routines?.length ?? 0) === 0 &&
          (page.executions?.length ?? 0) === 0
        ) {
          break;
        }
        const resp = await apiClient.post<{ last_synced_version: number }>(
          '/api/cloud-sync/ingest',
          {
            routines: page.routines || [],
            executions: page.executions || [],
            next_version: page.next_version || cursor,
            has_more: !!page.has_more,
          },
        );
        totalRoutines += page.routines?.length ?? 0;
        totalExecutions += page.executions?.length ?? 0;
        cursor = resp.last_synced_version;
        if (!page.has_more) break;
      }
      const fresh = await apiClient.get<LocalSyncState>('/api/cloud-sync/state');
      setStatus({
        lastSyncAt: new Date().toISOString(),
        lastSyncedVersion: fresh.last_synced_version,
        cacheBytes: fresh.cache_bytes,
        inFlight: false,
        lastError: null,
      });
      // Surface the pages that were applied so callers can trigger a
      // render refresh if desired. The return is Promise<void> per the
      // public type, but we can still broadcast via a custom event.
      if (totalRoutines + totalExecutions > 0) {
        window.dispatchEvent(
          new CustomEvent('resmon:cloud-sync-applied', {
            detail: { routines: totalRoutines, executions: totalExecutions },
          }),
        );
      }
    } catch (err: any) {
      const msg =
        err instanceof CloudUnauthorizedError
          ? 'Signed out (session expired)'
          : err?.message || String(err);
      setStatus((s) => ({ ...s, inFlight: false, lastError: msg }));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (!isSignedIn) return;
    await drainOnce();
  }, [isSignedIn, drainOnce]);

  // Wipe the mirror + cache + cursor when the user signs out.
  useEffect(() => {
    const wasSignedIn = prevSignedInRef.current;
    prevSignedInRef.current = isSignedIn;
    if (wasSignedIn && !isSignedIn) {
      apiClient.post('/api/cloud-sync/clear').catch(() => {});
      setStatus(initialStatus);
    }
  }, [isSignedIn]);

  // Hydrate the card with the persisted cursor / cache size on mount.
  useEffect(() => {
    apiClient
      .get<LocalSyncState>('/api/cloud-sync/state')
      .then((s) => {
        setStatus((cur) => ({
          ...cur,
          lastSyncedVersion: s.last_synced_version,
          cacheBytes: s.cache_bytes,
        }));
      })
      .catch(() => {});
  }, []);

  // 60-second poll while focused + instant sync on focus-gain.
  useEffect(() => {
    if (!isSignedIn) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let focusHandler: (() => void) | null = null;
    let visibilityHandler: (() => void) | null = null;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        drainOnce().catch(() => {});
      }
    };

    // Initial sync on mount.
    drainOnce().catch(() => {});
    timer = setInterval(tick, POLL_INTERVAL_MS);
    focusHandler = () => drainOnce().catch(() => {});
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        drainOnce().catch(() => {});
      }
    };
    window.addEventListener('focus', focusHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    return () => {
      if (timer !== null) clearInterval(timer);
      if (focusHandler) window.removeEventListener('focus', focusHandler);
      if (visibilityHandler)
        document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }, [isSignedIn, drainOnce]);

  return { status, syncNow };
}

/** Format a byte count for human display (e.g. "523 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
