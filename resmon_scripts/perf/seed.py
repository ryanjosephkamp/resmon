"""A seeded corpus of fixed size, the same every time it is built.

Every screen's speed depends on what is in the database, so a measurement is
only comparable to another taken over the same corpus. This builds one from a
fixed random seed: papers across the ten benchmark sources, six months of runs
with the per-source outcomes a real history has (answers, genuine empties,
outages, unreadable replies, windows a source cannot express), three routines,
saved configurations, a reading queue, and optionally an embedding for every
paper.

Papers are stored through ``normalizer.deduplicate_batch`` -- the function a
sweep stores through -- so the full-text index, the author and category facets
and the cross-source duplicate check are built exactly as a real run builds
them. The text is generated from a small vocabulary and means nothing; its
lengths match real titles and abstracts.

Dates are relative to the day the corpus is built, so a screen that shows "the
last seven days" shows the same thing whenever the harness runs. Everything
else is fixed by ``SEED`` and the arguments, and ``SEED_VERSION`` changes when
the shape does, which invalidates every cached build.
"""

from __future__ import annotations

import json
import random
import sqlite3
import struct
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from implementation_scripts import database, normalizer, reading_queue, vector_index
from implementation_scripts.api_base import NormalizedResult

SEED = 20261027
SEED_VERSION = 1

SOURCES = ["arxiv", "crossref", "dblp", "doaj", "europepmc",
           "hal", "inspire_hep", "openalex", "pubmed", "zenodo"]

EMBEDDING_MODEL = "perf-model"

_TOPICS = [
    "graph neural networks", "large language models", "protein folding",
    "reinforcement learning", "climate model downscaling", "single-cell sequencing",
    "quantum error correction", "federated learning", "causal inference",
    "retrieval-augmented generation", "diffusion models", "dark matter halos",
    "gene regulatory networks", "materials discovery", "neural operators",
    "speech recognition", "medical image segmentation", "topological insulators",
    "epidemic forecasting", "program synthesis",
]
_WORDS = (
    "analysis approach benchmark bound calibration coupling dataset dynamics "
    "efficient estimation evaluation framework generalization hierarchical "
    "inference interpretable kernel latent learning method model multiscale "
    "network nonlinear optimal perturbation prediction probabilistic robust "
    "sampling scalable sparse spectral stochastic structure supervised "
    "temporal theory transfer uncertainty variational adaptive baseline "
    "classification constraint convergence decomposition distribution "
    "embedding ensemble experiment feature gradient heterogeneous identity "
    "measurement observation operator parameter regime representation "
    "signal simulation stability statistic surrogate transformer validation"
).split()
_FIRST = ("Ada Bo Chen Dana Elif Femi Gita Hana Ivan Jae Kofi Lena Mara Nils Omar "
          "Priya Quinn Rosa Sven Tara Uma Viktor Wen Ximena Yusuf Zoe").split()
_LAST = ("Adeyemi Bauer Castillo Dubois Eriksen Fujita Garcia Haddad Ivanova "
         "Jensen Kowalski Larsen Moreau Nakamura Okafor Petrov Quintero Rossi "
         "Silva Tanaka Ueda Varga Wang Xu Yilmaz Zhang").split()
_CATEGORIES = ["cs.LG", "cs.CL", "cs.CV", "stat.ML", "q-bio.QM", "physics.comp-ph",
               "astro-ph.CO", "cond-mat.mtrl-sci", "quant-ph", "math.OC",
               "Medicine", "Biology", "Computer Science", "Physics", "Mathematics"]


def _sentence(rng: random.Random, n: int) -> str:
    return " ".join(rng.choice(_WORDS) for _ in range(n))


def _paper(rng: random.Random, i: int, today: datetime) -> NormalizedResult:
    source = SOURCES[i % len(SOURCES)]
    topic = rng.choice(_TOPICS)
    title = f"{_sentence(rng, rng.randint(2, 5)).capitalize()} {topic} {_sentence(rng, rng.randint(2, 6))}"
    sentences = []
    for _ in range(rng.randint(6, 11)):
        words = _sentence(rng, rng.randint(14, 26))
        if rng.random() < 0.35:
            words += f" {topic}"
        sentences.append(words.capitalize() + ".")
    published = today - timedelta(days=rng.randint(0, 730))
    authors = [f"{rng.choice(_FIRST)} {rng.choice(_LAST)}" for _ in range(rng.randint(1, 8))]
    doi = f"10.{rng.randint(1000, 9999)}/perf.{i:07d}" if rng.random() < 0.7 else None
    return NormalizedResult(
        source_repository=source,
        external_id=f"perf-{source}-{i:07d}",
        doi=doi,
        title=title,
        authors=authors,
        abstract=" ".join(sentences),
        publication_date=published.strftime("%Y-%m-%d"),
        url=f"https://example.org/{source}/{i:07d}",
        categories=rng.sample(_CATEGORIES, rng.randint(1, 3)),
    )


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# The per-source outcome mix of a real history: mostly answers, some genuine
# empties, and the non-answers resmon exists to tell apart from them.
_OUTCOMES = [
    (0.80, "ok", None),
    (0.08, "ok", "answered_empty"),
    (0.06, "ok", "upstream_failure"),
    (0.03, "ok", "parse_failure"),
    (0.03, "ok", "window_unanswerable"),
]


