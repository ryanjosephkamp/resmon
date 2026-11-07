# resmon_scripts/implementation_scripts/api_registry.py
"""Client registry mapping repository name strings to API client classes."""

import threading

_REGISTRY: dict[str, type] = {}

# Sources that were once available and are deliberately no longer loaded.
#
# A routine saved before a source was retired still names its slug, and the
# sweep engine catches the ValueError below and records it against that source.
# Without this table the recorded reason is "Unknown repository: ieee", which
# reads like a bug in resmon rather than a decision resmon made. The user is
# entitled to the actual reason, so it is stored here and surfaced verbatim.
RETIRED_REPOSITORIES: dict[str, str] = {
    "ieee": (
        "IEEE Xplore was withdrawn. Its API Terms of Use limit the "
        "grant to non-commercial activity within the licensee's institution, "
        "forbid using a search/retrieval application against the content "
        "(4(c)), forbid retaining it in bulk (4(f)), and require deleting it "
        "on termination (12). resmon is a retrieval application that keeps a "
        "corpus indefinitely, so it cannot be used against IEEE Xplore "
        "without putting the account holder in breach of the terms they "
        "accepted at registration."
    ),
    "nist_rmm": (
        "NIST RMM was withdrawn in November 2026. Its papers API has answered "
        "HTTP 500 to every search since the source was added in August 2026, "
        "last checked November 4, 2026. The source can return if NIST's API "
        "answers again."
    ),
    "oapen": (
        "OAPEN Library was withdrawn in October 2026. Its search API answers "
        "resmon's requests with HTTP 403 and a message saying the caller's "
        "address is not allowed to access the API. It did so from both places "
        "tried, a workstation and GitHub's hosted runners. The source can "
        "return if OAPEN lifts the block."
    ),
    "repec": (
        "RePEc/IDEAS was never activated: its htsearch CGI is no longer "
        "publicly reachable."
    ),
    "ssrn": (
        "SSRN was never activated: it answers programmatic requests with a "
        "Cloudflare bot challenge."
    ),
}

#: The name each retired source was shown under. A routine saved before a
#: source was retired still records an outcome under its slug, and a screen
#: that names the source by "ieee" reads as a key rather than as IEEE Xplore.
RETIRED_NAMES: dict[str, str] = {
    "ieee": "IEEE Xplore",
    "nist_rmm": "NIST Resource Metadata Management",
    "oapen": "OAPEN Library",
    "repec": "RePEc/IDEAS",
    "ssrn": "SSRN",
}


def register_client(name: str, client_class: type) -> None:
    """Register an API client class under a repository name.

    A retired slug is refused. Leaving a module out of ``_CLIENT_MODULES`` is
    not on its own enough to retire a source: every ``api_*.py`` calls this
    function at import time, so anything that imports the module directly —
    a test, a debug session, a future caller reaching for the class — puts the
    source back into this process-wide registry and a sweep can reach it again.
    That is exactly how a retired module such as ``api_ieee`` would stay
    reachable after being dropped from the import list, with the tier-2/3 tests
    passing when they should fail. Retirement belongs to the registry, not to
    the import list.
    """
    if name in RETIRED_REPOSITORIES:
        raise ValueError(
            f"{name} is retired and cannot be registered. "
            f"{RETIRED_REPOSITORIES[name]}"
        )
    _REGISTRY[name] = client_class


def get_client(name: str, **kwargs):
    """Instantiate and return a registered API client by name."""
    _ensure_loaded()
    if name not in _REGISTRY:
        retired = RETIRED_REPOSITORIES.get(name)
        if retired:
            raise ValueError(f"{name} is no longer available. {retired}")
        raise ValueError(f"Unknown repository: {name}")
    return _REGISTRY[name](**kwargs)


def list_repositories() -> list[str]:
    """Return a sorted list of all registered repository names."""
    _ensure_loaded()
    return sorted(_REGISTRY.keys())


# ---------------------------------------------------------------------------
# Lazy bulk-import so every api_*.py module gets a chance to call
# register_client() at import time.
# ---------------------------------------------------------------------------
_loaded = False
# Held while the client modules are imported. ``_loaded`` was once set before
# they were, with no lock: two watches fired at the same second as the
# engine's first users of the registry (November 4, 2026, at midnight), and the
# second thread saw ``_loaded`` true and asked for "crossref" before
# ``api_crossref`` had registered, so its run failed after 0 seconds with
# "Unknown repository: crossref". An import that raised partway also left the
# list half loaded for good.
_load_lock = threading.Lock()


def _ensure_loaded():
    """Import every client module once, so each has registered, before any lookup.

    ``_loaded`` turns true only after every import has succeeded, under the
    lock, and a second caller waits for the first rather than reading a list
    still being filled. An import that raises leaves ``_loaded`` false, so the
    next caller tries again.
    """
    global _loaded
    if _loaded:
        return
    with _load_lock:
        if _loaded:
            return
        _import_clients()
        _loaded = True


def _import_clients():
    from importlib import import_module
    _CLIENT_MODULES = [
        "api_arxiv",
        "api_biorxiv",
        "api_core",
        "api_crossref",
        "api_datacite",
        "api_dblp",
        "api_doaj",
        "api_dryad",
        "api_eric",
        "api_europepmc",
        "api_govinfo",
        "api_hal",
        "api_inspire_hep",
        "api_nasa_ads",
        "api_ndl_search",
        "api_openaire",
        "api_openalex",
        "api_openlibrary",
        "api_osti",
        "api_plos",
        "api_pubmed",
        "api_semantic_scholar",
        "api_springer",
        "api_zenodo",
        # NOTE: api_ieee, api_nist_rmm, api_oapen, api_repec and api_ssrn are
        # intentionally excluded from the active registry, for four different
        # reasons.
        #
        # RePEc and SSRN block programmatic access (SSRN via Cloudflare
        # bot-challenge 403s; RePEc/IDEAS htsearch CGI is no longer publicly
        # reachable) — they never worked.
        #
        # IEEE Xplore worked, and was withdrawn on its terms rather than on
        # its behavior: 4(c) forbids using a retrieval application
        # against the content at all, so no field-level gate makes the
        # integration compliant. See RETIRED_REPOSITORIES above for the wording
        # the user is shown, and docs/source-landscape.md for the full reading.
        #
        # OAPEN answered, and was withdrawn in October 2026 once its search
        # API answered HTTP 403 from both places resmon's requests were sent:
        # GitHub's hosted runners in the weekly live run and a workstation.
        # Unlike RePEc and SSRN it did work, and unlike IEEE Xplore its terms
        # are not the problem. The client itself is unchanged.
        #
        # NIST RMM never answered: its papers API has returned HTTP 500 to
        # every search since the source was added in August 2026. It was
        # withdrawn in November 2026, after the same 500 on November 4. Its
        # record mapping was written from the OpenAPI envelope and has never
        # been checked against a live response.
        #
        # All five client modules are retained on disk for reference but are
        # not loaded. See docs/source-landscape.md for the full rationale.
    ]
    for mod_name in _CLIENT_MODULES:
        import_module(f".{mod_name}", package=__package__)
