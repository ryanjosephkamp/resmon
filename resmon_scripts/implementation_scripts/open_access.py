"""Where an open copy of a paper is, under what license, and who said so.

The sources resmon asks already send this and resmon used to drop it: OpenAlex's
locations (Unpaywall's data), Europe PMC's full-text links and license, PubMed's
PMC id, INSPIRE's arXiv ids, Semantic Scholar's ``openAccessPdf``. arXiv's and
PLOS's PDF addresses are built from the paper's id. A client puts what its
record says on ``NormalizedResult.open_access`` and ``.identifiers``; this
module stores it per paper (schema 27) and answers which copy, if any, resmon
may download.

**The rule for downloading is a stated license.** A copy is downloadable only
when a source states a license for it that is an open one: a Creative Commons
license, a public-domain dedication, or arXiv's own distribution license, which
every arXiv paper carries (an arXiv copy's license is read from arXiv when its
PDF is asked for). "Free to read" with no license, a publisher's own terms
(``publisher-specific-oa``), and Unpaywall's ``other-oa`` and ``implied-oa``
are recorded but never downloaded: the paper's page offers Open at the source
instead. Nothing is downloaded from NASA ADS, Springer, CORE, BMC, or
nature.com, or from a Crossref text-mining link (no client stores those),
whatever license is stated: their terms are not settled for resmon
(``docs/source-landscape.md``). BMC and nature.com are Springer Nature's
journal sites, under the same terms as Springer.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

#: The licenses resmon reads a copy as open under, in the few words a person
#: reads. A license outside this table is recorded as the source said it and
#: never downloaded.
OPEN_LICENSES: dict[str, str] = {
    "cc-by": "CC BY",
    "cc-by-sa": "CC BY-SA",
    "cc-by-nd": "CC BY-ND",
    "cc-by-nc": "CC BY-NC",
    "cc-by-nc-sa": "CC BY-NC-SA",
    "cc-by-nc-nd": "CC BY-NC-ND",
    "cc0": "CC0",
    "public-domain": "public domain",
    "arxiv-nonexclusive": "arXiv's distribution license",
    "arxiv-assumed": "arXiv's distribution license (assumed for 1991 to 2003)",
}

#: What a source can say about a copy that is not an open license. Kept, so the
#: paper's page can say what the source said, and never downloaded.
NOT_OPEN_LICENSES: dict[str, str] = {
    "publisher-specific-oa": "the publisher's own terms",
    "other-oa": "an open-access license the source does not name",
    "implied-oa": "free to read, with no license stated",
}

#: The sources whose links resmon never downloads from, and why, in the words
#: a skipped download gives.
REFUSED_REPORTERS: dict[str, str] = {
    "nasa_ads": "NASA ADS's terms forbid systematic copies of its content.",
    "springer": "Springer's text-and-data-mining terms keep copies only for a project's duration.",
    "core": "CORE's terms require a license and attribution resmon has not settled.",
}

#: Sites resmon never downloads from that are not sources it asks, and why: other
#: sources (OpenAlex, Europe PMC, Semantic Scholar) report PDFs on them.
REFUSED_SITES: dict[str, str] = {
    "bmc": "BMC and nature.com are Springer Nature's journal sites, under the same terms as Springer.",
    "nature": "BMC and nature.com are Springer Nature's journal sites, under the same terms as Springer.",
}

#: Each refused provider as a sentence names it.
REFUSED_NAMES: dict[str, str] = {
    "nasa_ads": "NASA ADS", "springer": "Springer", "core": "CORE", "bmc": "BMC", "nature": "nature.com",
}

#: The hosts resmon never downloads from, by registered domain, whoever reported
#: the copy: the three sources, reached through another source's link, and the
#: two sites.
REFUSED_HOSTS: dict[str, str] = {
    "adsabs.harvard.edu": "nasa_ads",
    "springer.com": "springer",
    "springernature.com": "springer",
    "core.ac.uk": "core",
    "biomedcentral.com": "bmc",
    "nature.com": "nature",
}


def refused_why(provider: str) -> str:
    """Why resmon never downloads from *provider*, a key of ``REFUSED_NAMES``."""
    return REFUSED_REPORTERS.get(provider) or REFUSED_SITES[provider]

#: How a version of a paper is named by the sources, as resmon stores it.
_VERSIONS = {
    "publishedversion": "published", "published": "published", "vor": "published",
    "acceptedversion": "accepted", "accepted": "accepted", "am": "accepted",
    "submittedversion": "submitted", "submitted": "submitted", "preprint": "submitted",
}
#: The order a copy is preferred in: the version of record first.
_VERSION_RANK = {"published": 0, "accepted": 1, "submitted": 2, None: 3}

_CC_URL = re.compile(
    r"creativecommons\.org/(?:licenses/(?P<terms>[a-z-]+)|publicdomain/(?P<pd>zero|mark))", re.I)
_ARXIV_NEW = re.compile(r"^(\d{4}\.\d{4,5})(v\d+)?$")
_ARXIV_OLD = re.compile(r"^([a-z][a-z.-]*/\d{7})(v\d+)?$", re.I)
_DOI = re.compile(r"^10\.\d{4,9}/\S+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_license(raw: object) -> str | None:
    """A license as a source wrote it, as resmon stores it; None when none is stated.

    Reads OpenAlex's slugs (``cc-by-nc``), Europe PMC's words (``cc by-nc``),
    Semantic Scholar's run-together codes (``CCBYNC``), Creative Commons URLs,
    and arXiv's license URLs. Anything else that is not empty is kept in a
    lowercase form, so the page can say what the source said, and is not open.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    lowered = text.lower()
    if "arxiv.org/licenses/nonexclusive-distrib" in lowered:
        return "arxiv-nonexclusive"
    if "arxiv.org/licenses/assumed-1991-2003" in lowered:
        return "arxiv-assumed"
    url = _CC_URL.search(lowered)
    if url:
        if url.group("pd"):
            return "cc0" if url.group("pd") == "zero" else "public-domain"
        return "cc-" + url.group("terms").strip("-")
    squashed = re.sub(r"[\s_./]+", "-", lowered).strip("-")
    if re.match(r"^cc-?(?:0|zero)(?:-|$)", squashed):
        return "cc0"
    if squashed.replace("-", "") in ("publicdomain", "pd", "publicdomainmark"):
        return "public-domain"
    squashed = re.sub(r"(?:-\d+)+$", "", squashed)               # "cc-by-4-0"
    codes = {"ccby": "cc-by", "ccbysa": "cc-by-sa", "ccbynd": "cc-by-nd", "ccbync": "cc-by-nc",
             "ccbyncsa": "cc-by-nc-sa", "ccbyncnd": "cc-by-nc-nd", "ccbyndnc": "cc-by-nc-nd",
             "ccbysanc": "cc-by-nc-sa"}
    joined = squashed.replace("-", "")
    if joined in codes:
        return codes[joined]
    return squashed[:60] or None


