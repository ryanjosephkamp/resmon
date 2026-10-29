// Generated from docs/api-contract/openapi.json by scripts/atlas-api.mjs. Do not edit;
// regenerate with `npm run gen:atlas-api` after the API contract changes.

export interface paths {
    "/api/admin/erase-ai-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Admin Erase Ai Keys */
        post: operations["admin_erase_ai_keys_api_admin_erase_ai_keys_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-app-data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin Erase App Data
         * @description Erase the corpus + configs + executions + every API key.
         *
         *     The corpus is included as of 1.7.0. "All app data" that left every collected
         *     paper behind was not a description of what this did.
         */
        post: operations["admin_erase_app_data_api_admin_erase_app_data_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-configs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Admin Erase Configs */
        post: operations["admin_erase_configs_api_admin_erase_configs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-corpus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin Erase Corpus
         * @description Erase every collected paper. Executions, configs and keys are kept.
         */
        post: operations["admin_erase_corpus_api_admin_erase_corpus_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-execution-data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin Erase Execution Data
         * @description Erase all configs + all executions. Settings and API keys untouched.
         */
        post: operations["admin_erase_execution_data_api_admin_erase_execution_data_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Admin Erase Executions */
        post: operations["admin_erase_executions_api_admin_erase_executions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/erase-repo-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Admin Erase Repo Keys */
        post: operations["admin_erase_repo_keys_api_admin_erase_repo_keys_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/factory-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin Factory Reset
         * @description Erase every secret, config, execution, setting, and collected paper.
         *
         *     The corpus is included as of 1.7.0 — a "factory reset" that left tens of
         *     thousands of papers on disk was the single most misleading label in the app.
         */
        post: operations["admin_factory_reset_api_admin_factory_reset_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/reset-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Admin Reset Settings
         * @description Reset every setting plus erase every API key. Configs/executions kept.
         */
        post: operations["admin_reset_settings_api_admin_reset_settings_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ai/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * List Ai Models
         * @description Return the list of model IDs the BYOK credential can access.
         *
         *     The caller may send a freshly-typed ``key`` or rely on the credential
         *     already stored in the OS keyring for ``{provider}_api_key`` (or
         *     ``custom_llm_api_key`` for the Custom provider). ``local`` uses no
         *     key and requires ``endpoint`` instead.
         */
        post: operations["list_ai_models_api_ai_models_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/discovery-lag": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Discovery Lag
         * @description Median days between publication and resmon first seeing each paper.
         */
        get: operations["analytics_discovery_lag_api_analytics_discovery_lag_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/keyword-contribution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Keyword Contribution
         * @description Per keyword: papers it found that no other keyword did.
         *
         *     Scoped to one execution with ``?execution_id=``, otherwise to every keyword
         *     ever searched against the whole corpus. Cached like the other analytics —
         *     it reads every candidate document once, which is not free on a large corpus.
         */
        get: operations["analytics_keyword_contribution_api_analytics_keyword_contribution_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Overview
         * @description Everything the Analytics page needs, in one round trip.
         */
        get: operations["analytics_overview_api_analytics_overview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/publication-volume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Publication Volume
         * @description Papers per publication month, split by source or subject category.
         */
        get: operations["analytics_publication_volume_api_analytics_publication_volume_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/routine-health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Routine Health
         * @description Per routine: new results per run, and whether it has gone quiet.
         */
        get: operations["analytics_routine_health_api_analytics_routine_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/source-contribution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Analytics Source Contribution
         * @description Per source: papers delivered, and how many nothing else found.
         */
        get: operations["analytics_source_contribution_api_analytics_source_contribution_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/analytics/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Analytics Summary */
        get: operations["analytics_summary_api_analytics_summary_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/appearance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Appearance */
        get: operations["get_appearance_api_appearance_get"];
        /** Update Appearance */
        put: operations["update_appearance_api_appearance_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open Assistant Permission
         * @description Ask the person, and hold this request open until they answer.
         *
         *     Called by ``assistant_permission_server.py``, not by the renderer. The wait
         *     is the point: ``claude`` is blocked on this reply and will not run the tool
         *     until it arrives, so a write physically cannot precede the answer.
         *
         *     A card that nobody is listening for is denied immediately rather than left to
         *     time out — if the panel has closed the stream, there is no one to ask.
         */
        post: operations["open_assistant_permission_api_assistant_permissions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/permissions/{request_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Answer Assistant Permission
         * @description The panel's Allow / Deny.
         *
         *     A second answer to the same request is refused rather than applied: two taps
         *     on a card must not turn a deny into an allow.
         */
        post: operations["answer_assistant_permission_api_assistant_permissions__request_id__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Assistant Sessions */
        get: operations["list_assistant_sessions_api_assistant_sessions_get"];
        put?: never;
        /** Create Assistant Session */
        post: operations["create_assistant_session_api_assistant_sessions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions/browse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Browse Assistant Sessions */
        get: operations["browse_assistant_sessions_api_assistant_sessions_browse_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Assistant Session */
        get: operations["get_assistant_session_api_assistant_sessions__session_id__get"];
        put?: never;
        post?: never;
        /** Delete Assistant Session */
        delete: operations["delete_assistant_session_api_assistant_sessions__session_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions/{session_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Assistant Turn
         * @description Stop the running turn. Idempotent, and it says which happened.
         */
        post: operations["cancel_assistant_turn_api_assistant_sessions__session_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions/{session_id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export Assistant Session */
        get: operations["export_assistant_session_api_assistant_sessions__session_id__export_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/sessions/{session_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send Assistant Message */
        post: operations["send_assistant_message_api_assistant_sessions__session_id__messages_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assistant/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Assistant Status
         * @description Whether the assistant can run, and if not, the reason in one sentence.
         *
         *     Codex is reported as unavailable *with its reason* rather than omitted: a
         *     user who has Codex installed and sees no mention of it would reasonably
         *     conclude resmon had not noticed it.
         */
        get: operations["assistant_status_api_assistant_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/renderer-origin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Renderer Origin
         * @description Allow one more exact renderer origin on this backend.
         *
         *     Exists for the daemon. launchd starts it long before any window exists, so
         *     unlike an Electron-spawned backend it cannot be told its renderer's origin
         *     at spawn — and "any loopback origin" is what the old Library guard trusted
         *     and what this lock-down removes. Electron's main process, which read the
         *     token from the daemon's token file, registers its renderer's origin here
         *     once it has bound the renderer server.
         *
         *     Refused from a browser: a request carrying an Origin is a page, and a page
         *     must not be able to widen the set of pages the backend trusts, even the
         *     renderer itself.
         */
        post: operations["register_renderer_origin_api_auth_renderer_origin_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/backup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Backup Now
         * @description Write one bundle: the snapshotted database, the vault's bytes, optionally reports.
         */
        post: operations["backup_now_api_backup_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/backup/last": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Backup Last
         * @description The last bundle, the last restore outcome, and whether an undo copy exists.
         */
        get: operations["backup_last_api_backup_last_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/backup/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Backup Verify
         * @description Recompute every hash and report what a restore would and would not do.
         */
        post: operations["backup_verify_api_backup_verify_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/calendar/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Calendar Events */
        get: operations["calendar_events_api_calendar_events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cloud/backup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cloud Backup */
        post: operations["cloud_backup_api_cloud_backup_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cloud/link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cloud Link */
        post: operations["cloud_link_api_cloud_link_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cloud/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cloud Status */
        get: operations["cloud_status_api_cloud_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cloud/unlink": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cloud Unlink */
        post: operations["cloud_unlink_api_cloud_unlink_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/configurations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Configurations */
        get: operations["list_configurations_api_configurations_get"];
        put?: never;
        /** Create Configuration */
        post: operations["create_configuration_api_configurations_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/configurations/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Configurations
         * @description The same archive ``POST /api/configurations/export`` writes, as bytes.
         *
         *     The export route writes to a folder the engine chooses and answers with
         *     the path, which with no export folder chosen is the system's temporary
         *     folder. This one answers with the archive itself, so a renderer can hand
         *     it to the system's save dialog and the person chooses where it goes.
         *     ``export_configs`` builds it, so the two can never be two formats. An id
         *     that is no longer saved is left out, as the export route leaves it out, and
         *     a choice with none still saved is a 404 rather than an empty archive.
         */
        post: operations["download_configurations_api_configurations_archive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/configurations/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Export Configurations */
        post: operations["export_configurations_api_configurations_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/configurations/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Import Configurations */
        post: operations["import_configurations_api_configurations_import_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/configurations/{config_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Configuration Endpoint */
        put: operations["update_configuration_endpoint_api_configurations__config_id__put"];
        post?: never;
        /** Delete Configuration Endpoint */
        delete: operations["delete_configuration_endpoint_api_configurations__config_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/coverage/source-wall": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Source Wall Grid
         * @description Every source's recorded answer to each of the last ``limit`` runs.
         *
         *     The one read that crosses executions. `/api/executions` and
         *     `/api/executions/{id}` each carry the coverage of a single run, which
         *     answers "what did this run get"; nobody could ask "is my coverage still
         *     what it was" without opening runs one at a time and comparing them by
         *     hand. The rows have been on disk since schema 6.
         *
         *     The cells arrive **classified** -- one of the six states in
         *     ``source_wall.WALL_STATES`` -- rather than as a status and a reason for
         *     the caller to interpret. That is deliberate: every place that has
         *     re-derived this classification has eventually derived it differently, and
         *     the last time one did it put a tick on sources that had never been asked.
         *
         *     ``limit`` bounds what comes back, not what is read: there is no index on
         *     ``executions.start_time``, so finding the newest runs scans the table and
         *     sorts. Measured at 0.4 ms over 12 executions and 5.7 ms over 50,000.
         */
        get: operations["source_wall_grid_api_coverage_source_wall_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Credentials Presence
         * @description Return per-credential status for every known credential name.
         *
         *     Never returns the raw credential value.
         *
         *     Each entry carries ``present`` (kept for compatibility) and ``status``,
         *     which is ``present``, ``absent`` or ``unreadable``. The last one matters:
         *     an unsigned macOS build is denied access to keychain items an earlier
         *     build stored, and reporting that as "absent" tells the user their keys
         *     are gone when they are simply unreachable. ``keyring_responsive`` is
         *     False once a read has timed out, so the interface can say so once at the
         *     top rather than fifteen times over. Each webhook destination's signing
         *     secret (``webhook_secret_<id>``) is included for every webhook stored.
         */
        get: operations["credentials_presence_api_credentials_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/credentials/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate Credential */
        post: operations["validate_credential_api_credentials_validate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/credentials/{key_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Store Credential Endpoint */
        put: operations["store_credential_endpoint_api_credentials__key_name__put"];
        post?: never;
        /** Delete Credential Endpoint */
        delete: operations["delete_credential_endpoint_api_credentials__key_name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/deliveries/{delivery_id}/bundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Delivery Bundle
         * @description The report bundle a webhook envelope linked to, for whoever holds the link.
         *
         *     This is the one route in resmon that answers without the local API token,
         *     and it is the one route that is not for resmon: a webhook receiver is a
         *     program the user pointed a routine at, and handing it the token that opens
         *     every route would be a far worse trade than a signature over one delivery
         *     id with an expiry on it. ``api_auth.AUTH_SIGNED_PATHS`` is where the guard
         *     steps aside; everything it checks before the token -- the Host, and a
         *     browser's Origin -- still applies here.
         *
         *     Every way of not being entitled to the file gets the same 403: a wrong
         *     signature, an expired one, a destination with no secret stored, and a
         *     delivery that was not a webhook at all. A caller guessing learns only that
         *     it did not work.
         */
        get: operations["delivery_bundle_api_deliveries__delivery_id__bundle_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/deliveries/{delivery_id}/deliver": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve Delivery
         * @description Release a delivery that was waiting for review. The only promotion.
         */
        post: operations["approve_delivery_api_deliveries__delivery_id__deliver_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/deliveries/{delivery_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retry Delivery
         * @description Start the attempt sequence again, after the backoff has given up.
         */
        post: operations["retry_delivery_api_deliveries__delivery_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/deliveries/{delivery_id}/skip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Skip Delivery */
        post: operations["skip_delivery_api_deliveries__delivery_id__skip_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/briefs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get Document Briefs
         * @description A line about each paper asked for, for the plate's hover: title, authors,
         *     source and dates. Ids that are not in the corpus are left out, not invented.
         */
        post: operations["get_document_briefs_api_documents_briefs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{doc_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Document
         * @description One paper as stored, and where it stands in the reading queue.
         *
         *     The record exactly as resmon holds it: what the source gave (title,
         *     authors, abstract, identifiers, date) and when resmon first saw it. It adds
         *     nothing the corpus does not hold -- no summary, no score -- so a screen
         *     that shows a paper from this shows only what was collected.
         */
        get: operations["get_document_api_documents__doc_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{doc_id}/lifecycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Document Lifecycle
         * @description Lifecycle events recorded against one paper.
         */
        get: operations["document_lifecycle_api_documents__doc_id__lifecycle_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{doc_id}/why": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Document Why
         * @description What is locally verifiable about why this paper is in the corpus.
         */
        get: operations["document_why_api_documents__doc_id__why_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{document_id}/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Document Links
         * @description What else in the corpus looks like the same work as this paper.
         *
         *     A link is an assertion laid beside two records, never a merge: both rows stay,
         *     both provenances stay, and nothing is hidden. Each link names the ``method``
         *     that produced it, because "these two share a DOI" and "these two have
         *     near-identical titles and nearby vectors" are different strengths of claim.
         */
        get: operations["document_links_api_documents__document_id__links_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{document_id}/similar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Document Similar
         * @description The papers nearest this one, with distances and their sources.
         *
         *     Costs one index query and nothing at the provider: the document's vector is
         *     already stored, so "more like this" never calls an embedding model.
         */
        get: operations["document_similar_api_documents__document_id__similar_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/backfill": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start Embedding Backfill
         * @description Embed every document lacking a vector for the active model.
         *
         *     Returns immediately; poll ``GET /api/embeddings/status``. Resumable by
         *     construction — the work remaining is a query, not a stored cursor — so a
         *     cancelled run restarts where the corpus is, not where the last run thought
         *     it was.
         */
        post: operations["start_embedding_backfill_api_embeddings_backfill_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/backfill/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Embedding Backfill
         * @description Stop after the batch in flight. Vectors already written are kept.
         */
        post: operations["cancel_embedding_backfill_api_embeddings_backfill_cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/estimate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Embedding Estimate
         * @description What a backfill would cost, before it starts.
         *
         *     Built from the real pending set and the real text builder, not from an
         *     average: the number a user is shown is computed from the documents that will
         *     actually be sent.
         */
        get: operations["embedding_estimate_api_embeddings_estimate_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/probe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Probe Embedding Lane
         * @description Ask the configured (or supplied) lane to embed one short string.
         *
         *     This is what turns a claim about a provider into a fact about this machine.
         *     ``PROVIDER_EMBEDDING`` says what a vendor serves; only a probe says whether
         *     this endpoint, this key and this model answer — and for a local server that
         *     lists models and still refuses to embed, the probe is the entire difference
         *     between a usable lane and a corpus with nothing to rank (P9).
         */
        post: operations["probe_embedding_lane_api_embeddings_probe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/rebuild": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rebuild Embedding Index
         * @description Rebuild the vector index from the canonical table.
         *
         *     Exposed because the index is derived and the table is not: a database copied
         *     from a machine that could not load the extension arrives with every vector
         *     and no index, and this is the one action that fixes it.
         */
        post: operations["rebuild_embedding_index_api_embeddings_rebuild_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/embeddings/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Embedding Status
         * @description N of M embedded with model X, the run, the index, and the extension.
         */
        get: operations["embedding_status_api_embeddings_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence Projects */
        get: operations["evidence_projects_api_evidence_projects_get"];
        put?: never;
        /** Evidence Create Project */
        post: operations["evidence_create_project_api_evidence_projects_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence Project Detail */
        get: operations["evidence_project_detail_api_evidence_projects__project_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Evidence Rename Project */
        patch: operations["evidence_rename_project_api_evidence_projects__project_id__patch"];
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answer-previews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Selected Answer Preview */
        post: operations["selected_answer_preview_api_evidence_projects__project_id__answer_previews_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Selected Answer History */
        get: operations["selected_answer_history_api_evidence_projects__project_id__answers_get"];
        put?: never;
        /** Selected Answer Send */
        post: operations["selected_answer_send_api_evidence_projects__project_id__answers_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answers/{answer_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Selected Answer Detail */
        get: operations["selected_answer_detail_api_evidence_projects__project_id__answers__answer_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answers/{answer_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Selected Answer Cancel */
        post: operations["selected_answer_cancel_api_evidence_projects__project_id__answers__answer_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answers/{answer_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Selected Answer Events */
        get: operations["selected_answer_events_api_evidence_projects__project_id__answers__answer_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/answers/{answer_id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Selected Answer Export */
        get: operations["selected_answer_export_api_evidence_projects__project_id__answers__answer_id__export_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/bundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Evidence Bundle */
        post: operations["evidence_bundle_api_evidence_projects__project_id__bundle_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence Files */
        get: operations["evidence_files_api_evidence_projects__project_id__files_get"];
        put?: never;
        /** Evidence Add File */
        post: operations["evidence_add_file_api_evidence_projects__project_id__files_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/files/{file_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Evidence Remove File */
        delete: operations["evidence_remove_file_api_evidence_projects__project_id__files__file_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence Notes */
        get: operations["evidence_notes_api_evidence_projects__project_id__notes_get"];
        put?: never;
        /** Evidence Create Note */
        post: operations["evidence_create_note_api_evidence_projects__project_id__notes_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/notes/{note_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Evidence Edit Note */
        patch: operations["evidence_edit_note_api_evidence_projects__project_id__notes__note_id__patch"];
        trace?: never;
    };
    "/api/evidence/projects/{project_id}/reader/{file_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence Read */
        get: operations["evidence_read_api_evidence_projects__project_id__reader__file_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Executions */
        get: operations["list_executions_api_executions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Active Executions */
        get: operations["active_executions_api_executions_active_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export Executions
         * @description Bundle the reports and logs for the selected executions into a .zip.
         *
         *     The output path respects the Storage tab's configured export directory
         *     when set; otherwise a temporary file is used. Raises 404 if no executions
         *     in the selection exist.
         */
        post: operations["export_executions_api_executions_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution */
        get: operations["get_execution_api_executions__exec_id__get"];
        put?: never;
        post?: never;
        /** Delete Execution */
        delete: operations["delete_execution_api_executions__exec_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/bundle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download Execution Bundle
         * @description One run's bundle as bytes: the archive ``POST /api/executions/export`` writes.
         *
         *     The report, its PDF and LaTeX where a LaTeX engine could make them, the
         *     log, the metadata and the search record, built by ``_delivery_bundle``,
         *     the one builder the export route and the delivery queue share. The export
         *     route answers with a path on disk; this one with the archive itself, so a
         *     renderer can hand it to the save dialog.
         */
        get: operations["download_execution_bundle_api_executions__exec_id__bundle_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Execution
         * @description Request cooperative cancellation of a running execution.
         *
         *     A row that is not in the in-memory ``ProgressStore`` is not cancellable,
         *     and this used to say only "Execution not running" -- which read, on an
         *     interrupted row, as if resmon had lost track of something. The row's own
         *     state belongs in the sentence.
         *
         *     ``detail`` stays a **string**. FastAPI will serialise a dict there happily,
         *     and a renderer that renders ``detail`` directly -- which several of
         *     resmon's do -- would then show ``[object Object]``. Anything that needs the
         *     state structurally reads ``status`` off the row it already has.
         */
        post: operations["cancel_execution_api_executions__exec_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Execution Deliveries */
        get: operations["list_execution_deliveries_api_executions__exec_id__deliveries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Execution Papers
         * @description One page of the papers this run found, each with its stored id.
         *
         *     Results & Logs listed runs and rendered a Markdown report; the papers
         *     inside a run were reachable only by reading that text or by exporting the
         *     whole file. Neither gives a user something to click, and an execution id is
         *     not a paper id -- so the Papers tab needed a route that hands back the
         *     corpus-local document ids the rest of the app is keyed on (the same ids
         *     ``include_ids`` carries into a JSON export, phase 2.1a).
         *
         *     Paged rather than whole: a sweep can return thousands, and a renderer that
         *     holds all of them is a renderer that stops responding on the run that
         *     matters most. ``queue_status`` rides along so the Save control can show the
         *     state the database actually holds instead of guessing from what the user
         *     last clicked.
         */
        get: operations["get_execution_papers_api_executions__exec_id__documents_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/log": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution Log */
        get: operations["get_execution_log_api_executions__exec_id__log_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/progress/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution Progress Events */
        get: operations["get_execution_progress_events_api_executions__exec_id__progress_events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/progress/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream Progress */
        get: operations["stream_progress_api_executions__exec_id__progress_stream_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Export Execution References
         * @description Export one run; JSON can explicitly include corpus IDs for follow-up reads.
         */
        get: operations["export_execution_references_api_executions__exec_id__references_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution Report */
        get: operations["get_execution_report_api_executions__exec_id__report_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restart Execution
         * @description Start a fresh execution with the source's parameters, linked back to it.
         *
         *     Restart is not resume. ``progress_events`` is persisted once, at the end,
         *     so an interrupted run has nothing to resume *from* -- there is no durable
         *     record of which sources it had already asked. What resmon can honestly
         *     offer is the same search again, and a link saying where it came from.
         *
         *     The source row is never touched. Its history is what happened, and a
         *     restart is a second thing that happened, not a correction of the first.
         */
        post: operations["restart_execution_api_executions__exec_id__restart_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{exec_id}/search-record": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Execution Search Record
         * @description The complete, dated account of one search.
         *
         *     ``?format=markdown`` returns a methods-section-shaped document as
         *     ``text/markdown`` rather than JSON.
         */
        get: operations["execution_search_record_api_executions__exec_id__search_record_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/explorer/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Explorer Export
         * @description Export everything matching the current filters, not just the page shown.
         *
         *     Reuses the same renderers as the per-execution export; only the way the
         *     documents are selected differs.
         */
        post: operations["explorer_export_api_explorer_export_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/explorer/facets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Explorer Facets
         * @description Available filter values and their counts, for the current filters.
         */
        post: operations["explorer_facets_api_explorer_facets_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/explorer/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Explorer Search
         * @description Search the whole corpus. POST because the filter set is a structure.
         *
         *     ``sort="similarity"`` embeds the search phrase and re-orders the same
         *     filtered set by distance from it. The filters still decide *which* papers;
         *     the sort decides only their order, so switching sorts cannot change what a
         *     user is looking at.
         */
        post: operations["explorer_search_api_explorer_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/export/references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export Selected References
         * @description Render one selection, with one entry per stored document ID.
         *
         *     Execution selections are unioned before rendering. Publication date then ID
         *     descending fixes order independently of selection order, so BibTeX keys are
         *     allocated once for the complete file. This never merges corpus records.
         */
        post: operations["export_selected_references_api_export_references_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health
         * @description Liveness endpoint. Returns process identity so clients can attach-or-spawn.
         *
         *     ``embeddings`` reports whether *this* backend can load the vector extension,
         *     and why not when it cannot. It is here rather than on a route of its own
         *     because the renderer already reads health on startup to decide what to show,
         *     and phase 1.9's rule is that a feature whose dependency is missing is
         *     **absent** rather than present-and-broken: the Explorer's similarity sort and
         *     the similar-papers panel are not rendered when this says ``null``. A user is
         *     told the reason in Settings, not by a control that does nothing.
         *
         *     The load is attempted against a real connection on every call rather than
         *     read from a cached probe. It is a ``dlopen`` of a 165 KB library, and a
         *     health endpoint that answered from memory would keep reporting a capability
         *     the process had lost.
         */
        get: operations["health_api_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library Status */
        get: operations["library_status_api_library_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library Inventory */
        get: operations["library_inventory_api_library_export_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library List */
        get: operations["library_list_api_library_files_get"];
        put?: never;
        /** Library Import */
        post: operations["library_import_api_library_files_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/files/{file_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library Detail */
        get: operations["library_detail_api_library_files__file_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/files/{file_id}/open": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Library Open */
        post: operations["library_open_api_library_files__file_id__open_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/files/{file_id}/paper-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Library Link */
        post: operations["library_link_api_library_files__file_id__paper_links_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/files/{file_id}/text": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Library Read Text */
        get: operations["library_read_text_api_library_files__file_id__text_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library/vault": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Library Create Vault */
        post: operations["library_create_vault_api_library_vault_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lifecycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lifecycle Report
         * @description Recorded lifecycle events, and how much of the corpus they cover.
         */
        get: operations["lifecycle_report_api_lifecycle_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lifecycle/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lifecycle Check
         * @description Start a bounded lifecycle check over the least recently checked papers.
         *
         *     Returns immediately. Poll ``GET /api/lifecycle`` for progress and results.
         */
        post: operations["lifecycle_check_api_lifecycle_check_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lifecycle/for-documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lifecycle For Documents
         * @description Lifecycle events for a page of results, in one round trip.
         *
         *     The Explorer renders fifty papers at a time and needs to badge each one.
         *     Asking per row would be fifty requests to paint one screen; this is one.
         *     Ids with no events are simply absent from the map.
         */
        post: operations["lifecycle_for_documents_api_lifecycle_for_documents_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/lifecycle/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lifecycle Stop
         * @description Ask a running check to stop after its current slice.
         *
         *     Cooperative rather than abrupt: the papers already checked keep their
         *     results, and the rest stay unchecked rather than being recorded as clean.
         */
        post: operations["lifecycle_stop_api_lifecycle_stop_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/collapse-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Links Collapse Preview
         * @description Which of these ids a collapse *would* fold, without folding anything.
         *
         *     The interface asks for this only when the reader has switched collapse on.
         *     It returns a grouping; the rows themselves are untouched and the totals a
         *     page reports are computed without it.
         */
        post: operations["links_collapse_preview_api_links_collapse_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/for-documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Links For Documents
         * @description Links for a page of results in one round trip.
         *
         *     The same shape as ``/api/lifecycle/for-documents`` and for the same reason:
         *     the Explorer renders fifty rows, and fifty requests to badge them is the
         *     thing that endpoint exists to avoid.
         */
        post: operations["links_for_documents_api_links_for_documents_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Links Scan
         * @description Find near-duplicates across the corpus. Returns immediately.
         *
         *     Refused before it starts when there is nothing to compare, rather than
         *     running and reporting zero — "no near-duplicates" and "nothing is embedded"
         *     are different answers and only one of them is about the corpus.
         */
        post: operations["links_scan_api_links_scan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/scan/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Links Scan Cancel
         * @description Stop after the document in flight. Links already written are kept.
         */
        post: operations["links_scan_cancel_api_links_scan_cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Links Status
         * @description How many links are stored, by method, and the scan's state.
         */
        get: operations["links_status_api_links_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/map": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Collection Map
         * @description Where every paper sits on the Atlas plate, and on what basis.
         *
         *     The first call on a collection starts a fit in the background and answers
         *     ``fitting``; later calls answer from the fit, placing papers that arrived
         *     since. See ``collection_map`` for what a position does and does not say.
         */
        get: operations["get_collection_map_api_map_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/onboarding": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Onboarding State
         * @description What the first-run card renders, as facts rather than as prose.
         */
        get: operations["onboarding_state_api_onboarding_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/onboarding/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dismiss Onboarding
         * @description Put the card away for good.
         *
         *     Deliberately not a settings *group*: a group is something the assistant's
         *     ``update_settings`` reaches, and the assistant putting away the user's own
         *     getting-started card is not a write anyone would ask for.
         */
        post: operations["dismiss_onboarding_api_onboarding_dismiss_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Watch Profiles */
        get: operations["list_watch_profiles_api_profiles_get"];
        put?: never;
        /** Create Watch Profile */
        post: operations["create_watch_profile_api_profiles_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Import Watch Profiles
         * @description Import one or more exported profiles.
         *
         *     Reports per profile rather than failing the batch: a file with one bad
         *     entry should import the rest and say which one it could not read, because
         *     the alternative is a user editing JSON to find out which line resmon
         *     objected to.
         */
        post: operations["import_watch_profiles_api_profiles_import_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/matches/for-documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Profile Matches For Documents
         * @description Which watch profiles matched a page of papers, and on what basis.
         *
         *     The Explorer and the Results list render fifty papers at a time and each
         *     one may carry a basis badge. Asking per row would be fifty requests to
         *     paint one screen; this is one — the same shape and the same reason as
         *     ``/api/lifecycle/for-documents``.
         *
         *     Declared **above** ``/api/profiles/{profile_id}`` deliberately. FastAPI
         *     matches in declaration order, and a path parameter declared first swallows
         *     a literal segment after it: ``/api/profiles/starter`` was written below
         *     ``/api/profiles/{profile_id}`` once and three tests failed on it.
         */
        post: operations["profile_matches_for_documents_api_profiles_matches_for_documents_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/starter": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Starter Profiles
         * @description The curated set that ships with the app, not yet anybody's profile.
         *
         *     Served rather than bundled into the renderer so the files stay the one
         *     source: the picker shows what is on disk, and a user who edits or removes
         *     one sees that.
         */
        get: operations["list_starter_profiles_api_profiles_starter_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/{profile_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Watch Profile */
        get: operations["get_watch_profile_api_profiles__profile_id__get"];
        /** Update Watch Profile */
        put: operations["update_watch_profile_api_profiles__profile_id__put"];
        post?: never;
        /**
         * Delete Watch Profile
         * @description Remove a profile and its matches. **The corpus is untouched.**
         *
         *     A routine pointing at this profile is *named* rather than silently orphaned.
         *     There is no foreign key from a routine to a profile — a routine's
         *     configuration is a JSON blob — so the deletion cannot cascade, and the next
         *     fire of such a routine fails with a sentence saying the profile is gone.
         *     Saying which routines those are here is the difference between that being a
         *     surprise and being a consequence.
         */
        delete: operations["delete_watch_profile_api_profiles__profile_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/{profile_id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export Watch Profile */
        get: operations["export_watch_profile_api_profiles__profile_id__export_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/{profile_id}/lifecycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Watch Profile Lifecycle
         * @description Retractions and other lifecycle findings on this profile's papers.
         *
         *     A **join** over findings resmon already holds, never a new claim: the rule
         *     that resmon never asserts a lifecycle event on its own authority is at its
         *     most load-bearing here, because a false retraction attached to a named
         *     person is defamatory. Every finding carries its notice link and every match
         *     carries its basis, so a finding on a `name_only` match is visibly a finding
         *     on a paper that merely has this name on it.
         */
        get: operations["get_watch_profile_lifecycle_api_profiles__profile_id__lifecycle_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/profiles/{profile_id}/matches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Watch Profile Matches
         * @description Papers matched to this profile, **each with the basis it was matched on**.
         *
         *     The basis rides on every row and is never omitted: a list of papers with no
         *     basis is exactly the claim resmon refuses to make.
         */
        get: operations["get_watch_profile_matches_api_profiles__profile_id__matches_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/reading-queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Reading Queue
         * @description One page of saved papers. ``status`` omitted (or ``all``) means both.
         */
        get: operations["list_reading_queue_api_reading_queue_get"];
        put?: never;
        /**
         * Save To Reading Queue
         * @description Save a stored paper. Saving one already saved returns it unchanged.
         *
         *     201 either way: the request's outcome -- this paper is in the queue -- is
         *     the same, and the body carries the entry, so a second click cannot be
         *     mistaken for a state change. ``saved_at`` in that body is the original save
         *     time, which is how a caller can tell the two apart if it needs to.
         */
        post: operations["save_to_reading_queue_api_reading_queue_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/reading-queue/{document_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Reading Queue Status
         * @description Mark a saved paper read or unread.
         */
        put: operations["set_reading_queue_status_api_reading_queue__document_id__put"];
        post?: never;
        /**
         * Remove From Reading Queue
         * @description Take a paper out of the queue. The paper itself is not touched.
         *
         *     404 when there was nothing to remove, because "it is gone" and "it was
         *     never there" are different answers and the second one usually means the
         *     interface is looking at a list somebody else already changed.
         */
        delete: operations["remove_from_reading_queue_api_reading_queue__document_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/renderer/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Renderer Heartbeat
         * @description Renderer-presence ping.
         *
         *     The Electron renderer posts here every few seconds while it is
         *     running. The backend uses the most recent ping to decide whether
         *     to suppress its own desktop-notification dispatch (which would
         *     otherwise duplicate the in-renderer ``new Notification(...)`` and,
         *     on macOS, surface under ``Script Editor`` because it's invoked via
         *     ``osascript``). When the heartbeat is stale (renderer closed), the
         *     backend resumes dispatching so the headless-daemon path still
         *     works.
         */
        post: operations["renderer_heartbeat_api_renderer_heartbeat_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/repositories/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Repositories Catalog
         * @description Return the static repository catalog (never returns secrets).
         */
        get: operations["repositories_catalog_api_repositories_catalog_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore Stage
         * @description Verify a bundle and stage it. The restore itself happens on the next start.
         */
        post: operations["restore_stage_api_restore_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/restore/acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore Acknowledge
         * @description Dismiss the one-time "what a restore did not bring back" card.
         */
        post: operations["restore_acknowledge_api_restore_acknowledge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/restore/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore Cancel
         * @description Forget a staged restore. Nothing had been moved yet, so nothing is undone.
         */
        post: operations["restore_cancel_api_restore_cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/restore/undo-copy/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore Delete Undo
         * @description Delete the database copies a restore set aside. Irreversible, so confirm-gated.
         */
        post: operations["restore_delete_undo_api_restore_undo_copy_delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Routines */
        get: operations["list_routines_api_routines_get"];
        put?: never;
        /** Create Routine */
        post: operations["create_routine_api_routines_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Routine
         * @description Fetch a single routine by ID.
         *
         *     The renderer's notification path needs the per-routine
         *     ``notify_on_complete`` flag to decide whether to fire a desktop
         *     notification under ``notify_automatic_mode == 'selected'``. Without
         *     this endpoint the renderer's fetch silently 404s and the per-routine
         *     opt-in is treated as ``false``, which suppresses notifications even
         *     when the user enabled the per-row toggle.
         */
        get: operations["get_routine_api_routines__routine_id__get"];
        /** Update Routine Endpoint */
        put: operations["update_routine_endpoint_api_routines__routine_id__put"];
        post?: never;
        /** Delete Routine Endpoint */
        delete: operations["delete_routine_endpoint_api_routines__routine_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Activate Routine */
        post: operations["activate_routine_api_routines__routine_id__activate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Routine Coverage
         * @description Is this routine finding what its owner meant, and what is it missing?
         *
         *     Two lists, both scoped to the corpus resmon already holds — which is the one
         *     claim this endpoint is entitled to make, and it returns the sentence saying
         *     so rather than leaving the interface to remember it.
         */
        get: operations["routine_coverage_api_routines__routine_id__coverage_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Deactivate Routine */
        post: operations["deactivate_routine_api_routines__routine_id__deactivate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Routine Deliveries */
        get: operations["list_routine_deliveries_api_routines__routine_id__deliveries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/delivery-targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Routine Delivery Targets */
        get: operations["list_routine_delivery_targets_api_routines__routine_id__delivery_targets_get"];
        put?: never;
        /** Add Routine Delivery Target */
        post: operations["add_routine_delivery_target_api_routines__routine_id__delivery_targets_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/delivery-targets/{target_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Routine Delivery Target */
        put: operations["update_routine_delivery_target_api_routines__routine_id__delivery_targets__target_id__put"];
        post?: never;
        /** Delete Routine Delivery Target */
        delete: operations["delete_routine_delivery_target_api_routines__routine_id__delivery_targets__target_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Routine Documents
         * @description The papers this routine's runs collected: a watch's constellation.
         *
         *     Ids only, newest run first and each paper once, because what a screen does
         *     with them is mark them on the collection map; a page of records is the
         *     Explorer's job. ``total`` counts all of them, so a screen whose ``limit``
         *     cut the list short can say so rather than imply the marks are complete.
         */
        get: operations["routine_documents_api_routines__routine_id__documents_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/routines/{routine_id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run Routine Now
         * @description Run a routine immediately, outside its schedule.
         *
         *     Writing the MCP contract found that resmon had no way to do this at all:
         *     routines could be activated or deactivated, and running one now meant
         *     rebuilding its configuration by hand as a sweep. That is a gap in the
         *     application rather than only in the tool surface -- "run my arXiv routine
         *     now" is something a person should be able to do from the interface too.
         *
         *     Deliberately a thin wrapper over ``_dispatch_routine_fire``, the same
         *     function the scheduler calls, so a manual run and a scheduled fire take one
         *     code path and cannot drift apart. Everything that makes a scheduled fire
         *     correct -- admission control, the routine_id stamp, progress registration,
         *     the last_executed_at update -- applies here for free because it is
         *     literally the same code.
         *
         *     An **inactive** routine does run, and the response says so. ``is_active``
         *     governs whether the scheduler fires a routine on its own; it is not a
         *     statement that the routine may never run. Refusing here would mean a user
         *     has to activate a routine, run it, and deactivate it again to get one
         *     result.
         */
        post: operations["run_routine_now_api_routines__routine_id__run_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scheduler/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Scheduler Jobs */
        get: operations["get_scheduler_jobs_api_scheduler_jobs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scheduler/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Scheduler Status
         * @description Whether this database's active routines will fire, and what decides it.
         *
         *     The Routines page showed **Active** for a routine nothing would ever fire,
         *     and it looked exactly like one that would. The packaged app starts its own
         *     backend with ``RESMON_DISABLE_SCHEDULER=1`` (Update 4 / Fix D) and attaches
         *     to the background service only when that service is live, has a token file
         *     and runs the same version. When it does not attach, nothing fires -- and
         *     ``_record_missed_fires`` never runs, because it runs only where a scheduler
         *     starts, so the missed-fire count stays empty however many fires were
         *     missed. A routine that does not run and a routine that runs and finds
         *     nothing must not look the same; this is what lets the page tell them apart.
         *
         *     **What decides a routine's verdict.** Every released resmon keeps
         *     APScheduler's job store inside the corpus file itself
         *     (``scheduler._DEFAULT_DB_URL`` is built from the same ``DEFAULT_DB_PATH``
         *     the corpus opens), and a scheduler fires only what is in its store. So a
         *     routine with no job in *this* database's store will not fire, whichever
         *     process runs and whichever database it serves -- and activating a routine
         *     in a backend with no scheduler writes no job, because the CRUD sync helpers
         *     return early when ``scheduler is None``. That is the case measured on the
         *     owner's corpus, and it is answered with certainty.
         *
         *     A routine that does have a job here fires only if some live scheduler
         *     serves this file. This backend's own scheduler is known. Another process's
         *     is not: ``/api/health`` reports ``identity.corpus_id``, and it is ``null``
         *     on every version so far, so no running service can be shown to serve this
         *     database. Where one is running, or may be, the verdict is ``None`` --
         *     unconfirmed -- rather than a guess either way. Where no service answers and
         *     none is listening, nothing is running a schedule at all, and the verdict is
         *     ``False``.
         *
         *     The states, for a backend with no scheduler of its own, come from the
         *     daemon-status probe: ``no_service`` / ``service_stopped`` (nothing
         *     answers; unit file absent / present), ``service_other_version`` (a service
         *     answered as a version this app does not attach to),
         *     ``service_elsewhere`` (one of this version answered, and it is another
         *     process), ``service_unreachable`` (the lock names a service that did not
         *     answer cleanly), and ``scheduler_off`` (the lock names this very process,
         *     started with its scheduler turned off). Nothing here starts, stops or
         *     changes a schedule.
         */
        get: operations["scheduler_status_api_scheduler_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/search/dive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search Dive */
        post: operations["search_dive_api_search_dive_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/search/repositories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search Repositories */
        get: operations["search_repositories_api_search_repositories_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/search/sweep": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search Sweep */
        post: operations["search_sweep_api_search_sweep_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/service/daemon-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Service Daemon Status
         * @description Return ground-truth daemon status read from ``daemon.lock``.
         *
         *     Update 4 / Fix E. Unlike ``/api/health`` (which always describes the
         *     *current* backend), this endpoint reads the on-disk daemon lock file
         *     and probes the daemon's actual port. The Advanced tab uses it so that
         *     a renderer-spawned fallback backend cannot masquerade as the daemon.
         *
         *     Response shape::
         *
         *         {
         *           "lock_present": bool,
         *           "running": bool,                # true iff lock present AND health probe succeeds
         *           "pid": int | None,              # from the live health probe
         *           "port": int | None,
         *           "version": str | None,
         *           "started_at": str | None,
         *           "lock_pid": int | None,         # raw lock-file payload (for diagnostics)
         *           "lock_port": int | None,
         *           "lock_version": str | None,
         *           "error": str | None,            # populated when lock_present but probe failed
         *         }
         */
        get: operations["service_daemon_status_api_service_daemon_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/service/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Service Install
         * @description Render the platform unit template and write it to the install path.
         *
         *     ``register=True`` additionally asks the OS service manager to enable the
         *     unit at login (launchctl / systemctl / schtasks).
         */
        post: operations["service_install_api_service_install_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/service/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Service Status
         * @description Return whether the daemon unit file is installed and its path.
         */
        get: operations["service_status_api_service_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/service/uninstall": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Service Uninstall
         * @description Remove the unit file; optionally deregister with the OS first.
         */
        post: operations["service_uninstall_api_service_uninstall_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/ai": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Ai Settings */
        get: operations["get_ai_settings_api_settings_ai_get"];
        /** Update Ai Settings */
        put: operations["update_ai_settings_api_settings_ai_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/ai/cli-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Ai Cli Status
         * @description Report whether each subscription-lane CLI can be found, and where.
         *
         *     Detection only — this never runs the binary, so it cannot say whether
         *     anyone is logged in. That distinction is deliberate and is carried in the
         *     response: a CLI that is present but logged out fails on first use with
         *     ``CLI_AUTH``, and claiming "ready" here would be a promise this endpoint
         *     has not checked.
         *
         *     ``tried`` is returned because "not found" on its own is unhelpful. A
         *     packaged app launched from the Finder searches a far smaller PATH than a
         *     terminal does, so showing the candidate paths is what lets someone see that
         *     resmon looked in the wrong place rather than that their CLI is broken.
         */
        get: operations["get_ai_cli_status_api_settings_ai_cli_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/assistant": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Assistant Settings */
        get: operations["get_assistant_settings_api_settings_assistant_get"];
        /** Update Assistant Settings */
        put: operations["update_assistant_settings_api_settings_assistant_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/cloud": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Cloud Settings */
        get: operations["get_cloud_settings_api_settings_cloud_get"];
        /** Update Cloud Settings */
        put: operations["update_cloud_settings_api_settings_cloud_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Email Settings */
        get: operations["get_email_settings_api_settings_email_get"];
        /** Update Email Settings */
        put: operations["update_email_settings_api_settings_email_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/email/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send Test Email Endpoint
         * @description Send a test email using the currently-stored SMTP settings.
         *
         *     Loads the SMTP config via the same helper used for routine
         *     completion emails (settings table + keychain for the password) and
         *     invokes :func:`email_notifier.send_test_email`. Returns HTTP 400
         *     with a human-readable reason when configuration is incomplete or
         *     the SMTP handshake fails.
         */
        post: operations["send_test_email_endpoint_api_settings_email_test_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/embeddings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Embedding Settings
         * @description The stored settings, plus everything the tab needs to render honestly.
         *
         *     ``providers`` carries a *can embed* answer for every provider resmon lists,
         *     including the ones that cannot, so the interface states the limitation rather
         *     than quietly omitting the option. The evidence string travels with it: a user
         *     reading "Anthropic does not offer an embeddings API" can see what that rests
         *     on.
         */
        get: operations["get_embedding_settings_api_settings_embeddings_get"];
        /**
         * Update Embedding Settings
         * @description Store the settings, refusing a provider that cannot embed.
         *
         *     The refusal is **here**, at configuration, and not at backfill: P8. A user
         *     who picks Anthropic learns it when they pick it, with the reason, rather than
         *     after waiting for a run that was never going to produce anything.
         */
        put: operations["update_embedding_settings_api_settings_embeddings_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/execution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution Settings */
        get: operations["get_execution_settings_api_settings_execution_get"];
        /** Update Execution Settings */
        put: operations["update_execution_settings_api_settings_execution_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Notification Settings */
        get: operations["get_notification_settings_api_settings_notifications_get"];
        /** Update Notification Settings */
        put: operations["update_notification_settings_api_settings_notifications_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/storage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Storage Settings */
        get: operations["get_storage_settings_api_settings_storage_get"];
        /** Update Storage Settings */
        put: operations["update_storage_settings_api_settings_storage_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/today": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Today
         * @description The papers resmon first collected since Today was last looked at, by watch.
         *
         *     See ``today`` for what "new", "looked" and "watch" mean. Reading this does
         *     not mark anything looked at; ``POST /api/today/looked`` does.
         */
        get: operations["get_today_api_today_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/today/looked": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark Today Looked
         * @description Record that Today was looked at now: the next window starts here.
         */
        post: operations["mark_today_looked_api_today_looked_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/watchdog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Watchdog Report
         * @description Findings, what could not be judged yet, and the thresholds used.
         */
        get: operations["watchdog_report_api_watchdog_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/watchdog/mute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Watchdog Mute
         * @description Acknowledge one finding so it stops counting toward the alarm total.
         *
         *     Muting is per finding, never per source or per routine: the mute is dropped
         *     automatically once the condition clears, so the same source failing again
         *     later is reported again.
         */
        post: operations["watchdog_mute_api_watchdog_mute_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/watchdog/unmute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Watchdog Unmute
         * @description Un-acknowledge a finding, returning it to the alarm total.
         */
        post: operations["watchdog_unmute_api_watchdog_unmute_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** AIModelsRequest */
        AIModelsRequest: {
            /** Base Url */
            base_url?: string | null;
            /** Binary Path */
            binary_path?: string | null;
            /** Endpoint */
            endpoint?: string | null;
            /** Header Prefix */
            header_prefix?: string | null;
            /** Key */
            key?: string | null;
            /** Provider */
            provider: string;
        };
        /**
         * ActiveRuns
         * @description ``GET /api/executions/active``: the runs this backend is running now.
         */
        ActiveRuns: {
            /** Active Ids */
            active_ids: number[];
        } & {
            [key: string]: unknown;
        };
        /** AdminConfirmBody */
        AdminConfirmBody: {
            /**
             * Confirm
             * @default
             */
            confirm: string;
        };
        /**
         * AiCliProbe
         * @description One agent CLI, and where resmon looked for it.
         *
         *     ``found`` is detection, never a login check — the endpoint does not run the
         *     binary — and ``login_checked`` is the field that says so out loud. It is
         *     always ``false`` today, and it is in the body rather than in the
         *     documentation because a client that reads ``found`` as "ready" is making a
         *     claim resmon has not checked.
         *
         *     ``path`` and ``how`` are ``None`` on a machine where the CLI is absent,
         *     which is most CI runners; ``tried`` is the candidate list, and it is here
         *     because "not found" alone does not tell a user that resmon looked in the
         *     wrong place.
         */
        AiCliProbe: {
            /** Detail */
            detail: string;
            /** Found */
            found: boolean;
            /** How */
            how: string | null;
            /** Login Checked */
            login_checked: boolean;
            /** Path */
            path: string | null;
            /** Provider */
            provider: string;
            /** Tried */
            tried: string[];
        } & {
            [key: string]: unknown;
        };
        /**
         * AiCliStatus
         * @description ``GET /api/settings/ai/cli-status``.
         */
        AiCliStatus: {
            /** Providers */
            providers: components["schemas"]["AiCliProbe"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * AiKeysErased
         * @description ``POST /api/admin/erase-ai-keys``: every AI provider key slot cleared.
         *
         *     ``ai_keys_removed`` is the number of AI provider key names cleared. A name
         *     that held no key counts too, and the legacy ``ai_api_key`` slot is cleared
         *     without being counted. This route takes no ``confirm``.
         */
        AiKeysErased: {
            /** Ai Keys Removed */
            ai_keys_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * AiSettings
         * @description ``GET /api/settings/ai`` — the AI lane, as sixteen stored strings.
         *
         *     ``ai_chain`` and ``ai_default_models`` are JSON *documents* stored as text,
         *     and they are declared ``str`` here because that is what the endpoint
         *     answers: the renderer parses them. Declaring them as objects would be this
         *     contract describing a shape the route does not send.
         */
        AiSettings: {
            /** Ai Chain */
            ai_chain: string;
            /** Ai Cli Path */
            ai_cli_path: string;
            /** Ai Custom Base Url */
            ai_custom_base_url: string;
            /** Ai Custom Header Prefix */
            ai_custom_header_prefix: string;
            /** Ai Default Models */
            ai_default_models: string;
            /** Ai Effort */
            ai_effort: string;
            /** Ai Extraction Goals */
            ai_extraction_goals: string;
            /** Ai Local Endpoint */
            ai_local_endpoint: string;
            /** Ai Local Model */
            ai_local_model: string;
            /** Ai Model */
            ai_model: string;
            /** Ai Provider */
            ai_provider: string;
            /** Ai Show Audit Prefix */
            ai_show_audit_prefix: string;
            /** Ai Subscription Doc Cap */
            ai_subscription_doc_cap: string;
            /** Ai Summary Length */
            ai_summary_length: string;
            /** Ai Temperature */
            ai_temperature: string;
            /** Ai Tone */
            ai_tone: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AnalyticsOverview
         * @description ``GET /api/analytics/overview``: the five views in one round trip.
         */
        AnalyticsOverview: {
            discovery_lag: components["schemas"]["DiscoveryLag"];
            publication_volume: components["schemas"]["PublicationVolume"];
            routine_health: components["schemas"]["RoutineHealth"];
            source_contribution: components["schemas"]["SourceContribution"];
            summary: components["schemas"]["CorpusSummary"];
        } & {
            [key: string]: unknown;
        };
        /**
         * AppDataErased
         * @description ``POST /api/admin/erase-app-data``: papers, configurations, runs, and every AI and repository key.
         *
         *     Settings, the SMTP password and the Library's files are kept. The key
         *     counts are of names cleared, not keys found.
         */
        AppDataErased: {
            /** Ai Keys Removed */
            ai_keys_removed: number;
            /** Configs Removed */
            configs_removed: number;
            /** Documents Removed */
            documents_removed: number;
            /** Executions Removed */
            executions_removed: number;
            /** Repo Keys Removed */
            repo_keys_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * Appearance
         * @description ``GET`` and ``PUT /api/appearance``: the theme and the accent chosen.
         *
         *     ``accent`` is a lowercase ``#rrggbb``, or null when none has been chosen and
         *     the interface draws its own default. The PUT answers what it stored, so a
         *     caller can see the lowercasing rather than assume it.
         */
        Appearance: {
            /** Accent */
            accent: string | null;
            /**
             * Theme
             * @enum {string}
             */
            theme: "system" | "light" | "dark";
        } & {
            [key: string]: unknown;
        };
        /**
         * AppearanceBody
         * @description The whole appearance, every time: a PUT replaces both values.
         */
        AppearanceBody: {
            /** Accent */
            accent: string | null;
            /**
             * Theme
             * @enum {string}
             */
            theme: "system" | "light" | "dark";
        };
        /**
         * AssistantActivity
         * @description What this process saw of a conversation when the request arrived.
         *
         *     Observed separately from the transcript and not atomic with it, which
         *     ``basis`` says. ``turn_claimed`` is whether a turn holds the
         *     conversation's event bus, and ``cli_running`` whether a CLI process is
         *     alive for it. Both are this process's memory and say nothing about
         *     another process.
         */
        AssistantActivity: {
            /** Basis */
            basis: string;
            /** Cli Running */
            cli_running: boolean;
            /** Observed At Utc */
            observed_at_utc: string;
            /** Turn Claimed */
            turn_claimed: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantChoices
         * @description A conversation's saved choices: the request every turn makes, and when it was fixed.
         */
        AssistantChoices: {
            /** Binding Basis */
            binding_basis: string;
            /** Created At Utc */
            created_at_utc: string;
            /** Effort Basis */
            effort_basis: string;
            /** Model Basis */
            model_basis: string;
            /** Provider */
            provider: string;
            /** Requested Effort */
            requested_effort: string | null;
            /** Requested Model */
            requested_model: string | null;
            /** Runtime */
            runtime: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantComposerChoices
         * @description What the composer may ask for: connections, Claude model aliases and effort levels.
         *
         *     ``default_request`` is ``None``, and ``default_error`` says why, when the
         *     stored settings do not make a valid choice. The aliases are suggestions:
         *     the CLI decides at use time whether it accepts one, and ``limitations``
         *     says so in the words the composer shows.
         */
        AssistantComposerChoices: {
            /** Claude Aliases */
            claude_aliases: string[];
            /** Claude Efforts */
            claude_efforts: string[];
            /** Connections */
            connections: components["schemas"]["AssistantConnection"][];
            /** Default Error */
            default_error: string | null;
            default_request: components["schemas"]["AssistantDefaultRequest"] | null;
            /** Limitations */
            limitations: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantConnection
         * @description One connection the composer can offer.
         *
         *     ``runtime`` is ``None``, and ``implemented`` false, for a provider resmon
         *     lists but has no assistant for (Ollama, Codex). ``family`` is the request
         *     shape resmon's own loop builds and is present only on API-key
         *     connections. ``available`` checks local prerequisites only, an executable
         *     found or a key stored, never sign-in or whether a model is accepted.
         */
        AssistantConnection: {
            /** Available */
            available: boolean;
            /** Effort Supported */
            effort_supported: boolean;
            /** Family */
            family?: string | null;
            /** Implemented */
            implemented: boolean;
            /** Label */
            label: string;
            /** Provider */
            provider: string;
            /** Reason */
            reason: string;
            /** Runtime */
            runtime: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantDefaultRequest
         * @description The choice a new conversation gets from Settings when it names none.
         *
         *     ``model`` and ``effort`` are ``None`` when Settings leaves them to the
         *     runtime, whose own default resmon does not know.
         */
        AssistantDefaultRequest: {
            /** Effort */
            effort: string | null;
            /** Model */
            model: string | null;
            /** Provider */
            provider: string;
            /** Runtime */
            runtime: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantExport
         * @description ``GET /api/assistant/sessions/{session_id}/export``: a saved conversation as a file's text.
         *
         *     ``format`` is ``json`` or ``markdown``. ``text`` is the whole file, at most
         *     8 MiB, and carries its own limitations: persisted messages only, and
         *     completion unknown. ``filename`` and ``content_type`` are for saving it;
         *     the backend writes no file. ``snapshot`` is the read it was taken from.
         */
        AssistantExport: {
            /** Content Type */
            content_type: string;
            /** Filename */
            filename: string;
            /** Format */
            format: string;
            /** Session Id */
            session_id: number;
            snapshot: components["schemas"]["AssistantSnapshot"];
            /** Text */
            text: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantMessage
         * @description One stored message: ``user``, ``assistant``, or ``system`` for a notice shown during a turn.
         *
         *     ``tool_calls`` and ``tool_results`` are the JSON stored with an assistant
         *     message, parsed and otherwise untouched: a list, ``None`` when the turn
         *     used no tool, or ``{"unreadable": true}`` when the stored text does not
         *     parse. They are ``Any`` rather than a list of models because the column
         *     holds whatever a runtime returned, in the shape the version that wrote it
         *     used, and a typed list would turn such a row into a 500 where it is a
         *     transcript today. An ``Any`` value is written by pydantic's serializer,
         *     not ``jsonable_encoder``; for parsed JSON the two agree, and the parse
         *     refuses ``NaN`` and ``Infinity``, so the module docstring's non-finite
         *     case is reachable only through an out-of-range literal such as ``1e999``
         *     in a hand-edited row. Tool data can hold sensitive text and is returned
         *     as stored.
         *
         *     The tokens and ``cost_usd`` are what the runtime reported for the turn,
         *     ``None`` where it reported nothing. A reported cost does not establish
         *     what was billed.
         */
        AssistantMessage: {
            /** Content */
            content: string;
            /** Cost Usd */
            cost_usd: number | null;
            /** Created At */
            created_at: string;
            /** Id */
            id: number;
            /** Input Tokens */
            input_tokens: number | null;
            /** Output Tokens */
            output_tokens: number | null;
            /** Role */
            role: string;
            /** Tool Calls */
            tool_calls: unknown;
            /** Tool Results */
            tool_results: unknown;
        } & {
            [key: string]: unknown;
        };
        /** AssistantMessageBody */
        AssistantMessageBody: {
            /** Legacy Adoption */
            legacy_adoption?: {
                [key: string]: unknown;
            } | null;
            /** Text */
            text: string;
        };
        /**
         * AssistantModelReport
         * @description A model name a runtime reported during a turn, where it reported it, and when.
         *
         *     ``source`` names the field it came from, such as
         *     ``claude_system_init_model``. It is what the runtime said, kept beside the
         *     request and never merged with it. No runtime reports effort.
         */
        AssistantModelReport: {
            /** Model */
            model: string;
            /** Observed At Utc */
            observed_at_utc: string;
            /** Sequence */
            sequence: number;
            /** Source */
            source: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantOtherRuntime
         * @description A runtime Settings does not select, listed with its reason rather than left out.
         *
         *     The first entry is the other of resmon's two runtimes and the second is
         *     the Codex CLI, which is never available. ``installed`` is not a finding
         *     to rely on in either. On the first it is always true, whatever was found.
         *     On the Codex entry it is whether an executable sits where Codex is looked
         *     for, and when an agent-CLI path is configured that path is the only place
         *     looked, so a configured Claude CLI makes Codex read as installed.
         *     ``available`` and ``reason`` are the fields to read.
         */
        AssistantOtherRuntime: {
            /** Available */
            available: boolean;
            /** Installed */
            installed: boolean;
            /** Kind */
            kind: string;
            /** Reason */
            reason: string;
        } & {
            [key: string]: unknown;
        };
        /** AssistantPermissionAnswer */
        AssistantPermissionAnswer: {
            /** Allow */
            allow: boolean;
            /** Reason */
            reason?: string | null;
        };
        /**
         * AssistantPermissionAnswered
         * @description ``POST /api/assistant/permissions/{request_id}``: the panel's Allow or Deny, recorded once.
         *
         *     A second answer to the same request is a 409, so ``decision`` is the one
         *     that stands.
         */
        AssistantPermissionAnswered: {
            /** Decision */
            decision: string;
            /** Request Id */
            request_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantPermissionDecision
         * @description ``POST /api/assistant/permissions``: the answer the permission server hands the CLI.
         *
         *     Called by ``assistant_permission_server.py``, not the renderer, and held
         *     open until the person answers or five minutes pass. ``decision`` is
         *     ``allow`` or ``deny``; a timeout, a panel that was not open to ask, and a
         *     cancelled conversation all deny, and ``message`` says which.
         */
        AssistantPermissionDecision: {
            /** Decision */
            decision: string;
            /** Message */
            message: string;
            /** Request Id */
            request_id: string;
        } & {
            [key: string]: unknown;
        };
        /** AssistantPermissionOpen */
        AssistantPermissionOpen: {
            /**
             * Input
             * @default {}
             */
            input: {
                [key: string]: unknown;
            };
            /** Session Id */
            session_id: number;
            /** Tool Name */
            tool_name: string;
            /** Tool Use Id */
            tool_use_id?: string | null;
        };
        /**
         * AssistantRequested
         * @description What a turn asked a runtime for, which is not what the runtime used.
         *
         *     ``requested_model`` and ``requested_effort`` are ``None`` when the request
         *     left the choice to the runtime. Each ``*_basis`` says where a choice came
         *     from: ``explicit``, ``settings_default``, ``runtime_default``, or, for
         *     effort on an API key, ``not_supported``. ``binding_basis`` is ``new``, or
         *     ``legacy_confirmed`` for a conversation saved before choices were, whose
         *     next turn the person confirmed.
         */
        AssistantRequested: {
            /** Binding Basis */
            binding_basis: string;
            /** Effort Basis */
            effort_basis: string;
            /** Model Basis */
            model_basis: string;
            /** Provider */
            provider: string;
            /** Requested Effort */
            requested_effort: string | null;
            /** Requested Model */
            requested_model: string | null;
            /** Runtime */
            runtime: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantRuntimeStatus
         * @description Whether the runtime Settings selects can take a turn, and why or why not, in one sentence.
         *
         *     ``path`` is where the Claude CLI executable was found and ``how`` how it
         *     was found (``configured``, ``known-location``, ``path``); an available
         *     API-key runtime has no path and says ``api_key``. Both are ``None`` when
         *     the runtime is not available. A found executable is not a sign-in and a
         *     stored key is not an accepted one: ``available`` says a turn can be
         *     attempted, not that it will be answered.
         */
        AssistantRuntimeStatus: {
            /** Available */
            available: boolean;
            /** How */
            how: string | null;
            /** Kind */
            kind: string;
            /** Path */
            path: string | null;
            /** Reason */
            reason: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSession
         * @description ``POST /api/assistant/sessions`` (201): one conversation.
         *
         *     ``cli_session_id`` is the id resmon hands the Claude CLI to resume, and
         *     ``None`` on the API-key runtime, which keeps no session of its own.
         *     ``model`` is the model the conversation asked for, ``None`` for the
         *     runtime's default. ``title`` is the one given at creation, else the
         *     first message's opening words, else ``New conversation``. ``choices`` is
         *     ``None`` for a conversation saved before choices were (schema 15), which
         *     cannot send again until the person confirms new ones.
         */
        AssistantSession: {
            /** Choices */
            choices: components["schemas"]["AssistantChoices"] | components["schemas"]["AssistantUnreadable"] | null;
            /** Cli Session Id */
            cli_session_id: string | null;
            /** Created At */
            created_at: string;
            /** Id */
            id: number;
            /** Model */
            model: string | null;
            /** Runtime */
            runtime: string;
            /** Title */
            title: string;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSessionBrowsed
         * @description One conversation in a browse page.
         *
         *     Not an ``AssistantSession``: a browse row carries no ``cli_session_id``
         *     and orders its keys differently, and one model cannot keep both orders.
         */
        AssistantSessionBrowsed: {
            /** Choices */
            choices: components["schemas"]["AssistantChoices"] | components["schemas"]["AssistantUnreadable"] | null;
            /** Created At */
            created_at: string;
            /** Id */
            id: number;
            /** Message Count */
            message_count: number;
            /** Model */
            model: string | null;
            /** Runtime */
            runtime: string;
            /** Title */
            title: string;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /** AssistantSessionCreate */
        AssistantSessionCreate: {
            /** Choices */
            choices?: {
                [key: string]: unknown;
            } | null;
            /** Title */
            title?: string | null;
        };
        /**
         * AssistantSessionDeleted
         * @description ``DELETE /api/assistant/sessions/{session_id}``: the conversation, its messages and its choices are gone.
         */
        AssistantSessionDeleted: {
            /** Deleted */
            deleted: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSessionListed
         * @description One conversation in ``GET /api/assistant/sessions``.
         *
         *     ``cost_usd`` is the sum of the costs its runtime reported, ``None`` when
         *     no turn reported one. Turns that reported nothing add nothing to the sum,
         *     so it can be a partial total; the conversation's own ``totals`` says how
         *     many turns it covers.
         */
        AssistantSessionListed: {
            /** Choices */
            choices: components["schemas"]["AssistantChoices"] | components["schemas"]["AssistantUnreadable"] | null;
            /** Cli Session Id */
            cli_session_id: string | null;
            /** Cost Usd */
            cost_usd: number | null;
            /** Created At */
            created_at: string;
            /** Id */
            id: number;
            /** Message Count */
            message_count: number;
            /** Model */
            model: string | null;
            /** Runtime */
            runtime: string;
            /** Title */
            title: string;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSessionPage
         * @description ``GET /api/assistant/sessions/browse``: conversations newest created first, a page at a time.
         *
         *     ``through_id`` fixes which conversations the paging covers, so one created
         *     while paging does not shift the pages; it fixes the ids, not what the rows
         *     say. ``next_before_id`` is the next page's cursor, ``None`` on the last.
         */
        AssistantSessionPage: {
            /** Has More */
            has_more: boolean;
            /** Next Before Id */
            next_before_id: number | null;
            /** Sessions */
            sessions: components["schemas"]["AssistantSessionBrowsed"][];
            /** Through Id */
            through_id: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSessions
         * @description ``GET /api/assistant/sessions``: at most ``limit`` conversations, most recently active first.
         */
        AssistantSessions: {
            /** Sessions */
            sessions: components["schemas"]["AssistantSessionListed"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSettings
         * @description ``GET /api/settings/assistant``.
         */
        AssistantSettings: {
            /** Assistant Effort */
            assistant_effort: string;
            /** Assistant Model */
            assistant_model: string;
            /** Assistant Provider */
            assistant_provider: string;
            /** Assistant Runtime */
            assistant_runtime: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantSnapshot
         * @description The SQLite read a transcript or an export was taken from.
         *
         *     ``basis`` is ``persisted_messages_only``: a turn still streaming is not in
         *     it. ``last_message_id`` is ``None`` for a conversation with no messages.
         */
        AssistantSnapshot: {
            /** Basis */
            basis: string;
            /** Captured At Utc */
            captured_at_utc: string;
            /** Last Message Id */
            last_message_id: number | null;
            /** Message Count */
            message_count: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantStatus
         * @description ``GET /api/assistant/status``: whether the assistant can run, and every runtime it considered.
         *
         *     ``runtime`` is the one Settings selects, and ``available`` and ``reason``
         *     repeat its own. ``others`` lists the rest with their reasons, Codex
         *     included, because a runtime left out reads as one resmon never noticed.
         *     ``model`` and ``effort`` are what Settings asks for, not what a runtime
         *     uses; ``None`` or empty means none is set, and an API-key runtime has no
         *     effort at all. ``contract_version`` is the MCP contract's version, or
         *     ``unknown`` when the server module cannot be imported.
         */
        AssistantStatus: {
            /** Available */
            available: boolean;
            composer_choices: components["schemas"]["AssistantComposerChoices"];
            /** Contract Version */
            contract_version: string;
            /** Effort */
            effort: string | null;
            /** Kinds */
            kinds: string[];
            /** Model */
            model: string | null;
            /** Others */
            others: components["schemas"]["AssistantOtherRuntime"][];
            /** Provider */
            provider: string;
            /** Provider Source */
            provider_source: string;
            /** Reason */
            reason: string;
            runtime: components["schemas"]["AssistantRuntimeStatus"];
            tool_calling: components["schemas"]["AssistantToolCalling"];
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantToolCalling
         * @description The selected provider's tool calling, as two separate facts.
         *
         *     ``state`` is about the provider's own API (``yes``, ``no`` or
         *     ``unknown``); ``assistant`` is whether resmon's assistant drives it
         *     (``api_key_runtime``, ``cli_runtime`` or ``no``). A provider can support
         *     tool calling that resmon does not use, so the two are never merged.
         */
        AssistantToolCalling: {
            /** Assistant */
            assistant: string;
            /** Assistant Reason */
            assistant_reason: string;
            /** Reason */
            reason: string;
            /** State */
            state: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantTotals
         * @description What a conversation's assistant turns reported, summed.
         *
         *     ``reported_turns`` counts the ``turns`` that reported a cost, and is what
         *     says whether ``cost_usd`` is a total or a partial one. Each sum is
         *     ``None`` when no turn reported that figure.
         */
        AssistantTotals: {
            /** Cost Usd */
            cost_usd: number | null;
            /** Input Tokens */
            input_tokens: number | null;
            /** Output Tokens */
            output_tokens: number | null;
            /** Reported Turns */
            reported_turns: number;
            /** Turns */
            turns: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantTranscript
         * @description ``GET /api/assistant/sessions/{session_id}``: a conversation as one SQLite read, and what is running now.
         *
         *     ``session`` through ``turn_choices`` come from one read snapshot;
         *     ``running`` and ``activity_observation`` are observed afterwards and are
         *     not atomic with it. ``running`` is ``activity_observation.cli_running``.
         */
        AssistantTranscript: {
            activity_observation: components["schemas"]["AssistantActivity"];
            /** Choices Version */
            choices_version: number;
            /** Messages */
            messages: components["schemas"]["AssistantMessage"][];
            /** Running */
            running: boolean;
            session: components["schemas"]["AssistantSession"];
            snapshot: components["schemas"]["AssistantSnapshot"];
            totals: components["schemas"]["AssistantTotals"];
            /** Turn Choices */
            turn_choices: components["schemas"]["AssistantTurnChoices"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantTurnCancelled
         * @description ``POST /api/assistant/sessions/{session_id}/cancel``. Idempotent, and it says which happened.
         *
         *     ``cancelled`` is true only when a Claude CLI process running for the
         *     conversation was killed. An API-key turn runs no such process, so the
         *     answer is false whether or not one is running. ``permissions_denied``
         *     counts the approval cards still waiting for the conversation, now denied.
         */
        AssistantTurnCancelled: {
            /** Cancelled */
            cancelled: boolean;
            /** Permissions Denied */
            permissions_denied: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantTurnChoices
         * @description One turn's request, and the reports its runtime made, kept apart.
         *
         *     ``assistant_message_id`` is ``None`` until an answer is stored, and stays
         *     so for a turn that never got one. ``requested`` and ``reported`` are each
         *     ``AssistantUnreadable`` when their stored JSON fails validation, and both
         *     are, with ``assistant_message_id`` cleared, when the row points at
         *     messages outside this conversation.
         */
        AssistantTurnChoices: {
            /** Assistant Message Id */
            assistant_message_id: number | null;
            /** Created At Utc */
            created_at_utc: string;
            /** Reported */
            reported: components["schemas"]["AssistantModelReport"][] | components["schemas"]["AssistantUnreadable"];
            /** Requested */
            requested: components["schemas"]["AssistantRequested"] | components["schemas"]["AssistantUnreadable"];
            /** User Message Id */
            user_message_id: number;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * AssistantUnreadable
         * @description A stored value resmon could not read, said so rather than dropped or guessed.
         *
         *     It stands in for a conversation's choices, a turn's request, or a turn's
         *     reports when the stored row fails validation on the way out: a row a
         *     future version wrote, or a hand-edited database. The rest of the
         *     conversation still reads; only that part is withheld. It is its own model,
         *     in a union with the readable one, so a typed client has to tell the two
         *     apart before it reads a field, and ``unreadable`` is the only key it has.
         */
        AssistantUnreadable: {
            /**
             * Unreadable
             * @constant
             */
            unreadable: true;
        } & {
            [key: string]: unknown;
        };
        /**
         * BackupExclusions
         * @description What a bundle deliberately does not carry.
         *
         *     ``credentials`` names the keyring entries this machine held when the
         *     backup ran, names only and never a value; a restore cannot bring them
         *     back. A name the keyring would not answer for is left out, so the list can
         *     be short. ``process_state`` names files that exist only while a backend
         *     runs. ``state_dir`` is the state directory the backup ran with, or
         *     ``None``.
         */
        BackupExclusions: {
            /** Credentials */
            credentials: string[];
            /** Note */
            note: string;
            /** Process State */
            process_state: string[];
            /** State Dir */
            state_dir: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * BackupFile
         * @description One file a bundle carries: its path inside the bundle, its size in bytes, and its SHA-256.
         */
        BackupFile: {
            /** Path */
            path: string;
            /** Sha256 */
            sha256: string;
            /** Size */
            size: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * BackupLast
         * @description ``GET /api/backup/last``: the last bundle, a staged restore, the last restore's record, and the undo copies.
         *
         *     ``last_backup`` is ``None`` when no backup is recorded, or when the
         *     recorded bundle's manifest is gone or unreadable;
         *     ``last_backup_path_recorded`` is the recorded path either way, ``None``
         *     when there is none. ``pending_restore`` is the staged pointer, its
         *     unreadable form, or ``None``; ``pending_restore_runs_when`` is the sentence
         *     on what will apply it, ``None`` when nothing is staged. ``last_restore``
         *     is the record of the last restore a start acted on, applied or refused,
         *     and ``None`` when there is none or its file is not a JSON object.
         *     ``undo_copies`` lists the folders restores set aside, sorted by name,
         *     which is the UTC time each was made.
         *
         *     A pointer or record edited by hand into a shape no resmon wrote matches
         *     neither model of its union, and this route then answers 500 rather than a
         *     body.
         */
        BackupLast: {
            last_backup: components["schemas"]["BackupSummary"] | null;
            /** Last Backup Path Recorded */
            last_backup_path_recorded: string | null;
            /** Last Restore */
            last_restore: components["schemas"]["RestoreSucceeded"] | components["schemas"]["RestoreFailed"] | null;
            /** Pending Restore */
            pending_restore: components["schemas"]["RestorePointer"] | components["schemas"]["RestorePointerUnreadable"] | null;
            /** Pending Restore Runs When */
            pending_restore_runs_when: string | null;
            /** Undo Copies */
            undo_copies: string[];
        } & {
            [key: string]: unknown;
        };
        /**
         * BackupManifest
         * @description A bundle's manifest as ``POST /api/backup`` returns it: what was written.
         *
         *     Everything up to ``elapsed_seconds`` is what ``manifest.json`` in the
         *     bundle holds; the file stores it with its keys sorted. ``path``,
         *     ``manifest_sha256`` and ``fk_violations_message`` are added after the
         *     file is written. The table counts and the foreign-key findings are read
         *     from the bundle's own snapshot of the database, not the live one. A
         *     manifest records what was written and the hashes taken as it was written;
         *     it does not show that a restore will succeed.
         *     ``POST /api/backup/verify`` recomputes the hashes, and a restore runs its
         *     own checks when it applies.
         *
         *     ``vault_id`` is ``None`` when no Library vault is configured, and the
         *     bundle then carries no vault. ``includes_reports`` is whether reports were
         *     asked for; a reports folder that is missing or empty adds no files and
         *     still reads true. ``table_counts`` maps each application table to its row
         *     count; a table that could not be counted is left out, and
         *     ``table_count_denominator`` is how many were counted. ``fk_violations``
         *     lists at most 100 references, ``fk_violations_total`` counts all of them,
         *     and ``fk_violations_rows`` counts the distinct rows SQLite identified them
         *     by. ``fk_violations_message`` is ``""`` when there are none.
         *     ``elapsed_seconds`` is how long the backup took, to the millisecond.
         */
        BackupManifest: {
            /** App Version */
            app_version: string;
            /** Created At Utc */
            created_at_utc: string;
            /** Elapsed Seconds */
            elapsed_seconds: number;
            excluded: components["schemas"]["BackupExclusions"];
            /** Files */
            files: components["schemas"]["BackupFile"][];
            /** Fk Violations */
            fk_violations: components["schemas"]["ForeignKeyViolation"][];
            /** Fk Violations Message */
            fk_violations_message: string;
            /** Fk Violations Rows */
            fk_violations_rows: number;
            /** Fk Violations Total */
            fk_violations_total: number;
            /** Includes Reports */
            includes_reports: boolean;
            /** Manifest Sha256 */
            manifest_sha256: string;
            /** Manifest Version */
            manifest_version: number;
            /** Path */
            path: string;
            /** Schema Version */
            schema_version: number;
            /** Table Count Denominator */
            table_count_denominator: number;
            /** Table Counts */
            table_counts: {
                [key: string]: number;
            };
            /** Vault Id */
            vault_id: string | null;
        } & {
            [key: string]: unknown;
        };
        /** BackupRequest */
        BackupRequest: {
            /**
             * Confirm
             * @default
             */
            confirm: string;
            /**
             * Include Reports
             * @default true
             */
            include_reports: boolean;
        };
        /**
         * BackupSummary
         * @description The last bundle this resmon recorded writing, read from that bundle's manifest during the request.
         *
         *     ``files`` is the number of files the manifest lists. Nothing is re-hashed
         *     here, so a bundle damaged since it was written reads the same; only
         *     ``POST /api/backup/verify`` checks the bytes. The other fields are the
         *     manifest's own values, ``None`` where it records none.
         *     ``fk_violations_total`` is ``0`` when the manifest records none, and
         *     ``fk_violations_rows`` is ``None`` for a bundle written before resmon
         *     counted rows.
         */
        BackupSummary: {
            /** App Version */
            app_version: string | null;
            /** Created At Utc */
            created_at_utc: string | null;
            /** Files */
            files: number;
            /** Fk Violations Rows */
            fk_violations_rows: number | null;
            /** Fk Violations Total */
            fk_violations_total: number;
            /** Includes Reports */
            includes_reports: boolean | null;
            /** Path */
            path: string;
            /** Schema Version */
            schema_version: number | null;
            /** Vault Id */
            vault_id: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * BackupWritten
         * @description ``POST /api/backup``: one bundle written, and its manifest.
         *
         *     ``path`` is the bundle's folder, ``resmon-backup-<UTC stamp>``, inside the
         *     export directory Settings names, or inside the operating system's
         *     temporary folder when Settings names none. It is also recorded as the last
         *     backup.
         */
        BackupWritten: {
            manifest: components["schemas"]["BackupManifest"];
            /** Path */
            path: string;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /** Body_import_configurations_api_configurations_import_post */
        Body_import_configurations_api_configurations_import_post: {
            /** Files */
            files: string[];
        };
        /** BundleBody */
        BundleBody: {
            /**
             * Path
             * @default
             */
            path: string;
        };
        /**
         * BundleReport
         * @description ``POST /api/backup/verify``: every hash in a bundle recomputed, and what a restore would and would not do.
         *
         *     It changes nothing. ``ok`` is true when ``problems`` is empty: every file
         *     the manifest names is present at its recorded size and hash, the layout is
         *     a version this resmon reads, and the schema is not newer than this
         *     resmon's. That is the bundle agreeing with its own manifest; it is not a
         *     restore that has succeeded, and the restore verifies again and runs its own
         *     checks when a start applies it.
         *
         *     ``manifest`` is the bundle's ``manifest.json`` exactly as read, keys
         *     sorted as the file stores them. It is declared ``dict`` because its shape
         *     is whatever the file holds: this route reads a folder the person chose,
         *     which need not hold a bundle this resmon wrote, and reports what is wrong
         *     with it rather than failing. For a bundle this version wrote it holds
         *     ``BackupManifest``'s fields except the three added after the file was
         *     written, and one resmon 2.3.0 wrote has no ``fk_violations_rows``.
         *     Python's JSON parser accepts ``NaN`` and ``Infinity``, so one written
         *     into a manifest by hand, where the handler only copies it, is answered
         *     here as ``null`` where the route answered 500 before it was modeled.
         *     ``manifest_sha256`` is the hash of the file itself.
         *
         *     ``files_checked`` counts the files that matched and ``files_in_manifest``
         *     the files listed. ``schema_relation`` compares the bundle's schema with
         *     this resmon's: ``same``, ``older``, ``newer`` (a problem) or ``unknown``
         *     (a problem). ``vault_relation`` compares the bundle's vault with the one
         *     configured here: ``same``, ``different``, ``none_configured`` or
         *     ``none_in_backup``.
         *
         *     The foreign-key fields come from the manifest: ``fk_violations`` as listed
         *     there, hence ``Any``; ``fk_violations_total`` as an integer;
         *     ``fk_violations_rows`` ``None`` for a bundle written before resmon counted
         *     rows. Orphan rows never make ``ok`` false; ``needs_fk_acceptance`` says a
         *     restore must be told to accept them. ``vault_destination`` is ``None``
         *     when the bundle carries no vault or its database records no vault path.
         */
        BundleReport: {
            /** Files Checked */
            files_checked: number;
            /** Files In Manifest */
            files_in_manifest: number;
            /** Fk Violations */
            fk_violations: unknown[];
            /** Fk Violations Message */
            fk_violations_message: string;
            /** Fk Violations Rows */
            fk_violations_rows: number | null;
            /** Fk Violations Total */
            fk_violations_total: number;
            /** Manifest */
            manifest: {
                [key: string]: unknown;
            };
            /** Manifest Sha256 */
            manifest_sha256: string;
            /** Needs Fk Acceptance */
            needs_fk_acceptance: boolean;
            /** Ok */
            ok: boolean;
            /** Path */
            path: string;
            /** Problems */
            problems: string[];
            /** Schema Relation */
            schema_relation: string;
            vault_destination: components["schemas"]["BundleVaultDestination"] | null;
            /** Vault Relation */
            vault_relation: string;
            will_not_restore: components["schemas"]["BundleWillNotRestore"];
        } & {
            [key: string]: unknown;
        };
        /**
         * BundleVaultDestination
         * @description Where a restore would put the bundle's vault on this machine by default, and whether that folder is usable.
         *
         *     ``root_path`` is the vault path the bundle's own database records,
         *     ``parent`` the folder that would hold it and ``name`` its folder name.
         *     ``parent_exists`` and ``parent_writable`` are checked on this machine
         *     during the request. A missing parent is the ordinary case for a bundle
         *     from another machine and is not a problem: a restore can be given another
         *     parent.
         */
        BundleVaultDestination: {
            /** Name */
            name: string;
            /** Parent */
            parent: string;
            /** Parent Exists */
            parent_exists: boolean;
            /** Parent Writable */
            parent_writable: boolean;
            /** Root Path */
            root_path: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * BundleWillNotRestore
         * @description What a restore of this bundle will not bring back.
         *
         *     ``credentials`` and ``process_state`` are copied from the bundle's
         *     manifest as the handler finds them, which is why they are ``Any``: for a
         *     bundle resmon wrote, both are lists of names. ``note`` is fixed text about
         *     runs that were running and deliveries that were being sent.
         */
        BundleWillNotRestore: {
            /** Credentials */
            credentials: unknown[];
            /** Note */
            note: string;
            /** Process State */
            process_state: unknown[];
        } & {
            [key: string]: unknown;
        };
        /**
         * CalendarEvent
         * @description One event of ``GET /api/calendar/events``: a run that happened, or a fire
         *     a routine's schedule promises.
         *
         *     A run's ``id`` is its execution id; a promised fire's is a string naming
         *     the routine and the time (``routine-3-2026-10-29T09:00:00-04:00``) and its
         *     ``status`` is ``scheduled``. Promised fires are expanded only for active
         *     routines, from now to a year ahead, in the machine's own timezone.
         *     ``saved_configuration_id`` and ``saved_configuration_name`` are present on
         *     runs only.
         */
        CalendarEvent: {
            /** Allday */
            allDay: boolean;
            /** Color */
            color: string;
            /** End */
            end: string;
            /** Execution Id */
            execution_id: number | null;
            /** Id */
            id: number | string;
            /** New Results */
            new_results: number | null;
            /** Query */
            query: string | null;
            /** Routine Id */
            routine_id: number | null;
            /** Saved Configuration Id */
            saved_configuration_id?: number | null;
            /** Saved Configuration Name */
            saved_configuration_name?: string | null;
            /** Start */
            start: string;
            /** Status */
            status: string;
            /** Title */
            title: string;
            /** Total Results */
            total_results: number | null;
            /** Type */
            type: string;
        } & {
            [key: string]: unknown;
        };
        /** CloudBackup */
        CloudBackup: {
            /** Execution Ids */
            execution_ids?: number[] | null;
        };
        /**
         * CloudBackupUploaded
         * @description ``POST /api/cloud/backup``: what one upload of the reports folder to Google Drive reported.
         *
         *     The whole reports folder is uploaded into a ``backup-<local timestamp>``
         *     folder under ``resmon`` in the person's Drive. It is the reports folder
         *     only: not the database and not the Library, which ``POST /api/backup``
         *     carries. The request's ``execution_ids`` are not read.
         *
         *     ``success`` is true on every 200, including an upload that sent nothing.
         *     ``uploaded`` counts the files Drive accepted and ``total_files`` the files
         *     found in the folder, so ``uploaded < total_files`` means some were not
         *     sent, and both are 0 when the upload stopped before walking the folder.
         *     ``folder_name`` is ``None`` when it stopped before a Drive folder was made,
         *     and ``web_view_link`` when Drive did not return the folder's link.
         */
        CloudBackupUploaded: {
            /** Folder Name */
            folder_name: string | null;
            /** Success */
            success: boolean;
            /** Total Files */
            total_files: number;
            /** Uploaded */
            uploaded: number;
            /** Web View Link */
            web_view_link: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * CloudLinked
         * @description ``POST /api/cloud/link``: Google's sign-in flow ended with a token, and resmon stored it.
         *
         *     ``auth_url`` is the fixed string ``oauth_completed``, not a URL. The
         *     sign-in runs to its end inside this request, in a browser on this
         *     machine, so there is no address left to hand back. A stored token is not a
         *     working Drive: ``GET /api/cloud/status`` is the route that asks the API.
         *     Only this body is modeled; a missing ``credentials.json`` is a 400 and a
         *     flow that fails is a 500.
         */
        CloudLinked: {
            /** Auth Url */
            auth_url: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * CloudSettings
         * @description ``GET /api/settings/cloud`` — the Google Drive backup lane's two keys.
         */
        CloudSettings: {
            /** Cloud Auto Backup */
            cloud_auto_backup: string;
            /** Cloud Provider */
            cloud_provider: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * CloudStatus
         * @description ``GET /api/cloud/status``: whether a Drive token is stored, and what one call to the Drive API answered.
         *
         *     ``is_linked`` reads only the local keyring. ``api_ok`` is the outcome of
         *     one ``about.get`` call made with that token during this request, so it can
         *     be false while linked, for instance when the Drive API is not enabled on
         *     the OAuth project. ``api_reason`` is ``None`` when that call succeeded;
         *     otherwise a short code: Google's own error reason (such as
         *     ``accessNotConfigured``), ``http_error`` when the error carried none, the
         *     name of the Python exception that stopped the call, or ``no_token`` when
         *     nothing is linked and no call was made.
         */
        CloudStatus: {
            /** Api Ok */
            api_ok: boolean;
            /** Api Reason */
            api_reason: string | null;
            /** Is Linked */
            is_linked: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * CloudUnlinked
         * @description ``POST /api/cloud/unlink``: no Google Drive token is stored here any more.
         *
         *     ``success`` is true on every 200. With a token stored, resmon sends Google
         *     a revocation request when the token carries an access token, does not read
         *     the answer, and deletes the token from the keyring either way, so this
         *     says the local token is gone, not that Google revoked it. With no token
         *     stored, nothing is sent anywhere.
         */
        CloudUnlinked: {
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * CollapsePreview
         * @description ``POST /api/links/collapse-preview``: which rows a per-view fold would
         *     keep, and which it would fold into each kept one. It hides nothing itself.
         */
        CollapsePreview: {
            /** Folded */
            folded: {
                [key: string]: number[];
            };
            /** Keep */
            keep: number[];
        } & {
            [key: string]: unknown;
        };
        /**
         * CollectionMap
         * @description ``GET /api/map``: where every paper sits, and on what basis.
         *
         *     ``basis`` says what nearness means on this map: ``embeddings`` (the set
         *     model's vectors) or ``words`` (word statistics computed on this machine).
         *     It describes the points served, which during a refit can differ from the
         *     basis the next map will have.
         */
        CollectionMap: {
            /** Basis */
            basis: ("embeddings" | "words") | null;
            embedding_coverage: components["schemas"]["EmbeddingCoverage"] | null;
            /** Error */
            error: string | null;
            /** Fitted At */
            fitted_at: string | null;
            /** Fitted Count */
            fitted_count: number;
            /** Model */
            model: string | null;
            /** Placed Since Fit */
            placed_since_fit: number;
            points: components["schemas"]["MapPoints"];
            /** Refitting */
            refitting: boolean;
            /** Regions */
            regions: components["schemas"]["MapRegion"][];
            /**
             * State
             * @enum {string}
             */
            state: "empty" | "fitting" | "failed" | "ready";
            unplaced: components["schemas"]["MapUnplaced"];
        } & {
            [key: string]: unknown;
        };
        /** ConfigCreate */
        ConfigCreate: {
            /** Config Type */
            config_type: string;
            /** Link To Execution Id */
            link_to_execution_id?: number | null;
            /** Name */
            name: string;
            /** Parameters */
            parameters: {
                [key: string]: unknown;
            };
        };
        /** ConfigExport */
        ConfigExport: {
            /** Ids */
            ids: number[];
        };
        /** ConfigUpdate */
        ConfigUpdate: {
            /** Name */
            name?: string | null;
            /** Parameters */
            parameters?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * ConfigurationCreated
         * @description ``POST /api/configurations`` — 201, with the id the caller needs next.
         */
        ConfigurationCreated: {
            /** Config Type */
            config_type: string;
            /** Id */
            id: number;
            /** Name */
            name: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ConfigurationDeleted
         * @description ``DELETE /api/configurations/{config_id}``.
         *
         *     Deleting a routine configuration deletes its linked routine too, and the
         *     body says nothing about that. It is recorded here rather than in the model
         *     because adding a field would be inventing one the handler does not send.
         */
        ConfigurationDeleted: {
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * ConfigurationExport
         * @description ``POST /api/configurations/export`` — where the zip was written.
         *
         *     A local filesystem path, which is a desktop app's honest answer: the
         *     renderer reveals it in the Finder. It is the user's configured export
         *     directory when they have one and a temporary file when they do not.
         */
        ConfigurationExport: {
            /** Path */
            path: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ConfigurationImportResult
         * @description ``POST /api/configurations/import``.
         *
         *     ``routines_created`` is separate from ``imported`` because a routine
         *     configuration arrives as one file and lands as two rows, and a count that
         *     folded them together would tell a user they had imported twice what they
         *     did. ``errors`` carries the files that could not be read, so a bad entry
         *     reports itself rather than failing the batch.
         */
        ConfigurationImportResult: {
            /** Errors */
            errors: string[];
            /** Imported */
            imported: number;
            /** Routines Created */
            routines_created: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * ConfigurationUpdated
         * @description ``PUT /api/configurations/{config_id}``.
         *
         *     **The body assembled from whichever fields the caller sent.** The handler
         *     builds ``{"id": ..., **updates}``, where ``updates`` holds only the fields
         *     the request carried, so a rename answers two keys and a rename-plus-rewrite
         *     answers three. ``response_model_exclude_unset=True`` is what keeps the
         *     first case two keys instead of three-with-a-null.
         *
         *     ``parameters`` is a ``str`` because that is what the handler echoes: it
         *     stored ``json.dumps(...)`` and puts the stored text back. The list route
         *     answers the parsed object instead.
         */
        ConfigurationUpdated: {
            /** Id */
            id: number;
            /** Name */
            name?: string | null;
            /** Parameters */
            parameters?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * ConfigurationsErased
         * @description ``POST /api/admin/erase-configs``: every saved configuration deleted.
         *
         *     A routine configuration takes the routine it is linked to with it.
         *     ``configs_removed`` counts configurations; the routines deleted with them
         *     are not counted.
         */
        ConfigurationsErased: {
            /** Configs Removed */
            configs_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * CorpusErased
         * @description ``POST /api/admin/erase-corpus``: every collected paper deleted, with what hangs off each.
         *
         *     Runs, configurations, keys and the Library's files are kept.
         *     ``documents_removed`` counts papers.
         */
        CorpusErased: {
            /** Documents Removed */
            documents_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * CorpusSummary
         * @description ``GET /api/analytics/summary``. ``doi_coverage`` is ``None`` over no papers: a share of nothing.
         */
        CorpusSummary: {
            /** Completed Executions */
            completed_executions: number;
            /** Distinct Authors */
            distinct_authors: number;
            /** Documents */
            documents: number;
            /** Doi Coverage */
            doi_coverage: number | null;
            /** First Seen */
            first_seen: string | null;
            /** Last Seen */
            last_seen: string | null;
            /** Sample Size */
            sample_size: number;
            /** Sources */
            sources: number;
            /** Sufficient */
            sufficient: boolean;
            /** Unique Papers */
            unique_papers: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * CoverageDistribution
         * @description How far this routine's own results sit from its intent.
         */
        CoverageDistribution: {
            /** Count */
            count: number;
            /** Max */
            max: number;
            /** Median */
            median: number;
            /** Min */
            min: number;
            /** P75 Cutoff */
            p75_cutoff: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * CoveragePaper
         * @description One paper in a coverage list, and its distance from the intent: what was
         *     measured, not a verdict on whether it belongs.
         */
        CoveragePaper: {
            /** Distance */
            distance: number;
            /** Doi */
            doi: string | null;
            /** Id */
            id: number;
            /** Publication Date */
            publication_date: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * CredentialChanged
         * @description ``PUT`` and ``DELETE /api/credentials/{key_name}``: ``{"success": true}``.
         *
         *     Never the value. A ``PUT`` names its slot in the path and carries the
         *     value in the body; the answer says only that the keyring took it.
         */
        CredentialChanged: {
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * CredentialPresence
         * @description Whether one credential is there, never what it is.
         *
         *     ``status`` is ``present``, ``absent`` or ``unreadable``, and the third is
         *     the one that matters: an unsigned macOS build is denied access to keychain
         *     items an earlier build stored, and reporting that as absent tells a user
         *     their keys are gone when they are merely unreachable. ``present`` is the
         *     older boolean, kept beside it for compatibility.
         */
        CredentialPresence: {
            /** Present */
            present: boolean;
            /** Status */
            status: string;
        } & {
            [key: string]: unknown;
        };
        /** CredentialStore */
        CredentialStore: {
            /** Value */
            value: string;
        };
        /** CredentialValidate */
        CredentialValidate: {
            /** Base Url */
            base_url?: string | null;
            /** Key */
            key: string;
            /** Provider */
            provider: string;
        };
        /**
         * CredentialsPresence
         * @description ``GET /api/credentials``.
         *
         *     ``keyring_responsive`` is false once a read has timed out, so the interface
         *     can say so once at the top rather than fifteen times over. The map is keyed
         *     by credential name — the union of the catalog's slots, the AI slots and the
         *     SMTP slot — and never holds a value.
         */
        CredentialsPresence: {
            /** Credentials */
            credentials: {
                [key: string]: components["schemas"]["CredentialPresence"];
            };
            /** Keyring Responsive */
            keyring_responsive: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * DaemonStatus
         * @description ``GET /api/service/daemon-status`` — the lock file, and what answered.
         *
         *     ``running`` is true only when a lock names a port and that port's health
         *     answered 200; ``pid``, ``port``, ``version`` and ``started_at`` are the
         *     probe's, and the ``lock_*`` fields are the file's own, which may name a
         *     process that has died. ``error`` says why a lock that is present did not
         *     answer. ``is_self`` is present only on a probe that answered, and is true
         *     when the answer came from the process serving this request: a window
         *     attached to the service rather than beside it.
         */
        DaemonStatus: {
            /** Error */
            error: string | null;
            /** Is Self */
            is_self?: boolean | null;
            /** Lock Pid */
            lock_pid: number | null;
            /** Lock Port */
            lock_port: number | null;
            /** Lock Present */
            lock_present: boolean;
            /** Lock Version */
            lock_version: string | null;
            /** Pid */
            pid: number | null;
            /** Port */
            port: number | null;
            /** Running */
            running: boolean;
            /** Started At */
            started_at: string | null;
            /** Version */
            version: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * Delivery
         * @description One report's journey to one destination, as recorded.
         *
         *     ``state`` is the drain's own word: ``queued``, ``awaiting_review``,
         *     ``delivering``, ``delivered``, ``failed`` or ``skipped``. ``target_snapshot``
         *     is where it was sent at the time, which survives the destination being
         *     removed. Each field is stored, none inferred: "delivered" is never read
         *     off the absence of an error.
         */
        Delivery: {
            /** Artifact Sha256 */
            artifact_sha256: string | null;
            /** Attempts */
            attempts: number;
            /** Channel */
            channel: string;
            /** Delivered At Utc */
            delivered_at_utc: string | null;
            /** Execution Id */
            execution_id: number;
            /** Id */
            id: number;
            /** Last Error */
            last_error: string | null;
            /** Next Attempt At Utc */
            next_attempt_at_utc: string | null;
            /** Owner Pid */
            owner_pid: number | null;
            /** Owner Runtime Id */
            owner_runtime_id: string | null;
            /** Queued At Utc */
            queued_at_utc: string;
            /** State */
            state: string;
            /** Target Id */
            target_id: number | null;
            /** Target Snapshot */
            target_snapshot: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliveryActed
         * @description ``POST /api/deliveries/{delivery_id}/deliver``, ``/skip`` and ``/retry``:
         *     the state the person's decision left it in. ``attempts`` is present only on
         *     a retry, which starts the count again.
         */
        DeliveryActed: {
            /** Attempts */
            attempts?: number | null;
            /** Id */
            id: number;
            /** State */
            state: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliverySummary
         * @description Enabled destinations by channel, how many deliveries wait for a person,
         *     and the latest one, or ``None`` where there has been none.
         */
        DeliverySummary: {
            /** Awaiting Review */
            awaiting_review: number;
            /** Enabled Target Count */
            enabled_target_count: number;
            last: components["schemas"]["DeliverySummaryLast"] | null;
            /** Targets */
            targets: {
                [key: string]: number;
            };
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliverySummaryLast
         * @description The most recent delivery of a routine, in brief.
         */
        DeliverySummaryLast: {
            /** Attempts */
            attempts: number;
            /** Channel */
            channel: string;
            /** Delivered At Utc */
            delivered_at_utc: string | null;
            /** Execution Id */
            execution_id: number;
            /** Id */
            id: number;
            /** Last Error */
            last_error: string | null;
            /** State */
            state: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliveryTarget
         * @description A destination a routine's reports go to. ``enabled`` is stored ``0`` or
         *     ``1``; ``mode`` is ``automatic`` or ``review`` (each delivery waits for a
         *     person).
         */
        DeliveryTarget: {
            /** Channel */
            channel: string;
            /** Created At Utc */
            created_at_utc: string;
            /** Enabled */
            enabled: number;
            /** Id */
            id: number;
            /** Mode */
            mode: string;
            /** Routine Id */
            routine_id: number;
            /** Target */
            target: string;
            /** Updated At Utc */
            updated_at_utc: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliveryTargetAdded
         * @description ``POST /api/routines/{routine_id}/delivery-targets``.
         */
        DeliveryTargetAdded: {
            /** Id */
            id: number;
            /** Routine Id */
            routine_id: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * DeliveryTargetCreate
         * @description One destination for a routine's report.
         *
         *     ``target`` is the address for ``email`` and the directory for ``folder``.
         *     An empty email target means "the recipient configured under Settings ->
         *     Email", which is where the address came from before schema 21 and still
         *     does for every routine the migration seeded.
         */
        DeliveryTargetCreate: {
            /** Channel */
            channel: string;
            /**
             * Enabled
             * @default true
             */
            enabled: boolean;
            /**
             * Mode
             * @default automatic
             */
            mode: string;
            /**
             * Target
             * @default
             */
            target: string;
        };
        /** DeliveryTargetUpdate */
        DeliveryTargetUpdate: {
            /** Enabled */
            enabled?: boolean | null;
            /** Mode */
            mode?: string | null;
            /** Target */
            target?: string | null;
        };
        /**
         * DeliveryTargets
         * @description ``GET /api/routines/{routine_id}/delivery-targets``, and the channels
         *     resmon can act on today, so a screen offers exactly those.
         */
        DeliveryTargets: {
            /** Routine Id */
            routine_id: number;
            /** Shipped Channels */
            shipped_channels: string[];
            /** Targets */
            targets: components["schemas"]["DeliveryTarget"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * DiscoveryLag
         * @description ``GET /api/analytics/discovery-lag``.
         */
        DiscoveryLag: {
            /** Insufficient Reason */
            insufficient_reason: string | null;
            /** Minimum Sample */
            minimum_sample: number;
            /** Sample Size */
            sample_size: number;
            /** Sources */
            sources: components["schemas"]["DiscoveryLagRow"][];
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * DiscoveryLagRow
         * @description One source's lag, in days. ``None`` below the minimum sample, rather than a median of three.
         */
        DiscoveryLagRow: {
            /** Fastest Days */
            fastest_days: number | null;
            /** Median Days */
            median_days: number | null;
            /** Sample Size */
            sample_size: number;
            /** Slowest Days */
            slowest_days: number | null;
            /** Source */
            source: string;
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /** DiveRequest */
        DiveRequest: {
            /**
             * Ai Enabled
             * @default false
             */
            ai_enabled: boolean;
            /** Ai Settings */
            ai_settings?: {
                [key: string]: unknown;
            } | null;
            /** Date From */
            date_from?: string | null;
            /** Date To */
            date_to?: string | null;
            /** Ephemeral Credentials */
            ephemeral_credentials?: {
                [key: string]: string;
            } | null;
            /** Keywords */
            keywords?: string[] | null;
            /**
             * Max Results
             * @default 100
             */
            max_results: number;
            /** Query */
            query: string;
            /** Repository */
            repository: string;
            /** Request Id */
            request_id?: string | null;
            /** Saved Configuration Id */
            saved_configuration_id?: number | null;
        };
        /**
         * DocumentBrief
         * @description ``POST /api/documents/briefs``: one line about a paper, for a hover.
         */
        DocumentBrief: {
            /** Authors */
            authors: string | null;
            /** First Seen At */
            first_seen_at: string | null;
            /** Id */
            id: number;
            /** Publication Date */
            publication_date: string | null;
            /** Source */
            source: string;
            /** Title */
            title: string;
        } & {
            [key: string]: unknown;
        };
        /** DocumentBriefsBody */
        DocumentBriefsBody: {
            /** Ids */
            ids: number[];
        };
        /** DocumentIdsBody */
        DocumentIdsBody: {
            /**
             * Document Ids
             * @default []
             */
            document_ids: number[];
        };
        /**
         * EmailSettings
         * @description ``GET /api/settings/email`` — the SMTP destination, never the password.
         *
         *     The password lives in the keyring and is reported by ``/api/credentials``
         *     as present or absent. No field here has ever held a credential value and
         *     none may.
         */
        EmailSettings: {
            /** Smtp From */
            smtp_from: string;
            /** Smtp Port */
            smtp_port: string;
            /** Smtp Server */
            smtp_server: string;
            /** Smtp To */
            smtp_to: string;
            /** Smtp Username */
            smtp_username: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingCapability
         * @description Whether this backend can rank by similarity at all, and what by.
         *
         *     ``available`` needs both a loadable extension and rows in the index; either
         *     missing means the sort option and the similar-papers panel are *absent*
         *     rather than present and empty. ``reason`` is the sentence the Settings page
         *     shows instead, and it is the field this model exists to keep.
         */
        EmbeddingCapability: {
            /** Available */
            available: boolean;
            /** Extension */
            extension: string | null;
            /** Indexed */
            indexed: number;
            /** Model */
            model: string | null;
            /** Reason */
            reason: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingCoverage
         * @description How much of the corpus is embedded, read from the database not a counter.
         *
         *     From the database so the numbers are right after a restart, after a cancel,
         *     and for a corpus somebody else's run embedded.
         */
        EmbeddingCoverage: {
            /** Embedded */
            embedded: number;
            /** Model */
            model: string | null;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingIndexState
         * @description What the vector index currently holds.
         */
        EmbeddingIndexState: {
            /** Dims */
            dims: number | null;
            /** Model */
            model: string | null;
            /** Rows */
            rows: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingJobRun
         * @description The backfill job's own state, running or not.
         *
         *     ``skipped_no_text`` is separate from ``processed`` on purpose: a document
         *     with nothing to embed is not a failure and is not progress, and folding the
         *     two together would make a corpus of metadata-only records look embedded.
         */
        EmbeddingJobRun: {
            /** Cancelled */
            cancelled: boolean;
            /** Finished At */
            finished_at: string | null;
            /** Model */
            model: string | null;
            /** Processed */
            processed: number;
            /** Reason */
            reason: string | null;
            /** Running */
            running: boolean;
            /** Skipped No Text */
            skipped_no_text: number;
            /** Started At */
            started_at: string | null;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingJobStatus
         * @description ``run``, ``coverage``, ``extension`` and ``index`` together.
         */
        EmbeddingJobStatus: {
            coverage: components["schemas"]["EmbeddingCoverage"];
            extension: components["schemas"]["VectorExtensionStatus"];
            index: components["schemas"]["EmbeddingIndexState"];
            run: components["schemas"]["EmbeddingJobRun"];
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingLaneView
         * @description The configured lane. ``null`` on the route above means the feature is off.
         *
         *     ``credential_alias`` is a keyring slot *name*. No field here holds a key
         *     value, in the same way ``EmbeddingLane`` itself does not.
         */
        EmbeddingLaneView: {
            /** Base Url */
            base_url: string | null;
            /** Batch Size */
            batch_size: number;
            /** Credential Alias */
            credential_alias: string | null;
            /** Dims */
            dims: number | null;
            /** Endpoint */
            endpoint: string | null;
            /** Input Limit */
            input_limit: number | null;
            /** Kind */
            kind: string;
            /** Model */
            model: string;
            /** Provider */
            provider: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingProbeBody
         * @description An unsaved lane to probe, so a user can test before committing to it.
         */
        EmbeddingProbeBody: {
            /** Settings */
            settings?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * EmbeddingProviderAnswer
         * @description Whether one provider can embed at all, and what that rests on.
         *
         *     Every provider resmon lists appears here, including the ones that cannot
         *     embed, because the interface states the limitation rather than omitting the
         *     option. ``evidence`` is the observation behind ``state`` — a dated request
         *     and its status — and it is a field a model written from the UI's needs
         *     would have dropped, which would have left "Anthropic does not offer an
         *     embeddings API" as an assertion with nothing behind it.
         */
        EmbeddingProviderAnswer: {
            /** Default Model */
            default_model: string | null;
            /** Evidence */
            evidence: string | null;
            /** Offered */
            offered: boolean;
            /** Provider */
            provider: string;
            /** Reason */
            reason: string;
            /** State */
            state: string;
            /** Suggested Models */
            suggested_models: string[];
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingSettingsPage
         * @description ``GET /api/settings/embeddings`` — the stored keys plus everything the
         *     tab needs in order to render honestly.
         */
        EmbeddingSettingsPage: {
            capability: components["schemas"]["EmbeddingCapability"];
            lane: components["schemas"]["EmbeddingLaneView"] | null;
            /** Providers */
            providers: components["schemas"]["EmbeddingProviderAnswer"][];
            settings: components["schemas"]["EmbeddingSettingsValues"];
            status: components["schemas"]["EmbeddingJobStatus"];
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingSettingsSaved
         * @description ``PUT /api/settings/embeddings`` — the ack, and what the lane can now do.
         *
         *     The capability rides on the write because a model change rebuilds the
         *     index, and a client that had to re-read the page to learn that would render
         *     a stale answer in between.
         */
        EmbeddingSettingsSaved: {
            capability: components["schemas"]["EmbeddingCapability"];
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingSettingsValues
         * @description The stored ``embedding_*`` keys, owned by ``EMBEDDING_SETTING_KEYS``.
         */
        EmbeddingSettingsValues: {
            /** Embedding Base Url */
            embedding_base_url: string;
            /** Embedding Batch Size */
            embedding_batch_size: string;
            /** Embedding Dims */
            embedding_dims: string;
            /** Embedding Enabled */
            embedding_enabled: string;
            /** Embedding Endpoint */
            embedding_endpoint: string;
            /** Embedding Input Limit */
            embedding_input_limit: string;
            /** Embedding Model */
            embedding_model: string;
            /** Embedding Provider */
            embedding_provider: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EmbeddingStatus
         * @description ``GET /api/embeddings/status``: the backfill, the coverage, the vector
         *     extension and index, the configured lane, and whether ranking by meaning
         *     is available now (and if not, why).
         */
        EmbeddingStatus: {
            capability: components["schemas"]["EmbeddingCapability"];
            coverage: components["schemas"]["EmbeddingCoverage"];
            extension: components["schemas"]["VectorExtensionStatus"];
            index: components["schemas"]["EmbeddingIndexState"];
            lane: components["schemas"]["EmbeddingLaneView"] | null;
            run: components["schemas"]["EmbeddingJobRun"];
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceFileRecord
         * @description The exact Library file and version a membership or a note is pinned to.
         */
        EvidenceFileRecord: {
            /** Byte Size */
            byte_size: number;
            /** Created At Utc */
            created_at_utc: string;
            /** File Id */
            file_id: string;
            /** Media Type */
            media_type: string;
            /** Original Name */
            original_name: string;
            /** Sha256 */
            sha256: string;
            /** Vault Id */
            vault_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceMember
         * @description A membership with its file's record, as a list shows it.
         */
        EvidenceMember: {
            /** Added At Utc */
            added_at_utc: string;
            /** Availability */
            availability: string;
            file: components["schemas"]["EvidenceFileRecord"];
            /** File Id */
            file_id: string;
            /** Id */
            id: number;
            /** Project Id */
            project_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceMemberAdded
         * @description ``POST .../{project_id}/files``: ``added`` is false when the file was already a member.
         */
        EvidenceMemberAdded: {
            /** Added */
            added: boolean;
            /** Contract Version */
            contract_version: number;
            membership: components["schemas"]["EvidenceMembership"];
            project: components["schemas"]["EvidenceProject"];
            /** Project Id */
            project_id: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceMemberRemoved
         * @description ``DELETE .../{project_id}/files/{file_id}``: membership only; the file and its notes stay.
         */
        EvidenceMemberRemoved: {
            /** Contract Version */
            contract_version: number;
            project: components["schemas"]["EvidenceProject"];
            /** Project Id */
            project_id: string;
            /** Removed */
            removed: boolean;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceMembers
         * @description ``GET .../{project_id}/files``, at the project's current revision.
         */
        EvidenceMembers: {
            /** Contract Version */
            contract_version: number;
            /** Count Basis */
            count_basis: string;
            /** Files */
            files: components["schemas"]["EvidenceMember"][];
            /** Has More */
            has_more: boolean;
            /** Next After Id */
            next_after_id: number | null;
            /** Project Id */
            project_id: string;
            /** Revision */
            revision: number;
            /** Through Id */
            through_id: number;
            /** Total */
            total: number;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /** EvidenceMembership */
        EvidenceMembership: {
            /** Added At Utc */
            added_at_utc: string;
            /** File Id */
            file_id: string;
            /** Id */
            id: number;
            /** Project Id */
            project_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceNote
         * @description A plain note, or a passage pinned to a page, an extraction contract,
         *     the page text's hash and exact codepoint offsets. The anchor fields are
         *     ``None`` on a plain note. ``membership_state`` says whether its file is
         *     still in the project.
         */
        EvidenceNote: {
            /** Body */
            body: string;
            /** Created At Utc */
            created_at_utc: string;
            /** End Codepoint */
            end_codepoint: number | null;
            /** Extraction Contract */
            extraction_contract: string | null;
            file: components["schemas"]["EvidenceFileRecord"];
            /** File Id */
            file_id: string;
            /** Id */
            id: number;
            /** Kind */
            kind: string;
            /** Membership State */
            membership_state: string;
            /** Note Id */
            note_id: string;
            /** Page Number */
            page_number: number | null;
            /** Page Text Sha256 */
            page_text_sha256: string | null;
            /** Project Id */
            project_id: string;
            /** Quote */
            quote: string | null;
            /** Resolution */
            resolution: string;
            /** Revision */
            revision: number;
            /** Start Codepoint */
            start_codepoint: number | null;
            /** Updated At Utc */
            updated_at_utc: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceNoteSaved
         * @description ``POST .../{project_id}/notes`` and ``PATCH .../notes/{note_id}``.
         */
        EvidenceNoteSaved: {
            /** Contract Version */
            contract_version: number;
            note: components["schemas"]["EvidenceNote"];
            project: components["schemas"]["EvidenceProject"];
            /** Project Id */
            project_id: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceNotes
         * @description ``GET .../{project_id}/notes``.
         */
        EvidenceNotes: {
            /** Contract Version */
            contract_version: number;
            /** Count Basis */
            count_basis: string;
            /** Has More */
            has_more: boolean;
            /** Next After Id */
            next_after_id: number | null;
            /** Notes */
            notes: components["schemas"]["EvidenceNote"][];
            /** Project Id */
            project_id: string;
            /** Revision */
            revision: number;
            /** Through Id */
            through_id: number;
            /** Total */
            total: number;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidencePageText
         * @description ``GET .../{project_id}/reader/{file_id}?representation=text``: one page's canonical text.
         *
         *     ``status`` is ``extracted``, ``no_text``, ``unsupported``, ``malformed``,
         *     ``limit_exceeded``, ``timeout`` or ``unavailable``, and only ``extracted``
         *     carries a ``page_text_sha256`` a passage can be pinned to. ``examined_pages``
         *     names the page read; every other page is ``not_examined``. ``coverage`` is
         *     the sentence a reader shows: canonical text may omit or reshape a page.
         *     ``representation=pdf`` answers with the verified bytes instead, outside
         *     this model.
         */
        EvidencePageText: {
            /** Contract Version */
            contract_version: number;
            /** Coverage */
            coverage: string;
            /** Examined Pages */
            examined_pages: number[];
            /** Extraction Contract */
            extraction_contract: string;
            /** File Id */
            file_id: string;
            /** Media Type */
            media_type: string;
            /** Page Count */
            page_count: number | null;
            /** Page Number */
            page_number: number;
            /** Page Text Sha256 */
            page_text_sha256: string | null;
            /** Project Id */
            project_id: string;
            /** Remaining Pages */
            remaining_pages: string;
            /** Sha256 */
            sha256: string;
            /** Status */
            status: string;
            /** Text */
            text: string;
            /** Vault Id */
            vault_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceProject
         * @description A project row as stored, with its current counts.
         */
        EvidenceProject: {
            /** Created At Utc */
            created_at_utc: string;
            /** File Count */
            file_count: number;
            /** Id */
            id: number;
            /** Name */
            name: string;
            /** Note Count */
            note_count: number;
            /** Project Id */
            project_id: string;
            /** Revision */
            revision: number;
            /** Updated At Utc */
            updated_at_utc: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceProjectDetail
         * @description ``POST /api/evidence/projects``, ``GET`` and ``PATCH .../{project_id}``.
         */
        EvidenceProjectDetail: {
            /** Contract Version */
            contract_version: number;
            project: components["schemas"]["EvidenceProject"];
            /** Project Id */
            project_id: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * EvidenceProjects
         * @description ``GET /api/evidence/projects``.
         */
        EvidenceProjects: {
            /** Contract Version */
            contract_version: number;
            /** Count Basis */
            count_basis: string;
            /** Has More */
            has_more: boolean;
            /** Next After Id */
            next_after_id: number | null;
            /** Projects */
            projects: components["schemas"]["EvidenceProject"][];
            /** Through Id */
            through_id: number;
            /** Total */
            total: number;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ExecutionDataErased
         * @description ``POST /api/admin/erase-execution-data``: every saved configuration and every run record deleted.
         *
         *     The counts are as ``ConfigurationsErased`` and ``ExecutionsErased`` count
         *     them. Settings, keys and papers are kept.
         */
        ExecutionDataErased: {
            /** Configs Removed */
            configs_removed: number;
            /** Executions Removed */
            executions_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /** ExecutionExport */
        ExecutionExport: {
            /** Ids */
            ids: number[];
        };
        /**
         * ExecutionSettings
         * @description ``GET /api/settings/execution`` — two integers, parsed and bounded.
         */
        ExecutionSettings: {
            /** Max Concurrent Executions */
            max_concurrent_executions: number;
            /** Routine Fire Queue Limit */
            routine_fire_queue_limit: number;
        } & {
            [key: string]: unknown;
        };
        /** ExecutionSettingsBody */
        ExecutionSettingsBody: {
            /** Max Concurrent Executions */
            max_concurrent_executions: number;
            /** Routine Fire Queue Limit */
            routine_fire_queue_limit: number;
        };
        /**
         * ExecutionSettingsSaved
         * @description ``PUT /api/settings/execution`` echoes what it stored.
         *
         *     The echo is the point: the handler clamps nothing and refuses out-of-range
         *     values with a 400, so a caller comparing what came back with what it sent
         *     can tell a stored value from an ignored one.
         */
        ExecutionSettingsSaved: {
            /** Max Concurrent Executions */
            max_concurrent_executions: number;
            /** Routine Fire Queue Limit */
            routine_fire_queue_limit: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * ExecutionsErased
         * @description ``POST /api/admin/erase-executions``: every run record deleted, with the run's links to its papers.
         *
         *     The papers stay, and so do report files on disk. ``executions_removed``
         *     counts runs.
         */
        ExecutionsErased: {
            /** Executions Removed */
            executions_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /** ExplorerExportBody */
        ExplorerExportBody: {
            /**
             * Authors
             * @default []
             */
            authors: string[];
            /**
             * Categories
             * @default []
             */
            categories: string[];
            /** Date From */
            date_from?: string | null;
            /** Date To */
            date_to?: string | null;
            /**
             * Format
             * @default bibtex
             */
            format: string;
            /** Query */
            query?: string | null;
            /**
             * Sources
             * @default []
             */
            sources: string[];
        };
        /** ExplorerFilters */
        ExplorerFilters: {
            /**
             * Authors
             * @default []
             */
            authors: string[];
            /**
             * Categories
             * @default []
             */
            categories: string[];
            /** Date From */
            date_from?: string | null;
            /** Date To */
            date_to?: string | null;
            /** Query */
            query?: string | null;
            /**
             * Sources
             * @default []
             */
            sources: string[];
        };
        /**
         * ExplorerPage
         * @description ``POST /api/explorer/search``.
         *
         *     ``total`` is the count of every match, capped at ``count_cap`` when
         *     ``total_is_capped``. Under ``sort == "similarity"`` the phrase ranks the
         *     filtered set rather than filtering it, and ``ranked_count``,
         *     ``unranked_count`` and ``model`` say how; ``similarity_unavailable`` says
         *     why a requested ranking was refused and the page fell back to newest.
         *     Each of those four is absent when it does not apply.
         */
        ExplorerPage: {
            /** Count Cap */
            count_cap: number;
            /** Has More */
            has_more: boolean;
            /** Model */
            model?: string | null;
            /** Next Cursor */
            next_cursor: unknown | null;
            /** Page Size */
            page_size: number;
            /** Ranked Count */
            ranked_count?: number | null;
            /** Results */
            results: components["schemas"]["ExplorerPaper"][];
            /** Similarity Unavailable */
            similarity_unavailable?: string | null;
            /** Sort */
            sort: string;
            /** Total */
            total: number;
            /** Total Is Capped */
            total_is_capped: boolean;
            /** Unranked Count */
            unranked_count?: number | null;
            /** Used Full Text Index */
            used_full_text_index: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * ExplorerPaper
         * @description One row of an Explorer page. ``distance`` is present only under the
         *     similarity sort, and ``None`` for a paper with no vector yet, which is
         *     listed after every ranked one rather than dropped.
         */
        ExplorerPaper: {
            /** Abstract */
            abstract: string | null;
            /** Authors */
            authors: string | null;
            /** Categories */
            categories: string | null;
            /** Distance */
            distance?: number | null;
            /** Doi */
            doi: string | null;
            /** External Id */
            external_id: string;
            /** First Seen At */
            first_seen_at: string;
            /** Id */
            id: number;
            /** Metadata Hash */
            metadata_hash: string;
            /** Pub Sort */
            pub_sort: string;
            /** Publication Date */
            publication_date: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /** ExplorerSearchBody */
        ExplorerSearchBody: {
            /**
             * Authors
             * @default []
             */
            authors: string[];
            /**
             * Categories
             * @default []
             */
            categories: string[];
            /** Cursor */
            cursor?: string | null;
            /** Date From */
            date_from?: string | null;
            /** Date To */
            date_to?: string | null;
            /**
             * Limit
             * @default 50
             */
            limit: number;
            /** Query */
            query?: string | null;
            /**
             * Sort
             * @default newest
             */
            sort: string;
            /**
             * Sources
             * @default []
             */
            sources: string[];
        };
        /**
         * FactoryReset
         * @description ``POST /api/admin/factory-reset``: papers, configurations, runs, settings, and AI, repository and SMTP keys.
         *
         *     The counts are as the single-purpose routes count them, so the key counts
         *     are of names cleared. It does not clear the Google Drive token or a
         *     delivery target's webhook secret, and it does not touch the Library's
         *     files, report files on disk, or a restore's undo copies.
         */
        FactoryReset: {
            /** Ai Keys Removed */
            ai_keys_removed: number;
            /** Configs Removed */
            configs_removed: number;
            /** Documents Removed */
            documents_removed: number;
            /** Executions Removed */
            executions_removed: number;
            /** Repo Keys Removed */
            repo_keys_removed: number;
            /** Settings Cleared */
            settings_cleared: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * ForeignKeyViolation
         * @description One reference ``PRAGMA foreign_key_check`` found to a parent row that is not there.
         *
         *     ``rowid`` is ``None`` for a table without rowids, where two references
         *     cannot be told apart. ``fkid`` is the foreign key's index on its table, as
         *     SQLite numbers it.
         */
        ForeignKeyViolation: {
            /** Fkid */
            fkid: number;
            /** Parent */
            parent: string;
            /** Rowid */
            rowid: number | null;
            /** Table */
            table: string;
        } & {
            [key: string]: unknown;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /**
         * Health
         * @description ``GET /api/health``.
         *
         *     ``embeddings`` is attempted against a real connection on every call rather
         *     than read from a cached probe: it is a ``dlopen`` of a 165 KB library, and
         *     a health endpoint answering from memory would keep reporting a capability
         *     the process had lost.
         */
        Health: {
            embeddings: components["schemas"]["VectorExtensionStatus"];
            identity: components["schemas"]["RuntimeIdentity"];
            /** Pid */
            pid: number;
            /** Started At */
            started_at: string;
            /** Status */
            status: string;
            /** Version */
            version: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * KeywordContribution
         * @description ``GET /api/analytics/keyword-contribution``. Not part of the overview: it reads every paper once.
         */
        KeywordContribution: {
            /** Documents Considered */
            documents_considered: number;
            /** Documents Matched */
            documents_matched: number;
            /** Documents Unexplained */
            documents_unexplained: number;
            /** Fields Checked */
            fields_checked: string[];
            /** Insufficient Reason */
            insufficient_reason: string | null;
            /** Keywords */
            keywords: components["schemas"]["KeywordContributionRow"][];
            /** Minimum Sample For Share */
            minimum_sample_for_share: number;
            /** Sample Size */
            sample_size: number;
            scope: components["schemas"]["KeywordScope"];
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * KeywordContributionRow
         * @description One keyword: papers it matched, and how many no other keyword did.
         *
         *     ``unique_share`` is ``None`` below ``minimum_sample_for_share`` matches.
         */
        KeywordContributionRow: {
            /** Contains Operators */
            contains_operators: boolean;
            /** Keyword */
            keyword: string;
            /** Matched */
            matched: number;
            /** Shared */
            shared: number;
            /** Unique */
            unique: number;
            /** Unique Share */
            unique_share: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * KeywordScope
         * @description ``corpus``, or ``execution`` with the run's id.
         */
        KeywordScope: {
            /** Execution Id */
            execution_id?: number | null;
            /** Type */
            type: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryCounts
         * @description What the database records the vault holding; ``basis`` says it was not re-measured.
         */
        LibraryCounts: {
            /** Basis */
            basis: string;
            /** Items */
            items: number;
            /** Retained Bytes */
            retained_bytes: number;
        } & {
            [key: string]: unknown;
        };
        /** LibraryFile */
        LibraryFile: {
            /** Availability */
            availability: string;
            /** Byte Size */
            byte_size: number;
            /** Created At Utc */
            created_at_utc: string;
            /** File Id */
            file_id: string;
            /** Id */
            id: number;
            /** Media Type */
            media_type: string;
            /** Original Name */
            original_name: string;
            /** Paper Links */
            paper_links: components["schemas"]["LibraryPaperLink"][];
            /** Relative Path */
            relative_path: string;
            /** Sha256 */
            sha256: string;
            /** Vault Id */
            vault_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /** LibraryFileDetail */
        LibraryFileDetail: {
            file: components["schemas"]["LibraryFile"];
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryFiles
         * @description ``GET /api/library/files``: a descending page under a fixed ceiling, ``through_id``.
         */
        LibraryFiles: {
            /** Files */
            files: components["schemas"]["LibraryFile"][];
            /** Has More */
            has_more: boolean;
            /** Next Before Id */
            next_before_id: number | null;
            /** Through Id */
            through_id: number;
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryImported
         * @description ``POST /api/library/files``: 201 for a new copy, 200 for the same bytes already kept.
         */
        LibraryImported: {
            /** Created */
            created: boolean;
            /** Duplicate */
            duplicate: boolean;
            file: components["schemas"]["LibraryFile"];
            /** Linked Document Ids */
            linked_document_ids: number[];
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryInventory
         * @description ``GET /api/library/export``: the inventory as a JSON document in ``text``, and its file name.
         */
        LibraryInventory: {
            /** Content Type */
            content_type: string;
            /** Filename */
            filename: string;
            /** Format */
            format: string;
            /** Text */
            text: string;
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /** LibraryLimits */
        LibraryLimits: {
            /** Batch Files */
            batch_files: number;
            /** File Bytes */
            file_bytes: number;
            /** Items */
            items: number;
            /** Vault Bytes */
            vault_bytes: number;
        } & {
            [key: string]: unknown;
        };
        /** LibraryLinkBody */
        LibraryLinkBody: {
            /** Document Id */
            document_id: number;
            /** Expected Vault Id */
            expected_vault_id: string;
        };
        /** LibraryLinked */
        LibraryLinked: {
            /** Document Id */
            document_id: number;
            /** File Id */
            file_id: string;
            /** Paper Links */
            paper_links: components["schemas"]["LibraryPaperLink"][];
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /** LibraryOpenBody */
        LibraryOpenBody: {
            /** Expected Vault Id */
            expected_vault_id: string;
            /** Expected Version Id */
            expected_version_id: string;
        };
        /**
         * LibraryOpened
         * @description ``POST /api/library/files/{file_id}/open``: the verified path, for the desktop's opener only.
         */
        LibraryOpened: {
            /** File Id */
            file_id: string;
            /** Path */
            path: string;
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryPaperLink
         * @description A paper the owner associated a file with: an association, not an identification.
         */
        LibraryPaperLink: {
            /** Basis */
            basis: string;
            /** Document Id */
            document_id: number;
            /** Identity Scope */
            identity_scope: string;
            /** Title */
            title: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryStatus
         * @description ``GET /api/library`` and ``POST /api/library/vault``.
         *
         *     ``status`` is ``unconfigured``, ``ready``, ``busy``, ``mismatch``,
         *     ``needs_attention`` or ``unavailable``; ``reason`` is present only for the
         *     two that came from a refusal.
         */
        LibraryStatus: {
            counts: components["schemas"]["LibraryCounts"];
            limits: components["schemas"]["LibraryLimits"];
            /** Reason */
            reason?: string | null;
            /** Status */
            status: string;
            vault: components["schemas"]["LibraryVault"] | null;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryText
         * @description ``GET /api/library/files/{file_id}/text``: a retained TXT or MD file's bytes as literal text.
         */
        LibraryText: {
            /** Byte Size */
            byte_size: number;
            /** Encoding */
            encoding: string;
            /** File Id */
            file_id: string;
            /** Kind */
            kind: string;
            /** Line Count */
            line_count: number;
            /** Media Type */
            media_type: string;
            /** Normalization */
            normalization: string;
            /** Sha256 */
            sha256: string;
            /** Text */
            text: string;
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * LibraryVault
         * @description The vault by its id and folder name: never its absolute root.
         */
        LibraryVault: {
            /** Created At Utc */
            created_at_utc: string;
            /** Label */
            label: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /** LibraryVaultBody */
        LibraryVaultBody: {
            /** Parent Directory */
            parent_directory: string;
        };
        /** LifecycleCheckRequest */
        LifecycleCheckRequest: {
            /**
             * Limit
             * @default 1000
             */
            limit: number;
            /**
             * Run Until Done
             * @default false
             */
            run_until_done: boolean;
        };
        /** LifecycleForDocumentsRequest */
        LifecycleForDocumentsRequest: {
            /** Document Ids */
            document_ids?: number[];
        };
        /**
         * MapPoints
         * @description Every paper on the plate, one entry per paper in each list, in id order.
         *
         *     Columns rather than one object per paper: at 100,000 papers this is the
         *     difference between a few megabytes and a few dozen.
         */
        MapPoints: {
            /** Id */
            id: number[];
            /** Region */
            region: number[];
            /** Seen Day */
            seen_day: number[];
            /** X */
            x: number[];
            /** Y */
            y: number[];
        } & {
            [key: string]: unknown;
        };
        /**
         * MapRegion
         * @description One region of the collection map: a disc on the plate, and its name.
         *
         *     ``label`` and ``terms`` are the words most distinctive of the region's
         *     papers, so they are always lexical, whatever basis placed the papers.
         */
        MapRegion: {
            /** Id */
            id: number;
            /** Label */
            label: string;
            /** R */
            r: number;
            /** Size */
            size: number;
            /** Terms */
            terms: string[];
            /** X */
            x: number;
            /** Y */
            y: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * MapUnplaced
         * @description Papers in the collection that are not on the plate, and why.
         */
        MapUnplaced: {
            /** No Text */
            no_text: number;
            /** Not Embedded */
            not_embedded: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * MissedFire
         * @description One fire that came due and did not run, and what became of it since.
         */
        MissedFire: {
            /** Disposition */
            disposition: string | null;
            /** Due At Utc */
            due_at_utc: string;
            /** Id */
            id: number;
            /** Observed At Utc */
            observed_at_utc: string | null;
            /** Routine Id */
            routine_id: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * MissedFires
         * @description Fires that did not run, counted in pairs with the time beside each count.
         *
         *     ``count`` is every recorded miss. ``overlap_skipped`` is the subset refused
         *     because the routine's previous run was still going; the rest came due while
         *     resmon was not running, and ``last_closed_miss_due_at_utc`` is the latest of
         *     those. A routine that has missed none answers with zeros, not an absent key.
         */
        MissedFires: {
            /** Count */
            count: number;
            /** Last Closed Miss Due At Utc */
            last_closed_miss_due_at_utc: string | null;
            /** Last Due At Utc */
            last_due_at_utc: string | null;
            /** Last Overlap Skipped Due At Utc */
            last_overlap_skipped_due_at_utc: string | null;
            /** Overlap Skipped */
            overlap_skipped: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * NotificationSettings
         * @description ``GET /api/settings/notifications`` — the one group that is not strings.
         *
         *     The handler reads the same stored text as every other group and then
         *     *answers* a bool and a three-valued mode, defaulting ``notify_manual`` to
         *     true on a first load. So this model is ``bool`` and ``str`` where its
         *     siblings are ``str`` and ``str``, and a model copied from one of them would
         *     have turned ``true`` into ``"true"`` without dropping anything.
         */
        NotificationSettings: {
            /** Notify Automatic Mode */
            notify_automatic_mode: string;
            /** Notify Manual */
            notify_manual: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * OnboardingCounts
         * @description What the install already has. All three zero is what ``show`` keys on.
         */
        OnboardingCounts: {
            /** Documents */
            documents: number;
            /** Executions */
            executions: number;
            /** Routines */
            routines: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * OnboardingDismissed
         * @description ``POST /api/onboarding/dismiss``.
         */
        OnboardingDismissed: {
            /** Dismissed */
            dismissed: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * OnboardingState
         * @description ``GET /api/onboarding``.
         */
        OnboardingState: {
            counts: components["schemas"]["OnboardingCounts"];
            /** Dismissed */
            dismissed: boolean;
            /** Show */
            show: boolean;
            /** Steps */
            steps: components["schemas"]["OnboardingStep"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * OnboardingStep
         * @description One first-run step, as a fact rather than as prose.
         *
         *     ``done`` is **three-valued**, and declaring it ``bool`` is a real mistake
         *     that this file made and ``test_onboarding.py`` caught: the two credential
         *     steps call ``_credential_present``, which answers ``None`` when the keyring
         *     will not say. An unsigned macOS build is denied the items an earlier build
         *     stored, and "no key" there would tell somebody to add a key they already
         *     have — so the backend declines to answer, and the model has to be able to
         *     carry that. ``done: bool`` did not merely mis-describe it; it turned a 200
         *     into a ``ResponseValidationError``, which is a 500.
         *
         *     ``detail`` says which machine it looked on, and for the agent-CLI step it
         *     is detection and not a login check. The card renders it verbatim; it is not
         *     a key a client may synthesize.
         */
        OnboardingStep: {
            /** Detail */
            detail: string;
            /** Done */
            done: boolean | null;
            /** Id */
            id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * Paper
         * @description ``GET /api/documents/{doc_id}``: one paper as stored, and its place in the
         *     reading queue (``to_read``, ``read``, or ``None`` when it is not saved).
         */
        Paper: {
            /** Abstract */
            abstract: string | null;
            /** Authors */
            authors: string | null;
            /** Categories */
            categories: string | null;
            /** Doi */
            doi: string | null;
            /** External Id */
            external_id: string;
            /** First Seen At */
            first_seen_at: string;
            /** Id */
            id: number;
            /** Metadata Hash */
            metadata_hash: string;
            /** Pub Sort */
            pub_sort: string;
            /** Publication Date */
            publication_date: string | null;
            /** Queue Status */
            queue_status: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * PaperLink
         * @description Another record that looks like the same work, and why: ``method`` is
         *     ``shared_doi`` or ``vector+title``; ``label`` is the sentence a person reads.
         */
        PaperLink: {
            /** Id */
            id: number;
            /** Kind */
            kind: string;
            /** Label */
            label: string;
            /** Method */
            method: string;
            /** Score */
            score: number | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * PaperLinks
         * @description ``POST /api/links/for-documents``: the links of each asked-for paper,
         *     keyed by its id as a string. A paper with none is absent.
         */
        PaperLinks: {
            /** Links */
            links: {
                [key: string]: components["schemas"]["PaperLink"][];
            };
        } & {
            [key: string]: unknown;
        };
        /**
         * PaperWhy
         * @description ``GET /api/documents/{doc_id}/why``: what resmon can say about why a
         *     paper is in the corpus, and ``what_resmon_cannot_see`` -- the limits of
         *     that account, stated rather than implied.
         */
        PaperWhy: {
            document: components["schemas"]["PaperWhyDocument"];
            /** Fields Checked */
            fields_checked: string[];
            /** Headline */
            headline: string;
            /** Keyword Count */
            keyword_count: number;
            /** Keywords */
            keywords: components["schemas"]["PaperWhyKeyword"][];
            /** Matched Count */
            matched_count: number;
            /** Runs */
            runs: components["schemas"]["PaperWhyRun"][];
            source: components["schemas"]["PaperWhySource"];
            /** Verdict */
            verdict: string;
            /** What Resmon Cannot See */
            what_resmon_cannot_see: string[];
        } & {
            [key: string]: unknown;
        };
        /** PaperWhyDocument */
        PaperWhyDocument: {
            /** Doi */
            doi: string | null;
            /** First Seen At */
            first_seen_at: string | null;
            /** Id */
            id: number;
            /** Publication Date */
            publication_date: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * PaperWhyKeyword
         * @description One requested keyword: whether it is in the fields resmon holds, which
         *     ones, and those named in words (``where``).
         */
        PaperWhyKeyword: {
            /** Contains Operators */
            contains_operators: boolean;
            /** Fields */
            fields: string[];
            /** Keyword */
            keyword: string;
            /** Matched */
            matched: boolean;
            /** Where */
            where: string;
        } & {
            [key: string]: unknown;
        };
        /** PaperWhyRun */
        PaperWhyRun: {
            /** Execution Id */
            execution_id: number;
            /** Execution Type */
            execution_type: string;
            /** Keywords */
            keywords: string[];
            /** Routine Name */
            routine_name: string | null;
            /** Start Time */
            start_time: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * PaperWhySource
         * @description The source the paper came from, and whether resmon or the source decided
         *     the match: ``resmon_filtered_locally`` is false for a relevance-ranked
         *     upstream, which resmon cannot speak about with certainty.
         */
        PaperWhySource: {
            /** Keyword Combination */
            keyword_combination: string;
            /** Keyword Combination Notes */
            keyword_combination_notes: string;
            /** Name */
            name: string;
            /** Resmon Filtered Locally */
            resmon_filtered_locally: boolean;
            /** Slug */
            slug: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ProfileImportBody
         * @description One exported profile, or a list of them.
         */
        ProfileImportBody: {
            /**
             * Profiles
             * @default []
             */
            profiles: {
                [key: string]: unknown;
            }[];
        };
        /** ProfileMatchesForDocumentsBody */
        ProfileMatchesForDocumentsBody: {
            /**
             * Document Ids
             * @default []
             */
            document_ids: number[];
        };
        /**
         * PublicationVolume
         * @description ``GET /api/analytics/publication-volume``, by ``source`` or ``category``.
         */
        PublicationVolume: {
            /** Group By */
            group_by: string;
            /** Groups */
            groups: string[];
            /** Insufficient Reason */
            insufficient_reason: string | null;
            /** Sample Size */
            sample_size: number;
            /** Series */
            series: components["schemas"]["PublicationVolumeMonth"][];
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * PublicationVolumeMonth
         * @description One month: its total and each group's count; groups outside the top eight are ``other``.
         */
        PublicationVolumeMonth: {
            /** Groups */
            groups: {
                [key: string]: number;
            };
            /** Month */
            month: string;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * ReadingQueueCounts
         * @description How many are in each state, over the whole queue and not this page.
         */
        ReadingQueueCounts: {
            /** All */
            all: number;
            /** Read */
            read: number;
            /** To Read */
            to_read: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * ReadingQueueDocument
         * @description The stored paper a queue entry points at.
         *
         *     ``authors`` is the raw column, a JSON array stored as text; the renderer
         *     parses it. Every other nullable column of ``documents`` is optional here
         *     because it is nullable there.
         */
        ReadingQueueDocument: {
            /** Abstract */
            abstract: string | null;
            /** Authors */
            authors: string | null;
            /** Categories */
            categories: string | null;
            /** Doi */
            doi: string | null;
            /** External Id */
            external_id: string;
            /** First Seen At */
            first_seen_at: string;
            /** Id */
            id: number;
            /** Publication Date */
            publication_date: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * ReadingQueueEntry
         * @description One saved paper. ``read_at`` is ``None`` until it is marked read.
         *
         *     ``document`` is absent from the entry a write returns and present in the
         *     entry a page lists, which is why it is optional: the writes answer with the
         *     queue row alone and the caller already has the paper it just saved.
         */
        ReadingQueueEntry: {
            document?: components["schemas"]["ReadingQueueDocument"] | null;
            /** Document Id */
            document_id: number;
            /** Read At */
            read_at: string | null;
            /** Saved At */
            saved_at: string;
            /** Status */
            status: string;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ReadingQueuePage
         * @description ``GET /api/reading-queue``.
         *
         *     ``status`` echoes the filter that produced the page and is ``None`` when
         *     the caller asked for both, so a client can tell "everything" from
         *     "everything that happens to be unread".
         */
        ReadingQueuePage: {
            counts: components["schemas"]["ReadingQueueCounts"];
            /** Entries */
            entries: components["schemas"]["ReadingQueueEntry"][];
            /** Limit */
            limit: number;
            /** Offset */
            offset: number;
            /** Status */
            status: string | null;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * ReadingQueueRemoval
         * @description ``DELETE /api/reading-queue/{document_id}``. The paper is not touched.
         */
        ReadingQueueRemoval: {
            /** Document Id */
            document_id: number;
            /** Removed */
            removed: boolean;
        } & {
            [key: string]: unknown;
        };
        /** ReadingQueueSaveBody */
        ReadingQueueSaveBody: {
            /** Document Id */
            document_id: number;
        };
        /** ReadingQueueStatusBody */
        ReadingQueueStatusBody: {
            /** Status */
            status: string;
        };
        /** ReferenceExportBody */
        ReferenceExportBody: {
            /**
             * Document Ids
             * @default []
             */
            document_ids: number[];
            /** Execution Ids */
            execution_ids?: number[] | null;
            /**
             * Format
             * @default bibtex
             */
            format: string;
        };
        /**
         * RendererHeartbeat
         * @description ``POST /api/renderer/heartbeat``.
         *
         *     ``ttl_sec`` is how long this ping suppresses the backend's own desktop
         *     notifications. It is returned rather than assumed because the renderer
         *     sets its interval from it, and a renderer pinging slower than the TTL
         *     would get both notifications.
         */
        RendererHeartbeat: {
            /** Ok */
            ok: boolean;
            /** Ttl Sec */
            ttl_sec: number;
        } & {
            [key: string]: unknown;
        };
        /** RendererOriginBody */
        RendererOriginBody: {
            /** Origin */
            origin: string;
        };
        /**
         * RepositoryCatalogEntry
         * @description One source, as the Repositories page renders it.
         *
         *     Not decoration: ``rate_limit``, ``upstream_policy`` and
         *     ``keyword_combination`` are read by a user as statements of fact about
         *     somebody else's search engine, and ``attribution`` with its
         *     ``attribution_requirement`` is a license obligation rather than a courtesy
         *     when the requirement says ``required``. Those four are the fields a model
         *     written from the table's visible columns would have dropped, and dropping
         *     an attribution credit is the one failure mode in this file that is not
         *     merely a missing feature.
         */
        RepositoryCatalogEntry: {
            /** Api Key Requirement */
            api_key_requirement: string;
            /** Attribution */
            attribution: string;
            /** Attribution Requirement */
            attribution_requirement: string;
            /** Attribution Source */
            attribution_source: string | null;
            /** Client Module */
            client_module: string;
            constraints: components["schemas"]["RepositoryConstraints"];
            /** Credential Name */
            credential_name: string | null;
            /** Date Granularity */
            date_granularity: string;
            /** Description */
            description: string;
            /** Endpoint */
            endpoint: string;
            entity_search: components["schemas"]["RepositoryEntitySearch"];
            /** Keyword Combination */
            keyword_combination: string;
            /** Keyword Combination Notes */
            keyword_combination_notes: string;
            /** Name */
            name: string;
            /** Notes */
            notes: string;
            /** Parallel Safe */
            parallel_safe: string;
            /** Placeholder */
            placeholder: string;
            /** Query Method */
            query_method: string;
            /** Rate Limit */
            rate_limit: string;
            /** Registration Url */
            registration_url: string | null;
            /** Slug */
            slug: string;
            /** Subject Coverage */
            subject_coverage: string;
            /** Upstream Policy */
            upstream_policy: string;
            /** Website */
            website: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RepositoryConstraints
         * @description What resmon knows about a source *before* anybody presses the button.
         *
         *     Deliberately not here: whether the source requires a credential. That is
         *     on ``api_key_requirement`` and ``credential_name`` of the entry carrying
         *     this object, and a second copy is the exact drift this record exists to
         *     prevent — the sweep engine's own list of keyed sources disagreed with the
         *     catalog's for three releases and a source fell through the gap.
         *
         *     Also deliberately not here: whether the source is up. An outage is not
         *     something a user can act on while composing a query, it belongs to
         *     ``zero_reason`` and the source wall, and a page that warned about every
         *     provider's bad day would be warning about nothing.
         */
        RepositoryConstraints: {
            /** Established */
            established: string;
            /** Keyword Search */
            keyword_search: string;
            /** Notices */
            notices: components["schemas"]["RepositorySourceNotice"][];
            /** Records Per Request */
            records_per_request: number | null;
            /** Window Effect */
            window_effect: string;
            /** Window Refiltered Locally */
            window_refiltered_locally: boolean;
            /** Window Rounding */
            window_rounding: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RepositoryEntitySearch
         * @description How a source can be asked about a *person*, in that source's own syntax.
         *
         *     ``author_syntax`` is the string ``api_base.search_entity`` puts into the
         *     query, and a client that rewrites it destroys it silently — which is how
         *     two sources reported that a researcher had published nothing for as long as
         *     the capability existed. ``established`` is the dated observation behind the
         *     rest of the row, and it is the field that makes the others checkable.
         */
        RepositoryEntitySearch: {
            /** Author Query */
            author_query: string;
            /** Author Syntax */
            author_syntax: string;
            /** Established */
            established: string;
            /** Identifier Query */
            identifier_query: string;
            /** Identifier Syntax */
            identifier_syntax: string;
            /** Returns Affiliation */
            returns_affiliation: boolean;
            /** Returns Orcid */
            returns_orcid: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RepositoryKeysErased
         * @description ``POST /api/admin/erase-repo-keys``: every repository key slot the catalog names cleared.
         *
         *     ``repo_keys_removed`` is the number of catalog credential names cleared,
         *     whether or not each held a key. This route takes no ``confirm``.
         */
        RepositoryKeysErased: {
            /** Repo Keys Removed */
            repo_keys_removed: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RepositorySourceNotice
         * @description One sentence the interface shows before a search is submitted.
         *
         *     ``effect`` is the sentence itself, written as what resmon will do rather
         *     than as the name of the limitation, because a user cannot act on
         *     "year granularity" and can act on "it will search the whole of 2025".
         *     ``established`` is the code or the published wording the sentence was read
         *     from; it is not rendered beside the sentence, but it travels with it so
         *     that anything downstream can say where the claim came from.
         */
        RepositorySourceNotice: {
            /** Applies When */
            applies_when: string;
            /** Effect */
            effect: string;
            /** Established */
            established: string;
            /** Kind */
            kind: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestartRequest
         * @description Body of ``POST /api/executions/{id}/restart``. Every field optional.
         *
         *     The route took no body at all before this; it still answers a request that
         *     sends none, because the renderer's Restart button and every existing caller
         *     do exactly that.
         */
        RestartRequest: {
            /** Request Id */
            request_id?: string | null;
        };
        /**
         * RestoreAcknowledged
         * @description ``POST /api/restore/acknowledge``: the card about the last restore dismissed.
         *
         *     ``acknowledged`` is false when there was no record to dismiss, and true
         *     when the record was rewritten with ``acknowledged: true``.
         */
        RestoreAcknowledged: {
            /** Acknowledged */
            acknowledged: boolean;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoreCancelled
         * @description ``POST /api/restore/cancel``: no restore is staged now.
         *
         *     ``success`` is true whether or not one was staged, and nothing had moved.
         */
        RestoreCancelled: {
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoreFailed
         * @description The record of a staged restore a backend start refused or could not finish.
         *
         *     ``reason`` is a code and ``message`` the sentence for it: among them
         *     ``bundle_missing``, ``verification_failed``, ``manifest_changed``,
         *     ``database_in_use``, ``pointer_unreadable``, a verification refusal such
         *     as ``not_a_bundle``, or ``restore_failed`` for an error that carried no
         *     code. ``undone`` is present, and true, when the restore had begun moving
         *     files and its undo ran; ``vault_copy_kept`` is then the path of a vault
         *     copy the undo could not put back by itself, normally ``None``, and is
         *     absent from a record resmon 2.3.0 wrote. ``acknowledged`` is absent until
         *     the person dismisses the card.
         */
        RestoreFailed: {
            /** Acknowledged */
            acknowledged?: boolean | null;
            /** At Utc */
            at_utc: string;
            /** Bundle */
            bundle: string;
            /** Message */
            message: string;
            /**
             * Ok
             * @constant
             */
            ok: false;
            /** Reason */
            reason: string;
            /** Undone */
            undone?: boolean | null;
            /** Vault Copy Kept */
            vault_copy_kept?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestorePointer
         * @description A staged restore: the pointer the next backend start acts on.
         *
         *     Nothing has moved while this exists. ``bundle`` is the bundle's resolved
         *     path and ``manifest_sha256`` the manifest's hash when it was staged; a
         *     start that finds a different manifest refuses the restore.
         *     ``accept_fk_violations`` is whether the person accepted the bundle's
         *     orphan rows. ``vault_parent`` is the folder the vault is to go into on
         *     this machine, ``None`` for the path the bundle's database records; a
         *     pointer resmon 2.3.0 staged has no such key.
         */
        RestorePointer: {
            /** Accept Fk Violations */
            accept_fk_violations: boolean;
            /** Bundle */
            bundle: string;
            /** Manifest Sha256 */
            manifest_sha256: string;
            /** Staged At Utc */
            staged_at_utc: string;
            /** Vault Parent */
            vault_parent?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestorePointerUnreadable
         * @description A staged-restore pointer whose file is not valid JSON.
         *
         *     The next start records it as a failed restore, ``pointer_unreadable``,
         *     and clears it; nothing is restored from it.
         */
        RestorePointerUnreadable: {
            /** Bundle */
            bundle: null;
            /** Manifest Sha256 */
            manifest_sha256: null;
            /**
             * Unreadable
             * @constant
             */
            unreadable: true;
        } & {
            [key: string]: unknown;
        };
        /** RestoreRequest */
        RestoreRequest: {
            /**
             * Accept Fk Violations
             * @default false
             */
            accept_fk_violations: boolean;
            /**
             * Confirm
             * @default
             */
            confirm: string;
            /**
             * Path
             * @default
             */
            path: string;
            /**
             * Vault Parent
             * @default
             */
            vault_parent: string;
        };
        /**
         * RestoreRewrites
         * @description What a restore changed in the restored database because it described a process rather than the corpus.
         *
         *     ``executions_interrupted`` counts runs that were ``running`` in the bundle
         *     and are now ``interrupted`` with reason ``unknown``, since no process can
         *     be asked about them; ``deliveries_requeued`` counts deliveries that were
         *     being sent and are queued again.
         */
        RestoreRewrites: {
            /** Deliveries Requeued */
            deliveries_requeued: number;
            /** Executions Interrupted */
            executions_interrupted: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoreStaged
         * @description ``POST /api/restore``: a verified bundle staged; the restore itself runs when a backend next starts.
         *
         *     Nothing has been replaced when this answers. ``staged`` is the pointer
         *     written, and ``report`` the verification it was staged on, the same
         *     report ``POST /api/backup/verify`` answers. ``next_step`` is one sentence
         *     on what will apply the restore on this machine (reopening resmon, or
         *     restarting the background service that holds the database), decided from
         *     the daemon lock as it stood during the request.
         */
        RestoreStaged: {
            /** Next Step */
            next_step: string;
            report: components["schemas"]["BundleReport"];
            staged: components["schemas"]["RestorePointer"];
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoreSucceeded
         * @description The record of a staged restore a backend start applied.
         *
         *     Read from the state directory, where it outlives the version that wrote
         *     it: ``undo_includes_vault``, ``vault_parent`` and ``fk_violations_rows``
         *     are absent from a record resmon 2.3.0 wrote. ``ok`` says the restore's own
         *     checks passed: SQLite's ``integrity_check``, and its foreign-key check
         *     unless the orphan rows were accepted. It does not say the corpus is as the
         *     person remembers it.
         *
         *     ``undo_copy`` is the folder the replaced database was moved to, and with
         *     it the replaced vault when ``undo_includes_vault``; ``None`` when there
         *     was nothing to move. Nothing removes it but
         *     ``POST /api/restore/undo-copy/delete``. ``credentials_to_reenter`` and
         *     the ``fk_violations*`` fields are copied from the bundle's verification
         *     report, so the list fields are ``Any`` as they are there, with the same
         *     caveat ``BundleReport`` gives for a ``NaN`` in a file edited by hand.
         *     ``schema_relation`` is the bundle's schema against the version that
         *     applied it. ``acknowledged`` turns true when the person dismisses the
         *     card, and ``at_utc`` is when the record was written.
         */
        RestoreSucceeded: {
            /** Acknowledged */
            acknowledged: boolean;
            /** At Utc */
            at_utc: string;
            /** Bundle */
            bundle: string;
            /** Credentials To Reenter */
            credentials_to_reenter: unknown[];
            /** Fk Violations */
            fk_violations: unknown[];
            /** Fk Violations Message */
            fk_violations_message: string;
            /** Fk Violations Rows */
            fk_violations_rows?: number | null;
            /** Fk Violations Total */
            fk_violations_total: number;
            /**
             * Ok
             * @constant
             */
            ok: true;
            rewrites: components["schemas"]["RestoreRewrites"];
            /** Schema Relation */
            schema_relation: string;
            /** Undo Copy */
            undo_copy: string | null;
            /** Undo Includes Vault */
            undo_includes_vault?: boolean | null;
            vault: components["schemas"]["RestoredVault"];
            /** Vault Parent */
            vault_parent?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoreUndoCopiesDeleted
         * @description ``POST /api/restore/undo-copy/delete``: the folders restores set aside, deleted.
         *
         *     ``deleted`` is how many folders were listed for deletion. Each is removed
         *     with errors ignored, so it counts folders asked to go, not folders proven
         *     gone; ``GET /api/backup/last`` lists what is still there.
         */
        RestoreUndoCopiesDeleted: {
            /** Deleted */
            deleted: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RestoredVault
         * @description What an applied restore did with the Library vault.
         *
         *     ``restored`` is false, with ``reason`` ``no_vault_in_backup``, when the
         *     bundle carried no vault. Otherwise ``root_path`` is where the vault now is
         *     and ``replaced_kept_at`` where the vault that was there before was moved,
         *     ``None`` when that folder held none. A record resmon 2.3.0 wrote has no
         *     ``replaced_kept_at``.
         */
        RestoredVault: {
            /** Reason */
            reason?: string | null;
            /** Replaced Kept At */
            replaced_kept_at?: string | null;
            /** Restored */
            restored: boolean;
            /** Root Path */
            root_path?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * Routine
         * @description ``GET /api/routines/{routine_id}``: one routine, its switches as
         *     booleans, and every fire it missed, oldest first.
         */
        Routine: {
            /** Ai Enabled */
            ai_enabled: boolean;
            /** Ai Settings */
            ai_settings: string | null;
            /** Created At */
            created_at: string;
            /** Email Ai Summary Enabled */
            email_ai_summary_enabled: boolean;
            /** Email Enabled */
            email_enabled: boolean;
            /** Execution Location */
            execution_location: string | null;
            /** Id */
            id: number;
            /** Intent */
            intent: string | null;
            /** Is Active */
            is_active: boolean;
            /** Last Executed At */
            last_executed_at: string | null;
            /** Missed Fire Details */
            missed_fire_details: components["schemas"]["MissedFire"][];
            missed_fires: components["schemas"]["MissedFires"];
            /** Name */
            name: string;
            /** Notify On Complete */
            notify_on_complete: boolean;
            /** Parameters */
            parameters: string;
            /** Schedule Cron */
            schedule_cron: string;
            /** Storage Settings */
            storage_settings: string | null;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineActivation
         * @description ``POST /api/routines/{routine_id}/activate`` and ``/deactivate``. Only
         *     the schedule changes: the routine and its runs stay.
         */
        RoutineActivation: {
            /** Id */
            id: number;
            /** Is Active */
            is_active: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineCoverage
         * @description ``GET /api/routines/{routine_id}/coverage``: is this routine finding what
         *     was meant, and what is it missing?
         *
         *     ``intent_source`` is ``stated`` for a written intent and ``keywords`` where
         *     none was written and the routine's keywords stand in, which measures the
         *     query against what the query produced. ``cannot_see`` is the sentence that
         *     bounds both lists: resmon compares only against papers it already holds.
         *     ``reason`` says why there is nothing to measure, or is ``None``.
         *     ``summary`` is present whenever the audit itself ran, including to say why
         *     it measured nothing; ``missed_reference_distance`` (the median of this
         *     routine's own distances, which a missed paper must be inside) only when it
         *     measured.
         */
        RoutineCoverage: {
            /** Cannot See */
            cannot_see: string;
            distribution: components["schemas"]["CoverageDistribution"] | null;
            /** Intent */
            intent: string;
            /** Intent Source */
            intent_source: string;
            /** Missed In Corpus */
            missed_in_corpus: components["schemas"]["CoveragePaper"][];
            /** Missed In Corpus Total */
            missed_in_corpus_total: number;
            /** Missed In Corpus Total Is Lower Bound */
            missed_in_corpus_total_is_lower_bound: boolean;
            /** Missed Reference Distance */
            missed_reference_distance?: number | null;
            /** Model */
            model: string | null;
            /** Off Target */
            off_target: components["schemas"]["CoveragePaper"][];
            /** Off Target Total */
            off_target_total: number;
            /** Reason */
            reason: string | null;
            /** Results */
            results: number;
            /** Results Embedded */
            results_embedded: number;
            /** Routine Id */
            routine_id: number;
            /** Routine Name */
            routine_name: string | null;
            /** Summary */
            summary?: string | null;
        } & {
            [key: string]: unknown;
        };
        /** RoutineCreate */
        RoutineCreate: {
            /**
             * Ai Enabled
             * @default false
             */
            ai_enabled: boolean;
            /** Ai Settings */
            ai_settings?: {
                [key: string]: unknown;
            } | null;
            /**
             * Email Ai Summary Enabled
             * @default false
             */
            email_ai_summary_enabled: boolean;
            /**
             * Email Enabled
             * @default false
             */
            email_enabled: boolean;
            /** Intent */
            intent?: string | null;
            /**
             * Is Active
             * @default true
             */
            is_active: boolean;
            /** Name */
            name: string;
            /**
             * Notify On Complete
             * @default false
             */
            notify_on_complete: boolean;
            /** Parameters */
            parameters: {
                [key: string]: unknown;
            };
            /** Schedule Cron */
            schedule_cron: string;
            /** Storage Settings */
            storage_settings?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * RoutineCreated
         * @description ``POST /api/routines``. ``entity`` is present only for a routine that
         *     watches a person, and ``entity_warning`` only when none of its sources can
         *     be asked about one: the routine is still created, and the sentence says it
         *     will find nothing until a source that can is added.
         */
        RoutineCreated: {
            /** Entity */
            entity?: {
                [key: string]: unknown;
            } | null;
            /** Entity Warning */
            entity_warning?: string | null;
            /** Id */
            id: number;
            /** Name */
            name: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineDeliveries
         * @description ``GET /api/routines/{routine_id}/deliveries``: the record, newest
         *     first.
         */
        RoutineDeliveries: {
            /** Deliveries */
            deliveries: components["schemas"]["Delivery"][];
            /** Routine Id */
            routine_id: number;
            summary: components["schemas"]["DeliverySummary"];
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineDocuments
         * @description ``GET /api/routines/{routine_id}/documents``: the papers this routine's
         *     runs collected, newest run first, each once.
         *
         *     ``total`` counts every one; ``document_ids`` stops at ``limit``. Only ids:
         *     what a screen marks on the collection map, not a page of records.
         */
        RoutineDocuments: {
            /** Document Ids */
            document_ids: number[];
            /** Limit */
            limit: number;
            /** Routine Id */
            routine_id: number;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineFiring
         * @description One active routine, and whether anything will fire it.
         *
         *     ``will_fire`` is three-valued on purpose. ``True`` only where this
         *     backend's own scheduler holds the job; ``False`` where nothing can fire it
         *     as things stand; ``None`` where the answer depends on which database a
         *     running service serves, which no resmon so far reports. A two-valued field
         *     would have had to guess the third case one way or the other.
         */
        RoutineFiring: {
            /** Id */
            id: number;
            /**
             * Reason
             * @enum {string}
             */
            reason: "scheduled" | "not_scheduled" | "no_scheduler_running" | "unconfirmed";
            /** Will Fire */
            will_fire: boolean | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineHealth
         * @description ``GET /api/analytics/routine-health``.
         */
        RoutineHealth: {
            /** Insufficient Reason */
            insufficient_reason: string | null;
            /** Minimum Runs */
            minimum_runs: number;
            /** Routines */
            routines: components["schemas"]["RoutineHealthRow"][];
            /** Sample Size */
            sample_size: number;
            /** Stale After */
            stale_after: number;
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineHealthRow
         * @description One watch: what its completed runs found, and its fires that did not run.
         */
        RoutineHealthRow: {
            /** Is Active */
            is_active: boolean;
            /** Last Missed Fire At */
            last_missed_fire_at: string | null;
            /** Last New Result At */
            last_new_result_at: string | null;
            /** Missed Fires */
            missed_fires: number;
            /** Name */
            name: string;
            /** Routine Id */
            routine_id: number;
            /** Runs */
            runs: number;
            /** Runs Since New */
            runs_since_new: number;
            /** Sample Size */
            sample_size: number;
            /** Schedule Cron */
            schedule_cron: string;
            /** Series */
            series: components["schemas"]["RoutineHealthRun"][];
            /** Status */
            status: string;
            /** Sufficient */
            sufficient: boolean;
            /** Total New */
            total_new: number;
        } & {
            [key: string]: unknown;
        };
        /** RoutineHealthRun */
        RoutineHealthRun: {
            /** New Results */
            new_results: number;
            /** Start Time */
            start_time: string | null;
            /** Total Results */
            total_results: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineRow
         * @description One row of ``GET /api/routines``: the ``routines`` row as stored, and
         *     what its latest run did.
         *
         *     The five switches are SQLite's ``0`` and ``1`` here, as this list has always
         *     sent them; the single-routine read below coerces them to booleans. Typed as
         *     sent rather than as meant, so neither body changes. ``parameters``,
         *     ``ai_settings`` and ``storage_settings`` are the stored JSON text, not
         *     parsed objects. ``last_execution`` repeats ``last_executed_at`` under the
         *     name the classic table reads.
         */
        RoutineRow: {
            /** Ai Enabled */
            ai_enabled: number;
            /** Ai Settings */
            ai_settings: string | null;
            /** Created At */
            created_at: string;
            /** Email Ai Summary Enabled */
            email_ai_summary_enabled: number;
            /** Email Enabled */
            email_enabled: number;
            /** Execution Location */
            execution_location: string | null;
            /** Id */
            id: number;
            /** Intent */
            intent: string | null;
            /** Is Active */
            is_active: number;
            /** Last Executed At */
            last_executed_at: string | null;
            /** Last Execution */
            last_execution: string | null;
            /** Last Status */
            last_status: string | null;
            missed_fires: components["schemas"]["MissedFires"];
            /** Name */
            name: string;
            /** Notify On Complete */
            notify_on_complete: number;
            /** Parameters */
            parameters: string;
            /** Schedule Cron */
            schedule_cron: string;
            /** Storage Settings */
            storage_settings: string | null;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineRunStarted
         * @description ``POST /api/routines/{routine_id}/run``: a run started now, outside the
         *     schedule.
         *
         *     ``was_inactive`` says the routine was not scheduled and ran once because it
         *     was asked to, and ``detail`` says so in a sentence. A routine already
         *     running is refused with a 409 whose detail names that run, which is an
         *     error body and not this one.
         */
        RoutineRunStarted: {
            /** Detail */
            detail: string;
            /** Execution Id */
            execution_id: number;
            /** Missed Fires Marked Ran Late */
            missed_fires_marked_ran_late: number;
            /** Routine Id */
            routine_id: number;
            /** Was Inactive */
            was_inactive: boolean;
        } & {
            [key: string]: unknown;
        };
        /** RoutineUpdate */
        RoutineUpdate: {
            /** Ai Enabled */
            ai_enabled?: boolean | null;
            /** Ai Settings */
            ai_settings?: {
                [key: string]: unknown;
            } | null;
            /** Email Ai Summary Enabled */
            email_ai_summary_enabled?: boolean | null;
            /** Email Enabled */
            email_enabled?: boolean | null;
            /** Intent */
            intent?: string | null;
            /** Is Active */
            is_active?: boolean | null;
            /** Name */
            name?: string | null;
            /** Notify On Complete */
            notify_on_complete?: boolean | null;
            /** Parameters */
            parameters?: {
                [key: string]: unknown;
            } | null;
            /** Schedule Cron */
            schedule_cron?: string | null;
            /** Storage Settings */
            storage_settings?: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * RoutineUpdated
         * @description ``PUT /api/routines/{routine_id}``: the id and each column the request
         *     changed, as stored. Absent where unchanged; ``intent`` is ``None`` where
         *     the request cleared it. Switches are stored ``0`` or ``1`` and the JSON
         *     columns as text, which is what this answer repeats.
         */
        RoutineUpdated: {
            /** Ai Enabled */
            ai_enabled?: number | null;
            /** Ai Settings */
            ai_settings?: string | null;
            /** Email Ai Summary Enabled */
            email_ai_summary_enabled?: number | null;
            /** Email Enabled */
            email_enabled?: number | null;
            /** Id */
            id: number;
            /** Intent */
            intent?: string | null;
            /** Is Active */
            is_active?: number | null;
            /** Name */
            name?: string | null;
            /** Notify On Complete */
            notify_on_complete?: number | null;
            /** Parameters */
            parameters?: string | null;
            /** Schedule Cron */
            schedule_cron?: string | null;
            /** Storage Settings */
            storage_settings?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RoutineWatchingProfile
         * @description A routine whose ``parameters.entity`` points at the profile being deleted.
         *
         *     ``mode`` comes out of the routine's JSON blob and is whatever is in there,
         *     so it is optional: a blob with an ``entity`` and no ``mode`` is a real
         *     shape, not a broken one.
         */
        RoutineWatchingProfile: {
            /** Id */
            id: number;
            /** Is Active */
            is_active: boolean;
            /** Mode */
            mode: string | null;
            /** Name */
            name: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * Run
         * @description ``GET /api/executions/{exec_id}``: the row, which backend answered, and the
         *     runs restarted from it (the reverse of ``restarted_from``).
         */
        Run: {
            /** Cancel Reason */
            cancel_reason: string | null;
            coverage: components["schemas"]["RunCoverage"];
            /** Current Stage */
            current_stage: string | null;
            /** Dedup Cross Source */
            dedup_cross_source: number | null;
            /** Dedup Duplicates */
            dedup_duplicates: number | null;
            /** Dedup Invalid */
            dedup_invalid: number | null;
            /** Dedup New */
            dedup_new: number | null;
            /** Dedup Total */
            dedup_total: number | null;
            /** End Time */
            end_time: string | null;
            /** Error Message */
            error_message: string | null;
            /** Execution Type */
            execution_type: string;
            /** Id */
            id: number;
            identity: components["schemas"]["RuntimeIdentity"];
            /** Interrupted Reason */
            interrupted_reason: string | null;
            /** Keywords */
            keywords: string[] | null;
            /** Last Seen At Utc */
            last_seen_at_utc: string | null;
            /** Log Path */
            log_path: string | null;
            /** New Result Count */
            new_result_count: number | null;
            /** New Results */
            new_results: number | null;
            /** Owner Pid */
            owner_pid: number | null;
            /** Owner Runtime Id */
            owner_runtime_id: string | null;
            /** Parameters */
            parameters: string | null;
            /** Progress Events */
            progress_events: string | null;
            /** Query */
            query: string | null;
            /** Repositories */
            repositories: string[] | null;
            /** Request Id */
            request_id: string | null;
            /** Restarted From */
            restarted_from: number | null;
            /** Restarted Into */
            restarted_into: number[];
            /** Result Count */
            result_count: number | null;
            /** Result Path */
            result_path: string | null;
            /** Routine Id */
            routine_id: number | null;
            /** Saved Configuration Id */
            saved_configuration_id: number | null;
            /** Saved Configuration Name */
            saved_configuration_name: string | null;
            source_outcomes: components["schemas"]["RunSourceOutcomes"] | null;
            /** Start Time */
            start_time: string | null;
            /** Status */
            status: string;
            /** Total Results */
            total_results: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunCancelRequested
         * @description ``POST /api/executions/{exec_id}/cancel``. Cancellation is cooperative:
         *     this says it was asked for, not that the run has stopped.
         */
        RunCancelRequested: {
            /**
             * Status
             * @constant
             */
            status: "cancellation_requested";
        } & {
            [key: string]: unknown;
        };
        /**
         * RunCoverage
         * @description Which sources answered a run, as ``source_coverage.build`` accounts for it.
         *
         *     The same object the Results page, a delivery envelope and the search
         *     record read, built from saved facts at read time. ``summary`` is the one
         *     sentence; ``sources`` is the run's selection, in its order, and
         *     ``additional_sources`` what was recorded outside it.
         */
        RunCoverage: {
            /** Additional Sources */
            additional_sources: components["schemas"]["RunCoverageSource"][];
            /** Basis */
            basis: string;
            /** Basis Label */
            basis_label: string;
            counts: components["schemas"]["RunCoverageCounts"];
            /** Execution Id */
            execution_id: number;
            /** Notes */
            notes: string[];
            /** Selection Known */
            selection_known: boolean;
            /** Sources */
            sources: components["schemas"]["RunCoverageSource"][];
            /** Summary */
            summary: string;
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunCoverageCounts
         * @description How the selected sources split. ``genuine_empty`` and ``partial`` are
         *     subsets of ``answered``, not further categories.
         */
        RunCoverageCounts: {
            /** Answered */
            answered: number;
            /** Genuine Empty */
            genuine_empty: number;
            /** Non Answer */
            non_answer: number;
            /** Partial */
            partial: number;
            /** Unknown */
            unknown: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunCoverageSource
         * @description One source's recorded outcome on one run, from ``source_coverage.outcome``.
         *
         *     ``category`` is ``answered``, ``non_answer`` or ``unknown``; ``label`` is
         *     the short reason a person reads, and ``note`` the sentence that explains
         *     it. A selected source with no recorded row is ``unknown`` with
         *     ``outcome_recorded`` false, and every recorded field ``None``: nothing about
         *     an attempt, a failure or an empty answer can be inferred from silence.
         */
        RunCoverageSource: {
            /** Category */
            category: string;
            /** Genuine Empty */
            genuine_empty: boolean;
            /** Label */
            label: string;
            /** Note */
            note: string;
            /** Outcome Recorded */
            outcome_recorded: boolean;
            /** Partial */
            partial: boolean;
            /** Recorded At */
            recorded_at: string | null;
            /** Result Count */
            result_count: number | null;
            /** Source */
            source: string;
            /** Status */
            status: string | null;
            /** Zero Reason */
            zero_reason: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunLog
         * @description ``GET /api/executions/{exec_id}/log``: the run's log as written.
         */
        RunLog: {
            /** Log Text */
            log_text: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunPaper
         * @description One of a run's papers, and where it stands in the reading queue
         *     (``to_read``, ``read``, or ``None`` when it is not saved).
         */
        RunPaper: {
            /** Abstract */
            abstract: string | null;
            /** Authors */
            authors: string | null;
            /** Categories */
            categories: string | null;
            /** Doi */
            doi: string | null;
            /** External Id */
            external_id: string;
            /** First Seen At */
            first_seen_at: string;
            /** Id */
            id: number;
            /** Metadata Hash */
            metadata_hash: string;
            /** Pub Sort */
            pub_sort: string;
            /** Publication Date */
            publication_date: string | null;
            /** Queue Status */
            queue_status: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunPapersPage
         * @description ``GET /api/executions/{exec_id}/documents``: one page of a run's papers.
         */
        RunPapersPage: {
            /** Limit */
            limit: number;
            /** Offset */
            offset: number;
            /** Only New */
            only_new: boolean;
            /** Papers */
            papers: components["schemas"]["RunPaper"][];
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunReport
         * @description ``GET /api/executions/{exec_id}/report``: the Markdown report as written.
         */
        RunReport: {
            /** Report Text */
            report_text: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunRestarted
         * @description ``POST /api/executions/{exec_id}/restart``: a new run with the old one's
         *     parameters, linked back to it. ``duplicate`` as on ``RunStarted``.
         */
        RunRestarted: {
            /** Ai Enabled */
            ai_enabled: boolean;
            /** Duplicate */
            duplicate?: boolean | null;
            /** Execution Id */
            execution_id: number;
            /** Restarted From */
            restarted_from: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunRow
         * @description One row of ``GET /api/executions``, newest first.
         */
        RunRow: {
            /** Cancel Reason */
            cancel_reason: string | null;
            coverage: components["schemas"]["RunCoverage"];
            /** Current Stage */
            current_stage: string | null;
            /** Dedup Cross Source */
            dedup_cross_source: number | null;
            /** Dedup Duplicates */
            dedup_duplicates: number | null;
            /** Dedup Invalid */
            dedup_invalid: number | null;
            /** Dedup New */
            dedup_new: number | null;
            /** Dedup Total */
            dedup_total: number | null;
            /** End Time */
            end_time: string | null;
            /** Error Message */
            error_message: string | null;
            /** Execution Type */
            execution_type: string;
            /** Id */
            id: number;
            /** Interrupted Reason */
            interrupted_reason: string | null;
            /** Keywords */
            keywords: string[] | null;
            /** Last Seen At Utc */
            last_seen_at_utc: string | null;
            /** Log Path */
            log_path: string | null;
            /** New Result Count */
            new_result_count: number | null;
            /** New Results */
            new_results: number | null;
            /** Owner Pid */
            owner_pid: number | null;
            /** Owner Runtime Id */
            owner_runtime_id: string | null;
            /** Parameters */
            parameters: string | null;
            /** Progress Events */
            progress_events: string | null;
            /** Query */
            query: string | null;
            /** Repositories */
            repositories: string[] | null;
            /** Request Id */
            request_id: string | null;
            /** Restarted From */
            restarted_from: number | null;
            /** Result Count */
            result_count: number | null;
            /** Result Path */
            result_path: string | null;
            /** Routine Id */
            routine_id: number | null;
            /** Saved Configuration Id */
            saved_configuration_id: number | null;
            /** Saved Configuration Name */
            saved_configuration_name: string | null;
            source_outcomes: components["schemas"]["RunSourceOutcomes"] | null;
            /** Start Time */
            start_time: string | null;
            /** Status */
            status: string;
            /** Total Results */
            total_results: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * RunSourceOutcomes
         * @description The compact per-run count the list shows on each row.
         *
         *     ``could_not_answer`` counts the zeros that were not answers; ``not_recorded``
         *     the zeros resmon never observed, deliberately folded into neither.
         */
        RunSourceOutcomes: {
            /** Answered */
            answered: number;
            /** Could Not Answer */
            could_not_answer: number;
            /** Not Recorded */
            not_recorded: number;
            /** Selected */
            selected: number;
            /** Sources That Could Not Answer */
            sources_that_could_not_answer: string[];
        } & {
            [key: string]: unknown;
        };
        /**
         * RunStarted
         * @description ``POST /api/search/dive`` and ``POST /api/search/sweep``.
         *
         *     ``duplicate`` is present only when ``request_id`` matched a submission
         *     already made, and the id is that earlier run's: a retried click starts
         *     nothing new. Absent rather than ``false`` on a first submission.
         */
        RunStarted: {
            /** Duplicate */
            duplicate?: boolean | null;
            /** Execution Id */
            execution_id: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * RuntimeIdentity
         * @description Which backend, over which corpus — the attach-or-spawn answer.
         *
         *     This is the shape that exists because an MCP server once fell back to the
         *     default port and answered every question truthfully about the wrong corpus.
         *     ``corpus_id`` and ``build_id`` are ``None`` where the install has not
         *     recorded one; ``runtime_id`` is per process and always present.
         */
        RuntimeIdentity: {
            /** Build Id */
            build_id: string | null;
            /** Contract Version */
            contract_version: number;
            /** Corpus Id */
            corpus_id: string | null;
            /** Runtime Id */
            runtime_id: string;
            /** Schema Version */
            schema_version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SavedConfiguration
         * @description One saved configuration, as the list returns it.
         *
         *     ``parameters`` is a parsed object **here** and a JSON string on the body
         *     ``PUT`` answers — see ``ConfigurationUpdated``. The two really do differ,
         *     the list route parses the column and the write route echoes what it stored,
         *     and declaring both the same way would have made this contract wrong about
         *     one of them. It is ``Any`` rather than ``dict`` because the parse is
         *     best-effort: a column that will not parse is left as its original string.
         */
        SavedConfiguration: {
            /** Config Type */
            config_type: string;
            /** Created At */
            created_at: string;
            /** Id */
            id: number;
            /** Name */
            name: string;
            /** Parameters */
            parameters: unknown;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SchedulerStatus
         * @description ``GET /api/scheduler/status``.
         *
         *     ``service_version`` is the version the running background service reported
         *     (or its lock recorded, where it reported none), and ``None`` where no
         *     service answered. ``routines`` lists the **active** routines only: an
         *     inactive routine is not expected to fire, and a verdict on it would invite a
         *     sentence about nothing.
         */
        SchedulerStatus: {
            /** App Version */
            app_version: string;
            /** Routines */
            routines: components["schemas"]["RoutineFiring"][];
            /** Service Installed */
            service_installed: boolean;
            /** Service Version */
            service_version: string | null;
            /**
             * State
             * @enum {string}
             */
            state: "fires_here" | "no_service" | "service_stopped" | "service_other_version" | "service_elsewhere" | "service_unreachable" | "scheduler_off";
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedAnswer
         * @description ``POST .../answers`` (202), ``GET .../answers/{answer_id}`` and ``POST .../cancel``: one saved answer.
         *
         *     ``state`` is ``admitted`` or ``running``, then one of ``succeeded``,
         *     ``refused``, ``failed``, ``cancelled`` or ``interrupted``. ``result`` is
         *     present only for ``succeeded`` and ``refused``; ``validation`` is then
         *     ``exact_text_identity_only_support_unchecked``, and otherwise
         *     ``unvalidated``. ``current_originals`` is ``not_rechecked``: the saved
         *     excerpts are not a fresh check of the files. ``partial_text`` is what
         *     arrived before the end, unvalidated.
         */
        SelectedAnswer: {
            /** Answer Id */
            answer_id: string;
            /** Cleanup State */
            cleanup_state: string;
            /** Contract Version */
            contract_version: number;
            /** Created At Utc */
            created_at_utc: string;
            /** Current Originals */
            current_originals: string;
            /** Error Code */
            error_code: string | null;
            /** Error Message */
            error_message: string | null;
            /** Finished At Utc */
            finished_at_utc: string | null;
            /** Id */
            id: number;
            /** Limitations */
            limitations: string;
            /** Mode */
            mode: string;
            /** Partial Text */
            partial_text: string;
            /** Project Id */
            project_id: string;
            /** Project Revision */
            project_revision: number;
            /** Reports */
            reports: components["schemas"]["SelectedReport"][];
            request: components["schemas"]["SelectedRequest"];
            /** Request Sha256 */
            request_sha256: string;
            result: components["schemas"]["SelectedResult"] | null;
            /** Started At Utc */
            started_at_utc: string | null;
            /** State */
            state: string;
            usage: components["schemas"]["SelectedUsage"] | null;
            /** Validation */
            validation: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedAnswerRow
         * @description One answer in a project's history, without its request or result.
         */
        SelectedAnswerRow: {
            /** Answer Id */
            answer_id: string;
            /** Cleanup State */
            cleanup_state: string;
            /** Created At Utc */
            created_at_utc: string;
            /** Finished At Utc */
            finished_at_utc: string | null;
            /** Id */
            id: number;
            /** Mode */
            mode: string;
            /** Request Sha256 */
            request_sha256: string;
            /** State */
            state: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedAnswers
         * @description ``GET .../answers``: a project's answers, oldest first, at most 50 a page.
         */
        SelectedAnswers: {
            /** Answers */
            answers: components["schemas"]["SelectedAnswerRow"][];
            /** Contract Version */
            contract_version: number;
            /** Count Basis */
            count_basis: string;
            /** Has More */
            has_more: boolean;
            /** Next After Id */
            next_after_id: number | null;
            /** Project Id */
            project_id: string;
            /** Through Id */
            through_id: number;
            /** Total */
            total: number;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedCitation
         * @description An exact range of a selected source.
         *
         *     It identifies selected text and nothing more: that the quote supports the
         *     item it is attached to is not checked.
         */
        SelectedCitation: {
            /** End Codepoint */
            end_codepoint: number;
            /** Quote */
            quote: string;
            /** Source Id */
            source_id: string;
            /** Start Codepoint */
            start_codepoint: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedCoverage
         * @description What a request carries, counted: files, pages, segments, source bytes and codepoints, and notes.
         */
        SelectedCoverage: {
            /** File Count */
            file_count: number;
            /** Files */
            files: components["schemas"]["SelectedCoverageFile"][];
            /** Note Bytes */
            note_bytes: number;
            /** Note Count */
            note_count: number;
            /** Page Count */
            page_count: number;
            /** Segment Count */
            segment_count: number;
            /** Source Bytes */
            source_bytes: number;
            /** Source Codepoints */
            source_codepoints: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedCoverageFile
         * @description Which pages of one selected version were sent or checked, and how many were not examined.
         *
         *     ``known_page_count`` and ``unexamined_page_count`` are ``None`` where the
         *     page count is not known.
         */
        SelectedCoverageFile: {
            /** Anchor Checked Pages */
            anchor_checked_pages: number[];
            /** File Id */
            file_id: string;
            /** Known Page Count */
            known_page_count: number | null;
            /** Selected Pages */
            selected_pages: number[];
            /** Unexamined Page Count */
            unexamined_page_count: number | null;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedDisclosure
         * @description What sending a request reveals and reads, said before consent.
         *
         *     ``custom_endpoint`` is true when the request goes to a custom API base
         *     URL. The two reads are always true: the selected file bytes are read to
         *     check their digest, and a selected PDF page's structure is examined.
         */
        SelectedDisclosure: {
            /** Custom Endpoint */
            custom_endpoint: boolean;
            /** Limitations */
            limitations: string;
            /** Pdf Structure Examined For Selected Pages */
            pdf_structure_examined_for_selected_pages: boolean;
            /** Retained Digest Reads Selected File Bytes */
            retained_digest_reads_selected_file_bytes: boolean;
            /** Source Strings May Contain Private Material */
            source_strings_may_contain_private_material: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedItem
         * @description One item of an answer: ``source_statement``, ``interpretation``, ``note_summary`` or ``question``.
         *
         *     A source statement or interpretation carries citations; a note summary
         *     carries ``note_ids`` instead and cites no document.
         */
        SelectedItem: {
            /** Citations */
            citations: components["schemas"]["SelectedCitation"][];
            /** Kind */
            kind: string;
            /** Note Ids */
            note_ids: string[];
            /** Text */
            text: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedNote
         * @description An owner note chosen for a request. ``provenance`` is ``owner_note``: a saved local note, not document evidence.
         */
        SelectedNote: {
            anchor: components["schemas"]["SelectedNoteAnchor"] | null;
            /** Body */
            body: string;
            /** Created At Utc */
            created_at_utc: string;
            /** File Id */
            file_id: string;
            /** Kind */
            kind: string;
            /** Note Id */
            note_id: string;
            /** Provenance */
            provenance: string;
            /** Revision */
            revision: number;
            /** Updated At Utc */
            updated_at_utc: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedNoteAnchor
         * @description Where a selected passage note is pinned: one page's text, by hash and codepoint range.
         */
        SelectedNoteAnchor: {
            /** End Codepoint */
            end_codepoint: number;
            /** Extraction Contract */
            extraction_contract: string;
            /** Page Number */
            page_number: number;
            /** Page Text Sha256 */
            page_text_sha256: string;
            /** Quote */
            quote: string;
            /** Start Codepoint */
            start_codepoint: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedPayload
         * @description The exact payload a request sends, which ``request_sha256`` covers.
         *
         *     ``response_contract`` is the fixed description of the answer shape the
         *     runtime is asked for, sent with every request.
         */
        SelectedPayload: {
            coverage: components["schemas"]["SelectedCoverage"];
            disclosure: components["schemas"]["SelectedDisclosure"];
            /** Instruction */
            instruction: string;
            /** Mode */
            mode: string;
            /** Notes */
            notes: components["schemas"]["SelectedNote"][];
            /** Profile */
            profile: string;
            /** Project Id */
            project_id: string;
            /** Project Revision */
            project_revision: number;
            requested: components["schemas"]["SelectedRequested"];
            /** Response Contract */
            response_contract: {
                [key: string]: unknown;
            };
            /** Sources */
            sources: components["schemas"]["SelectedSource"][];
            /** System Sha256 */
            system_sha256: string;
            /** System Version */
            system_version: string;
            /** Vault Id */
            vault_id: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedPreview
         * @description ``POST .../answer-previews``: the exact request a Send would make, before any runtime is called.
         *
         *     It lives in the serving process until ``expires_at_utc`` and is lost on
         *     restart. ``owner_runtime_id`` names the process that holds it.
         */
        SelectedPreview: {
            /** Contract Version */
            contract_version: number;
            /** Expires At Utc */
            expires_at_utc: string;
            /** Owner Runtime Id */
            owner_runtime_id: string;
            /** Preview Id */
            preview_id: string;
            /** Project Id */
            project_id: string;
            request: components["schemas"]["SelectedRequest"];
            /** Request Sha256 */
            request_sha256: string;
            /** Vault Id */
            vault_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedReport
         * @description A model name the runtime reported, where it reported it, and when. Not the model that was asked for.
         */
        SelectedReport: {
            /** Model */
            model: string;
            /** Observed At Utc */
            observed_at_utc: string;
            /** Source */
            source: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedRequest
         * @description A request, immutable once admitted: the payload, the system text, and the exact user prompt with their hashes.
         *
         *     This model and every one inside it declare their fields in sorted key
         *     order, because a saved request, result, report or usage is canonical
         *     JSON with sorted keys, and those are the bytes ``request_sha256`` covers.
         *     A preview's request is the one place the order differs: it is the
         *     assembly's own dictionary, not yet canonicalized.
         */
        SelectedRequest: {
            payload: components["schemas"]["SelectedPayload"];
            /** Request Sha256 */
            request_sha256: string;
            /** System Sha256 */
            system_sha256: string;
            /** System Text */
            system_text: string;
            /** User Prompt */
            user_prompt: string;
            /** User Sha256 */
            user_sha256: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedRequested
         * @description The public half of the runtime choice a request was made with.
         *
         *     ``requested_model`` and ``requested_effort`` are what was asked for. What a
         *     runtime reported it used is in the answer's ``reports``, kept apart, because
         *     the two are different facts. Each ``*_basis`` says where a choice came
         *     from: ``explicit``, a settings or runtime default, or ``not_supported``.
         */
        SelectedRequested: {
            /** Binding Basis */
            binding_basis: string;
            /** Effort Basis */
            effort_basis: string;
            /** Model Basis */
            model_basis: string;
            /** Provider */
            provider: string;
            /** Requested Effort */
            requested_effort: string | null;
            /** Requested Model */
            requested_model: string | null;
            /** Runtime */
            runtime: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedResult
         * @description The validated answer. ``status`` is ``answer`` or ``insufficient_evidence``.
         */
        SelectedResult: {
            /** Limitations */
            limitations: string[];
            /** Mode */
            mode: string;
            /** Request Sha256 */
            request_sha256: string;
            /** Sections */
            sections: components["schemas"]["SelectedSection"][];
            /** Status */
            status: string;
            /** Version */
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedSection
         * @description A section of an answer: ``summary``, ``details``, ``limitations`` or ``questions``.
         */
        SelectedSection: {
            /** Items */
            items: components["schemas"]["SelectedItem"][];
            /** Kind */
            kind: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedSource
         * @description One selected segment, ``S01`` to ``S24``: an exact version's page text, or a range of it.
         *
         *     ``text`` is the literal selected text. ``start_codepoint`` and
         *     ``end_codepoint`` are global Unicode codepoint offsets on the page, end
         *     exclusive, never UTF-16 indices. ``page_count`` is ``None`` where a PDF's
         *     count is not known.
         */
        SelectedSource: {
            /** Byte Size */
            byte_size: number;
            /** End Codepoint */
            end_codepoint: number;
            /** Extraction Contract */
            extraction_contract: string;
            /** File Id */
            file_id: string;
            /** Media Type */
            media_type: string;
            /** Original Name */
            original_name: string;
            /** Page Count */
            page_count: number | null;
            /** Page Number */
            page_number: number;
            /** Page Text Sha256 */
            page_text_sha256: string;
            /** Project Id */
            project_id: string;
            /** Sha256 */
            sha256: string;
            /** Source Id */
            source_id: string;
            /** Source Sha256 */
            source_sha256: string;
            /** Start Codepoint */
            start_codepoint: number;
            /** Text */
            text: string;
            /** Vault Id */
            vault_id: string;
            /** Version Id */
            version_id: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedUsage
         * @description Usage as reported. ``provenance`` is ``runtime_report`` and ``billing`` is ``unknown``: no cost is known.
         */
        SelectedUsage: {
            /** Billing */
            billing: string;
            /** Provenance */
            provenance: string;
            reported: components["schemas"]["SelectedUsageReported"];
        } & {
            [key: string]: unknown;
        };
        /**
         * SelectedUsageReported
         * @description Token counts a runtime reported. Only the counts it reported are present.
         */
        SelectedUsageReported: {
            /** Cache Creation Tokens */
            cache_creation_tokens?: number | null;
            /** Cache Read Tokens */
            cache_read_tokens?: number | null;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
        } & {
            [key: string]: unknown;
        };
        /** ServiceInstallBody */
        ServiceInstallBody: {
            /** Port */
            port?: number | null;
            /**
             * Register
             * @default false
             */
            register: boolean;
        };
        /**
         * ServiceInstalled
         * @description ``POST /api/service/install`` — the unit written, and where.
         */
        ServiceInstalled: {
            /** Installed */
            installed: boolean;
            /** Unit Path */
            unit_path: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ServiceStatus
         * @description ``GET /api/service/status`` — whether the unit file is installed.
         *
         *     ``installed`` is the file's presence at ``unit_path`` and nothing more: an
         *     installed unit says nothing about whether a service is running, which is
         *     ``/api/service/daemon-status``'s question. ``platform`` is ``sys.platform``.
         */
        ServiceStatus: {
            /** Installed */
            installed: boolean;
            /** Platform */
            platform: string;
            /** Unit Path */
            unit_path: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * ServiceUninstalled
         * @description ``POST /api/service/uninstall``.
         *
         *     ``removed`` is whether a file was there to remove: uninstalling a service
         *     that was never installed answers ``installed: false`` and ``removed:
         *     false`` rather than an error.
         */
        ServiceUninstalled: {
            /** Installed */
            installed: boolean;
            /** Removed */
            removed: boolean;
            /** Unit Path */
            unit_path: string;
        } & {
            [key: string]: unknown;
        };
        /** SettingsBody */
        SettingsBody: {
            /** Settings */
            settings: {
                [key: string]: unknown;
            };
        };
        /**
         * SettingsReset
         * @description ``POST /api/admin/reset-settings``: every stored setting cleared, and every AI, repository and SMTP key.
         *
         *     ``settings_cleared`` counts the stored settings deleted; the schema
         *     version marker is kept and not counted. The key counts are of names
         *     cleared, not keys found, and the SMTP password is cleared without being
         *     counted. Configurations, runs and papers are kept.
         */
        SettingsReset: {
            /** Ai Keys Removed */
            ai_keys_removed: number;
            /** Repo Keys Removed */
            repo_keys_removed: number;
            /** Settings Cleared */
            settings_cleared: number;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * SettingsSaved
         * @description What the six plain settings PUTs answer: ``{"success": true}``.
         *
         *     One model for six routes rather than six identical ones. The two PUTs that
         *     answer more than this —  embeddings and execution — have their own, because
         *     a shared model that declared their extra keys would put those keys into the
         *     schema of four routes that never send them.
         */
        SettingsSaved: {
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceContribution
         * @description ``GET /api/analytics/source-contribution``: overlap needs two sources to compare.
         */
        SourceContribution: {
            /** Insufficient Reason */
            insufficient_reason: string | null;
            /** Sample Size */
            sample_size: number;
            /** Sources */
            sources: components["schemas"]["SourceContributionRow"][];
            /** Sufficient */
            sufficient: boolean;
        } & {
            [key: string]: unknown;
        };
        /** SourceContributionRow */
        SourceContributionRow: {
            /** Duplicated */
            duplicated: number;
            /** Source */
            source: string;
            /** Total */
            total: number;
            /** Unique Papers */
            unique_papers: number;
            /** Unique Share */
            unique_share: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceWall
         * @description ``GET /api/coverage/source-wall``: every source's answer to each of the last runs.
         *
         *     Served classified, with every word a screen draws: the legend, the verdict
         *     and the notes. A renderer that re-derived a state from ``status`` and
         *     ``zero_reason`` would be the second place to get it wrong.
         */
        SourceWall: {
            /** Notes */
            notes: string[];
            /** Runs */
            runs: components["schemas"]["SourceWallRun"][];
            /** Sources */
            sources: components["schemas"]["SourceWallSource"][];
            /** State Legend */
            state_legend: components["schemas"]["SourceWallLegendEntry"][];
            /** States */
            states: string[];
            /** Totals */
            totals: {
                [key: string]: number;
            };
            verdict: components["schemas"]["SourceWallVerdict"];
            window: components["schemas"]["SourceWallWindow"];
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceWallCell
         * @description One source's recorded answer to one run, already classified.
         *
         *     ``state`` is one of ``source_wall.WALL_STATES``; ``label`` and ``note`` are
         *     ``source_coverage``'s own words, unedited. ``outcome_recorded`` false is a
         *     run with no row for this source, which reads as not recorded or, where the
         *     run's saved selection says so, not asked. ``in_selection`` is ``None`` when
         *     the run's selection cannot be read.
         */
        SourceWallCell: {
            /** Execution Id */
            execution_id: number;
            /** In Selection */
            in_selection: boolean | null;
            /** Label */
            label: string;
            /** Note */
            note: string;
            /** Outcome Recorded */
            outcome_recorded: boolean;
            /** Partial */
            partial: boolean;
            /** Result Count */
            result_count: number | null;
            /** State */
            state: string;
            /** Status */
            status: string | null;
            /** Zero Reason */
            zero_reason: string | null;
        } & {
            [key: string]: unknown;
        };
        /** SourceWallLegendEntry */
        SourceWallLegendEntry: {
            /** Label */
            label: string;
            /** Meaning */
            meaning: string;
            /** State */
            state: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceWallRun
         * @description One column of the wall: a run, oldest first.
         */
        SourceWallRun: {
            /** Ended At */
            ended_at: string | null;
            /** Execution Id */
            execution_id: number;
            /** Execution Type */
            execution_type: string;
            /** Label */
            label: string;
            /** Started At */
            started_at: string | null;
            /** Status */
            status: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceWallSource
         * @description One row: a source, its cells in run order, and how many of each state.
         */
        SourceWallSource: {
            /** Cells */
            cells: components["schemas"]["SourceWallCell"][];
            /** Counts */
            counts: {
                [key: string]: number;
            };
            /** In Catalog */
            in_catalog: boolean;
            /** Latest Known State */
            latest_known_state: string | null;
            /** Name */
            name: string;
            /** Slug */
            slug: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * SourceWallVerdict
         * @description The sentence at the top. ``level`` is ``empty``, ``ok``, ``attention`` or ``unknown``.
         */
        SourceWallVerdict: {
            /** Detail */
            detail: string[];
            /** Headline */
            headline: string;
            /** Level */
            level: string;
        } & {
            [key: string]: unknown;
        };
        /** SourceWallWindow */
        SourceWallWindow: {
            /** Max */
            max: number;
            /** Requested */
            requested: number;
            /** Returned */
            returned: number;
            /** Runs Available */
            runs_available: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * StarterWatchProfile
         * @description One of the curated profiles that ship with the app.
         *
         *     Not a ``WatchProfile``: a starter is a file on disk, not a row, so it has
         *     no ``id``, no timestamps, and a ``source_file`` instead. Modeling it as a
         *     profile with optional ids would have told a client the two are the same
         *     thing, which is the drift this contract exists to stop.
         */
        StarterWatchProfile: {
            /** Affiliations */
            affiliations: string[];
            /** Basis Warning */
            basis_warning: string | null;
            /** Display Name */
            display_name: string;
            /** Field Hints */
            field_hints: string[];
            /** Identifiers */
            identifiers: {
                [key: string]: components["schemas"]["WatchProfileIdentifier"];
            };
            /** Kind */
            kind: string;
            /** Names */
            names: components["schemas"]["WatchProfileName"][];
            /** Notes */
            notes: string | null;
            /** Source File */
            source_file: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * StarterWatchProfileList
         * @description ``GET /api/profiles/starter``.
         */
        StarterWatchProfileList: {
            /** Profiles */
            profiles: components["schemas"]["StarterWatchProfile"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * StorageSettings
         * @description ``GET /api/settings/storage``.
         */
        StorageSettings: {
            /** Archive After Days */
            archive_after_days: string;
            /** Export Directory */
            export_directory: string;
            /** Pdf Policy */
            pdf_policy: string;
            /** Txt Policy */
            txt_policy: string;
        } & {
            [key: string]: unknown;
        };
        /** SweepRequest */
        SweepRequest: {
            /**
             * Ai Enabled
             * @default false
             */
            ai_enabled: boolean;
            /** Ai Settings */
            ai_settings?: {
                [key: string]: unknown;
            } | null;
            /** Date From */
            date_from?: string | null;
            /** Date To */
            date_to?: string | null;
            /** Ephemeral Credentials */
            ephemeral_credentials?: {
                [key: string]: string;
            } | null;
            /** Keywords */
            keywords?: string[] | null;
            /**
             * Max Results
             * @default 100
             */
            max_results: number;
            /** Query */
            query: string;
            /** Repositories */
            repositories: string[];
            /** Request Id */
            request_id?: string | null;
            /** Saved Configuration Id */
            saved_configuration_id?: number | null;
        };
        /**
         * TestEmailSent
         * @description ``POST /api/settings/email/test`` — a send the SMTP server accepted.
         *
         *     Only the first recipient is sent to, and ``recipient`` names it. Every
         *     failure, an incomplete configuration included, is a 400 whose ``detail``
         *     says which, so this body is the success case alone.
         */
        TestEmailSent: {
            /** Recipient */
            recipient: string;
            /** Success */
            success: boolean;
        } & {
            [key: string]: unknown;
        };
        /**
         * Today
         * @description ``GET /api/today``.
         *
         *     ``window`` is ``since_last_look`` when a look is recorded and
         *     ``first_look`` when none is, in which case ``since`` is seven days before
         *     ``now`` and the interface says so. ``papers`` holds at most 1,000, newest
         *     first; ``total`` counts them all.
         */
        Today: {
            /** From Searches */
            from_searches: number;
            /** Now */
            now: string;
            /** Papers */
            papers: components["schemas"]["TodayPaper"][];
            /** Since */
            since: string | null;
            /** Total */
            total: number;
            /** Watches */
            watches: components["schemas"]["TodayWatch"][];
            /**
             * Window
             * @enum {string}
             */
            window: "since_last_look" | "first_look";
        } & {
            [key: string]: unknown;
        };
        /**
         * TodayLooked
         * @description ``POST /api/today/looked``: the moment recorded.
         */
        TodayLooked: {
            /** Looked At */
            looked_at: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * TodayPaper
         * @description A paper resmon first collected since the last look.
         *
         *     ``abstract_lede`` is the opening of the abstract as the source gave it,
         *     never a summary; resmon does not keep summaries per paper.
         */
        TodayPaper: {
            /** Abstract Lede */
            abstract_lede: string | null;
            /** Authors */
            authors: string | null;
            /** Doi */
            doi: string | null;
            /** First Seen At */
            first_seen_at: string | null;
            /** Id */
            id: number;
            /** Publication Date */
            publication_date: string | null;
            /** Queue Status */
            queue_status: string | null;
            /** Source */
            source: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
            /** Watches */
            watches: number[];
        } & {
            [key: string]: unknown;
        };
        /**
         * TodayRun
         * @description A watch's most recent run.
         */
        TodayRun: {
            /** Ended At */
            ended_at: string | null;
            /** Execution Id */
            execution_id: number;
            /** New Result Count */
            new_result_count: number;
            /** Result Count */
            result_count: number;
            /** Sources Answered */
            sources_answered: number;
            /** Sources Not Answered */
            sources_not_answered: components["schemas"]["TodaySourceNote"][];
            /** Sources Total */
            sources_total: number;
            /** Started At */
            started_at: string | null;
            /** Status */
            status: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * TodaySourceNote
         * @description A source that did not answer on a watch's last run, or whose answer is unknown.
         */
        TodaySourceNote: {
            /** Label */
            label: string;
            /** Note */
            note: string;
            /** Source */
            source: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * TodayWatch
         * @description A routine, with what it found since the last look.
         *
         *     ``next_fire_at`` is what the job store holds, not a promise that anything
         *     will fire it: ``/api/scheduler/status`` says whether something will.
         */
        TodayWatch: {
            /** Id */
            id: number;
            /** Is Active */
            is_active: boolean;
            last_run: components["schemas"]["TodayRun"] | null;
            /** Members */
            members: number[];
            /** Name */
            name: string;
            /** New Count */
            new_count: number;
            /** Next Fire At */
            next_fire_at: string | null;
        } & {
            [key: string]: unknown;
        };
        /** ValidationError */
        ValidationError: {
            /** Context */
            ctx?: Record<string, never>;
            /** Input */
            input?: unknown;
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
        /**
         * VectorExtensionStatus
         * @description Whether sqlite-vec loaded in *this* process, and why not when it did not.
         *
         *     Returned by ``/api/health`` and twice inside the embeddings page. One model
         *     for all three, because they are one function's output: ``extension`` is the
         *     loaded version or ``None``, and exactly one of the two fields is ever set.
         */
        VectorExtensionStatus: {
            /** Extension */
            extension: string | null;
            /** Reason */
            reason: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfile
         * @description A stored watch profile, as every read of one returns it.
         *
         *     ``identifiers`` is keyed by scheme — ``watch_profiles.IDENTIFIER_SCHEMES``
         *     is the closed list of four, and a key outside it never reaches storage.
         *     The map is declared open here because the schema cannot say "one of these
         *     four keys, each optional" without also saying the keys are required, and
         *     the runtime constraint lives in ``_clean_identifiers`` where it belongs.
         *
         *     ``basis_warning`` is the field this journey exists to carry: a sentence
         *     when every match for this profile will be name-only, ``None`` when the
         *     profile can do better. It is computed on every read, never stored, and it
         *     is the field a careless model would have dropped.
         */
        WatchProfile: {
            /** Affiliations */
            affiliations: string[];
            /** Basis Warning */
            basis_warning: string | null;
            /** Created At */
            created_at: string;
            /** Display Name */
            display_name: string;
            /** Field Hints */
            field_hints: string[];
            /** Id */
            id: number;
            /** Identifiers */
            identifiers: {
                [key: string]: components["schemas"]["WatchProfileIdentifier"];
            };
            /** Kind */
            kind: string;
            /** Names */
            names: components["schemas"]["WatchProfileName"][];
            /** Notes */
            notes: string | null;
            /** Updated At */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        /** WatchProfileBody */
        WatchProfileBody: {
            /**
             * Affiliations
             * @default []
             */
            affiliations: string[];
            /**
             * Display Name
             * @default
             */
            display_name: string;
            /**
             * Field Hints
             * @default []
             */
            field_hints: string[];
            /**
             * Identifiers
             * @default {}
             */
            identifiers: {
                [key: string]: unknown;
            };
            /**
             * Kind
             * @default person
             */
            kind: string;
            /**
             * Names
             * @default []
             */
            names: unknown[];
            /** Notes */
            notes?: string | null;
        };
        /**
         * WatchProfileDeleted
         * @description ``DELETE /api/profiles/{profile_id}``.
         *
         *     **The conditionally assembled one.** ``detail`` is added by the handler
         *     only when something was watching the profile, and the route therefore sets
         *     ``response_model_exclude_unset=True`` — as every modeled route does —
         *     so an absent ``detail`` stays absent instead of being serialized as
         *     ``null``. A client distinguishing "no routines were affected" from "one was
         *     and here is the sentence" by key presence keeps working.
         */
        WatchProfileDeleted: {
            /** Deleted */
            deleted: number;
            /** Detail */
            detail?: string | null;
            /** Routines Watching */
            routines_watching: components["schemas"]["RoutineWatchingProfile"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileExport
         * @description ``GET /api/profiles/{profile_id}/export`` — the interchange format.
         *
         *     Ids and timestamps are deliberately absent, because a profile exported from
         *     one resmon and imported into another is the same *person* and not the same
         *     row. ``schema`` is ``watch_profiles.JSON_SCHEMA_VERSION`` and is what the
         *     importer refuses on.
         */
        WatchProfileExport: {
            /** Affiliations */
            affiliations: string[];
            /** Display Name */
            display_name: string;
            /** Field Hints */
            field_hints: string[];
            /** Identifiers */
            identifiers: {
                [key: string]: components["schemas"]["WatchProfileIdentifier"];
            };
            /** Kind */
            kind: string;
            /** Names */
            names: components["schemas"]["WatchProfileName"][];
            /** Notes */
            notes: string | null;
            /** Schema */
            schema: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileIdentifier
         * @description An identifier and the place the user says they got it from.
         */
        WatchProfileIdentifier: {
            /** Cited */
            cited: string;
            /** Value */
            value: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileImportFailure
         * @description One entry of an import file that could not be read, and why.
         *
         *     ``index`` is its position in the submitted list, because the point of
         *     reporting per profile rather than failing the batch is telling the user
         *     which line to look at.
         */
        WatchProfileImportFailure: {
            /** Index */
            index: number;
            /** Reason */
            reason: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileImportResult
         * @description ``POST /api/profiles/import``.
         */
        WatchProfileImportResult: {
            /** Failed */
            failed: components["schemas"]["WatchProfileImportFailure"][];
            /** Imported */
            imported: components["schemas"]["WatchProfile"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileLifecycle
         * @description ``GET /api/profiles/{profile_id}/lifecycle``.
         *
         *     ``checked_documents`` beside ``matched_documents`` is the coverage half:
         *     a profile whose papers have never been through a lifecycle check has no
         *     findings *because nothing looked*, which is a different fact from having
         *     none. ``coverage_note`` says that in a sentence rather than leaving it to
         *     be inferred from two numbers, and a model that dropped it would have turned
         *     the one into the other.
         */
        WatchProfileLifecycle: {
            /** Checked Documents */
            checked_documents: number;
            /** Coverage Note */
            coverage_note: string;
            /** Findings */
            findings: components["schemas"]["WatchProfileLifecycleFinding"][];
            /** Matched Documents */
            matched_documents: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileLifecycleFinding
         * @description A retraction or other lifecycle notice on a paper this profile matched.
         *
         *     A join over findings resmon already holds, never a new claim. Every field
         *     that carries the notice is here — ``notice_url`` is ``NOT NULL`` in
         *     ``document_lifecycle`` and the DOI and date are not — because a finding
         *     rendered without its notice link is resmon asserting a retraction on its
         *     own authority, which it does not do.
         *
         *     ``basis`` and ``matched_author`` come from the match, not the finding, so a
         *     finding on a ``name_only`` match is visibly a finding on a paper that
         *     merely has this name on it.
         */
        WatchProfileLifecycleFinding: {
            /** Basis */
            basis: string;
            /** Document Id */
            document_id: number;
            /** Doi */
            doi: string | null;
            /** First Seen At */
            first_seen_at: string;
            /** Kind */
            kind: string;
            /** Label */
            label: string | null;
            /** Matched Author */
            matched_author: string;
            /** Notice Date */
            notice_date: string | null;
            /** Notice Doi */
            notice_doi: string | null;
            /** Notice Url */
            notice_url: string;
            /** Provider */
            provider: string;
            /** Provider Source */
            provider_source: string | null;
            /** Severity */
            severity: string;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileList
         * @description ``GET /api/profiles``.
         */
        WatchProfileList: {
            /** Profiles */
            profiles: components["schemas"]["WatchProfile"][];
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileMatchPage
         * @description ``GET /api/profiles/{profile_id}/matches``.
         *
         *     ``by_basis`` is a count per basis over the whole profile, not over this
         *     page, which is why it sits beside ``total`` rather than being derived from
         *     ``matches``.
         */
        WatchProfileMatchPage: {
            /** By Basis */
            by_basis: {
                [key: string]: number;
            };
            /** Matches */
            matches: components["schemas"]["WatchProfileMatchRow"][];
            /** Total */
            total: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileMatchRef
         * @description A profile that matched one paper, and the basis it matched on.
         *
         *     The basis rides on every match everywhere it is returned. A match with no
         *     basis is the claim resmon refuses to make: that a paper is by this person,
         *     rather than that a paper has this name on it.
         */
        WatchProfileMatchRef: {
            /** Basis */
            basis: string;
            /** Display Name */
            display_name: string;
            /** Evidence */
            evidence: string | null;
            /** Matched Author */
            matched_author: string;
            /** Profile Id */
            profile_id: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileMatchRow
         * @description One paper matched to a profile, as the matches page lists it.
         *
         *     Every nullable column of ``documents`` is optional here because it is
         *     nullable there: ``title`` and ``source_repository`` are ``NOT NULL`` in the
         *     schema and the rest are not.
         */
        WatchProfileMatchRow: {
            /** Basis */
            basis: string;
            /** Document Id */
            document_id: number;
            /** Doi */
            doi: string | null;
            /** Evidence */
            evidence: string | null;
            /** First Seen At */
            first_seen_at: string;
            /** Matched Author */
            matched_author: string;
            /** Publication Date */
            publication_date: string | null;
            /** Source Repository */
            source_repository: string;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileMatchesByDocument
         * @description ``POST /api/profiles/matches/for-documents``.
         *
         *     **The map with caller-supplied keys.** ``matches`` is keyed by document id
         *     as a string — the handler builds it with ``str(row["document_id"])`` —
         *     and holds only the documents that matched something, so a key's absence
         *     means "nothing matched", not "not asked about".
         */
        WatchProfileMatchesByDocument: {
            /** Matches */
            matches: {
                [key: string]: components["schemas"]["WatchProfileMatchRef"][];
            };
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchProfileName
         * @description One spelling of the watched name.
         *
         *     ``script`` is empty rather than guessed when the value is not ASCII — see
         *     ``watch_profiles._clean_names`` — so it is a string that may be empty, not
         *     an optional one.
         */
        WatchProfileName: {
            /** Script */
            script: string;
            /** Value */
            value: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogCounts
         * @description ``alarms`` is the badge: broken plus unusual, muted ones excluded.
         */
        WatchdogCounts: {
            /** Advice */
            advice: number;
            /** Alarms */
            alarms: number;
            /** Broken */
            broken: number;
            /** Muted */
            muted: number;
            /** Unusual */
            unusual: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogFinding
         * @description One thing the watchdog can say is wrong, with what it rests on.
         *
         *     ``scope`` and ``evidence`` are declared ``dict`` rather than modeled, for
         *     two different reasons, and only one of them is good.
         *
         *     ``evidence`` holds a different key set for each of the seven finding kinds,
         *     so there is no field list to write down and ``dict`` is the description
         *     that fits.
         *
         *     ``scope`` is ``dict`` because a source's scope carries a **string** id and
         *     a routine's carries an **integer** one, and this docstring used to claim
         *     that a model declaring either would silently coerce the other. It would
         *     not: on the pinned pydantic 2.12.4, ``id: str`` fed ``1`` raises rather
         *     than stringifying it, so the mistake would be a 500 the equality sweep
         *     catches and not a wrong body nobody notices. ``Union[str, int]`` is the
         *     right annotation, keeps both runtime types, and would give a client a real
         *     shape instead of ``object``. It is not here because the premise was found
         *     to be wrong after this slice was reviewed, and adding an unreviewed model
         *     to an accepted change is the worse trade. See the module docstring.
         *
         *     ``what_to_do`` is a field, not prose the renderer composes, because the
         *     sentence depends on the finding and a generic one would be advice resmon
         *     has not earned.
         */
        WatchdogFinding: {
            /** Detail */
            detail: string;
            /** Evidence */
            evidence: {
                [key: string]: unknown;
            };
            /** Key */
            key: string;
            /** Kind */
            kind: string;
            /** Muted */
            muted: boolean;
            /** Muted At */
            muted_at: string | null;
            /** Scope */
            scope: {
                [key: string]: unknown;
            };
            /** Severity */
            severity: string;
            /** Title */
            title: string;
            /** What To Do */
            what_to_do: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogMuteAck
         * @description ``POST /api/watchdog/mute`` and ``/unmute``, which differ only in ``status``.
         */
        WatchdogMuteAck: {
            /** Finding Key */
            finding_key: string;
            /** Status */
            status: string;
        } & {
            [key: string]: unknown;
        };
        /** WatchdogMuteRequest */
        WatchdogMuteRequest: {
            /** Finding Key */
            finding_key: string;
            /** Note */
            note?: string | null;
        };
        /**
         * WatchdogReport
         * @description ``GET /api/watchdog``.
         *
         *     ``sufficient`` is false when there is no history to reason over at all. The
         *     interface then says "nothing to check yet" rather than "all clear", which
         *     would be a claim the watchdog has not earned — and it is exactly the field
         *     a model written from the happy path would have left out.
         */
        WatchdogReport: {
            /** Checked At */
            checked_at: string;
            counts: components["schemas"]["WatchdogCounts"];
            /** Findings */
            findings: components["schemas"]["WatchdogFinding"][];
            /** Not Enough Data */
            not_enough_data: components["schemas"]["WatchdogUnjudged"][];
            /** Sufficient */
            sufficient: boolean;
            thresholds: components["schemas"]["WatchdogThresholds"];
            watching: components["schemas"]["WatchdogWatching"];
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogThresholds
         * @description The numbers every rule above was judged against.
         *
         *     Returned rather than documented, so a user reading "has failed on its last
         *     3 runs" can see that 3 is the threshold and not a coincidence.
         */
        WatchdogThresholds: {
            /** Cadence Lag Multiple */
            cadence_lag_multiple: number;
            /** Consecutive Errors */
            consecutive_errors: number;
            /** Consecutive Zeros */
            consecutive_zeros: number;
            /** Flatline Runs */
            flatline_runs: number;
            /** Min Baseline Runs */
            min_baseline_runs: number;
            /** Min Runs For Cadence */
            min_runs_for_cadence: number;
            /** Overdue Cadence Multiple */
            overdue_cadence_multiple: number;
            /** Overdue Floor Days */
            overdue_floor_days: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogUnjudged
         * @description Something the watchdog is watching and cannot judge yet.
         *
         *     The other half of an empty findings list: silence from a monitor means
         *     either "nothing is wrong" or "nothing has been measured", and this list is
         *     the second. ``runs_not_a_measurement`` is present on a source row and
         *     absent on a routine row, so it is optional and the route excludes unset.
         */
        WatchdogUnjudged: {
            /** Reason */
            reason: string;
            /** Runs Needed */
            runs_needed: number;
            /** Runs Not A Measurement */
            runs_not_a_measurement?: number | null;
            /** Runs Recorded */
            runs_recorded: number;
            /** Scope */
            scope: {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        /**
         * WatchdogWatching
         * @description How many sources and active routines the counts above are over.
         */
        WatchdogWatching: {
            /** Routines */
            routines: number;
            /** Sources */
            sources: number;
        } & {
            [key: string]: unknown;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    admin_erase_ai_keys_api_admin_erase_ai_keys_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiKeysErased"];
                };
            };
        };
    };
    admin_erase_app_data_api_admin_erase_app_data_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AppDataErased"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_erase_configs_api_admin_erase_configs_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationsErased"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_erase_corpus_api_admin_erase_corpus_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CorpusErased"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_erase_execution_data_api_admin_erase_execution_data_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionDataErased"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_erase_executions_api_admin_erase_executions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionsErased"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_erase_repo_keys_api_admin_erase_repo_keys_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepositoryKeysErased"];
                };
            };
        };
    };
    admin_factory_reset_api_admin_factory_reset_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FactoryReset"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    admin_reset_settings_api_admin_reset_settings_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsReset"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_ai_models_api_ai_models_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AIModelsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    analytics_discovery_lag_api_analytics_discovery_lag_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DiscoveryLag"];
                };
            };
        };
    };
    analytics_keyword_contribution_api_analytics_keyword_contribution_get: {
        parameters: {
            query?: {
                execution_id?: number | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KeywordContribution"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    analytics_overview_api_analytics_overview_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnalyticsOverview"];
                };
            };
        };
    };
    analytics_publication_volume_api_analytics_publication_volume_get: {
        parameters: {
            query?: {
                group_by?: string;
                months?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicationVolume"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    analytics_routine_health_api_analytics_routine_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineHealth"];
                };
            };
        };
    };
    analytics_source_contribution_api_analytics_source_contribution_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceContribution"];
                };
            };
        };
    };
    analytics_summary_api_analytics_summary_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CorpusSummary"];
                };
            };
        };
    };
    get_appearance_api_appearance_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Appearance"];
                };
            };
        };
    };
    update_appearance_api_appearance_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AppearanceBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Appearance"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    open_assistant_permission_api_assistant_permissions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssistantPermissionOpen"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantPermissionDecision"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    answer_assistant_permission_api_assistant_permissions__request_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssistantPermissionAnswer"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantPermissionAnswered"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_assistant_sessions_api_assistant_sessions_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantSessions"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_assistant_session_api_assistant_sessions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssistantSessionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantSession"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    browse_assistant_sessions_api_assistant_sessions_browse_get: {
        parameters: {
            query?: {
                limit?: number;
                before_id?: number | null;
                through_id?: number | null;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantSessionPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_assistant_session_api_assistant_sessions__session_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantTranscript"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_assistant_session_api_assistant_sessions__session_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantSessionDeleted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_assistant_turn_api_assistant_sessions__session_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantTurnCancelled"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    export_assistant_session_api_assistant_sessions__session_id__export_get: {
        parameters: {
            query: {
                format: string;
            };
            header?: never;
            path: {
                session_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantExport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    send_assistant_message_api_assistant_sessions__session_id__messages_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssistantMessageBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    assistant_status_api_assistant_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantStatus"];
                };
            };
        };
    };
    register_renderer_origin_api_auth_renderer_origin_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RendererOriginBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    backup_now_api_backup_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BackupRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupWritten"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    backup_last_api_backup_last_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupLast"];
                };
            };
        };
    };
    backup_verify_api_backup_verify_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BundleBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    calendar_events_api_calendar_events_get: {
        parameters: {
            query?: {
                start?: string | null;
                end?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CalendarEvent"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cloud_backup_api_cloud_backup_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CloudBackup"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CloudBackupUploaded"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cloud_link_api_cloud_link_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CloudLinked"];
                };
            };
        };
    };
    cloud_status_api_cloud_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CloudStatus"];
                };
            };
        };
    };
    cloud_unlink_api_cloud_unlink_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CloudUnlinked"];
                };
            };
        };
    };
    list_configurations_api_configurations_get: {
        parameters: {
            query?: {
                config_type?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SavedConfiguration"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_configuration_api_configurations_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationCreated"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_configurations_api_configurations_archive_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigExport"];
            };
        };
        responses: {
            /** @description The archive, as a download. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/zip": string;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    export_configurations_api_configurations_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigExport"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationExport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    import_configurations_api_configurations_import_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_import_configurations_api_configurations_import_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationImportResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_configuration_endpoint_api_configurations__config_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                config_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationUpdated"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_configuration_endpoint_api_configurations__config_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                config_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationDeleted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    source_wall_grid_api_coverage_source_wall_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceWall"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    credentials_presence_api_credentials_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialsPresence"];
                };
            };
        };
    };
    validate_credential_api_credentials_validate_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialValidate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    store_credential_endpoint_api_credentials__key_name__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key_name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialStore"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialChanged"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_credential_endpoint_api_credentials__key_name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialChanged"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delivery_bundle_api_deliveries__delivery_id__bundle_get: {
        parameters: {
            query?: {
                exp?: string;
                sig?: string;
            };
            header?: never;
            path: {
                delivery_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    approve_delivery_api_deliveries__delivery_id__deliver_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                delivery_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryActed"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_delivery_api_deliveries__delivery_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                delivery_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryActed"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    skip_delivery_api_deliveries__delivery_id__skip_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                delivery_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryActed"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_document_briefs_api_documents_briefs_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DocumentBriefsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentBrief"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_document_api_documents__doc_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                doc_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Paper"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    document_lifecycle_api_documents__doc_id__lifecycle_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                doc_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    document_why_api_documents__doc_id__why_get: {
        parameters: {
            query?: {
                execution_id?: number | null;
            };
            header?: never;
            path: {
                doc_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaperWhy"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    document_links_api_documents__document_id__links_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                document_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    document_similar_api_documents__document_id__similar_get: {
        parameters: {
            query?: {
                k?: number;
            };
            header?: never;
            path: {
                document_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    start_embedding_backfill_api_embeddings_backfill_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    cancel_embedding_backfill_api_embeddings_backfill_cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    embedding_estimate_api_embeddings_estimate_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    probe_embedding_lane_api_embeddings_probe_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["EmbeddingProbeBody"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rebuild_embedding_index_api_embeddings_rebuild_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    embedding_status_api_embeddings_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmbeddingStatus"];
                };
            };
        };
    };
    evidence_projects_api_evidence_projects_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceProjects"];
                };
            };
        };
    };
    evidence_create_project_api_evidence_projects_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceProjectDetail"];
                };
            };
        };
    };
    evidence_project_detail_api_evidence_projects__project_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceProjectDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_rename_project_api_evidence_projects__project_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceProjectDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_preview_api_evidence_projects__project_id__answer_previews_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SelectedPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_history_api_evidence_projects__project_id__answers_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SelectedAnswers"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_send_api_evidence_projects__project_id__answers_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SelectedAnswer"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_detail_api_evidence_projects__project_id__answers__answer_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                answer_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SelectedAnswer"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_cancel_api_evidence_projects__project_id__answers__answer_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                answer_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SelectedAnswer"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_events_api_evidence_projects__project_id__answers__answer_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                answer_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    selected_answer_export_api_evidence_projects__project_id__answers__answer_id__export_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                answer_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_bundle_api_evidence_projects__project_id__bundle_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_files_api_evidence_projects__project_id__files_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceMembers"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_add_file_api_evidence_projects__project_id__files_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceMemberAdded"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_remove_file_api_evidence_projects__project_id__files__file_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                file_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceMemberRemoved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_notes_api_evidence_projects__project_id__notes_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceNotes"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_create_note_api_evidence_projects__project_id__notes_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceNoteSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_edit_note_api_evidence_projects__project_id__notes__note_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                note_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceNoteSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    evidence_read_api_evidence_projects__project_id__reader__file_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                file_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidencePageText"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_executions_api_executions_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
                type?: string | null;
                routine_id?: number | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunRow"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    active_executions_api_executions_active_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActiveRuns"];
                };
            };
        };
    };
    export_executions_api_executions_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionExport"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_api_executions__exec_id__get: {
        parameters: {
            query?: {
                expected_runtime_id?: string | null;
            };
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Run"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_execution_api_executions__exec_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    download_execution_bundle_api_executions__exec_id__bundle_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The archive, as a download. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/zip": string;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_execution_api_executions__exec_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCancelRequested"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_execution_deliveries_api_executions__exec_id__deliveries_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_papers_api_executions__exec_id__documents_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
                only_new?: boolean;
            };
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunPapersPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_log_api_executions__exec_id__log_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunLog"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_progress_events_api_executions__exec_id__progress_events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_progress_api_executions__exec_id__progress_stream_get: {
        parameters: {
            query?: {
                last_event_id?: number;
            };
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    export_execution_references_api_executions__exec_id__references_get: {
        parameters: {
            query?: {
                format?: string;
                only_new?: boolean;
                include_ids?: boolean;
            };
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_report_api_executions__exec_id__report_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restart_execution_api_executions__exec_id__restart_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RestartRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunRestarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    execution_search_record_api_executions__exec_id__search_record_get: {
        parameters: {
            query?: {
                format?: string;
            };
            header?: never;
            path: {
                exec_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    explorer_export_api_explorer_export_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExplorerExportBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    explorer_facets_api_explorer_facets_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExplorerFilters"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    explorer_search_api_explorer_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExplorerSearchBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExplorerPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    export_selected_references_api_export_references_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReferenceExportBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    health_api_health_get: {
        parameters: {
            query?: {
                expected_runtime_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_status_api_library_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryStatus"];
                };
            };
        };
    };
    library_inventory_api_library_export_get: {
        parameters: {
            query: {
                expected_vault_id: string;
                format?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryInventory"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_list_api_library_files_get: {
        parameters: {
            query: {
                expected_vault_id: string;
                q?: string;
                through_id?: number | null;
                before_id?: number | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryFiles"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_import_api_library_files_post: {
        parameters: {
            query: {
                expected_vault_id: string;
                filename: string;
                document_id?: number | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryImported"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_detail_api_library_files__file_id__get: {
        parameters: {
            query: {
                expected_vault_id: string;
            };
            header?: never;
            path: {
                file_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryFileDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_open_api_library_files__file_id__open_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                file_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryOpenBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryOpened"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_link_api_library_files__file_id__paper_links_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                file_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryLinkBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryLinked"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_read_text_api_library_files__file_id__text_get: {
        parameters: {
            query: {
                expected_vault_id: string;
                expected_version_id: string;
            };
            header?: never;
            path: {
                file_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryText"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    library_create_vault_api_library_vault_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryVaultBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lifecycle_report_api_lifecycle_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    lifecycle_check_api_lifecycle_check_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LifecycleCheckRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lifecycle_for_documents_api_lifecycle_for_documents_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LifecycleForDocumentsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lifecycle_stop_api_lifecycle_stop_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    links_collapse_preview_api_links_collapse_preview_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DocumentIdsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollapsePreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    links_for_documents_api_links_for_documents_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DocumentIdsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaperLinks"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    links_scan_api_links_scan_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    links_scan_cancel_api_links_scan_cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    links_status_api_links_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    get_collection_map_api_map_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollectionMap"];
                };
            };
        };
    };
    onboarding_state_api_onboarding_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OnboardingState"];
                };
            };
        };
    };
    dismiss_onboarding_api_onboarding_dismiss_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OnboardingDismissed"];
                };
            };
        };
    };
    list_watch_profiles_api_profiles_get: {
        parameters: {
            query?: {
                kind?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileList"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_watch_profile_api_profiles_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WatchProfileBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfile"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    import_watch_profiles_api_profiles_import_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProfileImportBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileImportResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    profile_matches_for_documents_api_profiles_matches_for_documents_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProfileMatchesForDocumentsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileMatchesByDocument"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_starter_profiles_api_profiles_starter_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StarterWatchProfileList"];
                };
            };
        };
    };
    get_watch_profile_api_profiles__profile_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfile"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_watch_profile_api_profiles__profile_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WatchProfileBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfile"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_watch_profile_api_profiles__profile_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileDeleted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    export_watch_profile_api_profiles__profile_id__export_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileExport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_watch_profile_lifecycle_api_profiles__profile_id__lifecycle_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileLifecycle"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_watch_profile_matches_api_profiles__profile_id__matches_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                profile_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchProfileMatchPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_reading_queue_api_reading_queue_get: {
        parameters: {
            query?: {
                status?: string | null;
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadingQueuePage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    save_to_reading_queue_api_reading_queue_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReadingQueueSaveBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadingQueueEntry"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_reading_queue_status_api_reading_queue__document_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                document_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReadingQueueStatusBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadingQueueEntry"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_from_reading_queue_api_reading_queue__document_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                document_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadingQueueRemoval"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    renderer_heartbeat_api_renderer_heartbeat_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RendererHeartbeat"];
                };
            };
        };
    };
    repositories_catalog_api_repositories_catalog_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepositoryCatalogEntry"][];
                };
            };
        };
    };
    restore_stage_api_restore_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RestoreRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestoreStaged"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restore_acknowledge_api_restore_acknowledge_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestoreAcknowledged"];
                };
            };
        };
    };
    restore_cancel_api_restore_cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestoreCancelled"];
                };
            };
        };
    };
    restore_delete_undo_api_restore_undo_copy_delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminConfirmBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RestoreUndoCopiesDeleted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_routines_api_routines_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineRow"][];
                };
            };
        };
    };
    create_routine_api_routines_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoutineCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineCreated"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_routine_api_routines__routine_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Routine"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_routine_endpoint_api_routines__routine_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoutineUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineUpdated"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_routine_endpoint_api_routines__routine_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    activate_routine_api_routines__routine_id__activate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineActivation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    routine_coverage_api_routines__routine_id__coverage_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineCoverage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deactivate_routine_api_routines__routine_id__deactivate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineActivation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_routine_deliveries_api_routines__routine_id__deliveries_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineDeliveries"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_routine_delivery_targets_api_routines__routine_id__delivery_targets_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryTargets"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    add_routine_delivery_target_api_routines__routine_id__delivery_targets_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryTargetCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryTargetAdded"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_routine_delivery_target_api_routines__routine_id__delivery_targets__target_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
                target_id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryTargetUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_routine_delivery_target_api_routines__routine_id__delivery_targets__target_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
                target_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    routine_documents_api_routines__routine_id__documents_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineDocuments"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    run_routine_now_api_routines__routine_id__run_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                routine_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoutineRunStarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_scheduler_jobs_api_scheduler_jobs_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    scheduler_status_api_scheduler_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchedulerStatus"];
                };
            };
        };
    };
    search_dive_api_search_dive_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DiveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_repositories_api_search_repositories_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string[];
                };
            };
        };
    };
    search_sweep_api_search_sweep_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SweepRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    service_daemon_status_api_service_daemon_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DaemonStatus"];
                };
            };
        };
    };
    service_install_api_service_install_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ServiceInstallBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceInstalled"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    service_status_api_service_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceStatus"];
                };
            };
        };
    };
    service_uninstall_api_service_uninstall_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ServiceInstallBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceUninstalled"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ai_settings_api_settings_ai_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiSettings"];
                };
            };
        };
    };
    update_ai_settings_api_settings_ai_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_ai_cli_status_api_settings_ai_cli_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiCliStatus"];
                };
            };
        };
    };
    get_assistant_settings_api_settings_assistant_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssistantSettings"];
                };
            };
        };
    };
    update_assistant_settings_api_settings_assistant_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_cloud_settings_api_settings_cloud_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CloudSettings"];
                };
            };
        };
    };
    update_cloud_settings_api_settings_cloud_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_email_settings_api_settings_email_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmailSettings"];
                };
            };
        };
    };
    update_email_settings_api_settings_email_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    send_test_email_endpoint_api_settings_email_test_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TestEmailSent"];
                };
            };
        };
    };
    get_embedding_settings_api_settings_embeddings_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmbeddingSettingsPage"];
                };
            };
        };
    };
    update_embedding_settings_api_settings_embeddings_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmbeddingSettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_settings_api_settings_execution_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionSettings"];
                };
            };
        };
    };
    update_execution_settings_api_settings_execution_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionSettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionSettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_notification_settings_api_settings_notifications_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationSettings"];
                };
            };
        };
    };
    update_notification_settings_api_settings_notifications_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_storage_settings_api_settings_storage_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StorageSettings"];
                };
            };
        };
    };
    update_storage_settings_api_settings_storage_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingsBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SettingsSaved"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_today_api_today_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Today"];
                };
            };
        };
    };
    mark_today_looked_api_today_looked_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TodayLooked"];
                };
            };
        };
    };
    watchdog_report_api_watchdog_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchdogReport"];
                };
            };
        };
    };
    watchdog_mute_api_watchdog_mute_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WatchdogMuteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchdogMuteAck"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    watchdog_unmute_api_watchdog_unmute_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WatchdogMuteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WatchdogMuteAck"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
