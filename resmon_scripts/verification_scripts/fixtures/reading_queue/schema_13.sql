-- The complete resmon schema at version 13, as `init_db` left it at commit
-- a1a377b9d9d5ff0b224c5dceb1ac1ae2f29fbf8f — the last public `main` before the
-- reading queue.
--
-- Dumped from a database that version actually built, rather than written by
-- hand: the schema-13 migration itself shipped broken on existing corpora
-- because a hand-reasoned idea of "what an older database looks like" left out
-- a column, and the only fixture that catches that class of bug is one the old
-- code produced. `test_reading_queue_upgrade.py` executes this file, fills the
-- tables with rows, and upgrades it.
--
-- The FTS5 shadow tables (`documents_fts_*`) and `sqlite_sequence` are omitted
-- because SQLite creates them itself — `CREATE VIRTUAL TABLE documents_fts`
-- below brings the first set with it, and the second appears with the first
-- AUTOINCREMENT insert. Everything else is byte-for-byte what version 13 held.
--
-- Committed rather than generated at test time so the check is portable: CI
-- has no copy of the old code, and a fixture that has to be regenerated from
-- history is a fixture that quietly stops being schema 13.

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE assistant_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL,
    role            TEXT NOT NULL
        CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL DEFAULT '',
    tool_calls      TEXT,
    tool_results    TEXT,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        REAL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE
);

CREATE TABLE assistant_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    runtime         TEXT NOT NULL,
    cli_session_id  TEXT,
    model           TEXT,
    title           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cloud_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'google_drive',
    account_info TEXT,
    is_linked INTEGER NOT NULL DEFAULT 0,
    auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    sync_status TEXT DEFAULT 'idle' CHECK(sync_status IN ('idle', 'syncing', 'error'))
);

