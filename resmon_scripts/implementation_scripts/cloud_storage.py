# resmon_scripts/implementation_scripts/cloud_storage.py
"""Google Drive cloud storage integration via OAuth 2.0."""

import logging
from pathlib import Path

from .config import PROJECT_ROOT
from .credential_manager import get_credential, store_credential, delete_credential

logger = logging.getLogger(__name__)

# OAuth 2.0 scopes — file-level access only (least privilege)
_SCOPES = ["https://www.googleapis.com/auth/drive.file"]

# Credential key names used in the OS keyring
_TOKEN_KEY = "google_drive_token"
_CLIENT_ID_KEY = "google_drive_client_id"
_CLIENT_SECRET_KEY = "google_drive_client_secret"


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------

def authorize_google_drive(
    client_secrets_file: str | Path | None = None,
) -> bool:
    """Initiate the OAuth 2.0 flow for Google Drive.

    If *client_secrets_file* is provided, it should be the path to a
    ``credentials.json`` downloaded from Google Cloud Console.  The
    resulting token is serialized and stored securely via
    ``credential_manager``.  No tokens or secrets appear in logs
    (constitution §8).

    Returns True on success, False on failure.
    """
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow

        if client_secrets_file is None:
            client_secrets_file = PROJECT_ROOT / "credentials.json"

        client_secrets_file = Path(client_secrets_file)
        if not client_secrets_file.exists():
            logger.error(
                "Client secrets file not found: %s. "
                "Download it from Google Cloud Console.",
                client_secrets_file,
            )
            return False

        flow = InstalledAppFlow.from_client_secrets_file(
            str(client_secrets_file), scopes=_SCOPES
        )
        creds = flow.run_local_server(port=0)

        # Serialize the token and store it securely
        store_credential(_TOKEN_KEY, creds.to_json())
        logger.info("Google Drive authorization succeeded. Token stored.")
        return True

    except Exception as exc:
        # Never log token or secret contents
        logger.error("Google Drive authorization failed: %s", type(exc).__name__)
        return False


# ---------------------------------------------------------------------------
# Connection check
# ---------------------------------------------------------------------------

def is_token_stored() -> bool:
    """Return True iff a Google Drive OAuth token is persisted locally.

    This reflects only **link state** — whether the user has completed the
    OAuth flow — and does *not* make any network calls. Use
    :func:`probe_api` to test live API reachability.
    """
    return bool(get_credential(_TOKEN_KEY))


def probe_api() -> tuple[bool, str | None]:
    """Probe the Google Drive API with the stored token.

    Returns ``(ok, reason)`` where ``ok`` is ``True`` iff a lightweight
    ``about.get`` call succeeds and ``reason`` is a short human-readable
    string on failure (e.g. ``"drive_api_not_enabled"``) or ``None`` on
    success.
    """
    token_json = get_credential(_TOKEN_KEY)
    if not token_json:
        return False, "no_token"

    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError

        creds = Credentials.from_authorized_user_info(
            _parse_token(token_json), scopes=_SCOPES
        )

        if creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request
            creds.refresh(Request())
            store_credential(_TOKEN_KEY, creds.to_json())

        service = build("drive", "v3", credentials=creds)
        try:
            service.about().get(fields="user").execute()
        except HttpError as http_exc:
            status = getattr(http_exc.resp, "status", None)
            # The payload carries the machine-readable reason — e.g.
            # ``accessNotConfigured`` when the Drive API is disabled on
            # the OAuth project.
            reason = "http_error"
            try:
                import json as _json
                payload = _json.loads(http_exc.content.decode("utf-8"))
                errs = payload.get("error", {}).get("errors") or []
                if errs and isinstance(errs, list):
                    reason = errs[0].get("reason") or reason
            except Exception:
                pass
            logger.warning(
                "Google Drive API probe returned %s (%s).", status, reason
            )
            return False, reason

        logger.info("Google Drive connection verified.")
        return True, None

    except Exception as exc:
        logger.warning("Google Drive connection check failed: %s", type(exc).__name__)
        return False, type(exc).__name__


def check_connection() -> bool:
    """Back-compat wrapper: True iff token stored **and** live probe succeeds.

    Retained for callers that only need a single boolean (e.g.
    ``/api/cloud/backup`` gating). UI status should prefer the explicit
    two-field shape returned by :func:`probe_api`.
    """
    if not is_token_stored():
        return False
    ok, _reason = probe_api()
    return ok


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def upload_file(
    local_path: str | Path,
    cloud_folder: str | None = None,
) -> str | None:
    """Upload a single file to Google Drive.

    *cloud_folder* is the Drive folder ID.  If None, uploads to root.
    Returns the Drive file ID on success, None on failure.
    """
    local_path = Path(local_path)
    if not local_path.is_file():
        logger.error("File not found: %s", local_path)
        return None

    service = _get_drive_service()
    if service is None:
        return None

    try:
        from googleapiclient.http import MediaFileUpload

        file_metadata: dict = {"name": local_path.name}
        if cloud_folder:
            file_metadata["parents"] = [cloud_folder]

        media = MediaFileUpload(str(local_path), resumable=True)
        result = (
            service.files()
            .create(body=file_metadata, media_body=media, fields="id")
            .execute()
        )
        file_id = result.get("id")
        logger.info("Uploaded %s → Drive file ID: %s", local_path.name, file_id)
        return file_id

    except Exception as exc:
        logger.error("Upload failed for %s: %s", local_path.name, type(exc).__name__)
        return None