def _outcome(rng: random.Random) -> tuple[str, Optional[str]]:
    roll, total = rng.random(), 0.0
    for weight, status, reason in _OUTCOMES:
        total += weight
        if roll < total:
            return status, reason
    return "ok", None


def build(path: Path, *, papers: int, runs: int = 150, embed_dims: Optional[int] = None,
          today: Optional[datetime] = None) -> dict:
    """Build the corpus at ``path`` and return its manifest."""
    started = time.perf_counter()
    path = Path(path)
    if path.exists():
        path.unlink()
    for suffix in ("-wal", "-shm"):
        side = path.with_name(path.name + suffix)
        if side.exists():
            side.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    today = (today or datetime.now(timezone.utc)).replace(hour=0, minute=0, second=0, microsecond=0)
    rng = random.Random(SEED)

    database.init_db(path)
    conn = database.get_connection(path)
    try:
        # The sweep's duplicate check looks a hash up with no index on it, a
        # full scan per stored paper -- a cost the sweep benchmark is there to
        # show. Building 100,000 papers through it would take the better part
        # of an hour, so the build adds an index for itself and drops it before
        # the corpus is used: what is measured has the real schema.
        conn.execute("CREATE INDEX IF NOT EXISTS perf_seed_metadata_hash ON documents(metadata_hash)")
        # Papers, a thousand at a time, through the sweep's own storage path.
        # One in thirty is the same paper from a second source, so the
        # cross-source check and the near-duplicate links have work to do.
        batch: list[NormalizedResult] = []
        stats = {"new": 0, "duplicates": 0, "invalid": 0, "cross_source": 0}
        for i in range(papers):
            paper = _paper(rng, i, today)
            if i % 30 == 29 and batch:
                twin = batch[-1]
                paper = NormalizedResult(
                    source_repository=SOURCES[(SOURCES.index(twin.source_repository) + 3) % len(SOURCES)],
                    external_id=f"perf-twin-{i:07d}", doi=twin.doi, title=twin.title,
                    authors=twin.author_names, abstract=twin.abstract,
                    publication_date=twin.publication_date, url=f"https://example.org/twin/{i:07d}",
                    categories=list(twin.categories),
                )
            batch.append(paper)
            if len(batch) == 1000:
                for key, value in normalizer.deduplicate_batch(conn, batch).items():
                    if key in stats:
                        stats[key] += value
                batch = []
        if batch:
            for key, value in normalizer.deduplicate_batch(conn, batch).items():
                if key in stats:
                    stats[key] += value
        conn.commit()

        doc_ids_by_source: dict[str, list[int]] = {s: [] for s in SOURCES}
        for row in conn.execute("SELECT id, source_repository FROM documents ORDER BY id"):
            doc_ids_by_source.setdefault(row[1], []).append(int(row[0]))

        routine_ids = _routines(conn)
        config_ids = _configurations(conn)
        _runs(conn, rng, runs, today, routine_ids, config_ids, doc_ids_by_source)

        for doc_id in [ids[0] for ids in doc_ids_by_source.values() if ids][:10] + list(range(100, 115)):
            try:
                reading_queue.save(conn, doc_id)
            except Exception:  # an id the seed did not produce at this size
                pass

        if embed_dims:
            _embeddings(conn, embed_dims)
        conn.execute("DROP INDEX IF EXISTS perf_seed_metadata_hash")
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        counts = {
            table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("documents", "executions", "execution_sources",
                          "execution_documents", "routines", "saved_configurations",
                          "document_embeddings")
        }
    finally:
        conn.close()
    manifest = {
        "seed": SEED, "seed_version": SEED_VERSION, "papers_requested": papers,
        "runs": runs, "embed_dims": embed_dims, "anchor_day": _iso(today),
        "counts": counts, "dedup": stats,
        "build_seconds": round(time.perf_counter() - started, 1),
        "bytes": path.stat().st_size,
    }
    path.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def _routines(conn: sqlite3.Connection) -> list[int]:
    specs = [
        ("daily_agents", "0 16 * * *", ["arxiv", "openalex", "crossref", "pubmed"], "large language models"),
        ("weekly_folding", "0 7 * * 1", ["europepmc", "pubmed", "openalex"], "protein folding"),
        ("monthly_climate", "0 9 1 * *", ["arxiv", "doaj", "zenodo", "hal", "openalex"], "climate model downscaling"),
    ]
    ids = []
    for name, cron, repos, query in specs:
        ids.append(database.insert_routine(conn, {
            "name": name, "schedule_cron": cron,
            "parameters": json.dumps({"query": query, "keywords": [query],
                                      "repositories": repos, "max_results": 100}),
            "is_active": 1, "notify_on_complete": 1, "execution_location": "local",
        }))
    return ids


