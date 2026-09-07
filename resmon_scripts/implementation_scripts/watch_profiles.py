"""Watch profiles: the people a routine can be pointed at.

Until 2.1 a routine watched *words*. A researcher who wants to know when a
particular person publishes had to guess a keyword query and live with whatever
it caught. A profile is the thing you point a routine at instead: a name, the
identifiers you have for that person, where they work, and nothing resmon
invented.

## The rule this module exists to serve

**An author match is a string match unless the source gives an identifier, and
the product says so.** Everything here is arranged around making that sayable:

* A profile's ``identifiers`` are optional and each carries **where the user got
  it** (``cited``). An identifier nobody can trace back is an assertion, and the
  whole point of an identifier is that it is checkable.
* A profile with **neither an identifier nor an affiliation** is told at
  creation, in words, that every match it can ever produce will be name-only.
  That is ``basis_warning``, and it is returned by the API and by MCP rather
  than left for the interface to remember to say.
* ``field_hints`` are for **disambiguation only** and are never used to search.
  Narrowing a person's papers by topic would silently hide their work, which is
  the opposite of what someone watching a person wants.

## SQLite is the truth; JSON is the interchange

Decision 2. The table is the source of truth because matching joins against
``document_authors`` and the lifecycle tables; the JSON shape below is what
``export`` writes, ``import`` reads, and the starter directory ships. It carries
a ``schema`` field so a file written today can be read by a resmon that has
moved on.

Google Drive backup covers the database, and therefore covers profiles, with no
new code.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from .api_base import bare_orcid

logger = logging.getLogger(__name__)

__all__ = [
    "JSON_SCHEMA_VERSION",
    "ProfileError",
    "STARTER_DIRECTORY",
    "basis_warning_for",
    "create_profile",
    "delete_profile",
    "get_profile",
    "list_profiles",
    "load_starter_profiles",
    "profile_from_json",
    "profile_to_json",
    "update_profile",
    "validate_profile",
]

# The interchange format's own version, independent of the database schema. A
# file is readable when resmon understands its ``schema``; the two numbers move
# for different reasons and conflating them is how an export stops importing.
JSON_SCHEMA_VERSION = 1

KINDS = ("person", "institution", "group")

# The identifier schemes a profile may carry. Each is a *namespace*, and an id
# is never compared across two of them.
IDENTIFIER_SCHEMES = ("orcid", "openalex", "ror", "semantic_scholar")

STARTER_DIRECTORY = Path(__file__).resolve().parent / "assets" / "profiles"

_ROR_RE = re.compile(r"^(?:https?://ror\.org/)?(0[0-9a-hjkmnp-z]{6}\d{2})$", re.I)


class ProfileError(ValueError):
    """A profile that cannot be stored, with a sentence a person can act on."""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _clean_names(raw: Any) -> list[dict]:
    """Names as ``[{"value": ..., "script": ...}]``, canonical first.

    ``script`` is kept because a name written in more than one script is one
    person with two spellings, and a matcher that folded them together would be
    guessing. It defaults to ``latin`` only when the value is entirely ASCII —
    otherwise it stays empty rather than being asserted.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for entry in raw or []:
        if isinstance(entry, str):
            entry = {"value": entry}
        if not isinstance(entry, dict):
            continue
        value = str(entry.get("value") or "").strip()
        if not value or value.lower() in seen:
            continue
        seen.add(value.lower())
        script = str(entry.get("script") or "").strip()
        if not script:
            script = "latin" if value.isascii() else ""
        out.append({"value": value, "script": script})
    return out