def _find_or_create_folder(service, name: str, parent_id: str | None = None) -> str | None:
    """Return the Drive file ID of a folder named *name* under *parent_id*,
    creating it if it does not exist. Returns ``None`` on failure.

    With the ``drive.file`` scope, ``files.list`` only returns items this
    app created, so the folder returned here is always the app-owned one.
    """
    try:
        safe_name = name.replace("'", "\\'")
        parent_clause = (
            f"'{parent_id}' in parents" if parent_id else "'root' in parents"
        )
        query = (
            f"name = '{safe_name}' and mimeType = 'application/vnd.google-apps.folder' "
            f"and trashed = false and {parent_clause}"
        )
        results = (
            service.files()
            .list(q=query, fields="files(id, name)", pageSize=1)
            .execute()
        )
        items = results.get("files", [])
        if items:
            return items[0]["id"]

        metadata: dict = {
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
        }
        if parent_id:
            metadata["parents"] = [parent_id]
        folder = service.files().create(body=metadata, fields="id").execute()
        return folder.get("id")
    except Exception as exc:
        logger.error("Folder lookup/create failed for %r: %s", name, type(exc).__name__)
        return None


def upload_directory(
    local_dir: str | Path,
    cloud_folder: str | None = None,
    folder_name: str | None = None,
) -> dict:
    """Upload *local_dir* to Google Drive, mirroring its subdirectory tree.

    Files are placed inside a top-level ``resmon`` folder in the user's
    Drive (created on first use). If *folder_name* is provided, a child
    folder by that name is created under ``resmon`` and used as the
    backup root for this call; otherwise a timestamped folder
    ``backup-YYYYMMDD-HHMMSS`` is used so successive backups do not
    clobber one another.

    Returns a dict with::

        {
            "uploaded_ids": [<file-id>, ...],
            "total_files": <int>,
            "folder_id": <root-folder-id>,
            "folder_name": <root-folder-name>,
            "web_view_link": <url>,
        }

    On hard failure (no service, directory missing) ``uploaded_ids`` is
    empty and ``web_view_link`` is ``None``.
    """
    from datetime import datetime as _dt

    local_dir = Path(local_dir)
    result: dict = {
        "uploaded_ids": [],
        "total_files": 0,
        "folder_id": None,
        "folder_name": None,
        "web_view_link": None,
    }

    if not local_dir.is_dir():
        logger.error("Directory not found: %s", local_dir)
        return result

    service = _get_drive_service()
    if service is None:
        return result

    # Resolve backup root: <My Drive>/resmon/<cloud_folder or folder_name or timestamp>/
    root_id = cloud_folder or _find_or_create_folder(service, "resmon")
    if root_id is None:
        return result

    stamp = folder_name or f"backup-{_dt.now().strftime('%Y%m%d-%H%M%S')}"
    backup_root_id = _find_or_create_folder(service, stamp, parent_id=root_id)
    if backup_root_id is None:
        return result

    # Recursively walk local_dir, mirroring subdirectories in Drive.
    uploaded_ids: list[str] = []
    total_files = 0
    dir_id_cache: dict[Path, str] = {local_dir: backup_root_id}

    for sub in sorted(p for p in local_dir.rglob("*") if p.is_file()):
        total_files += 1
        # Ensure each parent directory exists in Drive (walk from top down).
        rel_parents = sub.parent.relative_to(local_dir).parts
        current_local = local_dir
        current_drive = backup_root_id
        for part in rel_parents:
            current_local = current_local / part
            if current_local in dir_id_cache:
                current_drive = dir_id_cache[current_local]
                continue
            new_id = _find_or_create_folder(service, part, parent_id=current_drive)
            if new_id is None:
                break
            dir_id_cache[current_local] = new_id
            current_drive = new_id
        else:
            fid = upload_file(sub, current_drive)
            if fid:
                uploaded_ids.append(fid)
            continue
        # folder creation failed → skip this file
        logger.warning("Skipped upload (folder-create failed): %s", sub)

    # Fetch web view link for the backup root so the UI can deep-link.
    web_view: str | None = None
    try:
        meta = (
            service.files()
            .get(fileId=backup_root_id, fields="webViewLink")
            .execute()
        )
        web_view = meta.get("webViewLink")
    except Exception as exc:
        logger.warning("Could not fetch webViewLink: %s", type(exc).__name__)

    logger.info(
        "Uploaded %d/%d files from %s into Drive folder %r",
        len(uploaded_ids),
        total_files,
        local_dir,
        stamp,
    )
    result.update(
        uploaded_ids=uploaded_ids,
        total_files=total_files,
        folder_id=backup_root_id,
        folder_name=stamp,
        web_view_link=web_view,
    )
    return result


