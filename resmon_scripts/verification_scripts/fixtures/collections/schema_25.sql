-- A resmon database at schema 25, written by the 1.0 code (docs/one-oh at 04f622d0), before collections.
--
-- What it holds: three watches (one paused) and their runs over three fields,
-- a Deep Sweep over papers already held, a run that found some papers again,
-- six papers saved to read (one read), a saved search, and a look at Today on
-- October 30, 2026, so some papers are new on Today and some are not.
--
-- Everything is synthetic. Clock columns are fixed values rather than when the
-- file was written, and the one-shot backfill marker a launch writes
-- (`document_facets_backfilled`) is left out. The fts5 shadow tables are left
-- out too: the three `documents_fts_*` triggers rebuild the index as the
-- documents are inserted.
--
-- `test_collections_upgrade.py` walks this file to schema 26 in one `init_db`.

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

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
CREATE TABLE execution_documents (
    execution_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    is_new INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (execution_id, document_id),
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
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
CREATE TABLE cloud_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'google_drive',
    account_info TEXT,
    is_linked INTEGER NOT NULL DEFAULT 0,
    auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    sync_status TEXT DEFAULT 'idle' CHECK(sync_status IN ('idle', 'syncing', 'error'))
);
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE document_authors (
    document_id       INTEGER NOT NULL,
    author            TEXT NOT NULL,
    -- Schema 13. All three are nullable and are NULL far more often than
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
CREATE INDEX idx_document_authors_orcid
    ON document_authors(orcid) WHERE orcid IS NOT NULL;
CREATE INDEX idx_document_authors_author
    ON document_authors(author);
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
CREATE INDEX idx_watch_profiles_orcid
    ON watch_profiles(orcid) WHERE orcid IS NOT NULL;
CREATE TABLE watch_profile_members (
    profile_id        INTEGER NOT NULL,
    member_profile_id INTEGER NOT NULL,
    PRIMARY KEY (profile_id, member_profile_id),
    FOREIGN KEY (profile_id) REFERENCES watch_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (member_profile_id) REFERENCES watch_profiles(id) ON DELETE CASCADE
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
CREATE INDEX idx_watch_profile_matches_profile
    ON watch_profile_matches(profile_id, first_seen_at DESC);
CREATE TABLE document_categories (
    document_id INTEGER NOT NULL,
    category    TEXT NOT NULL,
    PRIMARY KEY (document_id, category),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_categories_category
    ON document_categories(category);
CREATE INDEX idx_documents_source
    ON documents(source_repository);
CREATE INDEX idx_documents_first_seen
    ON documents(first_seen_at);
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
CREATE INDEX idx_execution_sources_source
    ON execution_sources(source);
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
CREATE INDEX idx_execution_ai_exec
    ON execution_ai(execution_id);
CREATE TABLE watchdog_mutes (
    finding_key TEXT PRIMARY KEY,
    muted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    note        TEXT
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
CREATE INDEX idx_document_lifecycle_severity
    ON document_lifecycle(severity);
CREATE TABLE document_lifecycle_checks (
    document_id   INTEGER PRIMARY KEY,
    checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
    status        TEXT NOT NULL
        CHECK (status IN ('ok', 'no_identifier', 'error')),
    error_message TEXT,
    providers     TEXT,
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
CREATE INDEX idx_document_embeddings_model
    ON document_embeddings(model);
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
CREATE INDEX idx_document_links_b
    ON document_links(document_b);
CREATE TABLE assistant_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    runtime         TEXT NOT NULL,
    cli_session_id  TEXT,
    model           TEXT,
    title           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX idx_assistant_messages_session
    ON assistant_messages(session_id, id);
CREATE TABLE reading_queue (
    document_id INTEGER PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'to_read'
        CHECK (status IN ('to_read', 'read')),
    saved_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    read_at     TEXT,
    CHECK ((status = 'read' AND read_at IS NOT NULL)
           OR (status = 'to_read' AND read_at IS NULL)),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_reading_queue_status_saved
    ON reading_queue(status, saved_at DESC, document_id DESC);
CREATE INDEX idx_documents_pubsort ON documents(pub_sort DESC, id DESC);
CREATE VIRTUAL TABLE documents_fts USING fts5(
                title, abstract, authors,
                content='documents',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            );
CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
        END;
CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
CREATE TABLE assistant_turn_choices (
        user_message_id INTEGER PRIMARY KEY REFERENCES assistant_messages(id) ON DELETE CASCADE,
        assistant_message_id INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
        version INTEGER NOT NULL CHECK(version=1),
        requested_json TEXT NOT NULL,
        reported_json TEXT NOT NULL DEFAULT '[]',
        created_at_utc TEXT NOT NULL
    );
CREATE UNIQUE INDEX idx_assistant_turn_choices_assistant_message
        ON assistant_turn_choices(assistant_message_id) WHERE assistant_message_id IS NOT NULL;
CREATE TABLE library_vault (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    vault_id TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
CREATE TABLE library_file_documents (
    file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE RESTRICT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    linked_at_utc TEXT NOT NULL,
    PRIMARY KEY (file_id, document_id)
);
CREATE INDEX idx_library_file_documents_document ON library_file_documents(document_id);
CREATE TABLE evidence_projects (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL UNIQUE,
 vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created_at_utc TEXT NOT NULL,
 updated_at_utc TEXT NOT NULL
);
CREATE TABLE evidence_project_files (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE RESTRICT,
 version_id TEXT NOT NULL REFERENCES library_files(version_id) ON DELETE RESTRICT,
 added_at_utc TEXT NOT NULL,
 UNIQUE(project_id, file_id)
);
CREATE TABLE evidence_notes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 note_id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE RESTRICT,
 version_id TEXT NOT NULL REFERENCES library_files(version_id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('note', 'passage')),
 body TEXT NOT NULL CHECK(length(body) <= 20000),
 page_number INTEGER,
 extraction_contract TEXT,
 page_text_sha256 TEXT,
 start_codepoint INTEGER,
 end_codepoint INTEGER,
 quote TEXT,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created_at_utc TEXT NOT NULL,
 updated_at_utc TEXT NOT NULL,
 CHECK (
  (kind = 'note' AND length(body) >= 1 AND page_number IS NULL AND extraction_contract IS NULL
   AND page_text_sha256 IS NULL AND start_codepoint IS NULL AND end_codepoint IS NULL AND quote IS NULL)
  OR
  (kind = 'passage' AND page_number IS NOT NULL AND page_number >= 1 AND extraction_contract IS NOT NULL
   AND page_text_sha256 IS NOT NULL AND length(page_text_sha256) = 64 AND page_text_sha256 NOT GLOB '*[^0-9a-f]*'
   AND start_codepoint IS NOT NULL AND end_codepoint IS NOT NULL AND quote IS NOT NULL AND start_codepoint >= 0 AND end_codepoint > start_codepoint
   AND length(quote) BETWEEN 1 AND 20000 AND end_codepoint - start_codepoint = length(quote))
 )
);
CREATE INDEX idx_evidence_project_files_order ON evidence_project_files(project_id, id);
CREATE INDEX idx_evidence_notes_order ON evidence_notes(project_id, id);
CREATE TABLE evidence_answers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 answer_id TEXT NOT NULL UNIQUE,
 preview_id TEXT NOT NULL UNIQUE,
 vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,
 project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,
 project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
 mode TEXT NOT NULL CHECK(mode IN ('question', 'briefing')),
 state TEXT NOT NULL CHECK(state IN ('admitted', 'running', 'succeeded', 'refused', 'failed', 'cancelled', 'interrupted')),
 request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB)) <= 262144),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 private_binding_json TEXT NOT NULL CHECK(length(CAST(private_binding_json AS BLOB)) <= 4096),
 private_native_session_id TEXT,
 owner_runtime_id TEXT NOT NULL,
 partial_text TEXT NOT NULL DEFAULT '' CHECK(length(CAST(partial_text AS BLOB)) <= 65536),
 result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 65536),
 reports_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(reports_json AS BLOB)) <= 16384),
 usage_json TEXT CHECK(usage_json IS NULL OR length(CAST(usage_json AS BLOB)) <= 4096),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 80),
 error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
 cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('not_started', 'pending', 'confirmed', 'unknown')),
 created_at_utc TEXT NOT NULL,
 started_at_utc TEXT,
 finished_at_utc TEXT,
 CHECK((state IN ('admitted','running') AND finished_at_utc IS NULL)
       OR (state IN ('succeeded','refused','failed','cancelled','interrupted') AND finished_at_utc IS NOT NULL)),
 CHECK(result_json IS NULL OR state IN ('succeeded','refused'))
);
CREATE INDEX idx_evidence_answers_project_order ON evidence_answers(project_id, id);
CREATE TABLE "executions" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_type TEXT NOT NULL CHECK(execution_type IN ('deep_dive', 'deep_sweep', 'automated_sweep')),
    routine_id INTEGER,
    saved_configuration_id INTEGER,
    parameters TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    result_count INTEGER DEFAULT 0,
    new_result_count INTEGER DEFAULT 0,
    log_path TEXT,
    result_path TEXT,
    error_message TEXT,
    progress_events TEXT,
    current_stage TEXT,
    owner_pid INTEGER,
    owner_runtime_id TEXT,
    last_seen_at_utc TEXT,
    interrupted_reason TEXT CHECK(interrupted_reason IS NULL OR interrupted_reason IN ('owner_dead', 'daemon_restart', 'unknown')),
    restarted_from INTEGER REFERENCES executions(id) ON DELETE SET NULL, cancel_reason TEXT, dedup_total INTEGER, dedup_new INTEGER, dedup_duplicates INTEGER, dedup_invalid INTEGER, dedup_cross_source INTEGER, request_id TEXT,
    FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL,
    FOREIGN KEY (saved_configuration_id) REFERENCES saved_configurations(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_executions_request_id ON executions(request_id) WHERE request_id IS NOT NULL;
CREATE TABLE routine_missed_fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    due_at_utc TEXT NOT NULL,
    observed_at_utc TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'recorded' CHECK(disposition IN ('recorded', 'ran_late', 'skipped')),
    UNIQUE(routine_id, due_at_utc)
);
CREATE INDEX idx_routine_missed_fires_routine ON routine_missed_fires(routine_id, due_at_utc);
CREATE TABLE routine_delivery_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('email', 'folder', 'webhook', 'feed')),
    target TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL DEFAULT 'automatic' CHECK(mode IN ('automatic', 'review')),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX idx_routine_delivery_targets_routine ON routine_delivery_targets(routine_id, id);
CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    target_id INTEGER REFERENCES routine_delivery_targets(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email', 'folder', 'webhook', 'feed')),
    target_snapshot TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued', 'awaiting_review', 'delivering', 'delivered', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_utc TEXT,
    last_error TEXT,
    artifact_sha256 TEXT,
    owner_pid INTEGER,
    owner_runtime_id TEXT,
    queued_at_utc TEXT NOT NULL,
    delivered_at_utc TEXT,
    UNIQUE(execution_id, target_id)
);
CREATE INDEX idx_deliveries_due ON deliveries(state, next_attempt_at_utc);
CREATE INDEX idx_deliveries_execution ON deliveries(execution_id);
CREATE INDEX idx_documents_metadata_hash ON documents(metadata_hash);
CREATE TABLE assistant_turn_failures (
    user_message_id INTEGER PRIMARY KEY REFERENCES assistant_messages(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (code IN ('cli_auth', 'stopped', 'failed')),
    message TEXT NOT NULL,
    detail TEXT,
    partial_text TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    tool_results TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    failed_at_utc TEXT NOT NULL
);
CREATE TABLE execution_ai_models (
    execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    lane_index INTEGER NOT NULL,
    position INTEGER NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL CHECK (calls > 0),
    PRIMARY KEY (execution_id, lane_index, model)
);
CREATE TABLE "assistant_session_choices" (
        session_id INTEGER PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version=1),
        runtime TEXT NOT NULL CHECK(runtime IN ('claude_cli','codex_cli','api_key')),
        provider TEXT NOT NULL,
        requested_model TEXT,
        requested_effort TEXT CHECK(requested_effort IS NULL OR (length(requested_effort) BETWEEN 1 AND 32 AND requested_effort NOT GLOB '*[^a-z0-9_-]*')),
        model_basis TEXT NOT NULL CHECK(model_basis IN ('explicit','settings_default','runtime_default')),
        effort_basis TEXT NOT NULL CHECK(effort_basis IN ('explicit','settings_default','runtime_default','not_supported')),
        route_digest TEXT NOT NULL,
        binding_basis TEXT NOT NULL CHECK(binding_basis IN ('new','legacy_confirmed')),
        created_at_utc TEXT NOT NULL,
        CHECK(runtime != 'api_key' OR requested_effort IS NULL),
        CHECK(runtime != 'claude_cli' OR requested_effort IS NULL OR requested_effort IN ('low','medium','high','xhigh','max'))
    );
CREATE TABLE "library_files" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL UNIQUE,
    version_id TEXT NOT NULL UNIQUE,
    vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 67108864),
    media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'text/plain', 'text/markdown', 'text/x-tex')),
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    created_at_utc TEXT NOT NULL,
    UNIQUE(vault_id, sha256)
);
CREATE TABLE library_removed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL UNIQUE,
    version_id TEXT NOT NULL UNIQUE,
    vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,
    original_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes_state TEXT NOT NULL CHECK (bytes_state IN ('held', 'missing')),
    record_json TEXT NOT NULL,
    removed_at_utc TEXT NOT NULL
);

