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
         *     top rather than fifteen times over.
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
        /** AssistantMessageBody */
        AssistantMessageBody: {
            /** Legacy Adoption */
            legacy_adoption?: {
                [key: string]: unknown;
            } | null;
            /** Text */
            text: string;
        };
        /** AssistantPermissionAnswer */
        AssistantPermissionAnswer: {
            /** Allow */
            allow: boolean;
            /** Reason */
            reason?: string | null;
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
        /** CloudBackup */
        CloudBackup: {
            /** Execution Ids */
            execution_ids?: number[] | null;
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
        /** LibraryLinkBody */
        LibraryLinkBody: {
            /** Document Id */
            document_id: number;
            /** Expected Vault Id */
            expected_vault_id: string;
        };
        /** LibraryOpenBody */
        LibraryOpenBody: {
            /** Expected Vault Id */
            expected_vault_id: string;
            /** Expected Version Id */
            expected_version_id: string;
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
        /** SettingsBody */
        SettingsBody: {
            /** Settings */
            settings: {
                [key: string]: unknown;
            };
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
    list_executions_api_executions_get: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
                type?: string | null;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
                    "application/json": unknown;
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
