# resmon_scripts/implementation_scripts/config_manager.py
"""Configuration management: validation, CRUD, export/import."""

import json
import logging
import sqlite3
import zipfile
from pathlib import Path

from .database import (
    insert_configuration,
    update_configuration,
    delete_configuration as db_delete_configuration,
    get_configurations,
)
from .utils import sanitize_filename

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JSON Schema (Appendix C)
# ---------------------------------------------------------------------------

# The base schema applies to every config_type. Type-specific required
# fields are layered on top in ``validate_config`` because the three stored
# shapes differ:
#   * ``manual_sweep`` — top-level ``repositories`` (array) + ``keywords``.
#   * ``manual_dive``  — top-level singular ``repository`` (string) +
#     ``keywords``; the Deep Dive page intentionally stores a single repo
#     slug rather than a one-element array.
#   * ``routine``      — wrapper payload with ``linked_routine_id``,
#     ``schedule_cron``, and a nested ``parameters`` object that holds the
#     sweep payload. The wrapper is produced by ``_serialize_routine_for_config``
#     in ``resmon.py`` and is not a sweep payload itself.
CONFIG_SCHEMA = {
    "required": ["config_type", "name"],
    "properties": {
        "config_type": {"type": "string", "enum": ["manual_dive", "manual_sweep", "routine"]},
        "name": {"type": "string", "min_length": 1},
        "repository": {"type": "string", "min_length": 1},
        "repositories": {"type": "array", "min_items": 1},
        "keywords": {"type": "array", "min_items": 1},
        "categories": {"type": "object"},
        "date_range_type": {"type": "string", "enum": ["absolute", "relative"]},
        "date_range_value": {"type": "integer", "minimum": 1},
        "date_range_unit": {"type": "string", "enum": ["hours", "days", "weeks"]},
        "date_from": {"type": "string"},
        "date_to": {"type": "string"},
        "max_results_per_repository": {"type": "integer", "minimum": 1, "maximum": 10000},
        "schedule": {"type": "object"},
        "ai_enabled": {"type": "boolean"},
        "ai_settings": {"type": "object"},
        "email_enabled": {"type": "boolean"},
        "email_ai_summary": {"type": "boolean"},
        "storage_settings": {"type": "object"},
    },
}

# Type check map for lightweight validation without jsonschema dependency
_TYPE_MAP = {
    "string": str,
    "integer": int,
    "boolean": bool,
    "array": list,
    "object": dict,
}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_config(config_dict: dict) -> None:
    """Validate a configuration dict against the schema.

    Raises ValueError with details on failure.
    """
    errors: list[str] = []

    # Check base required fields (config_type, name) for every type.
    for field in CONFIG_SCHEMA["required"]:
        if field not in config_dict:
            errors.append(f"Missing required field: '{field}'")
        elif config_dict[field] is None:
            errors.append(f"Required field '{field}' is null")

    # Layer in config_type-specific required fields. The three stored
    # shapes diverge (singular ``repository`` for dive, plural
    # ``repositories`` for sweep, wrapper payload for routine), so a single
    # flat required list cannot cover them all without rejecting valid
    # exports on import.
    config_type = config_dict.get("config_type")
    if config_type == "manual_sweep":
        type_required = ["repositories", "keywords"]
    elif config_type == "manual_dive":
        type_required = ["repository", "keywords"]
    elif config_type == "routine":
        type_required = ["parameters"]
    else:
        type_required = []
    for field in type_required:
        if field not in config_dict:
            errors.append(f"Missing required field: '{field}'")
        elif config_dict[field] is None:
            errors.append(f"Required field '{field}' is null")

    props = CONFIG_SCHEMA["properties"]

    for key, value in config_dict.items():
        if key not in props:
            continue  # Allow extra fields

        spec = props[key]
        expected_type = _TYPE_MAP.get(spec.get("type", ""))

        # Type check
        if expected_type and not isinstance(value, expected_type):
            errors.append(f"Field '{key}' must be {spec['type']}, got {type(value).__name__}")
            continue

        # Enum check
        if "enum" in spec and value not in spec["enum"]:
            errors.append(f"Field '{key}' must be one of {spec['enum']}, got '{value}'")

        # String min_length
        if spec.get("min_length") and isinstance(value, str) and len(value) < spec["min_length"]:
            errors.append(f"Field '{key}' must have at least {spec['min_length']} character(s)")

        # Array min_items
        if spec.get("min_items") and isinstance(value, list) and len(value) < spec["min_items"]:
            errors.append(f"Field '{key}' must have at least {spec['min_items']} item(s)")

        # Integer range
        if isinstance(value, int) and not isinstance(value, bool):
            if "minimum" in spec and value < spec["minimum"]:
                errors.append(f"Field '{key}' must be >= {spec['minimum']}")
            if "maximum" in spec and value > spec["maximum"]:
                errors.append(f"Field '{key}' must be <= {spec['maximum']}")

    if errors:
        raise ValueError("Configuration validation failed:\n  " + "\n  ".join(errors))


