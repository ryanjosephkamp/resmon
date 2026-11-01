/**
 * The collection the maps specs draw, written through the engine's own
 * database functions before launch, and the ways they reach the engine and a
 * paper on a map: by its title in the map's find, or from the keyboard, never
 * by computing where its dot is drawn. Positions computed from a plate's view
 * missed on a slow runner in a short window four ways (a view read mid-ease, a
 * title block over the dot, a newer dot drawn over it, a click intercepted).
 */
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { atlasEnv, heldScreen } from './resmon-app';

export const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, link_execution_document, record_execution_source, update_execution_status, set_setting)

TOPICS = {
    "protein": ("arxiv", "protein folding residue amino chain conformation binding structure"),
    "traffic": ("crossref", "traffic congestion road sensor commute intersection vehicle flow"),
    "quantum": ("dblp", "quantum qubit circuit entanglement gate decoherence photon error"),
}
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = {t: {"new": [], "old": []} for t in TOPICS}
for topic, (source, words) in TOPICS.items():
    w = words.split()
    for n in range(20):
        fresh = n < 2 and topic != "quantum"
        doc = insert_document(conn, {
            "source_repository": source, "external_id": f"{topic}-{n}",
            "title": f"{w[0].title()} {w[n % len(w)]} {w[(n + 3) % len(w)]} study {n}",
            "authors": "Ada Lovelace, Alan Turing" if n % 2 else "Grace Hopper",
            "abstract": " ".join(w[(n + k) % len(w)] for k in range(30)) + ". A second sentence follows.",
            "publication_date": ["2024-03-15", "2023", "2025-01"][n % 3] if n % 5 else None,
            "doi": f"10.5555/{topic}.{n}",
            "url": f"https://arxiv.org/abs/2401.{1000 + n:05d}" if source == "arxiv" else f"https://example.org/{topic}/{n}",
            "metadata_hash": f"{topic}-{n}",
        })
        seen = now - (timedelta(hours=2 + n) if fresh else timedelta(days=10 + 3 * n))
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(seen), doc))
        ids[topic]["new" if fresh else "old"].append(doc)
# Three papers with too little text to place: no abstract, and titles of only common words.
bare = []
for n, title in enumerate(["On the", "Of it", "A study"]):
    bare.append(insert_document(conn, {"source_repository": "dblp", "external_id": f"bare-{n}", "title": title,
        "authors": "Grace Hopper", "metadata_hash": f"bare-{n}"}))
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(now - timedelta(days=5)), bare[-1]))
conn.commit()

def run(routine_id, docs, started, kind="automated_sweep"):
    e = insert_execution(conn, {"execution_type": kind, "routine_id": routine_id,
        "parameters": json.dumps({"repositories": ["arxiv"], "query": "x"}), "start_time": fmt(started)})
    for d in docs:
        link_execution_document(conn, e, d)
    record_execution_source(conn, e, "arxiv", "ok", result_count=len(docs), zero_reason=None)
    update_execution_status(conn, e, "completed", end_time=fmt(started + timedelta(seconds=41)),
        result_count=len(docs), new_result_count=len(docs))
    return e
protein = insert_routine(conn, {"name": "Protein structure", "schedule_cron": "0 2 * * *",
    "parameters": json.dumps({"repositories": ["arxiv"], "query": "protein"}), "is_active": 1})
traffic = insert_routine(conn, {"name": "Traffic flow", "schedule_cron": "0 3 * * *",
    "parameters": json.dumps({"repositories": ["crossref"], "query": "traffic"}), "is_active": 1})
run(protein, ids["protein"]["old"] + ids["protein"]["new"], now - timedelta(days=1))
run(traffic, ids["traffic"]["old"] + ids["traffic"]["new"], now - timedelta(days=1))
sweep = run(None, ids["quantum"]["old"][:15] + bare, now - timedelta(days=2), kind="deep_sweep")
local = datetime.now().astimezone()
looked = local.replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=1)
set_setting(conn, "today_looked_at", fmt(looked.astimezone(timezone.utc)))
conn.commit()
print(json.dumps({"old_protein": ids["protein"]["old"], "sweep": sweep, "quantum": ids["quantum"]["old"],
    "protein_watch": protein}))