-- documents: 105 row(s)
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (1, 'arxiv', 'optics-0', NULL, 'Photonic crystal study 0', 'Author 0, Coauthor 0', 'We study photonic lattices and waveguides, case 0.', '2026-01-01', 'https://example.org/optics/0', 'physics.optics', '0495a3227699e811117fdfcd8ec15744715a33e9d5098fbbaa86438f101d8db0', '2026-10-23 08:11:59');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (2, 'crossref', 'optics-1', '10.5555/optics.1', 'Photonic crystal study 1', 'Author 1, Coauthor 1', 'We study photonic lattices and waveguides, case 1.', '2026-02-02', 'https://example.org/optics/1', 'physics.optics', '53c856ae3414d35459fc4f3c1376cf998b4b25845f94bcaa5d011a7e1eab59ed', '2026-10-23 10:23:58');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (3, 'pubmed', 'optics-2', '10.5555/optics.2', 'Photonic crystal study 2', 'Author 2, Coauthor 2', 'We study photonic lattices and waveguides, case 2.', '2026-03-03', 'https://example.org/optics/2', 'physics.optics', 'ea60fd473db9e76b482dd90ea9e876c4f78edefa3584a759fce59df2a86d2686', '2026-10-23 12:35:57');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (4, 'arxiv', 'optics-3', '10.5555/optics.3', 'Photonic crystal study 3', 'Author 3, Coauthor 3', 'We study photonic lattices and waveguides, case 3.', '2026-04-04', 'https://example.org/optics/3', 'physics.optics', '4c594aba52dd78807b683fbf495344765d5b62b9802055ab0c3d4271b3542aa9', '2026-10-23 14:47:56');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (5, 'crossref', 'optics-4', NULL, 'Photonic crystal study 4', 'Author 4, Coauthor 4', 'We study photonic lattices and waveguides, case 4.', '2026-05-05', 'https://example.org/optics/4', 'physics.optics', '48c14ceb8c66c3bd8294e6af801b8edfbc3570c0fa9b3beafe79e98edd6de3f4', '2026-10-23 16:59:55');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (6, 'pubmed', 'optics-5', '10.5555/optics.5', 'Photonic crystal study 5', 'Author 5, Coauthor 0', 'We study photonic lattices and waveguides, case 5.', '2026-06-06', 'https://example.org/optics/5', 'physics.optics', '2646f1d6dda3ac0c5eec7b4effb8933df98c5604a6cfe3e2ab3c4a6b00ce49e7', '2026-10-23 19:11:54');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (7, 'arxiv', 'optics-6', '10.5555/optics.6', 'Photonic crystal study 6', 'Author 6, Coauthor 1', 'We study photonic lattices and waveguides, case 6.', '2026-07-07', 'https://example.org/optics/6', 'physics.optics', '672c0917cdf8431b71f81eec1839a8f37fa5b0c18630577e597f75a27c7874ee', '2026-10-23 21:23:53');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (8, 'crossref', 'optics-7', '10.5555/optics.7', 'Photonic crystal study 7', 'Author 0, Coauthor 2', 'We study photonic lattices and waveguides, case 7.', '2026-08-08', 'https://example.org/optics/7', 'physics.optics', '5172a3975bfbe4fdc1e4fe34c28a639834ad6d3670d2553cb3f508966d56c80c', '2026-10-23 23:35:52');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (9, 'pubmed', 'optics-8', NULL, 'Photonic crystal study 8', 'Author 1, Coauthor 3', 'We study photonic lattices and waveguides, case 8.', '2026-09-09', 'https://example.org/optics/8', 'physics.optics', 'e1d2ac9920641ac86ee249faa049cc267196588c4089e4c3ea9fc79ee1bd6fa7', '2026-10-24 01:47:51');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (10, 'arxiv', 'optics-9', '10.5555/optics.9', 'Photonic crystal study 9', 'Author 2, Coauthor 4', 'We study photonic lattices and waveguides, case 9.', '2026-01-10', 'https://example.org/optics/9', 'physics.optics', '7bdc50f921f50f420deccc8ee426496671afe40c956990ba973a746d8cd6c344', '2026-10-24 03:59:50');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (11, 'crossref', 'optics-10', '10.5555/optics.10', 'Photonic crystal study 10', 'Author 3, Coauthor 0', 'We study photonic lattices and waveguides, case 10.', '2026-02-11', 'https://example.org/optics/10', 'physics.optics', '156f4d82631d106a45cf39a7c0311bd103c7e84de3669accbd4e3179a5950f91', '2026-10-24 06:11:49');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (12, 'pubmed', 'optics-11', '10.5555/optics.11', 'Photonic crystal study 11', 'Author 4, Coauthor 1', 'We study photonic lattices and waveguides, case 11.', '2026-03-12', 'https://example.org/optics/11', 'physics.optics', 'f9ef0a75ac6cdf78e8f8f71abb0270893434ecf50b79fdb5743fd8269dc9ad59', '2026-10-24 08:23:48');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (13, 'arxiv', 'optics-12', NULL, 'Photonic crystal study 12', 'Author 5, Coauthor 2', 'We study photonic lattices and waveguides, case 12.', '2026-04-13', 'https://example.org/optics/12', 'physics.optics', 'a62a507e2c892e44de9e3c4e1583908b28dce61130abe494e3343fa417d3b795', '2026-10-24 10:35:47');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (14, 'crossref', 'optics-13', '10.5555/optics.13', 'Photonic crystal study 13', 'Author 6, Coauthor 3', 'We study photonic lattices and waveguides, case 13.', '2026-05-14', 'https://example.org/optics/13', 'physics.optics', '171be0ab4b42a5e8fc19408ed1d320cefacc218869c86ae9cfb8133ecfe1e773', '2026-10-24 12:47:46');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (15, 'pubmed', 'optics-14', '10.5555/optics.14', 'Photonic crystal study 14', 'Author 0, Coauthor 4', 'We study photonic lattices and waveguides, case 14.', '2026-06-15', 'https://example.org/optics/14', 'physics.optics', '5611e7046481596ffca5ccbbd3deab6cfc02987c8b9a170fa54855ae42b4aaeb', '2026-10-24 14:59:45');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (16, 'arxiv', 'optics-15', '10.5555/optics.15', 'Photonic crystal study 15', 'Author 1, Coauthor 0', 'We study photonic lattices and waveguides, case 15.', '2026-07-16', 'https://example.org/optics/15', 'physics.optics', '3a608c8f2c682b6b0153a56983c70b3b69bf54db3412a28e798f9713574c77d4', '2026-10-24 17:11:44');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (17, 'crossref', 'optics-16', NULL, 'Photonic crystal study 16', 'Author 2, Coauthor 1', 'We study photonic lattices and waveguides, case 16.', '2026-08-17', 'https://example.org/optics/16', 'physics.optics', 'f3242c007844f9797431fe85c8e61fc29139fec6bc41f07054b45a3036e1f08a', '2026-10-24 19:23:43');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (18, 'pubmed', 'optics-17', '10.5555/optics.17', 'Photonic crystal study 17', 'Author 3, Coauthor 2', 'We study photonic lattices and waveguides, case 17.', '2026-09-18', 'https://example.org/optics/17', 'physics.optics', 'b608d383f07ee994d3bba9b5f8d2a7df54c347fb16c7317cc0deeb5b94b5bfbf', '2026-10-24 21:35:42');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (19, 'arxiv', 'optics-18', '10.5555/optics.18', 'Photonic crystal study 18', 'Author 4, Coauthor 3', 'We study photonic lattices and waveguides, case 18.', '2026-01-19', 'https://example.org/optics/18', 'physics.optics', '2de538aa7bf56778ee2014530165782834569381fc7db46133edf2e12d5ffd46', '2026-10-24 23:47:41');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (20, 'crossref', 'optics-19', '10.5555/optics.19', 'Photonic crystal study 19', 'Author 5, Coauthor 4', 'We study photonic lattices and waveguides, case 19.', '2026-02-20', 'https://example.org/optics/19', 'physics.optics', 'ec850e0549e1e4ec7812a4d1eae82f898a2a69b1fbd1f147e24e64f6df780b4e', '2026-10-25 01:59:40');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (21, 'pubmed', 'optics-20', NULL, 'Photonic crystal study 20', 'Author 6, Coauthor 0', 'We study photonic lattices and waveguides, case 20.', '2026-03-21', 'https://example.org/optics/20', 'physics.optics', '5706bd4e2594e0c012aab88da45ad2e8669356807a25ed78cb72975b4a65ad35', '2026-10-25 04:11:39');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (22, 'arxiv', 'optics-21', '10.5555/optics.21', 'Photonic crystal study 21', 'Author 0, Coauthor 1', 'We study photonic lattices and waveguides, case 21.', '2026-04-22', 'https://example.org/optics/21', 'physics.optics', 'f30e819ade21780b60d9380f368d0ed6ea692baf890247ab71c50e3cece27558', '2026-10-25 06:23:38');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (23, 'crossref', 'optics-22', '10.5555/optics.22', 'Photonic crystal study 22', 'Author 1, Coauthor 2', 'We study photonic lattices and waveguides, case 22.', '2026-05-23', 'https://example.org/optics/22', 'physics.optics', '89bc606e14cf8774031eea8bad20ea578206da4b809aa3a8f416e0b0f3758b70', '2026-10-25 08:35:37');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (24, 'pubmed', 'optics-23', '10.5555/optics.23', 'Photonic crystal study 23', 'Author 2, Coauthor 3', 'We study photonic lattices and waveguides, case 23.', '2026-06-24', 'https://example.org/optics/23', 'physics.optics', 'aa80269a8982308a61228e6a709e1e0f9024fab6da2bd3251f0d9e132cdd146b', '2026-10-25 10:47:36');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (25, 'arxiv', 'optics-24', NULL, 'Photonic crystal study 24', 'Author 3, Coauthor 4', 'We study photonic lattices and waveguides, case 24.', '2026-07-25', 'https://example.org/optics/24', 'physics.optics', '9d6a604ae6a986a3f3c5e77730706e6f3abf274118b67f3dc0dc3ccda08c6b0b', '2026-10-25 12:59:35');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (26, 'crossref', 'optics-25', '10.5555/optics.25', 'Photonic crystal study 25', 'Author 4, Coauthor 0', 'We study photonic lattices and waveguides, case 25.', '2026-08-26', 'https://example.org/optics/25', 'physics.optics', 'cd88900b4281c4ebc36d681954f21f3f0378ce5b5f31c31bb92c3a7c7ae94533', '2026-10-25 15:11:34');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (27, 'pubmed', 'optics-26', '10.5555/optics.26', 'Photonic crystal study 26', 'Author 5, Coauthor 1', 'We study photonic lattices and waveguides, case 26.', '2026-09-27', 'https://example.org/optics/26', 'physics.optics', 'e8c2080997e9ccbee22452572ea3a9bbfda108dc3da2a61c119a194fc3f4003f', '2026-10-25 17:23:33');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (28, 'arxiv', 'optics-27', '10.5555/optics.27', 'Photonic crystal study 27', 'Author 6, Coauthor 2', 'We study photonic lattices and waveguides, case 27.', '2026-01-01', 'https://example.org/optics/27', 'physics.optics', '27dbc6e683308438449b31a1c303ed31bd04ccfc3c2e1ccf007ab70ce8c8cc75', '2026-10-25 19:35:32');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (29, 'crossref', 'optics-28', NULL, 'Photonic crystal study 28', 'Author 0, Coauthor 3', 'We study photonic lattices and waveguides, case 28.', '2026-02-02', 'https://example.org/optics/28', 'physics.optics', '7c8255cc6f1d673f57b8244410c66e231e0c642a1157534d243ec70357a14bfe', '2026-10-25 21:47:31');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (30, 'pubmed', 'optics-29', '10.5555/optics.29', 'Photonic crystal study 29', 'Author 1, Coauthor 4', 'We study photonic lattices and waveguides, case 29.', '2026-03-03', 'https://example.org/optics/29', 'physics.optics', '1664df773ae269e56870a10383f4b1f99be0ed785e39f97ae0d668a2b1e56a44', '2026-10-25 23:59:30');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (31, 'arxiv', 'learning-0', NULL, 'Diffusion model study 0', 'Author 0, Coauthor 0', 'We study denoising diffusion models for images, case 0.', '2026-01-01', 'https://example.org/learning/0', 'cs.LG', '78db7c0a7b7575c511ac33974d78a597ef0f9bc82a5f2f1c2d540799aa1d2fb2', '2026-10-26 02:11:29');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (32, 'crossref', 'learning-1', '10.5555/learning.1', 'Diffusion model study 1', 'Author 1, Coauthor 1', 'We study denoising diffusion models for images, case 1.', '2026-02-02', 'https://example.org/learning/1', 'cs.LG', '53644b12e60005bf1dc0b1ede20a60867a594f0a1705c40e09d63100a3a92e30', '2026-10-26 04:23:28');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (33, 'pubmed', 'learning-2', '10.5555/learning.2', 'Diffusion model study 2', 'Author 2, Coauthor 2', 'We study denoising diffusion models for images, case 2.', '2026-03-03', 'https://example.org/learning/2', 'cs.LG', 'ec969fdcf20ef989d31f705f4c9039cc42659029f4edd82640de925b4942a857', '2026-10-26 06:35:27');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (34, 'arxiv', 'learning-3', '10.5555/learning.3', 'Diffusion model study 3', 'Author 3, Coauthor 3', 'We study denoising diffusion models for images, case 3.', '2026-04-04', 'https://example.org/learning/3', 'cs.LG', '62ee572659bf15222cbb81e6461f91bd54dea3e7e0ab4201368df81f4ab68aaf', '2026-10-26 08:47:26');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (35, 'crossref', 'learning-4', NULL, 'Diffusion model study 4', 'Author 4, Coauthor 4', 'We study denoising diffusion models for images, case 4.', '2026-05-05', 'https://example.org/learning/4', 'cs.LG', '4ad8157f5bdb455a15c96fcb8ce830774dbe12a526072babf995c8076ba54dae', '2026-10-26 10:59:25');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (36, 'pubmed', 'learning-5', '10.5555/learning.5', 'Diffusion model study 5', 'Author 5, Coauthor 0', 'We study denoising diffusion models for images, case 5.', '2026-06-06', 'https://example.org/learning/5', 'cs.LG', '51bf2faddaef754e4052743646ba15028696be898930fbae5e15fc6e63b36f85', '2026-10-26 13:11:24');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (37, 'arxiv', 'learning-6', '10.5555/learning.6', 'Diffusion model study 6', 'Author 6, Coauthor 1', 'We study denoising diffusion models for images, case 6.', '2026-07-07', 'https://example.org/learning/6', 'cs.LG', 'f6b0dbdc50f703ba514057b25bd937fa8e6c2d0ba0a008ba65ab9f904013f7ce', '2026-10-26 15:23:23');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (38, 'crossref', 'learning-7', '10.5555/learning.7', 'Diffusion model study 7', 'Author 0, Coauthor 2', 'We study denoising diffusion models for images, case 7.', '2026-08-08', 'https://example.org/learning/7', 'cs.LG', 'df0c4df95ca9cd89d980e97d9ed2f02feaf687379bac584dc8f777e252033e8e', '2026-10-26 17:35:22');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (39, 'pubmed', 'learning-8', NULL, 'Diffusion model study 8', 'Author 1, Coauthor 3', 'We study denoising diffusion models for images, case 8.', '2026-09-09', 'https://example.org/learning/8', 'cs.LG', '76af196bb4c3408812bb78861a50c411ca918368858f29cd298ba909412339fb', '2026-10-26 19:47:21');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (40, 'arxiv', 'learning-9', '10.5555/learning.9', 'Diffusion model study 9', 'Author 2, Coauthor 4', 'We study denoising diffusion models for images, case 9.', '2026-01-10', 'https://example.org/learning/9', 'cs.LG', '7f74002c48a51249d2da6aabbfd0f1927c458cea315264ab932381d88de85826', '2026-10-26 21:59:20');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (41, 'crossref', 'learning-10', '10.5555/learning.10', 'Diffusion model study 10', 'Author 3, Coauthor 0', 'We study denoising diffusion models for images, case 10.', '2026-02-11', 'https://example.org/learning/10', 'cs.LG', '8f26b9bb3fa63e87d80a0bb9e2f4112c333fd28718d2bda5cbc17dc9a4fb9c7e', '2026-10-27 00:11:19');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (42, 'pubmed', 'learning-11', '10.5555/learning.11', 'Diffusion model study 11', 'Author 4, Coauthor 1', 'We study denoising diffusion models for images, case 11.', '2026-03-12', 'https://example.org/learning/11', 'cs.LG', '4e5851203108ac0566e444f6955097cb4081ff0ed67e32239ed9b87a3ab7cc5f', '2026-10-27 02:23:18');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (43, 'arxiv', 'learning-12', NULL, 'Diffusion model study 12', 'Author 5, Coauthor 2', 'We study denoising diffusion models for images, case 12.', '2026-04-13', 'https://example.org/learning/12', 'cs.LG', '7c39b33a2f8d01294d59b8d5c278f6fd8c3e5e8c6bf509fadeb9f2a41213da13', '2026-10-27 04:35:17');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (44, 'crossref', 'learning-13', '10.5555/learning.13', 'Diffusion model study 13', 'Author 6, Coauthor 3', 'We study denoising diffusion models for images, case 13.', '2026-05-14', 'https://example.org/learning/13', 'cs.LG', '05ef9abe741564893a296a85dc91ef2546bddb5269ea9293f08ade00940f465f', '2026-10-27 06:47:16');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (45, 'pubmed', 'learning-14', '10.5555/learning.14', 'Diffusion model study 14', 'Author 0, Coauthor 4', 'We study denoising diffusion models for images, case 14.', '2026-06-15', 'https://example.org/learning/14', 'cs.LG', '74648dcf82edeabce83294b33d2683b31165dd1b4b0b8aa819895ebc478f24f1', '2026-10-27 08:59:15');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (46, 'arxiv', 'learning-15', '10.5555/learning.15', 'Diffusion model study 15', 'Author 1, Coauthor 0', 'We study denoising diffusion models for images, case 15.', '2026-07-16', 'https://example.org/learning/15', 'cs.LG', '84d705b5ef34da6ca486bffd927dd5140c973d5756ca76bf33f15a2f95a0b0ae', '2026-10-27 11:11:14');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (47, 'crossref', 'learning-16', NULL, 'Diffusion model study 16', 'Author 2, Coauthor 1', 'We study denoising diffusion models for images, case 16.', '2026-08-17', 'https://example.org/learning/16', 'cs.LG', '2ffa20c9920fa6096eec4f9ba5fb7e04c07f4dbe7f06c23be7fce66a9c284153', '2026-10-27 13:23:13');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (48, 'pubmed', 'learning-17', '10.5555/learning.17', 'Diffusion model study 17', 'Author 3, Coauthor 2', 'We study denoising diffusion models for images, case 17.', '2026-09-18', 'https://example.org/learning/17', 'cs.LG', '751dd919bca777f414495ea2b69c5fc3928d6d8c48a5826f77e37b8c303c3e3c', '2026-10-27 15:35:12');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (49, 'arxiv', 'learning-18', '10.5555/learning.18', 'Diffusion model study 18', 'Author 4, Coauthor 3', 'We study denoising diffusion models for images, case 18.', '2026-01-19', 'https://example.org/learning/18', 'cs.LG', '490c7f5ae96425b43bc6bcf66339bc13d55213c593201c1c9b00be517cb57371', '2026-10-27 17:47:11');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (50, 'crossref', 'learning-19', '10.5555/learning.19', 'Diffusion model study 19', 'Author 5, Coauthor 4', 'We study denoising diffusion models for images, case 19.', '2026-02-20', 'https://example.org/learning/19', 'cs.LG', '01a7ff310fd79751a91621a9302e89d09e25a3fd57f3134807161a63676d3f17', '2026-10-27 19:59:10');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (51, 'pubmed', 'learning-20', NULL, 'Diffusion model study 20', 'Author 6, Coauthor 0', 'We study denoising diffusion models for images, case 20.', '2026-03-21', 'https://example.org/learning/20', 'cs.LG', 'e91366ece6fd79337e004c2f99a1db36857918c3e6fa6f51150d1337463fb7e5', '2026-10-27 22:11:09');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (52, 'arxiv', 'learning-21', '10.5555/learning.21', 'Diffusion model study 21', 'Author 0, Coauthor 1', 'We study denoising diffusion models for images, case 21.', '2026-04-22', 'https://example.org/learning/21', 'cs.LG', 'fa3bd8990b2e9fc8a195fbcb0c2548c3baf7741fa2d4fff878c2d7f647e6f869', '2026-10-28 00:23:08');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (53, 'crossref', 'learning-22', '10.5555/learning.22', 'Diffusion model study 22', 'Author 1, Coauthor 2', 'We study denoising diffusion models for images, case 22.', '2026-05-23', 'https://example.org/learning/22', 'cs.LG', 'cf94cb4a6e5c1ec88eb67ceccd80e0b7897654d04cc43c738909b79947684938', '2026-10-28 02:35:07');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (54, 'pubmed', 'learning-23', '10.5555/learning.23', 'Diffusion model study 23', 'Author 2, Coauthor 3', 'We study denoising diffusion models for images, case 23.', '2026-06-24', 'https://example.org/learning/23', 'cs.LG', '74e1118c9e6aa6fb9c51a17de6c30784c8fa4c41c63e60a7c841f09255fba1e7', '2026-10-28 04:47:06');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (55, 'arxiv', 'learning-24', NULL, 'Diffusion model study 24', 'Author 3, Coauthor 4', 'We study denoising diffusion models for images, case 24.', '2026-07-25', 'https://example.org/learning/24', 'cs.LG', '185db94838a0e8938ab22cd7cfa958ef8baebc03839554e83f9c0487d77be4fc', '2026-10-28 06:59:05');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (56, 'crossref', 'learning-25', '10.5555/learning.25', 'Diffusion model study 25', 'Author 4, Coauthor 0', 'We study denoising diffusion models for images, case 25.', '2026-08-26', 'https://example.org/learning/25', 'cs.LG', '6ee67d7d56c7ac16e527c2684682ff05a460a1f77844dfe5941385ae665ee36b', '2026-10-28 09:11:04');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (57, 'pubmed', 'learning-26', '10.5555/learning.26', 'Diffusion model study 26', 'Author 5, Coauthor 1', 'We study denoising diffusion models for images, case 26.', '2026-09-27', 'https://example.org/learning/26', 'cs.LG', '7ad4f5fc827ff34b8c42d1c69a38eaa8544e98814c29861b8f718ba116ded760', '2026-10-28 11:23:03');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (58, 'arxiv', 'learning-27', '10.5555/learning.27', 'Diffusion model study 27', 'Author 6, Coauthor 2', 'We study denoising diffusion models for images, case 27.', '2026-01-01', 'https://example.org/learning/27', 'cs.LG', '94fd4d4a26dad32eed147d8d911e2c56bb86ea8578eb77836d1f657e238068b9', '2026-10-28 13:35:02');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (59, 'crossref', 'learning-28', NULL, 'Diffusion model study 28', 'Author 0, Coauthor 3', 'We study denoising diffusion models for images, case 28.', '2026-02-02', 'https://example.org/learning/28', 'cs.LG', '938c40a1e18440b33c1357b16f246fab423a73948fc9f75fcbe9cc5184ceabc5', '2026-10-28 15:47:01');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (60, 'pubmed', 'learning-29', '10.5555/learning.29', 'Diffusion model study 29', 'Author 1, Coauthor 4', 'We study denoising diffusion models for images, case 29.', '2026-03-03', 'https://example.org/learning/29', 'cs.LG', '0ad783341a5d127586d003b5fc28d07033f7d3f8503763dbd20c7f1fe7f01bbc', '2026-10-28 17:59:00');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (61, 'arxiv', 'learning-30', '10.5555/learning.30', 'Diffusion model study 30', 'Author 2, Coauthor 0', 'We study denoising diffusion models for images, case 30.', '2026-04-04', 'https://example.org/learning/30', 'cs.LG', '8fdcd35412bfdc90a35a26b4a97fc8101183c2ff1a38a490684bf18a1bcf845e', '2026-10-28 20:10:59');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (62, 'crossref', 'learning-31', '10.5555/learning.31', 'Diffusion model study 31', 'Author 3, Coauthor 1', 'We study denoising diffusion models for images, case 31.', '2026-05-05', 'https://example.org/learning/31', 'cs.LG', 'd7553a79a0b1e2b611c7fc50fe6c9789695db7b3d866f19a95f11f25cfee3c6f', '2026-10-28 22:22:58');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (63, 'pubmed', 'learning-32', NULL, 'Diffusion model study 32', 'Author 4, Coauthor 2', 'We study denoising diffusion models for images, case 32.', '2026-06-06', 'https://example.org/learning/32', 'cs.LG', 'ccb51ea3c1779533634a9900f84b06836e64ceba378c2934b32c69bf7be09e51', '2026-10-29 00:34:57');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (64, 'arxiv', 'learning-33', '10.5555/learning.33', 'Diffusion model study 33', 'Author 5, Coauthor 3', 'We study denoising diffusion models for images, case 33.', '2026-07-07', 'https://example.org/learning/33', 'cs.LG', '1f6d9fc590f6978284ef2a32dac9edebbeb02f3ac9ef57d9675ed30653e22997', '2026-10-29 02:46:56');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (65, 'crossref', 'learning-34', '10.5555/learning.34', 'Diffusion model study 34', 'Author 6, Coauthor 4', 'We study denoising diffusion models for images, case 34.', '2026-08-08', 'https://example.org/learning/34', 'cs.LG', '3b654eb363fdba632664b344ed918427a5d97799d2d3b6213c952b8a060cd481', '2026-10-29 04:58:55');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (66, 'pubmed', 'learning-35', '10.5555/learning.35', 'Diffusion model study 35', 'Author 0, Coauthor 0', 'We study denoising diffusion models for images, case 35.', '2026-09-09', 'https://example.org/learning/35', 'cs.LG', 'd598266d2b604e214e1ce49f983e0b2bba70738d573ca79d62aefd06cd996ffd', '2026-10-29 07:10:54');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (67, 'arxiv', 'learning-36', NULL, 'Diffusion model study 36', 'Author 1, Coauthor 1', 'We study denoising diffusion models for images, case 36.', '2026-01-10', 'https://example.org/learning/36', 'cs.LG', '7149f3303ec029b99936d1989cf25314cb7eddaa6e4587c3e13d88669c29b7bd', '2026-10-29 09:22:53');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (68, 'crossref', 'learning-37', '10.5555/learning.37', 'Diffusion model study 37', 'Author 2, Coauthor 2', 'We study denoising diffusion models for images, case 37.', '2026-02-11', 'https://example.org/learning/37', 'cs.LG', '98f4831c67a141d160dcfb1793a303876f48f0367848cb74574597a97f3ed844', '2026-10-29 11:34:52');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (69, 'pubmed', 'learning-38', '10.5555/learning.38', 'Diffusion model study 38', 'Author 3, Coauthor 3', 'We study denoising diffusion models for images, case 38.', '2026-03-12', 'https://example.org/learning/38', 'cs.LG', '593b4be4a6e51e04e465c2a3e31df10eda241a4def6ce68a352e94853c425c11', '2026-10-29 13:46:51');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (70, 'arxiv', 'learning-39', '10.5555/learning.39', 'Diffusion model study 39', 'Author 4, Coauthor 4', 'We study denoising diffusion models for images, case 39.', '2026-04-13', 'https://example.org/learning/39', 'cs.LG', 'ffb73c2946253742043066127e9ec1d66b7691f960b6d9c4992382137d80f1ef', '2026-10-29 15:58:50');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (71, 'arxiv', 'biology-0', NULL, 'Protein folding study 0', 'Author 0, Coauthor 0', 'We study folding pathways of small proteins, case 0.', '2026-01-01', 'https://example.org/biology/0', 'q-bio.BM', '3ab52a0d4fb01e4fbd6e6454a7203cbc8a458a80572901879ece1949346417c1', '2026-10-29 18:10:49');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (72, 'crossref', 'biology-1', '10.5555/biology.1', 'Protein folding study 1', 'Author 1, Coauthor 1', 'We study folding pathways of small proteins, case 1.', '2026-02-02', 'https://example.org/biology/1', 'q-bio.BM', 'f2f7f957e009528278e0684378a24c888cd2f2487bb7aa65e0cea6f3c5fa4a61', '2026-10-29 20:22:48');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (73, 'pubmed', 'biology-2', '10.5555/biology.2', 'Protein folding study 2', 'Author 2, Coauthor 2', 'We study folding pathways of small proteins, case 2.', '2026-03-03', 'https://example.org/biology/2', 'q-bio.BM', 'a711f49068fbaf4b7ef30b7ac0b9c341ecf9119d0ad78341ef0598f4fa3a1a00', '2026-10-29 22:34:47');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (74, 'arxiv', 'biology-3', '10.5555/biology.3', 'Protein folding study 3', 'Author 3, Coauthor 3', 'We study folding pathways of small proteins, case 3.', '2026-04-04', 'https://example.org/biology/3', 'q-bio.BM', 'c6d02769715f90eb32ea619fe4ffea582c4b4f1828966c9b55c9fb1da02f36c5', '2026-10-30 00:46:46');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (75, 'crossref', 'biology-4', NULL, 'Protein folding study 4', 'Author 4, Coauthor 4', 'We study folding pathways of small proteins, case 4.', '2026-05-05', 'https://example.org/biology/4', 'q-bio.BM', 'a653b314b81f62176bcb1d6b70d1615192538d0c1f57a4428637a806668f6d36', '2026-10-30 02:58:45');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (76, 'pubmed', 'biology-5', '10.5555/biology.5', 'Protein folding study 5', 'Author 5, Coauthor 0', 'We study folding pathways of small proteins, case 5.', '2026-06-06', 'https://example.org/biology/5', 'q-bio.BM', '29c476f3fc2cfd414c8907808b979455e1bca48c28cf85424416f396d70efb29', '2026-10-30 05:10:44');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (77, 'arxiv', 'biology-6', '10.5555/biology.6', 'Protein folding study 6', 'Author 6, Coauthor 1', 'We study folding pathways of small proteins, case 6.', '2026-07-07', 'https://example.org/biology/6', 'q-bio.BM', 'a99cd3eae4510d3346fb3f1398d52856976a44e4a55d41cf5a26fd645007c8fb', '2026-10-30 07:22:43');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (78, 'crossref', 'biology-7', '10.5555/biology.7', 'Protein folding study 7', 'Author 0, Coauthor 2', 'We study folding pathways of small proteins, case 7.', '2026-08-08', 'https://example.org/biology/7', 'q-bio.BM', 'f389141ff768b347f94c992792b965fd4707b905f4281679f9c222af82249839', '2026-10-30 09:34:42');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (79, 'pubmed', 'biology-8', NULL, 'Protein folding study 8', 'Author 1, Coauthor 3', 'We study folding pathways of small proteins, case 8.', '2026-09-09', 'https://example.org/biology/8', 'q-bio.BM', '10b103bab81a6072ea6415c4fc228d4af35531655e86b8f68b10b13050face6c', '2026-10-30 11:46:41');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (80, 'arxiv', 'biology-9', '10.5555/biology.9', 'Protein folding study 9', 'Author 2, Coauthor 4', 'We study folding pathways of small proteins, case 9.', '2026-01-10', 'https://example.org/biology/9', 'q-bio.BM', '32fa3adb7605d826d1a77dcfa94380d5faaa5af14a06f2572e633d2093ed6590', '2026-10-30 13:58:40');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (81, 'crossref', 'biology-10', '10.5555/biology.10', 'Protein folding study 10', 'Author 3, Coauthor 0', 'We study folding pathways of small proteins, case 10.', '2026-02-11', 'https://example.org/biology/10', 'q-bio.BM', '58826d3ecbe5e6c042dac58f7b5c924f8413a588cf072ae675f07b50b2f055f7', '2026-10-30 16:10:39');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (82, 'pubmed', 'biology-11', '10.5555/biology.11', 'Protein folding study 11', 'Author 4, Coauthor 1', 'We study folding pathways of small proteins, case 11.', '2026-03-12', 'https://example.org/biology/11', 'q-bio.BM', 'af6024928e50e16e5305905da32309559fa27f55a56feaa7322656eac0828764', '2026-10-30 18:22:38');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (83, 'arxiv', 'biology-12', NULL, 'Protein folding study 12', 'Author 5, Coauthor 2', 'We study folding pathways of small proteins, case 12.', '2026-04-13', 'https://example.org/biology/12', 'q-bio.BM', '76e4cb81a17dcdc2fe7b320465c16e05eb626110210a2e4c2e5577910326eea5', '2026-10-30 20:34:37');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (84, 'crossref', 'biology-13', '10.5555/biology.13', 'Protein folding study 13', 'Author 6, Coauthor 3', 'We study folding pathways of small proteins, case 13.', '2026-05-14', 'https://example.org/biology/13', 'q-bio.BM', '5099d39ffa560fe82d142be086b555ca7f1f10a8b5fd5b8cd3ec6a20cc41c9ff', '2026-10-30 22:46:36');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (85, 'pubmed', 'biology-14', '10.5555/biology.14', 'Protein folding study 14', 'Author 0, Coauthor 4', 'We study folding pathways of small proteins, case 14.', '2026-06-15', 'https://example.org/biology/14', 'q-bio.BM', 'b0eac5dab373930226db8db49d82e9b6139c9178ca769eb14122f4a2dbb56c9d', '2026-10-31 00:58:35');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (86, 'arxiv', 'biology-15', '10.5555/biology.15', 'Protein folding study 15', 'Author 1, Coauthor 0', 'We study folding pathways of small proteins, case 15.', '2026-07-16', 'https://example.org/biology/15', 'q-bio.BM', 'a54348258a04f0f9ccf999703f2a1cca4d16d151989ed9d138c2d756024a34e3', '2026-10-31 03:10:34');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (87, 'crossref', 'biology-16', NULL, 'Protein folding study 16', 'Author 2, Coauthor 1', 'We study folding pathways of small proteins, case 16.', '2026-08-17', 'https://example.org/biology/16', 'q-bio.BM', 'd656f1050f9135030bb1673c479c5ba38a0561deb32e63cd00f689e7f9e170b1', '2026-10-31 05:22:33');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (88, 'pubmed', 'biology-17', '10.5555/biology.17', 'Protein folding study 17', 'Author 3, Coauthor 2', 'We study folding pathways of small proteins, case 17.', '2026-09-18', 'https://example.org/biology/17', 'q-bio.BM', '1b7e2cf35e24c2681981b09ab6e15b7f55101210b8db85623684d95980bc0371', '2026-10-31 07:34:32');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (89, 'arxiv', 'biology-18', '10.5555/biology.18', 'Protein folding study 18', 'Author 4, Coauthor 3', 'We study folding pathways of small proteins, case 18.', '2026-01-19', 'https://example.org/biology/18', 'q-bio.BM', '8ff2e7aace07fc0706f8459258d360a82fdeaaab543ec3e2b0bd898bf0b2ff13', '2026-10-31 09:46:31');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (90, 'crossref', 'biology-19', '10.5555/biology.19', 'Protein folding study 19', 'Author 5, Coauthor 4', 'We study folding pathways of small proteins, case 19.', '2026-02-20', 'https://example.org/biology/19', 'q-bio.BM', '0504535ecaebe51c13be7292c43d38bdb0c0f01e871a3451cbde8eab7b639238', '2026-10-31 11:58:30');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (96, 'arxiv', 'optics-30', '10.5555/optics.30', 'Photonic crystal study 30', 'Author 2, Coauthor 0', 'We study photonic lattices and waveguides, case 30.', '2026-04-04', 'https://example.org/optics/30', 'physics.optics', 'd5fbf83d12c036ebaa7188fc219083dc8ba270b7a819c042284a4b9c335bce43', '2026-11-01 01:10:24');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (97, 'crossref', 'optics-31', '10.5555/optics.31', 'Photonic crystal study 31', 'Author 3, Coauthor 1', 'We study photonic lattices and waveguides, case 31.', '2026-05-05', 'https://example.org/optics/31', 'physics.optics', '3c56c46c39659be00b004f8d2d981d9ef72d3e9bd5175154b7f60325c8aa60a0', '2026-11-01 03:22:23');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (98, 'pubmed', 'optics-32', NULL, 'Photonic crystal study 32', 'Author 4, Coauthor 2', 'We study photonic lattices and waveguides, case 32.', '2026-06-06', 'https://example.org/optics/32', 'physics.optics', '7987052fe62b8b01962341f4fe1018013e0f95a30e69fec620f6cfab0474632c', '2026-11-01 05:34:22');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (99, 'arxiv', 'optics-33', '10.5555/optics.33', 'Photonic crystal study 33', 'Author 5, Coauthor 3', 'We study photonic lattices and waveguides, case 33.', '2026-07-07', 'https://example.org/optics/33', 'physics.optics', '00785bd7d45482f397222e1475369db2d78be5d3ac617dfdd84e3bf7640df5f0', '2026-11-01 07:46:21');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (100, 'crossref', 'optics-34', '10.5555/optics.34', 'Photonic crystal study 34', 'Author 6, Coauthor 4', 'We study photonic lattices and waveguides, case 34.', '2026-08-08', 'https://example.org/optics/34', 'physics.optics', 'ef26c385bcede5c6df86aeb70fa97a0b7feea9ff704676edd720707c8ffcee01', '2026-11-01 09:58:20');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (101, 'pubmed', 'optics-35', '10.5555/optics.35', 'Photonic crystal study 35', 'Author 0, Coauthor 0', 'We study photonic lattices and waveguides, case 35.', '2026-09-09', 'https://example.org/optics/35', 'physics.optics', '8a3deba5a7ece025d649ae43054092c700bd31e2b7be91cb30ad8c2c3f7ee103', '2026-11-01 12:10:19');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (102, 'arxiv', 'optics-36', NULL, 'Photonic crystal study 36', 'Author 1, Coauthor 1', 'We study photonic lattices and waveguides, case 36.', '2026-01-10', 'https://example.org/optics/36', 'physics.optics', '7e185a9ef03ef4173e0b02e1a959b6c7b221d798be03b70cedf69f99c0405563', '2026-11-01 14:22:18');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (103, 'crossref', 'optics-37', '10.5555/optics.37', 'Photonic crystal study 37', 'Author 2, Coauthor 2', 'We study photonic lattices and waveguides, case 37.', '2026-02-11', 'https://example.org/optics/37', 'physics.optics', 'd938a2432bcad92efd26d76025b81aa393f8715f5e72de0a2d58d1dc4fb5d801', '2026-11-01 16:34:17');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (104, 'pubmed', 'optics-38', '10.5555/optics.38', 'Photonic crystal study 38', 'Author 3, Coauthor 3', 'We study photonic lattices and waveguides, case 38.', '2026-03-12', 'https://example.org/optics/38', 'physics.optics', '4af43ff29e1f53b40365a873f7dfa2186ecdccc00c7855371e2997d61966b39c', '2026-11-01 18:46:16');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (105, 'arxiv', 'optics-39', '10.5555/optics.39', 'Photonic crystal study 39', 'Author 4, Coauthor 4', 'We study photonic lattices and waveguides, case 39.', '2026-04-13', 'https://example.org/optics/39', 'physics.optics', 'bd81f3685805b2c24fbaeacdfda0aeeae6e59a59fc1edfcc41b74c82744c484c', '2026-11-01 20:58:15');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (106, 'crossref', 'optics-40', NULL, 'Photonic crystal study 40', 'Author 5, Coauthor 0', 'We study photonic lattices and waveguides, case 40.', '2026-05-14', 'https://example.org/optics/40', 'physics.optics', 'b6f9c85e36774d26d05efe114005d99c7c6364bce67c039b86ab26aa131b45d5', '2026-11-01 23:10:14');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (107, 'pubmed', 'optics-41', '10.5555/optics.41', 'Photonic crystal study 41', 'Author 6, Coauthor 1', 'We study photonic lattices and waveguides, case 41.', '2026-06-15', 'https://example.org/optics/41', 'physics.optics', 'b3cf0dd45f2cf58ccc665c27a355a587cc46307693af75b08ea83b928705f795', '2026-11-02 01:22:13');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (108, 'arxiv', 'optics-42', '10.5555/optics.42', 'Photonic crystal study 42', 'Author 0, Coauthor 2', 'We study photonic lattices and waveguides, case 42.', '2026-07-16', 'https://example.org/optics/42', 'physics.optics', 'f0201cb5e7bcb0f3b24436d78bbe1f684d43485b9627abd5cbf12f85569a2224', '2026-11-02 03:34:12');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (109, 'crossref', 'optics-43', '10.5555/optics.43', 'Photonic crystal study 43', 'Author 1, Coauthor 3', 'We study photonic lattices and waveguides, case 43.', '2026-08-17', 'https://example.org/optics/43', 'physics.optics', '5501a67094770dc79d7426eee2898da9bf73290020e1868581348ff5ca2b1c72', '2026-11-02 05:46:11');
INSERT INTO "documents" ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract", "publication_date", "url", "categories", "metadata_hash", "first_seen_at") VALUES (110, 'pubmed', 'optics-44', NULL, 'Photonic crystal study 44', 'Author 2, Coauthor 4', 'We study photonic lattices and waveguides, case 44.', '2026-09-18', 'https://example.org/optics/44', 'physics.optics', '998b07fa363b5d99ea766f2debf111aef5d1930e0251ea4d81a1285fb33737b5', '2026-10-23 07:58:10');