def _configurations(conn: sqlite3.Connection) -> list[int]:
    ids = []
    for i, (kind, query) in enumerate([
        ("deep_dive", "graph neural networks"), ("deep_dive", "quantum error correction"),
        ("deep_sweep", "diffusion models"), ("deep_sweep", "causal inference"),
        ("deep_sweep", "single-cell sequencing"), ("deep_dive", "neural operators"),
    ]):
        params = {"query": query, "keywords": [query], "max_results": 100}
        if kind == "deep_dive":
            params["repository"] = SOURCES[i]
        else:
            params["repositories"] = SOURCES[:5]
        ids.append(database.insert_configuration(conn, {
            "name": f"{query} ({kind.replace('_', ' ')})",
            "config_type": "manual_dive" if kind == "deep_dive" else "manual_sweep",
            "parameters": json.dumps(params),
        }))
    return ids


def _runs(conn: sqlite3.Connection, rng: random.Random, runs: int, today: datetime,
          routine_ids: list[int], config_ids: list[int],
          doc_ids_by_source: dict[str, list[int]]) -> None:
    linked: set[int] = set()
    for n in range(runs):
        started = today - timedelta(hours=(runs - n) * 29) + timedelta(minutes=rng.randint(0, 50))
        roll = rng.random()
        if roll < 0.6:
            kind, routine = "automated_sweep", routine_ids[n % len(routine_ids)]
            repos = json.loads(database.get_routine_by_id(conn, routine)["parameters"])["repositories"]
        elif roll < 0.85:
            kind, routine, repos = "deep_sweep", None, rng.sample(SOURCES, rng.randint(3, 10))
        else:
            kind, routine, repos = "deep_dive", None, [rng.choice(SOURCES)]
        params = {"query": rng.choice(_TOPICS), "max_results": 100,
                  "date_from": (started - timedelta(days=30)).strftime("%Y-%m-%d"),
                  "date_to": started.strftime("%Y-%m-%d")}
        if kind == "deep_dive":
            params["repository"] = repos[0]
        else:
            params["repositories"] = repos
        exec_id = database.insert_execution(conn, {
            "execution_type": kind, "routine_id": routine,
            "saved_configuration_id": config_ids[n % len(config_ids)] if kind != "automated_sweep" and n % 4 == 0 else None,
            "parameters": json.dumps(params), "start_time": _iso(started),
        })
        total = 0
        found: list[int] = []
        for slug in repos:
            status, reason = _outcome(rng)
            count = 0 if reason else rng.randint(5, 100)
            database.record_execution_source(conn, exec_id, slug, status,
                                             result_count=count, zero_reason=reason)
            total += count
            pool = doc_ids_by_source.get(slug) or []
            if pool and count:
                start = rng.randrange(len(pool))
                found.extend(pool[(start + k) % len(pool)] for k in range(min(count, len(pool))))
        final = "completed"
        if repos and total == 0:
            final = "failed"
        elif rng.random() < 0.03:
            final = "cancelled"
        new = [doc for doc in dict.fromkeys(found) if doc not in linked]
        linked.update(new)
        conn.executemany(
            "INSERT OR IGNORE INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, ?)",
            [(exec_id, doc, int(doc in set(new))) for doc in dict.fromkeys(found)],
        )
        conn.executemany(
            "UPDATE documents SET first_seen_at = ? WHERE id = ?",
            [(started.strftime("%Y-%m-%d %H:%M:%S"), doc) for doc in new],
        )
        ended = started + timedelta(seconds=rng.randint(8, 240))
        database.update_execution_status(
            conn, exec_id, final, end_time=_iso(ended),
            result_count=len(dict.fromkeys(found)), new_result_count=len(new),
        )
    conn.commit()


def _embeddings(conn: sqlite3.Connection, dims: int) -> None:
    """A unit vector for every paper, from a hash of its id -- not from meaning."""
    rows = []
    for (doc_id,) in conn.execute("SELECT id FROM documents ORDER BY id").fetchall():
        local = random.Random(doc_id * 7919)
        values = [local.uniform(-1.0, 1.0) for _ in range(dims)]
        norm = sum(v * v for v in values) ** 0.5 or 1.0
        rows.append((doc_id, EMBEDDING_MODEL, dims,
                     struct.pack(f"{dims}f", *(v / norm for v in values)), "title+abstract"))
        if len(rows) == 5000:
            conn.executemany(
                "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
                "VALUES (?, ?, ?, ?, ?)", rows)
            rows = []
    if rows:
        conn.executemany(
            "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
            "VALUES (?, ?, ?, ?, ?)", rows)
    conn.commit()
    result = vector_index.rebuild(conn, EMBEDDING_MODEL)
    if not result.get("ok"):
        raise RuntimeError(f"the vector index did not build: {result}")


def cached(cache: Path, *, papers: int, runs: int = 150, embed_dims: Optional[int] = None) -> Path:
    """A built corpus from ``cache``, building it if this shape is not there today."""
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    name = f"corpus-v{SEED_VERSION}-{papers}p-{runs}r-{embed_dims or 0}d-{today}.db"
    path = Path(cache) / name
    if not path.exists() or not path.with_suffix(".manifest.json").exists():
        build(path, papers=papers, runs=runs, embed_dims=embed_dims)
    return path
