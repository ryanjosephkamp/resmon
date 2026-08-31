# resmon_scripts/implementation_scripts/api_registry.py
"""Client registry mapping repository name strings to API client classes."""

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
        "IEEE Xplore was withdrawn in v1.8.1. Its API Terms of Use limit the "
        "grant to non-commercial activity within the licensee's institution, "
        "forbid using a search/retrieval application against the content "
        "(4(c)), forbid retaining it in bulk (4(f)), and require deleting it "
        "on termination (12). resmon is a retrieval application that keeps a "
        "corpus indefinitely, so it cannot be used against IEEE Xplore "
        "without putting the account holder in breach of the terms they "
        "accepted at registration."
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


def register_client(name: str, client_class: type) -> None:
    """Register an API client class under a repository name.

    A retired slug is refused. Leaving a module out of ``_CLIENT_MODULES`` is
    not on its own enough to retire a source: every ``api_*.py`` calls this
    function at import time, so anything that imports the module directly —
    a test, a debug session, a future caller reaching for the class — puts the
    source back into this process-wide registry and a sweep can reach it again.
    That is exactly how ``api_ieee`` stayed reachable after being dropped from
    the import list, and it was found because the tier-2/3 tests kept passing
    when they should have failed. Retirement belongs to the registry, not to
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


def _ensure_loaded():
    global _loaded
    if _loaded:
        return
    _loaded = True
    from importlib import import_module
    _CLIENT_MODULES = [
        "api_arxiv",
        "api_biorxiv",
        "api_core",
        "api_crossref",
        "api_datacite",
        "api_dblp",
        "api_doaj",
        "api_eric",
        "api_europepmc",
        "api_hal",
        "api_inspire_hep",
        "api_nasa_ads",
        "api_openaire",
        "api_openalex",
        "api_osti",
        "api_plos",
        "api_pubmed",
        "api_semantic_scholar",
        "api_springer",
        "api_zenodo",
        # NOTE: api_ieee, api_repec and api_ssrn are intentionally excluded from
        # the active registry, for two different reasons.
        #
        # RePEc and SSRN block programmatic access (SSRN via Cloudflare
        # bot-challenge 403s; RePEc/IDEAS htsearch CGI is no longer publicly
        # reachable) — they never worked.
        #
        # IEEE Xplore worked, and was withdrawn in v1.8.1 on its terms rather
        # than on its behaviour: 4(c) forbids using a retrieval application
        # against the content at all, so no field-level gate makes the
        # integration compliant. See RETIRED_REPOSITORIES above for the wording
        # the user is shown, and docs/source-landscape.md for the full reading.
        #
        # All three client modules are retained on disk for reference but are
        # not loaded. See .ai/prep/repos.md → "Excluded Repositories".
    ]
    for mod_name in _CLIENT_MODULES:
        import_module(f".{mod_name}", package=__package__)