-- execution_documents: 125 row(s)
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 1, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 2, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 3, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 4, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 5, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 6, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 7, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 8, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 9, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 10, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 11, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 12, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 13, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 14, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 15, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 16, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 17, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 18, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 19, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 20, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 21, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 22, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 23, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 24, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 25, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 26, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 27, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 28, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 29, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (1, 30, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 31, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 32, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 33, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 34, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 35, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 36, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 37, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 38, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 39, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 40, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 41, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 42, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 43, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 44, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 45, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 46, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 47, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 48, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 49, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 50, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 51, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 52, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 53, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 54, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 55, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 56, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 57, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 58, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 59, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 60, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 61, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 62, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 63, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 64, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 65, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 66, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 67, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 68, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 69, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (2, 70, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 71, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 72, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 73, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 74, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 75, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 76, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 77, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 78, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 79, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 80, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 81, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 82, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 83, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 84, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 85, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 86, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 87, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 88, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 89, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (3, 90, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 26, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 27, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 28, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 29, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 30, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 96, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 97, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 98, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 99, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 100, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 101, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 102, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 103, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 104, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 105, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 106, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 107, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 108, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 109, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (4, 110, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 31, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 32, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 33, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 34, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 35, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 36, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 37, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 38, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 39, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 40, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 41, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 42, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 43, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 44, 1);
INSERT INTO "execution_documents" ("execution_id", "document_id", "is_new") VALUES (5, 45, 1);

-- routines: 3 row(s)
INSERT INTO "routines" ("id", "name", "schedule_cron", "parameters", "is_active", "email_enabled", "email_ai_summary_enabled", "ai_enabled", "notify_on_complete", "ai_settings", "storage_settings", "intent", "execution_location", "created_at", "updated_at", "last_executed_at") VALUES (1, 'Optics watch', '0 6 * * *', '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "optics", "keywords": ["optics"], "max_results": 100}', 1, 0, 0, 0, 1, NULL, NULL, NULL, 'local', '2026-10-20 09:00:00', '2026-10-20 09:00:00', NULL);
INSERT INTO "routines" ("id", "name", "schedule_cron", "parameters", "is_active", "email_enabled", "email_ai_summary_enabled", "ai_enabled", "notify_on_complete", "ai_settings", "storage_settings", "intent", "execution_location", "created_at", "updated_at", "last_executed_at") VALUES (2, 'Learning watch', '0 6 * * *', '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "learning", "keywords": ["learning"], "max_results": 100}', 1, 0, 0, 0, 1, NULL, NULL, NULL, 'local', '2026-10-20 10:00:00', '2026-10-20 10:00:00', NULL);
INSERT INTO "routines" ("id", "name", "schedule_cron", "parameters", "is_active", "email_enabled", "email_ai_summary_enabled", "ai_enabled", "notify_on_complete", "ai_settings", "storage_settings", "intent", "execution_location", "created_at", "updated_at", "last_executed_at") VALUES (3, 'Biology watch', '0 6 * * *', '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "biology", "keywords": ["biology"], "max_results": 100}', 0, 0, 0, 0, 1, NULL, NULL, NULL, 'local', '2026-10-20 11:00:00', '2026-10-20 11:00:00', NULL);

-- saved_configurations: 1 row(s)
INSERT INTO "saved_configurations" ("id", "name", "config_type", "parameters", "created_at", "updated_at") VALUES (1, 'Learning search', 'manual_sweep', '{"query": "learning"}', '2026-10-21 09:00:00', '2026-10-21 09:00:00');

-- app_settings: 4 row(s)
INSERT INTO "app_settings" ("key", "value") VALUES ('execution_sources_backfilled', '1');
INSERT INTO "app_settings" ("key", "value") VALUES ('dedup_columns_backfilled', '1');
INSERT INTO "app_settings" ("key", "value") VALUES ('schema_version', '25');
INSERT INTO "app_settings" ("key", "value") VALUES ('today_looked_at', '2026-10-30 12:00:00');

-- document_authors: 210 row(s)
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (1, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (1, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (2, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (2, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (3, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (3, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (4, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (4, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (5, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (5, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (6, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (6, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (7, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (7, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (8, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (8, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (9, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (9, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (10, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (10, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (11, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (11, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (12, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (12, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (13, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (13, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (14, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (14, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (15, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (15, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (16, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (16, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (17, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (17, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (18, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (18, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (19, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (19, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (20, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (20, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (21, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (21, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (22, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (22, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (23, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (23, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (24, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (24, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (25, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (25, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (26, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (26, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (27, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (27, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (28, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (28, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (29, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (29, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (30, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (30, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (31, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (31, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (32, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (32, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (33, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (33, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (34, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (34, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (35, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (35, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (36, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (36, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (37, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (37, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (38, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (38, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (39, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (39, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (40, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (40, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (41, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (41, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (42, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (42, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (43, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (43, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (44, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (44, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (45, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (45, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (46, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (46, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (47, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (47, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (48, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (48, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (49, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (49, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (50, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (50, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (51, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (51, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (52, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (52, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (53, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (53, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (54, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (54, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (55, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (55, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (56, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (56, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (57, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (57, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (58, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (58, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (59, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (59, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (60, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (60, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (61, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (61, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (62, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (62, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (63, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (63, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (64, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (64, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (65, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (65, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (66, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (66, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (67, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (67, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (68, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (68, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (69, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (69, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (70, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (70, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (71, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (71, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (72, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (72, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (73, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (73, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (74, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (74, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (75, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (75, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (76, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (76, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (77, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (77, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (78, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (78, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (79, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (79, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (80, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (80, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (81, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (81, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (82, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (82, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (83, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (83, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (84, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (84, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (85, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (85, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (86, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (86, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (87, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (87, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (88, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (88, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (89, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (89, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (90, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (90, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (96, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (96, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (97, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (97, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (98, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (98, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (99, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (99, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (100, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (100, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (101, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (101, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (102, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (102, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (103, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (103, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (104, 'Author 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (104, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (105, 'Author 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (105, 'Coauthor 4', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (106, 'Author 5', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (106, 'Coauthor 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (107, 'Author 6', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (107, 'Coauthor 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (108, 'Author 0', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (108, 'Coauthor 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (109, 'Author 1', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (109, 'Coauthor 3', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (110, 'Author 2', NULL, NULL, NULL);
INSERT INTO "document_authors" ("document_id", "author", "orcid", "affiliation", "source_author_id") VALUES (110, 'Coauthor 4', NULL, NULL, NULL);

-- document_categories: 105 row(s)
INSERT INTO "document_categories" ("document_id", "category") VALUES (1, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (2, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (3, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (4, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (5, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (6, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (7, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (8, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (9, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (10, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (11, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (12, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (13, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (14, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (15, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (16, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (17, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (18, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (19, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (20, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (21, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (22, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (23, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (24, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (25, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (26, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (27, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (28, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (29, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (30, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (31, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (32, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (33, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (34, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (35, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (36, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (37, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (38, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (39, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (40, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (41, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (42, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (43, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (44, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (45, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (46, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (47, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (48, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (49, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (50, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (51, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (52, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (53, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (54, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (55, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (56, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (57, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (58, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (59, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (60, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (61, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (62, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (63, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (64, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (65, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (66, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (67, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (68, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (69, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (70, 'cs.LG');
INSERT INTO "document_categories" ("document_id", "category") VALUES (71, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (72, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (73, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (74, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (75, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (76, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (77, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (78, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (79, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (80, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (81, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (82, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (83, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (84, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (85, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (86, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (87, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (88, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (89, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (90, 'q-bio.BM');
INSERT INTO "document_categories" ("document_id", "category") VALUES (96, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (97, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (98, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (99, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (100, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (101, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (102, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (103, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (104, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (105, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (106, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (107, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (108, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (109, 'physics.optics');
INSERT INTO "document_categories" ("document_id", "category") VALUES (110, 'physics.optics');

-- reading_queue: 6 row(s)
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (1, 'read', '2026-10-31 07:01:00', '2026-10-31 07:01:00', '2026-10-31 08:00:00');
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (2, 'to_read', '2026-10-31 07:02:00', '2026-10-31 07:02:00', NULL);
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (3, 'to_read', '2026-10-31 07:03:00', '2026-10-31 07:03:00', NULL);
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (4, 'to_read', '2026-10-31 07:04:00', '2026-10-31 07:04:00', NULL);
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (5, 'to_read', '2026-10-31 07:05:00', '2026-10-31 07:05:00', NULL);
INSERT INTO "reading_queue" ("document_id", "status", "saved_at", "updated_at", "read_at") VALUES (6, 'to_read', '2026-10-31 07:06:00', '2026-10-31 07:06:00', NULL);

-- executions: 5 row(s)
INSERT INTO "executions" ("id", "execution_type", "routine_id", "saved_configuration_id", "parameters", "start_time", "end_time", "status", "result_count", "new_result_count", "log_path", "result_path", "error_message", "progress_events", "current_stage", "owner_pid", "owner_runtime_id", "last_seen_at_utc", "interrupted_reason", "restarted_from", "cancel_reason", "dedup_total", "dedup_new", "dedup_duplicates", "dedup_invalid", "dedup_cross_source", "request_id") VALUES (1, 'automated_sweep', 1, NULL, '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "optics", "keywords": ["optics"], "max_results": 100}', '2026-10-26T06:00:00+00:00', '2026-10-26T06:05:00+00:00', 'completed', 30, 30, NULL, NULL, NULL, NULL, NULL, 1001, '00000000-0000-4000-8000-000000000001', '2026-10-26T06:05:00.000000+00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "executions" ("id", "execution_type", "routine_id", "saved_configuration_id", "parameters", "start_time", "end_time", "status", "result_count", "new_result_count", "log_path", "result_path", "error_message", "progress_events", "current_stage", "owner_pid", "owner_runtime_id", "last_seen_at_utc", "interrupted_reason", "restarted_from", "cancel_reason", "dedup_total", "dedup_new", "dedup_duplicates", "dedup_invalid", "dedup_cross_source", "request_id") VALUES (2, 'automated_sweep', 2, NULL, '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "learning", "keywords": ["learning"], "max_results": 100}', '2026-10-28T06:00:00+00:00', '2026-10-28T06:05:00+00:00', 'completed', 40, 40, NULL, NULL, NULL, NULL, NULL, 1002, '00000000-0000-4000-8000-000000000002', '2026-10-28T06:05:00.000000+00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "executions" ("id", "execution_type", "routine_id", "saved_configuration_id", "parameters", "start_time", "end_time", "status", "result_count", "new_result_count", "log_path", "result_path", "error_message", "progress_events", "current_stage", "owner_pid", "owner_runtime_id", "last_seen_at_utc", "interrupted_reason", "restarted_from", "cancel_reason", "dedup_total", "dedup_new", "dedup_duplicates", "dedup_invalid", "dedup_cross_source", "request_id") VALUES (3, 'automated_sweep', 3, NULL, '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "biology", "keywords": ["biology"], "max_results": 100}', '2026-10-30T06:00:00+00:00', '2026-10-30T06:05:00+00:00', 'completed', 20, 20, NULL, NULL, NULL, NULL, NULL, 1003, '00000000-0000-4000-8000-000000000003', '2026-10-30T06:05:00.000000+00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "executions" ("id", "execution_type", "routine_id", "saved_configuration_id", "parameters", "start_time", "end_time", "status", "result_count", "new_result_count", "log_path", "result_path", "error_message", "progress_events", "current_stage", "owner_pid", "owner_runtime_id", "last_seen_at_utc", "interrupted_reason", "restarted_from", "cancel_reason", "dedup_total", "dedup_new", "dedup_duplicates", "dedup_invalid", "dedup_cross_source", "request_id") VALUES (4, 'automated_sweep', 1, NULL, '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "optics", "keywords": ["optics"], "max_results": 100}', '2026-11-01T06:00:00+00:00', '2026-11-01T06:05:00+00:00', 'completed', 20, 15, NULL, NULL, NULL, NULL, NULL, 1004, '00000000-0000-4000-8000-000000000004', '2026-11-01T06:05:00.000000+00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "executions" ("id", "execution_type", "routine_id", "saved_configuration_id", "parameters", "start_time", "end_time", "status", "result_count", "new_result_count", "log_path", "result_path", "error_message", "progress_events", "current_stage", "owner_pid", "owner_runtime_id", "last_seen_at_utc", "interrupted_reason", "restarted_from", "cancel_reason", "dedup_total", "dedup_new", "dedup_duplicates", "dedup_invalid", "dedup_cross_source", "request_id") VALUES (5, 'deep_sweep', NULL, NULL, '{"repositories": ["arxiv", "crossref", "pubmed"], "query": "learning", "keywords": ["learning"], "max_results": 100}', '2026-11-03T06:00:00+00:00', '2026-11-03T06:05:00+00:00', 'completed', 15, 0, NULL, NULL, NULL, NULL, NULL, 1005, '00000000-0000-4000-8000-000000000005', '2026-11-03T06:05:00.000000+00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- AUTOINCREMENT high-water marks. Restored explicitly because
-- a deleted row leaves the sequence above the highest surviving id.
UPDATE sqlite_sequence SET seq = 125 WHERE name = 'documents';
UPDATE sqlite_sequence SET seq = 5 WHERE name = 'executions';
UPDATE sqlite_sequence SET seq = 3 WHERE name = 'routines';
UPDATE sqlite_sequence SET seq = 1 WHERE name = 'saved_configurations';

COMMIT;