# ---------------------------------------------------------------------------
# CRUD operations (wrappers around database.py)
# ---------------------------------------------------------------------------

def save_config(
    conn: sqlite3.Connection,
    name: str,
    config_type: str,
    parameters: dict,
) -> int:
    """Validate and save a configuration. Returns the configuration ID."""
    full_config = {"config_type": config_type, "name": name, **parameters}
    validate_config(full_config)

    config_dict = {
        "name": name,
        "config_type": config_type,
        "parameters": json.dumps(parameters),
    }
    return insert_configuration(conn, config_dict)


def load_config(conn: sqlite3.Connection, config_id: int) -> dict | None:
    """Retrieve a configuration by ID. Returns dict with parsed parameters or None."""
    row = conn.execute(
        "SELECT * FROM saved_configurations WHERE id = ?", (config_id,)
    ).fetchone()
    if row is None:
        return None
    result = dict(row)
    try:
        result["parameters"] = json.loads(result["parameters"])
    except (json.JSONDecodeError, TypeError):
        pass
    return result


def delete_config(conn: sqlite3.Connection, config_id: int) -> None:
    """Delete a configuration by ID."""
    db_delete_configuration(conn, config_id)


# ---------------------------------------------------------------------------
# Export / Import
# ---------------------------------------------------------------------------