def upload_paths(
    local_paths: list[str | Path],
    base_dir: str | Path,
    folder_name: str | None = None,
) -> dict:
    """Upload a specific list of files to Google Drive, preserving their
    layout **relative to** *base_dir*.

    Unlike :func:`upload_directory`, which mirrors an entire tree, this
    helper uploads only the files passed in — intended for per-execution
    auto-backup so one run does not re-upload the full reports history.

    *base_dir* is the anchor against which each path's relative location
    (and therefore the mirrored Drive subdirectory) is computed. Files
    outside *base_dir* are uploaded to the backup root with no
    sub-directory prefix.

    Returns the same dict shape as :func:`upload_directory`.
    """
    from datetime import datetime as _dt

    base_dir = Path(base_dir)
    result: dict = {
        "uploaded_ids": [],
        "total_files": 0,
        "folder_id": None,
        "folder_name": None,
        "web_view_link": None,
    }

    # Filter to existing files.
    files: list[Path] = []
    for p in local_paths:
        pp = Path(p)
        if pp.is_file():
            files.append(pp)
        else:
            logger.warning("upload_paths: skipping missing file %s", pp)
    if not files:
        return result

    service = _get_drive_service()
    if service is None:
        return result

    root_id = _find_or_create_folder(service, "resmon")
    if root_id is None:
        return result

    stamp = folder_name or f"backup-{_dt.now().strftime('%Y%m%d-%H%M%S')}"
    backup_root_id = _find_or_create_folder(service, stamp, parent_id=root_id)
    if backup_root_id is None:
        return result

    uploaded_ids: list[str] = []
    dir_id_cache: dict[Path, str] = {base_dir: backup_root_id}

    for sub in files:
        try:
            rel_parent = sub.parent.resolve().relative_to(base_dir.resolve())
            rel_parts = rel_parent.parts
        except ValueError:
            # File lives outside base_dir — upload at backup root.
            rel_parts = ()

        current_local = base_dir
        current_drive = backup_root_id
        ok = True
        for part in rel_parts:
            current_local = current_local / part
            if current_local in dir_id_cache:
                current_drive = dir_id_cache[current_local]
                continue
            new_id = _find_or_create_folder(service, part, parent_id=current_drive)
            if new_id is None:
                ok = False
                break
            dir_id_cache[current_local] = new_id
            current_drive = new_id
        if not ok:
            logger.warning("upload_paths: skipping (folder-create failed) %s", sub)
            continue
        fid = upload_file(sub, current_drive)
        if fid:
            uploaded_ids.append(fid)

    web_view: str | None = None
    try:
        meta = (
            service.files()
            .get(fileId=backup_root_id, fields="webViewLink")
            .execute()
        )
        web_view = meta.get("webViewLink")
    except Exception as exc:
        logger.warning("Could not fetch webViewLink: %s", type(exc).__name__)

    logger.info(
        "Uploaded %d/%d selected files into Drive folder %r",
        len(uploaded_ids),
        len(files),
        stamp,
    )
    result.update(
        uploaded_ids=uploaded_ids,
        total_files=len(files),
        folder_id=backup_root_id,
        folder_name=stamp,
        web_view_link=web_view,
    )
    return result


# ---------------------------------------------------------------------------
# Revoke
# ---------------------------------------------------------------------------

def revoke_authorization() -> bool:
    """Revoke the stored OAuth token and unlink the Google Drive account.

    Returns True if revocation succeeded or no token existed.
    """
    token_json = get_credential(_TOKEN_KEY)
    if not token_json:
        logger.info("No Google Drive token to revoke.")
        return True

    try:
        import httpx
        from google.oauth2.credentials import Credentials

        creds = Credentials.from_authorized_user_info(
            _parse_token(token_json), scopes=_SCOPES
        )
        if creds.token:
            httpx.post(
                "https://oauth2.googleapis.com/revoke",
                params={"token": creds.token},
                timeout=15,
            )

        delete_credential(_TOKEN_KEY)
        logger.info("Google Drive authorization revoked.")
        return True

    except Exception as exc:
        logger.warning("Revocation error: %s", type(exc).__name__)
        # Still delete local token even if remote revoke fails
        delete_credential(_TOKEN_KEY)
        return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_token(token_json: str) -> dict:
    """Deserialize a token JSON string into a dict."""
    import json
    return json.loads(token_json)


def _get_drive_service():
    """Build and return an authorized Google Drive service, or None."""
    token_json = get_credential(_TOKEN_KEY)
    if not token_json:
        logger.error("No Google Drive token stored. Call authorize_google_drive() first.")
        return None

    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_info(
            _parse_token(token_json), scopes=_SCOPES
        )

        if creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request
            creds.refresh(Request())
            store_credential(_TOKEN_KEY, creds.to_json())

        return build("drive", "v3", credentials=creds)

    except Exception as exc:
        logger.error("Failed to build Drive service: %s", type(exc).__name__)
        return None