def _clean_identifiers(raw: Any) -> dict:
    """Identifiers, each normalised and each carrying its citation.

    An ORCID is stored **bare and upper-cased** by ``api_base.bare_orcid``, for
    the same reason the corpus stores it that way: the profile's id and the
    record's id have to compare equal or an identifier match silently becomes a
    name match.
    """
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for scheme in IDENTIFIER_SCHEMES:
        entry = raw.get(scheme)
        if entry is None:
            continue
        if isinstance(entry, str):
            entry = {"value": entry}
        if not isinstance(entry, dict):
            continue
        value = str(entry.get("value") or "").strip()
        if not value:
            continue
        if scheme == "orcid":
            value = bare_orcid(value) or ""
            if not value:
                raise ProfileError(
                    "That does not look like an ORCID. An ORCID is sixteen digits in "
                    "four groups, like 0000-0002-1825-0097.")
        if scheme == "ror":
            match = _ROR_RE.match(value)
            if not match:
                raise ProfileError(
                    "That does not look like a ROR id. A ROR id looks like "
                    "https://ror.org/02mhbdp94 or 02mhbdp94.")
            value = match.group(1).lower()
        out[scheme] = {"value": value, "cited": str(entry.get("cited") or "").strip()}
    return out


def _clean_strings(raw: Any) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in raw or []:
        text = str(value or "").strip()
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append(text)
    return out


def validate_profile(profile: dict) -> dict:
    """Normalise a profile and refuse one that cannot be stored.

    Refuses only what makes a profile meaningless — no kind, no name. It does
    **not** refuse a profile with no identifier, because a researcher watching
    someone whose ORCID they do not have is a real and common case; what happens
    instead is ``basis_warning``, which says plainly what every match will be.
    """
    kind = str(profile.get("kind") or "person").strip().lower()
    if kind not in KINDS:
        raise ProfileError(f"'{kind}' is not a kind of profile. Use one of: "
                           f"{', '.join(KINDS)}.")

    names = _clean_names(profile.get("names"))
    display = str(profile.get("display_name") or "").strip()
    if not names and display:
        names = _clean_names([display])
    if not names:
        raise ProfileError("A profile needs at least one name.")
    if not display:
        display = names[0]["value"]

    return {
        "kind": kind,
        "display_name": display,
        "names": names,
        "identifiers": _clean_identifiers(profile.get("identifiers")),
        "affiliations": _clean_strings(profile.get("affiliations")),
        "field_hints": _clean_strings(profile.get("field_hints")),
        "notes": (str(profile.get("notes") or "").strip() or None),
    }


def basis_warning_for(profile: dict) -> Optional[str]:
    """What every match for this profile will be, when that is worth saying.

    ``None`` when the profile can produce something better than a name match.
    A sentence when it cannot — returned at creation over the API and over MCP,
    so the interface cannot forget to say it and a harness gets it too.
    """
    identifiers = profile.get("identifiers") or {}
    if identifiers.get("orcid"):
        return None
    if profile.get("affiliations"):
        return (
            "This profile has no ORCID, so a paper can only be matched by name "
            "and affiliation — never by identity. Two researchers with the same "
            "name at the same institution would both match.")
    return (
        "This profile has neither an identifier nor an affiliation, so **every "
        "match will be name-only**: resmon can tell you a paper has this name on "
        "it and nothing more. Add an ORCID, or an affiliation, to do better.")


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def _row_to_profile(row: sqlite3.Row) -> dict:
    profile = {
        "id": row["id"],
        "kind": row["kind"],
        "display_name": row["display_name"],
        "names": json.loads(row["names"] or "[]"),
        "identifiers": json.loads(row["identifiers"] or "{}"),
        "affiliations": json.loads(row["affiliations"] or "[]"),
        "field_hints": json.loads(row["field_hints"] or "[]"),
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    profile["basis_warning"] = basis_warning_for(profile)
    return profile


def create_profile(conn: sqlite3.Connection, profile: dict) -> dict:
    clean = validate_profile(profile)
    cursor = conn.execute(
        "INSERT INTO watch_profiles "
        "(kind, display_name, names, identifiers, orcid, affiliations, "
        " field_hints, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (clean["kind"], clean["display_name"],
         json.dumps(clean["names"], ensure_ascii=False),
         json.dumps(clean["identifiers"], ensure_ascii=False),
         (clean["identifiers"].get("orcid") or {}).get("value"),
         json.dumps(clean["affiliations"], ensure_ascii=False),
         json.dumps(clean["field_hints"], ensure_ascii=False),
         clean["notes"]),
    )
    conn.commit()
    return get_profile(conn, int(cursor.lastrowid))


