# resmon_scripts/implementation_scripts/api_registry.py
"""Client registry mapping repository name strings to API client classes."""

_REGISTRY: dict[str, type] = {}


def register_client(name: str, client_class: type) -> None:
    """Register an API client class under a repository name."""
    _REGISTRY[name] = client_class


def get_client(name: str, **kwargs):
    """Instantiate and return a registered API client by name."""
    _ensure_loaded()
    if name not in _REGISTRY:
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
        "api_dblp",
        "api_doaj",
        "api_europepmc",
        "api_hal",
        "api_ieee",
        "api_nasa_ads",
        "api_openalex",
        "api_plos",
        "api_pubmed",
        "api_semantic_scholar",
        "api_springer",
        # NOTE: api_repec and api_ssrn are intentionally excluded from the active
        # registry. Both sources block programmatic access (SSRN via Cloudflare
        # bot-challenge 403s; RePEc/IDEAS htsearch CGI is no longer publicly
        # reachable). The client modules are retained on disk for historical
        # reference but are not loaded. See .ai/prep/repos.md → "Excluded
        # Repositories" for the full rationale.
    ]
    for mod_name in _CLIENT_MODULES:
        import_module(f".{mod_name}", package=__package__)