CREATE TABLE document_authors (
    document_id       INTEGER NOT NULL,
    author            TEXT NOT NULL,
    -- Schema 13 (2.1). All three are nullable and are NULL far more often than
    -- not: measured on 2026-09-06, OpenAlex carried an ORCID on 9 of 17
    -- authorships and Crossref on 2 of 84. NULL means **the source did not
    -- say**, never "this person has no ORCID", and nothing downstream may read
    -- it the second way.
    orcid             TEXT,
    affiliation       TEXT,
    -- The source's own author id, prefixed with its slug so two sources' ids
    -- can never be compared by accident: `semantic_scholar:1751762`.
    source_author_id  TEXT,
    PRIMARY KEY (document_id, author),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE document_categories (
    document_id INTEGER NOT NULL,
    category    TEXT NOT NULL,
    PRIMARY KEY (document_id, category),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE document_embeddings (
    document_id INTEGER NOT NULL,
    model       TEXT NOT NULL,
    dims        INTEGER NOT NULL,
    vector      BLOB NOT NULL,
    fields      TEXT NOT NULL,
    embedded_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, model),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE document_lifecycle (
    document_id     INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    severity        TEXT NOT NULL
        CHECK (severity IN ('critical', 'caution', 'informational')),
    notice_key      TEXT NOT NULL,
    label           TEXT,
    notice_doi      TEXT,
    notice_url      TEXT NOT NULL,
    notice_date     TEXT,
    detail          TEXT,
    provider        TEXT NOT NULL,
    provider_source TEXT,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, kind, notice_key),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE document_lifecycle_checks (
    document_id   INTEGER PRIMARY KEY,
    checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
    status        TEXT NOT NULL
        CHECK (status IN ('ok', 'no_identifier', 'error')),
    error_message TEXT,
    providers     TEXT,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE document_links (
    document_a  INTEGER NOT NULL,
    document_b  INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    score       REAL,
    method      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_a, document_b, kind),
    CHECK (document_a < document_b),
    FOREIGN KEY (document_a) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (document_b) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_repository TEXT NOT NULL,
    external_id TEXT NOT NULL,
    doi TEXT,
    title TEXT NOT NULL,
    authors TEXT,
    abstract TEXT,
    publication_date TEXT,
    url TEXT,
    categories TEXT,
    metadata_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    pub_sort TEXT GENERATED ALWAYS AS (COALESCE(publication_date, '')) VIRTUAL,
    UNIQUE(source_repository, external_id)
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
                title, abstract, authors,
                content='documents',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            );

CREATE TABLE execution_ai (
    execution_id    INTEGER NOT NULL,
    lane_index      INTEGER NOT NULL,
    lane_label      TEXT NOT NULL,
    lane_kind       TEXT NOT NULL
        CHECK (lane_kind IN ('subscription', 'api_key', 'local')),
    provider        TEXT NOT NULL,
    model           TEXT,
    credential_alias TEXT,
    outcome         TEXT NOT NULL
        CHECK (outcome IN ('running', 'ok', 'partial', 'failed', 'skipped')),
    error_kind      TEXT,
    http_status     INTEGER,
    safe_message    TEXT,
    docs_attempted  INTEGER NOT NULL DEFAULT 0,
    docs_succeeded  INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    PRIMARY KEY (execution_id, lane_index),
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

CREATE TABLE execution_documents (
    execution_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    is_new INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (execution_id, document_id),
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE execution_sources (
    execution_id    INTEGER NOT NULL,
    source          TEXT NOT NULL,
    status          TEXT NOT NULL
        CHECK (status IN ('ok', 'error', 'skipped_missing_key', 'cancelled')),
    result_count    INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    credential_name TEXT,
    zero_reason     TEXT,
    zero_detail     TEXT,
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (execution_id, source),
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

CREATE TABLE executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_type TEXT NOT NULL CHECK(execution_type IN ('deep_dive', 'deep_sweep', 'automated_sweep')),
    routine_id INTEGER,
    saved_configuration_id INTEGER,
    parameters TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
    result_count INTEGER DEFAULT 0,
    new_result_count INTEGER DEFAULT 0,
    log_path TEXT,
    result_path TEXT,
    error_message TEXT,
    progress_events TEXT,
    current_stage TEXT, cancel_reason TEXT, dedup_total INTEGER, dedup_new INTEGER, dedup_duplicates INTEGER, dedup_invalid INTEGER, dedup_cross_source INTEGER,
    FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL,
    FOREIGN KEY (saved_configuration_id) REFERENCES saved_configurations(id) ON DELETE SET NULL
);

CREATE TABLE routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule_cron TEXT NOT NULL,
    parameters TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    email_ai_summary_enabled INTEGER NOT NULL DEFAULT 0,
    ai_enabled INTEGER NOT NULL DEFAULT 0,
    notify_on_complete INTEGER NOT NULL DEFAULT 0,
    ai_settings TEXT,
    storage_settings TEXT,
    -- Free text: what this routine is actually looking for, in the user's own
    -- words. The keyword string is what resmon *sends*; this is what the user
    -- *means*, and the coverage audit needs the second to judge the first. It
    -- is optional and defaults to nothing rather than to the keyword string,
    -- because "the user wrote this" and "we reused the query" are different
    -- facts and the audit says which one it is working from.
    intent TEXT,
    execution_location TEXT NOT NULL DEFAULT 'local'
        CHECK (execution_location IN ('local', 'cloud')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_executed_at TEXT
);

CREATE TABLE saved_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    config_type TEXT NOT NULL CHECK(config_type IN ('manual_dive', 'manual_sweep', 'routine')),
    parameters TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE watch_profile_matches (
    document_id     INTEGER NOT NULL,
    profile_id      INTEGER NOT NULL,
    basis           TEXT NOT NULL
                    CHECK (basis IN ('identifier', 'name+affiliation', 'name_only')),
    matched_author  TEXT NOT NULL,
    evidence        TEXT,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, profile_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_id) REFERENCES watch_profiles(id) ON DELETE CASCADE
);

CREATE TABLE watch_profile_members (
    profile_id        INTEGER NOT NULL,
    member_profile_id INTEGER NOT NULL,
    PRIMARY KEY (profile_id, member_profile_id),
    FOREIGN KEY (profile_id) REFERENCES watch_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (member_profile_id) REFERENCES watch_profiles(id) ON DELETE CASCADE
);

CREATE TABLE watch_profiles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL CHECK (kind IN ('person', 'institution', 'group')),
    display_name  TEXT NOT NULL,
    -- The canonical name plus aliases, as JSON: [{"value": ..., "script": ...}].
    names         TEXT NOT NULL DEFAULT '[]',
    -- {"orcid": {"value": ..., "cited": ...}, "openalex": {...}, ...}. Every
    -- identifier carries where the user got it, because an identifier nobody
    -- can trace is an assertion.
    identifiers   TEXT NOT NULL DEFAULT '{}',
    orcid         TEXT,
    affiliations  TEXT NOT NULL DEFAULT '[]',
    -- Keywords used **only** to disambiguate, never to search: a profile is a
    -- person, and narrowing their papers by topic would silently hide their work.
    field_hints   TEXT NOT NULL DEFAULT '[]',
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE watchdog_mutes (
    finding_key TEXT PRIMARY KEY,
    muted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    note        TEXT
);

CREATE INDEX idx_assistant_messages_session
    ON assistant_messages(session_id, id);

CREATE INDEX idx_document_authors_author
    ON document_authors(author);

CREATE INDEX idx_document_authors_orcid
    ON document_authors(orcid) WHERE orcid IS NOT NULL;

CREATE INDEX idx_document_categories_category
    ON document_categories(category);

CREATE INDEX idx_document_embeddings_model
    ON document_embeddings(model);

CREATE INDEX idx_document_lifecycle_severity
    ON document_lifecycle(severity);

CREATE INDEX idx_document_links_b
    ON document_links(document_b);

CREATE INDEX idx_documents_first_seen
    ON documents(first_seen_at);

CREATE INDEX idx_documents_pubsort ON documents(pub_sort DESC, id DESC);

CREATE INDEX idx_documents_source
    ON documents(source_repository);

CREATE INDEX idx_execution_ai_exec
    ON execution_ai(execution_id);

CREATE INDEX idx_execution_sources_source
    ON execution_sources(source);

CREATE INDEX idx_watch_profile_matches_profile
    ON watch_profile_matches(profile_id, first_seen_at DESC);

CREATE INDEX idx_watch_profiles_orcid
    ON watch_profiles(orcid) WHERE orcid IS NOT NULL;
