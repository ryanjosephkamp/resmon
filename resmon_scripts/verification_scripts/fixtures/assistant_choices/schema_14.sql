-- Authored synthetic schema-14 fixture; built by public ca881b92d594a2fd207634195d9dd454d9829b00.
PRAGMA foreign_keys=OFF;
BEGIN;
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
INSERT INTO "app_settings" ("key","value") VALUES ('schema_version','14');
INSERT INTO "app_settings" ("key","value") VALUES ('dedup_columns_backfilled','1');
INSERT INTO "app_settings" ("key","value") VALUES ('execution_sources_backfilled','1');
INSERT INTO "app_settings" ("key","value") VALUES ('export_directory','/tmp/exports');
INSERT INTO "app_settings" ("key","value") VALUES ('email_enabled','true');
INSERT INTO "app_settings" ("key","value") VALUES ('pdf_policy','keep');
INSERT INTO "assistant_messages" ("id","session_id","role","content","tool_calls","tool_results","input_tokens","output_tokens","cost_usd","created_at") VALUES (1,1,'user','set one up',NULL,NULL,NULL,NULL,NULL,'2026-02-05 14:00:00');
INSERT INTO "assistant_messages" ("id","session_id","role","content","tool_calls","tool_results","input_tokens","output_tokens","cost_usd","created_at") VALUES (2,1,'assistant','done','[{"name": "create_routine"}]','[{"routine": {"id": 1}}]',120,40,0.012,'2026-02-05 14:05:00');
INSERT INTO "assistant_messages" ("id","session_id","role","content","tool_calls","tool_results","input_tokens","output_tokens","cost_usd","created_at") VALUES (3,2,'user','R04c old API user text',NULL,NULL,NULL,NULL,NULL,'2026-09-11 02:07:50');
INSERT INTO "assistant_messages" ("id","session_id","role","content","tool_calls","tool_results","input_tokens","output_tokens","cost_usd","created_at") VALUES (4,2,'assistant','R04c old API answer',NULL,NULL,NULL,NULL,NULL,'2026-09-11 02:07:50');
INSERT INTO "assistant_sessions" ("id","runtime","cli_session_id","model","title","created_at","updated_at") VALUES (1,'claude_cli','sess-1','opus','Weekly arXiv','2026-02-05 14:00:00','2026-02-05 14:05:00');
INSERT INTO "assistant_sessions" ("id","runtime","cli_session_id","model","title","created_at","updated_at") VALUES (2,'api_key',NULL,NULL,'Legacy API','2026-09-11 02:07:50','2026-09-11 02:07:50');
INSERT INTO "cloud_sync" ("id","provider","account_info","is_linked","auto_backup_enabled","last_sync_at","sync_status") VALUES (1,'google_drive','{"email": "someone@example.invalid"}',1,1,'2026-02-05 06:00:00','idle');
INSERT INTO "document_authors" ("document_id","author","orcid","affiliation","source_author_id") VALUES (1,'Ada Lovelace','0000-0002-9322-3515','MIT','A1');
INSERT INTO "document_authors" ("document_id","author","orcid","affiliation","source_author_id") VALUES (1,'Alan Turing',NULL,NULL,NULL);
INSERT INTO "document_authors" ("document_id","author","orcid","affiliation","source_author_id") VALUES (2,'Grace Hopper',NULL,NULL,NULL);
INSERT INTO "document_authors" ("document_id","author","orcid","affiliation","source_author_id") VALUES (3,'Grace Hopper',NULL,NULL,NULL);
INSERT INTO "document_categories" ("document_id","category") VALUES (1,'cs.LG');
INSERT INTO "document_categories" ("document_id","category") VALUES (1,'stat.ML');
INSERT INTO "document_categories" ("document_id","category") VALUES (2,'q-bio');
INSERT INTO "document_embeddings" ("document_id","model","dims","vector","fields","embedded_at") VALUES (1,'nomic-embed-text',4,X'00010203','title+abstract','2026-02-03 12:00:00');
INSERT INTO "document_lifecycle" ("document_id","kind","severity","notice_key","label","notice_doi","notice_url","notice_date","detail","provider","provider_source","first_seen_at") VALUES (1,'retraction','critical','notice-1','Retracted','10.0000/notice-1','https://example.invalid/notice-1','2026-02-01','Synthetic retraction notice.','crossref','crossref-api','2026-02-01 10:00:00');
INSERT INTO "document_lifecycle_checks" ("document_id","checked_at","status","error_message","providers") VALUES (1,'2026-02-01 10:00:00','ok',NULL,'["crossref"]');
INSERT INTO "document_links" ("document_a","document_b","kind","score","method","created_at") VALUES (2,3,'near_duplicate',0.98,'title','2026-02-02 11:00:00');
INSERT INTO "documents" ("id","source_repository","external_id","doi","title","authors","abstract","publication_date","url","categories","metadata_hash","first_seen_at") VALUES (1,'arxiv','legacy-1','10.0000/legacy-1','Legacy diffusion models','Ada Lovelace, Alan Turing','About diffusion.','2026-01-15','https://example.invalid/1','cs.LG, stat.ML','legacy-h1','2026-01-16 09:00:00');
INSERT INTO "documents" ("id","source_repository","external_id","doi","title","authors","abstract","publication_date","url","categories","metadata_hash","first_seen_at") VALUES (2,'pubmed','legacy-2',NULL,'Legacy protein folding','Grace Hopper','About folding.','2025-11-02','https://example.invalid/2','q-bio','legacy-h2','2026-01-16 09:00:01');
INSERT INTO "documents" ("id","source_repository","external_id","doi","title","authors","abstract","publication_date","url","categories","metadata_hash","first_seen_at") VALUES (3,'openalex','legacy-3',NULL,'Legacy protein folding','Grace Hopper',NULL,NULL,'https://example.invalid/3',NULL,'legacy-h3','2026-01-16 09:00:02');
INSERT INTO "execution_ai" ("execution_id","lane_index","lane_label","lane_kind","provider","model","credential_alias","outcome","error_kind","http_status","safe_message","docs_attempted","docs_succeeded","started_at","ended_at") VALUES (1,0,'Local summariser','local','ollama','llama3',NULL,'ok',NULL,NULL,NULL,2,2,'2026-01-16 09:01:00','2026-01-16 09:01:30');
INSERT INTO "execution_documents" ("execution_id","document_id","is_new") VALUES (1,1,1);
INSERT INTO "execution_documents" ("execution_id","document_id","is_new") VALUES (1,2,1);
INSERT INTO "execution_documents" ("execution_id","document_id","is_new") VALUES (2,2,0);
INSERT INTO "execution_documents" ("execution_id","document_id","is_new") VALUES (2,3,1);
INSERT INTO "execution_sources" ("execution_id","source","status","result_count","error_message","credential_name","zero_reason","zero_detail","recorded_at") VALUES (1,'arxiv','ok',2,NULL,NULL,NULL,NULL,'2026-01-16 09:01:00');
INSERT INTO "execution_sources" ("execution_id","source","status","result_count","error_message","credential_name","zero_reason","zero_detail","recorded_at") VALUES (2,'pubmed','error',0,'HTTP 503',NULL,'could_not_answer','The source replied 503.','2026-01-17 09:02:00');
INSERT INTO "executions" ("id","execution_type","routine_id","saved_configuration_id","parameters","start_time","end_time","status","result_count","new_result_count","log_path","result_path","error_message","progress_events","current_stage","cancel_reason","dedup_total","dedup_new","dedup_duplicates","dedup_invalid","dedup_cross_source") VALUES (1,'deep_dive',NULL,NULL,'{"keywords": ["diffusion"], "repositories": ["arxiv"]}','2026-01-16 09:00:00','2026-01-16 09:01:00','completed',2,2,NULL,NULL,NULL,NULL,NULL,NULL,2,2,NULL,NULL,NULL);
INSERT INTO "executions" ("id","execution_type","routine_id","saved_configuration_id","parameters","start_time","end_time","status","result_count","new_result_count","log_path","result_path","error_message","progress_events","current_stage","cancel_reason","dedup_total","dedup_new","dedup_duplicates","dedup_invalid","dedup_cross_source") VALUES (2,'automated_sweep',1,NULL,'{"keywords": ["folding"], "repositories": ["pubmed"]}','2026-01-17 09:00:00','2026-01-17 09:02:00','completed',2,1,NULL,NULL,NULL,NULL,NULL,NULL,2,1,NULL,NULL,1);
INSERT INTO "routines" ("id","name","schedule_cron","parameters","is_active","email_enabled","email_ai_summary_enabled","ai_enabled","notify_on_complete","ai_settings","storage_settings","intent","execution_location","created_at","updated_at","last_executed_at") VALUES (1,'Diffusion watch','0 8 * * 1','{"keywords": ["diffusion"], "repositories": ["arxiv"]}',1,0,0,0,0,NULL,NULL,'anything on diffusion models','local','2026-01-11 08:00:00','2026-01-11 08:00:00',NULL);
INSERT INTO "saved_configurations" ("id","name","config_type","parameters","created_at","updated_at") VALUES (1,'Weekly arXiv','manual_sweep','{"keywords": ["diffusion"]}','2026-01-10 08:00:00','2026-01-10 08:00:00');
INSERT INTO "watch_profile_matches" ("document_id","profile_id","basis","matched_author","evidence","first_seen_at") VALUES (2,1,'name_only','Grace Hopper','{"matched_on": "name"}','2026-01-17 09:02:00');
INSERT INTO "watch_profile_members" ("profile_id","member_profile_id") VALUES (2,1);
INSERT INTO "watch_profiles" ("id","kind","display_name","names","identifiers","orcid","affiliations","field_hints","notes","created_at","updated_at") VALUES (1,'person','Grace Hopper','[{"value": "Grace Hopper", "script": "Latn"}]','{}',NULL,'["Yale"]','[]',NULL,'2026-01-05 07:00:00','2026-01-05 07:00:00');
INSERT INTO "watch_profiles" ("id","kind","display_name","names","identifiers","orcid","affiliations","field_hints","notes","created_at","updated_at") VALUES (2,'group','Folding group','[{"value": "Folding group", "script": "Latn"}]','{}',NULL,'[]','[]',NULL,'2026-01-05 07:00:01','2026-01-05 07:00:01');
INSERT INTO "watchdog_mutes" ("finding_key","muted_at","note") VALUES ('source:pubmed','2026-02-04 13:00:00','known outage');
INSERT INTO "reading_queue" ("document_id","status","saved_at","updated_at","read_at") VALUES (1,'to_read','2026-09-11 02:07:50','2026-09-11 02:07:50',NULL);
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
CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
        END;
CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
CREATE INDEX idx_reading_queue_status_saved
    ON reading_queue(status, saved_at DESC, document_id DESC);
INSERT INTO documents_fts(documents_fts) VALUES ('rebuild');
COMMIT;
PRAGMA foreign_keys=ON;
