"""The contact address resmon gives Crossref and OpenAlex, when the person has set one.

Both ask a client to name a contact address with its requests, so they can
write to someone before blocking a client that misbehaves, and Crossref serves
requests that carry one from its polite pool. An address goes only where the
person has set one in Settings › Sources, and only to these two sources; with
none set, nothing is sent. A placeholder address would name nobody, and would
let one copy of resmon's misbehavior count against every copy.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Optional

#: The ``app_settings`` key.
SETTING = "source_contact_email"
#: The sources the address is sent to, and no others.
SOURCES = ("crossref", "openalex")

_ADDRESS = re.compile(r"^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$")
_LONGEST = 254


def normalized(value: Optional[str]) -> Optional[str]:
    """The address as stored: trimmed, or None for none. Raises ``ValueError`` for one that is not an address."""
    if value is None:
        return None
    address = value.strip()
    if not address:
        return None
    if len(address) > _LONGEST or not _ADDRESS.match(address):
        raise ValueError("That is not an email address: it needs one @ and a domain, and no spaces.")
    return address


def read(conn: sqlite3.Connection) -> Optional[str]:
    """The stored address, or None. One stored by hand that is not an address counts as none."""
    from .database import get_setting

    try:
        return normalized(get_setting(conn, SETTING))
    except (ValueError, sqlite3.Error):
        return None


def client_options(source: str, conn: sqlite3.Connection) -> dict:
    """What a source's client is given when it is made: the address for Crossref and OpenAlex, when one is set."""
    if source not in SOURCES:
        return {}
    address = read(conn)
    return {"mailto": address} if address else {}


def user_agent(address: Optional[str]) -> Optional[str]:
    """The User-Agent that names the address, or None to send the default one."""
    return f"resmon (mailto:{address})" if address else None