`;

export interface Seeded { old_protein: number[]; sweep: number; quantum: number[]; protein_watch: number }
export interface MapBody { state: string; points: { id: number[]; x: number[]; y: number[] } }

export async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return response.json();
  }, [route, method, body] as const) as Promise<T>;
}

/**
 * Wait for the plate to hold still. It eases into its view as it opens, and on a
 * slow machine a position read mid-ease puts the click where a dot used to be.
 */
export async function stillView(win: Page, canvas: string): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const view = (await win.locator(canvas).getAttribute('data-view')) ?? '';
    const held = view !== '' && view === last;
    last = view;
    return held;
  }, { intervals: [400], timeout: 20_000 }).toBe(true);
}

/** The map's own find bar, in *scope* (Today's plate column, or a run's map). */
function findBar(scope: Locator): { bar: Locator; find: Locator } {
  const bar = scope.getByRole('group', { name: 'Find and filter on the map' });
  return { bar, find: bar.getByRole('searchbox', { name: /Find on the map/ }) };
}

/**
 * The first of *ids* whose whole title the map's find matches in no other
 * paper, with that title: a paper the find can step to and nothing else.
 */
export async function uniqueTitle(win: Page, ids: readonly number[]): Promise<{ id: number; title: string }> {
  for (const id of ids) {
    const { title } = await engine<{ title: string }>(win, `/api/documents/${id}`);
    const found = await engine<{ ids: number[] }>(win, `/api/map/find?q=${encodeURIComponent(title)}`);
    if (found.ids.length === 1 && found.ids[0] === id) return { id, title };
  }
  throw new Error(`each of papers ${ids.join(', ')} shares its title with another`);
}

/**
 * Open a paper the way a person finds one: its title typed into the map's
 * find, and Enter, which flies the map to it, chooses it, and opens it beside
 * the map. Returns the paper opened, once the map has stopped moving.
 */
export async function findAndOpen(win: Page, scope: Locator, canvas: string, title: string): Promise<number> {
  const { bar, find } = findBar(scope);
  await find.fill(title);
  await expect(bar.getByRole('status')).toHaveText('1 paper matches', { timeout: 30_000 });
  await find.press('Enter');
  const panel = win.locator('section[data-map-paper]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await stillView(win, canvas);
  return Number(await panel.getAttribute('data-map-paper'));
}

/** Clear the map's find, so every paper is lit again. */
export async function clearFind(scope: Locator): Promise<void> {
  const { bar, find } = findBar(scope);
  await find.fill('');
  await expect(bar.getByRole('status')).toHaveText(/ shown$/, { timeout: 30_000 });
}

/**
 * Click the middle of a plate, once it holds still: where a find or "Show it
 * on the map" has just put a paper. The one place a click is aimed, so the
 * spec never computes where a dot is drawn.
 */
export async function clickCenter(win: Page, canvas: string): Promise<void> {
  await stillView(win, canvas);
  const box = await win.locator(canvas).boundingBox();
  if (!box) throw new Error(`${canvas} has no box`);
  await win.locator(canvas).click({ position: { x: box.width / 2, y: box.height / 2 } });
}

/** Choose a paper from the keyboard: the plate focused, and Enter, which chooses the lit paper nearest its middle. */
export async function chooseByKeyboard(win: Page, canvas: string): Promise<void> {
  await stillView(win, canvas);
  await win.locator(canvas).focus();
  await win.keyboard.press('Enter');
}

/** The maps specs' launch environment: Atlas, and the window no larger than the screen a run is held to. */
export const mapsEnv = atlasEnv;

/**
 * Slow the renderer down as a slow runner is, when `RESMON_E2E_CPU_THROTTLE`
 * names a rate (4 is four times slower). Asked again after each reload.
 */
export async function throttle(win: Page): Promise<void> {
  const rate = Number(process.env.RESMON_E2E_CPU_THROTTLE);
  if (!rate || rate <= 1) return;
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

export async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  const held = heldScreen();
  if (held) { width = Math.min(width, held[0]); height = Math.min(height, held[1]); }
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.unmaximize();
    win?.setSize(w, h);
  }, [width, height] as const);
}