def is_open(license_slug: str | None) -> bool:
    return license_slug in OPEN_LICENSES


def license_words(license_slug: str | None) -> str | None:
    """The license in the few words a page shows, or None when none was stated."""
    if license_slug is None:
        return None
    return OPEN_LICENSES.get(license_slug) or NOT_OPEN_LICENSES.get(license_slug) or license_slug


def normalize_version(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    return _VERSIONS.get(raw.strip().lower().replace(" ", ""))


def bare_doi(raw: object) -> str | None:
    """A DOI without its resolver prefix, lowercased (DOIs compare without case)."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    text = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", text, flags=re.I)
    text = re.sub(r"^doi:\s*", "", text, flags=re.I)
    return text.lower() if _DOI.match(text) else None


def bare_arxiv_id(raw: object) -> str | None:
    """An arXiv id without its version, its ``arXiv:`` prefix or its URL.

    ``2401.00001v2`` and ``https://arxiv.org/abs/2401.00001`` are both
    ``2401.00001``; an old-style id keeps its archive: ``hep-th/9901001``.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    text = re.sub(r"^(?:https?://)?(?:www\.|export\.)?arxiv\.org(?::\d+)?/(?:abs|pdf)/", "", text, flags=re.I)
    text = re.sub(r"^arxiv:\s*", "", text, flags=re.I)
    text = re.sub(r"\.pdf$", "", text, flags=re.I)
    for pattern in (_ARXIV_NEW, _ARXIV_OLD):
        match = pattern.match(text)
        if match:
            return match.group(1)
    return None


def host_of(url: str | None) -> str | None:
    if not url:
        return None
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    return host.lower() if host else None


def refused_by_host(url: str | None) -> str | None:
    """The refused provider whose site *url* is on, or None."""
    host = host_of(url)
    if not host:
        return None
    for domain, provider in REFUSED_HOSTS.items():
        if host == domain or host.endswith("." + domain):
            return provider
    return None


@dataclass(frozen=True)
class OpenAccessLocation:
    """One copy of a paper a source says is open, as that source said it.

    ``license`` is None when the source stated none for this copy, which is the
    commonest case and is never read as "open". ``license_basis`` says where the
    license came from (``database.LICENSE_BASES``).
    """

    reported_by: str
    pdf_url: str | None = None
    landing_url: str | None = None
    license: str | None = None
    license_basis: str | None = None
    version: str | None = None

    @property
    def location(self) -> str:
        return self.pdf_url or self.landing_url or ""

    @property
    def host(self) -> str | None:
        return host_of(self.location)


def location(reported_by: str, *, pdf_url: object = None, landing_url: object = None,
             license: object = None, version: object = None,
             basis: str = "record") -> OpenAccessLocation | None:
    """A location from a source's fields, or None when it names no https or http address."""
    def url(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        text = value.strip()
        return text if text.lower().startswith(("https://", "http://")) and len(text) <= 2000 else None

    pdf, landing = url(pdf_url), url(landing_url)
    if not pdf and not landing:
        return None
    slug = normalize_license(license)
    return OpenAccessLocation(
        reported_by=reported_by, pdf_url=pdf, landing_url=landing, license=slug,
        license_basis=basis if slug else None, version=normalize_version(version))


#: Where a watch's automatic fetch of an arXiv PDF goes. Checked on arXiv's own
#: pages on November 5, 2026:
#:
#: * arXiv Bulk Data Access (https://info.arxiv.org/help/bulk_data.html) asks
#:   that tools that harvest use the dedicated site export.arxiv.org, and links
#:   full-text tools back to arXiv for downloads.
#: * Terms of Use for arXiv APIs (https://info.arxiv.org/help/api/tou.html): no
#:   more than one request every three seconds, on a single connection, across
#:   all of a user's machines; and direct users to arxiv.org for e-print content.
#: * arxiv.org's robots.txt (https://arxiv.org/robots.txt) says indiscriminate
#:   automated downloads are not permitted, with a 15-second crawl delay for
#:   crawlers. export.arxiv.org's robots.txt (https://export.arxiv.org/robots.txt)
#:   disallows every path to crawlers; resmon is not one: it fetches only the PDFs
#:   a watch's new papers have, at most ``full_text.PER_RUN_CAP`` a run.
#:
#: So a watch's fetch, which no person clicked, goes to export.arxiv.org, paced
#: by the one limiter every request there shares (``api_arxiv._RATE_LIMITER``,
#: three seconds apart); a person's Get the PDF stays on arxiv.org, where arXiv
#: asks that people be sent.
ARXIV_EXPORT_HOST = "export.arxiv.org"


def fetch_address(url: str, requested_by: str) -> str:
    """Where a download fetches *url* from: a watch's arXiv PDF from export.arxiv.org, anything else as it is."""
    if requested_by != "watch" or host_of(url) != "arxiv.org":
        return url
    parts = urlsplit(url)
    if not parts.path.startswith("/pdf/"):
        return url
    netloc = ARXIV_EXPORT_HOST + (f":{parts.port}" if parts.port else "")
    return urlunsplit(("https", netloc, parts.path, parts.query, ""))


def arxiv_location(arxiv_id: str, reported_by: str) -> OpenAccessLocation:
    """arXiv's own copy, built from the id. Its license is read from arXiv when asked for."""
    return OpenAccessLocation(
        reported_by=reported_by,
        pdf_url=f"https://arxiv.org/pdf/{arxiv_id}",
        landing_url=f"https://arxiv.org/abs/{arxiv_id}",
        version="submitted",
    )


#: The journal each PLOS DOI's middle part names, as journals.plos.org spells it.
_PLOS_JOURNALS = {
    "pone": "plosone", "pbio": "plosbiology", "pmed": "plosmedicine",
    "pcbi": "ploscompbiol", "pgen": "plosgenetics", "ppat": "plospathogens",
    "pntd": "plosntds", "pclm": "climate", "pwat": "water", "pdig": "digitalhealth",
    "pgph": "globalpublichealth", "pmen": "mentalhealth", "pstr": "sustainabilitytransformation",
    "pcsy": "complexsystems",
}


def plos_location(doi: str) -> OpenAccessLocation | None:
    """PLOS's own PDF of an article, from its DOI, under PLOS's license.

    PLOS publishes every article under CC BY 4.0 (a few, by U.S. government
    authors, under CC0): https://plos.org/terms-of-use/. Its search API does
    not say which, so resmon records CC BY from that policy, with the basis
    ``host_policy``; for a CC0 article that understates what is allowed, never
    overstates it.
    """
    match = re.match(r"^10\.1371/journal\.([a-z]{4})\.\d+$", doi or "", re.I)
    if not match or match.group(1).lower() not in _PLOS_JOURNALS:
        return None
    journal = _PLOS_JOURNALS[match.group(1).lower()]
    return OpenAccessLocation(
        reported_by="plos",
        pdf_url=f"https://journals.plos.org/{journal}/article/file?id={doi}&type=printable",
        landing_url=f"https://journals.plos.org/{journal}/article?id={doi}",
        license="cc-by", license_basis="host_policy", version="published",
    )


@dataclass
class OpenAccessRecord:
    """What one source's record says about open copies and other identifiers."""

    locations: list[OpenAccessLocation] = field(default_factory=list)
    identifiers: list[tuple[str, str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def record(conn: sqlite3.Connection, document_id: int, reported_by: str,
           locations: Iterable[OpenAccessLocation], identifiers: Iterable[tuple[str, str]],
           *, seen_at: str | None = None) -> None:
    """Store what one source's record said about a stored paper. Idempotent.

    A location already held from that source is refreshed: ``seen_at`` moves,
    and a license or version the source states now is kept, while one it no
    longer states is not erased (a source that stopped saying does not make
    the earlier statement untrue). An arXiv id adds arXiv's own copy.
    Nothing is committed here; the caller's transaction holds it.
    """
    stamp = seen_at or now_iso()
    rows = list(locations)
    clean_ids: list[tuple[str, str]] = []
    for scheme, value in identifiers:
        if scheme == "arxiv":
            value = bare_arxiv_id(value) or ""
        elif scheme == "pmcid":
            value = value.strip().upper()
            value = value if re.match(r"^PMC\d+$", value) else ""
        elif scheme == "pmid":
            value = value.strip()
            value = value if value.isdigit() else ""
        if value and (scheme, value) not in clean_ids:
            clean_ids.append((scheme, value))
    for scheme, value in clean_ids:
        conn.execute(
            "INSERT INTO document_identifiers (document_id, scheme, value, reported_by, seen_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, scheme, value) DO UPDATE SET "
            "seen_at = excluded.seen_at", (document_id, scheme, value, reported_by, stamp))
        if scheme == "arxiv":
            rows.append(arxiv_location(value, reported_by))
    for item in rows:
        if not item.location:
            continue
        conn.execute(
            "INSERT INTO document_open_access (document_id, reported_by, location, pdf_url, "
            "landing_url, license, license_basis, version, host, first_seen_at, seen_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(document_id, reported_by, location) DO UPDATE SET "
            "pdf_url = COALESCE(excluded.pdf_url, pdf_url), "
            "landing_url = COALESCE(excluded.landing_url, landing_url), "
            "license = COALESCE(excluded.license, license), "
            "license_basis = CASE WHEN excluded.license IS NOT NULL THEN excluded.license_basis "
            "ELSE license_basis END, "
            "version = COALESCE(excluded.version, version), seen_at = excluded.seen_at",
            (document_id, item.reported_by, item.location, item.pdf_url, item.landing_url,
             item.license, item.license_basis, item.version, item.host, stamp, stamp))


def set_license(conn: sqlite3.Connection, location_id: int, license_slug: str, basis: str) -> None:
    """Record a license read for one location after it was stored (arXiv's, read from arXiv)."""
    conn.execute(
        "UPDATE document_open_access SET license = ?, license_basis = ?, seen_at = ? WHERE id = ?",
        (license_slug, basis, now_iso(), int(location_id)))
    conn.commit()


#: How many other copies of a paper are read with it. A DOI shared by more
#: records than this is not one paper's.
MAX_COPIES = 25


def copies_of(conn: sqlite3.Connection, document_id: int) -> list[int]:
    """This paper and every stored copy of it: the same DOI, or the same arXiv id.

    The paper itself first. A copy is a record another source holds of the same
    work; a near-identical title alone does not make one.
    """
    row = conn.execute("SELECT id, doi FROM documents WHERE id = ?", (int(document_id),)).fetchone()
    if row is None:
        return []
    found = [int(row[0])]
    doi = bare_doi(row[1])
    if doi:
        for (other,) in conn.execute(
                "SELECT id FROM documents WHERE lower(doi) = ? AND id != ? ORDER BY id LIMIT ?",
                (doi, int(document_id), MAX_COPIES)):
            found.append(int(other))
    for (other,) in conn.execute(
            "SELECT DISTINCT b.document_id FROM document_identifiers a "
            "JOIN document_identifiers b ON b.scheme = a.scheme AND b.value = a.value "
            "WHERE a.document_id = ? AND a.scheme = 'arxiv' AND b.document_id != ? LIMIT ?",
            (int(document_id), int(document_id), MAX_COPIES)):
        if int(other) not in found:
            found.append(int(other))
    return found[:MAX_COPIES + 1]


def locations_for(conn: sqlite3.Connection, document_ids: Iterable[int]) -> list[dict]:
    """Every location stored for these papers, as rows."""
    ids = [int(i) for i in document_ids]
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    return [dict(r) for r in conn.execute(
        f"SELECT id, document_id, reported_by, location, pdf_url, landing_url, license, "
        f"license_basis, version, host, first_seen_at, seen_at FROM document_open_access "
        f"WHERE document_id IN ({marks}) ORDER BY id", ids)]


def identifiers_for(conn: sqlite3.Connection, document_ids: Iterable[int]) -> list[dict]:
    ids = [int(i) for i in document_ids]
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    return [dict(r) for r in conn.execute(
        f"SELECT document_id, scheme, value, reported_by FROM document_identifiers "
        f"WHERE document_id IN ({marks}) ORDER BY document_id, scheme, value", ids)]


def refusal(row: dict) -> str | None:
    """Why resmon will not download this location, or None. Reads only what is stored."""
    reporter = str(row.get("reported_by") or "")
    if reporter in REFUSED_REPORTERS:
        return REFUSED_REPORTERS[reporter]
    provider = refused_by_host(row.get("pdf_url"))
    if provider:
        return refused_why(provider)
    return None


def needs_license_lookup(row: dict) -> bool:
    """An arXiv copy whose license is not known yet: it is read from arXiv when asked for."""
    return (row.get("license") is None and bool(row.get("pdf_url"))
            and host_of(row.get("pdf_url")) == "arxiv.org")


def downloadable(row: dict) -> bool:
    """Whether resmon would download this location, as it stands now."""
    return (bool(row.get("pdf_url")) and refusal(row) is None
            and (is_open(row.get("license")) or needs_license_lookup(row)))


def best_copy(rows: Iterable[dict]) -> dict | None:
    """The location resmon would download: an open license first, then the version of record.

    A location with a stated open license is preferred to an arXiv copy whose
    license is still to be read; among those, the published version, then the
    accepted, then the submitted; then the first one stored.
    """
    candidates = [r for r in rows if downloadable(r)]
    if not candidates:
        return None
    return min(candidates, key=lambda r: (
        0 if is_open(r.get("license")) else 1,
        _VERSION_RANK.get(r.get("version"), 3),
        int(r.get("id") or 0)))


def summary(rows: list[dict]) -> dict:
    """What a paper's page says about its open copies: the best one, and why if none."""
    best = best_copy(rows)
    if best is not None:
        return {"downloadable": True, "best": best, "why_not": None}
    with_pdf = [r for r in rows if r.get("pdf_url")]
    if not rows:
        why = "no_open_copy"
    elif not with_pdf:
        why = "no_pdf"
    elif all(refusal(r) for r in with_pdf):
        why = "refused_source"
    else:
        why = "no_license"
    return {"downloadable": False, "best": None, "why_not": why}
