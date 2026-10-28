"""Turning the engine's answers into lines a person reads.

Two rules govern everything here. A field the engine did not send reads
"not recorded", never a blank that looks like zero or a default that looks like
a fact. And a time is converted to the reader's clock only when the engine said
which zone it was written in: a timestamp stored without one is printed as
stored and says so, because converting it would mean guessing.
"""

from __future__ import annotations

import json
import shutil
import textwrap
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional, TextIO

NOT_RECORDED = "not recorded"

_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")


class Out:
    """Where a command writes, and how wide it may write."""

    def __init__(self, stream: TextIO, width: int) -> None:
        self.stream = stream
        self.width = width
        encoding = getattr(stream, "encoding", None) or "utf-8"
        try:
            "●○⊘✕·–→".encode(encoding)
            self.unicode = True
        except (UnicodeEncodeError, LookupError):
            self.unicode = False

    def line(self, text: str = "") -> None:
        self.stream.write(text + "\n")

    def para(self, text: str, indent: int = 0, hang: Optional[int] = None) -> None:
        """``text`` wrapped to the width; continuation lines indented by ``hang``."""
        lead = " " * indent
        rest = " " * (indent if hang is None else hang)
        wrapped = textwrap.fill(text, width=self.width, initial_indent=lead,
                                subsequent_indent=rest, break_on_hyphens=False,
                                break_long_words=False)
        self.stream.write((wrapped or lead.rstrip()) + "\n")

    def packed(self, items: list[str], sep: str = "  ") -> None:
        """``items`` on as few lines as fit, never breaking one across two."""
        line = ""
        for item in items:
            if line and len(line) + len(sep) + len(item) > self.width:
                self.line(line)
                line = item
            else:
                line = f"{line}{sep}{item}" if line else item
        if line:
            self.line(line)

    def json(self, data: Any) -> None:
        json.dump(data, self.stream, indent=2, ensure_ascii=False)
        self.stream.write("\n")


def terminal_width(env: Mapping[str, str]) -> int:
    raw = env.get("COLUMNS", "")
    width = int(raw) if raw.isdigit() else shutil.get_terminal_size((100, 24)).columns
    return max(60, min(width, 120))


# ---------------------------------------------------------------------------
# Numbers and words
# ---------------------------------------------------------------------------

def count(n: Any) -> str:
    return f"{n:,}" if isinstance(n, int) and not isinstance(n, bool) else NOT_RECORDED


def plural(n: int, singular: str, many: Optional[str] = None) -> str:
    return singular if n == 1 else (many or singular + "s")


def join(names: Iterable[str]) -> str:
    """``a``, ``a and b``, ``a, b, and c``: the Oxford comma."""
    items = list(names)
    if len(items) <= 2:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def authors(value: Optional[str], limit: int = 3) -> str:
    """The stored author string, first ``limit`` names, with how many more."""
    names = [a.strip() for a in (value or "").split(",") if a.strip()]
    if not names:
        return f"authors {NOT_RECORDED}"
    if len(names) <= limit:
        return join(names)
    more = len(names) - limit
    return ", ".join(names[:limit]) + f", and {more} {plural(more, 'other')}"


def link(paper: Mapping[str, Any]) -> Optional[str]:
    doi = (paper.get("doi") or "").strip()
    if doi:
        return doi if doi.startswith("http") else f"https://doi.org/{doi}"
    url = (paper.get("url") or "").strip()
    return url or None


# ---------------------------------------------------------------------------
# Dates and times
# ---------------------------------------------------------------------------

def parse_moment(value: Any, *, assume_utc: bool = False) -> Optional[datetime]:
    """An aware datetime for a value that names its zone, a naive one for a value
    that does not (unless ``assume_utc``), or None for anything unreadable.

    ``assume_utc`` is for the one column whose zone is known without being
    written: ``documents.first_seen_at`` defaults to SQLite's ``datetime('now')``,
    which is UTC by definition, and ``today._iso`` reads it the same way."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"  # Python 3.10's fromisoformat has no "Z"
    if "T" not in text and " " in text:
        text = text.replace(" ", "T", 1)
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None and assume_utc:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def _clock(moment: datetime) -> str:
    hour = moment.hour % 12 or 12
    return f"{hour}:{moment.minute:02d} {'AM' if moment.hour < 12 else 'PM'}"


def when(value: Any, *, long: bool = False, assume_utc: bool = False) -> str:
    """``Oct 28, 2026 2:05 PM EDT``, or ``October 28, 2026, 2:05 PM EDT`` when ``long``."""
    moment = parse_moment(value, assume_utc=assume_utc)
    if moment is None:
        return str(value) if isinstance(value, str) and value.strip() else NOT_RECORDED
    zoned = moment.tzinfo is not None
    if zoned:
        moment = moment.astimezone()
    month = _MONTHS[moment.month - 1]
    if long:
        text = f"{month} {moment.day}, {moment.year}, {_clock(moment)}"
    else:
        text = f"{month[:3]} {moment.day}, {moment.year} {_clock(moment)}"
    return f"{text} {moment.strftime('%Z')}".rstrip() if zoned else f"{text} (time zone not recorded)"


def duration(start: Any, end: Any) -> Optional[str]:
    """How long between two zoned moments, or None when either is missing or unzoned."""
    a, b = parse_moment(start), parse_moment(end)
    if a is None or b is None or a.tzinfo is None or b.tzinfo is None:
        return None
    seconds = int((b - a).total_seconds())
    if seconds < 0:
        return None
    if seconds < 60:
        return f"{seconds} s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes} min {seconds} s" if seconds else f"{minutes} min"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min"


def publication_date(value: Any) -> str:
    """A source's publication date in US form, at the precision the source gave it."""
    if not isinstance(value, str) or not value.strip():
        return NOT_RECORDED
    parts = value.strip()[:10].split("-")
    try:
        year = int(parts[0])
        if len(parts) == 1:
            return str(year)
        month = _MONTHS[int(parts[1]) - 1]
        if len(parts) == 2:
            return f"{month} {year}"
        return f"{month} {int(parts[2])}, {year}"
    except (ValueError, IndexError):
        return value.strip()