def update_profile(conn: sqlite3.Connection, profile_id: int, profile: dict) -> Optional[dict]:
    clean = validate_profile(profile)
    cursor = conn.execute(
        "UPDATE watch_profiles SET kind = ?, display_name = ?, names = ?, "
        "identifiers = ?, orcid = ?, affiliations = ?, field_hints = ?, "
        "notes = ?, updated_at = datetime('now') WHERE id = ?",
        (clean["kind"], clean["display_name"],
         json.dumps(clean["names"], ensure_ascii=False),
         json.dumps(clean["identifiers"], ensure_ascii=False),
         (clean["identifiers"].get("orcid") or {}).get("value"),
         json.dumps(clean["affiliations"], ensure_ascii=False),
         json.dumps(clean["field_hints"], ensure_ascii=False),
         clean["notes"], profile_id),
    )
    conn.commit()
    return get_profile(conn, profile_id) if cursor.rowcount else None


def get_profile(conn: sqlite3.Connection, profile_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM watch_profiles WHERE id = ?", (profile_id,)).fetchone()
    return _row_to_profile(row) if row else None


def list_profiles(conn: sqlite3.Connection, kind: str | None = None) -> list[dict]:
    if kind:
        rows = conn.execute(
            "SELECT * FROM watch_profiles WHERE kind = ? ORDER BY display_name",
            (kind,)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM watch_profiles ORDER BY display_name").fetchall()
    return [_row_to_profile(r) for r in rows]


def delete_profile(conn: sqlite3.Connection, profile_id: int) -> bool:
    """Remove a profile and the matches that belong to it — **and nothing else**.

    The corpus is untouched: a match row is a statement about a paper, not the
    paper, and deleting the person you were watching must not delete their work
    out of your library. The foreign key cascades to ``watch_profile_matches``
    and stops there.
    """
    cursor = conn.execute("DELETE FROM watch_profiles WHERE id = ?", (profile_id,))
    conn.commit()
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# The interchange format
# ---------------------------------------------------------------------------

def profile_to_json(profile: dict) -> dict:
    """The documented export shape. Ids and timestamps are deliberately absent.

    A profile exported from one resmon and imported into another is the *same
    person*, not the same row, and carrying the id across would collide with
    whatever occupies it there.
    """
    return {
        "schema": JSON_SCHEMA_VERSION,
        "kind": profile["kind"],
        "display_name": profile["display_name"],
        "names": profile.get("names") or [],
        "identifiers": profile.get("identifiers") or {},
        "affiliations": profile.get("affiliations") or [],
        "field_hints": profile.get("field_hints") or [],
        "notes": profile.get("notes"),
    }


def profile_from_json(document: Any) -> dict:
    """Read one exported profile. Refuses a schema this resmon does not know."""
    if not isinstance(document, dict):
        raise ProfileError("A profile file must be a JSON object.")
    schema = document.get("schema")
    if schema is None:
        raise ProfileError(
            "This file has no 'schema' field, so resmon cannot tell what it is.")
    try:
        schema = int(schema)
    except (TypeError, ValueError):
        raise ProfileError(f"'{schema}' is not a schema version.") from None
    if schema > JSON_SCHEMA_VERSION:
        raise ProfileError(
            f"This profile was written by a newer resmon (schema {schema}; this "
            f"one reads {JSON_SCHEMA_VERSION}). Update resmon to import it.")
    return validate_profile(document)


def load_starter_profiles(directory: Path | None = None) -> list[dict]:
    """The curated starter set that ships with the app.

    Every file is validated on load and a broken one is **skipped with a log
    line** rather than taking the whole picker down: a starter directory is a
    convenience, and one bad file must not make the feature unusable.
    """
    directory = directory or STARTER_DIRECTORY
    out: list[dict] = []
    if not directory.is_dir():
        return out
    for path in sorted(directory.glob("*.json")):
        try:
            profile = profile_from_json(json.loads(path.read_text(encoding="utf-8")))
        except (ProfileError, ValueError, OSError) as exc:
            logger.warning("Starter profile %s could not be read: %s", path.name, exc)
            continue
        profile["source_file"] = path.name
        profile["basis_warning"] = basis_warning_for(profile)
        out.append(profile)
    return out