def export_configs(
    conn: sqlite3.Connection,
    config_ids: list[int],
    output_path: Path,
) -> Path:
    """Export selected configurations as JSON files packaged in a ZIP archive.

    Returns the output path.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for cid in config_ids:
            config = load_config(conn, cid)
            if config is None:
                logger.warning("Config ID %d not found, skipping export", cid)
                continue

            name_slug = sanitize_filename(config["name"]).replace(" ", "_").lower()
            filename = f"config_{config['config_type']}_{name_slug}_{cid}.json"

            export_data = {
                "config_type": config["config_type"],
                "name": config["name"],
                **(config["parameters"] if isinstance(config["parameters"], dict) else {}),
            }
            zf.writestr(filename, json.dumps(export_data, indent=2))

    logger.info("Exported %d config(s) to %s", len(config_ids), output_path)
    return output_path


# What the import side will take, said once so the refusals and the page help
# can agree with each other.
IMPORT_ACCEPTS = (
    "the .zip that Export Selected writes, or the .json configuration files "
    "inside one"
)

# An exported configuration is a few hundred bytes of JSON. These caps exist
# so that a ZIP chosen by mistake -- or built to be unpleasant -- is refused by
# size rather than decompressed into memory. All three are far above anything
# the export side can produce: the largest configuration shape is a routine
# wrapper, and a user with five hundred saved presets has other problems.
#
# Each cap bounds one thing, and saying which matters, because the first two
# alone do not bound the total. ``_archive_members`` holds every member it
# read until the caller has parsed them, so a per-member limit and a member
# count *multiply*: 512 members of 1 MiB each is 512 MiB resident, which is
# not what a reader of "refused by size rather than decompressed into memory"
# would expect. The third cap is the one that makes that sentence true.
#
#   _MAX_ARCHIVE_MEMBERS  how many entries are looked at at all
#   _MAX_MEMBER_BYTES     the largest single configuration file read
#   _MAX_ARCHIVE_BYTES    the total held in memory at once
_MAX_ARCHIVE_MEMBERS = 512
_MAX_MEMBER_BYTES = 1 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024


def _archive_members(fp: Path, display: str) -> tuple[list[tuple[str, bytes]], list[str]]:
    """Read the JSON members of an exported archive, with their own names.

    Returns the members and the problems worth telling the user about.
    Directory entries and the ``__MACOSX``/``._`` bookkeeping that macOS's
    Archive Utility adds when someone unzips and rezips an export are skipped
    silently -- they are not files the user chose and naming them would read
    as a fault.

    Two kinds of refusal, and the line between them is deliberate: something
    wrong with a single member skips that member and keeps the rest, the way
    the batch treats a bad file; something wrong with the archive as a whole
    -- too many entries, too much in total -- refuses the archive, because
    importing an arbitrary prefix of it is not a result anyone asked for.
    """
    members: list[tuple[str, bytes]] = []
    errors: list[str] = []
    with zipfile.ZipFile(fp) as zf:
        entries = [
            info for info in zf.infolist()
            if not info.is_dir()
            and not info.filename.startswith("__MACOSX/")
            and not Path(info.filename).name.startswith("._")
        ]
        if len(entries) > _MAX_ARCHIVE_MEMBERS:
            errors.append(
                f"{display}: {len(entries)} files inside, more than the "
                f"{_MAX_ARCHIVE_MEMBERS} an export is expected to hold")
            return [], errors
        # Spent against the declared size *before* the member is read, so the
        # budget bounds what is decompressed rather than reporting on it
        # afterwards. zipfile stops a read at the declared uncompressed size
        # and fails the CRC if the real stream disagrees, so the declaration
        # is a bound and not merely a hint.
        remaining = _MAX_ARCHIVE_BYTES
        for info in entries:
            if not info.filename.lower().endswith(".json"):
                continue
            if info.file_size > _MAX_MEMBER_BYTES:
                errors.append(
                    f"{display} ({info.filename}): larger than a saved "
                    "configuration can be, so it was not read")
                continue
            if info.file_size > remaining:
                errors.append(
                    f"{display}: the configuration files inside add up to "
                    f"more than {_MAX_ARCHIVE_BYTES // (1024 * 1024)} MB, so "
                    "none of them were read")
                return [], errors
            raw = zf.read(info)
            remaining -= len(raw)
            members.append((info.filename, raw))
    return members, errors


def import_configs(
    conn: sqlite3.Connection,
    file_paths: list[Path],
    display_names: list[str] | None = None,
) -> tuple[list[int], list[str]]:
    """Import saved configurations from the files a user chose.

    Takes either shape the app can put in a user's hands: the ZIP that
    ``export_configs`` writes, holding one JSON file per configuration, or a
    loose ``.json`` file out of one. This used to take only the second, which
    meant the Configurations page would not read back the single file its own
    Export Selected button produced -- the import refused the archive and the
    journey stopped at the format boundary.

    What a file *is* is decided from its content, never its name. The caller
    writes each upload to a temporary file of its own choosing, so by the time
    a path reaches here its suffix says nothing about what the user picked.
    ``display_names`` carries the names the user does recognise, aligned with
    ``file_paths``; without it the temporary names are used, which is right for
    a caller reading real files off disk.

    Returns the new configuration IDs and, separately, a line per file that
    could not be used. A bad entry reports itself rather than failing the
    batch, because a user who selected six files and mistyped one should get
    the five.
    """
    imported_ids: list[int] = []
    errors: list[str] = []
    names = display_names or []

    for index, fp in enumerate(file_paths):
        fp = Path(fp)
        display = names[index] if index < len(names) else fp.name

        # One JSON document per (source, name) pair, so that a validation
        # failure inside an archive can say which member it was.
        documents: list[tuple[str, bytes]] = []
        if zipfile.is_zipfile(fp):
            try:
                documents, archive_errors = _archive_members(fp, display)
            except (zipfile.BadZipFile, OSError) as exc:
                logger.error("Failed to read export archive %s: %s", display, exc)
                errors.append(f"{display}: could not be read ({exc})")
                continue
            errors.extend(archive_errors)
            if not documents and not archive_errors:
                errors.append(
                    f"{display}: no configuration files inside — expected "
                    f"{IMPORT_ACCEPTS}")
                continue
            documents = [(f"{display} ({member})", raw) for member, raw in documents]
        else:
            try:
                documents = [(display, fp.read_bytes())]
            except OSError as exc:
                logger.error("Failed to read config file %s: %s", display, exc)
                errors.append(f"{display}: could not be read ({exc})")
                continue

        for label, raw in documents:
            # ``json.loads`` on bytes, not an opened text handle: a file that
            # is not UTF-8 raises UnicodeDecodeError from the decoder, which is
            # not a JSONDecodeError and used to escape this handler as a 500.
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                logger.error("Failed to parse config file %s: %s", label, exc)
                errors.append(
                    f"{label}: not a configuration file — expected "
                    f"{IMPORT_ACCEPTS}")
                continue

            if not isinstance(data, dict):
                errors.append(
                    f"{label}: not a configuration file — expected "
                    f"{IMPORT_ACCEPTS}")
                continue

            try:
                validate_config(data)
            except ValueError as exc:
                logger.error("Invalid config file %s: %s", label, exc)
                errors.append(f"{label}: {exc}")
                continue

            name = data.pop("name")
            config_type = data.pop("config_type")
            config_id = save_config(conn, name, config_type, data)
            imported_ids.append(config_id)
            logger.info("Imported config '%s' (ID %d) from %s", name, config_id, label)

    return imported_ids, errors
