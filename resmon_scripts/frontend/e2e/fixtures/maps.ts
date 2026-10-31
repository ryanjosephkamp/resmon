/**
 * The collection the maps specs draw, written through the engine's own
 * database functions before launch, and the ways they reach the engine and a
 * paper's dot.
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';

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

/** Click a paper's dot: where the plate's drawing puts it, read from the plate's own view. */
export async function clickPaper(win: Page, canvas: string, id: number, map: MapBody): Promise<void> {
  const at = map.points.id.indexOf(id);
  expect(at, `paper ${id} is on the map`).toBeGreaterThanOrEqual(0);
  const node = win.locator(canvas);
  const [cx, cy, scale] = ((await node.getAttribute('data-view')) ?? '').split(' ').map(Number);
  const box = await node.boundingBox();
  if (!box || cx === undefined || cy === undefined || scale === undefined) throw new Error('the plate has no view');
  const x = ((map.points.x[at] ?? 0) - cx) * scale + box.width / 2;
  const y = box.height / 2 - ((map.points.y[at] ?? 0) - cy) * scale;
  await node.click({ position: { x, y } });
}

/**
 * The first of *ids* whose dot a click can reach. Today's title block sits over
 * a corner of the plate, and how much it covers depends on the window's size,
 * which a CI runner's screen decides; any of these papers serves the step.
 */
export async function reachable(win: Page, canvas: string, ids: readonly number[], map: MapBody): Promise<number> {
  const node = win.locator(canvas);
  const [cx, cy, scale] = ((await node.getAttribute('data-view')) ?? '').split(' ').map(Number);
  const box = await node.boundingBox();
  if (!box || cx === undefined || cy === undefined || scale === undefined) throw new Error('the plate has no view');
  for (const id of ids) {
    const at = map.points.id.indexOf(id);
    if (at < 0) continue;
    const x = box.x + ((map.points.x[at] ?? 0) - cx) * scale + box.width / 2;
    const y = box.y + box.height / 2 - ((map.points.y[at] ?? 0) - cy) * scale;
    const hit = await node.evaluate((el, [px, py]) => {
      const top = document.elementFromPoint(px, py);
      return top === el;
    }, [x, y] as const);
    if (hit) return id;
  }
  throw new Error(`none of papers ${ids.join(', ')} can be clicked on ${canvas}`);
}

/**
 * Click papers among *ids* until one of them opens beside the map: the dot
 * clicked and the paper it opened. A click opens the nearest paper, and on a
 * small plate that can be another paper's dot drawn over this one, a new one
 * that the list shows instead.
 */
export async function openBeside(win: Page, canvas: string, ids: readonly number[], map: MapBody): Promise<{ clicked: number; opened: number }> {
  const panel = win.locator('section[data-map-paper]');
  // Today's title block covers a corner of the plate until the map is moved from
  // its whole view; in a short window that corner can hold every one of these.
  // One step in sends it away, as it does for a person exploring.
  const zoomIn = win.locator(canvas).locator('xpath=ancestor::*[contains(@class,"plate")][1]').getByRole('button', { name: 'Zoom in' });
  if (await win.locator('.cartouche:not(.away)').count()) {
    await zoomIn.click();
    await expect(win.locator('.cartouche:not(.away)')).toHaveCount(0);
  }
  for (const id of ids) {
    await stillView(win, canvas);
    const clicked = await reachable(win, canvas, [id], map).catch(() => null);
    if (clicked === null) continue;
    await clickPaper(win, canvas, clicked, map);
    if (await panel.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      const opened = Number(await panel.getAttribute('data-map-paper'));
      if (ids.includes(opened)) return { clicked, opened };
    }
    await win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  }
  throw new Error(`none of papers ${ids.join(', ')} opened beside ${canvas}`);
}

export async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.unmaximize();
    win?.setSize(w, h);
  }, [width, height] as const);
}

