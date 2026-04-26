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


def import_configs(
    conn: sqlite3.Connection,
    file_paths: list[Path],
) -> list[int]:
    """Validate and import JSON configuration files. Returns list of new config IDs."""
    imported_ids: list[int] = []

    for fp in file_paths:
        fp = Path(fp)
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            logger.error("Failed to read config file %s: %s", fp, exc)
            continue

        try:
            validate_config(data)
        except ValueError as exc:
            logger.error("Invalid config file %s: %s", fp, exc)
            continue

        name = data.pop("name")
        config_type = data.pop("config_type")
        config_id = save_config(conn, name, config_type, data)
        imported_ids.append(config_id)
        logger.info("Imported config '%s' (ID %d) from %s", name, config_id, fp)

    return imported_ids
