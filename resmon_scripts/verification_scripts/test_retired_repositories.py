"""Retired sources stay retired, and say why.

IEEE Xplore was withdrawn in v1.8.1 on its terms rather than its behaviour
(see ``api_registry.RETIRED_REPOSITORIES``). Retirement has two halves and both
are load-bearing: the module is not imported, and the registry refuses the slug
even if something imports it anyway. The second half exists because the first
one silently failed — the tier-2/3 tests imported ``api_ieee`` directly, its
module-scope ``_register()`` put the source back, and the suite went on passing.
"""

import importlib

import pytest

from implementation_scripts import api_registry
from implementation_scripts.api_registry import (
    RETIRED_REPOSITORIES,
    get_client,
    list_repositories,
    register_client,
)


RETIRED = sorted(RETIRED_REPOSITORIES)


def test_ieee_is_retired():
    assert "ieee" in RETIRED_REPOSITORIES


@pytest.mark.parametrize("slug", RETIRED)
def test_retired_slugs_are_not_registered(slug):
    assert slug not in list_repositories()


@pytest.mark.parametrize("slug", RETIRED)
def test_retired_slugs_are_absent_from_the_catalog(slug):
    from implementation_scripts.repo_catalog import REPOSITORY_CATALOG

    assert slug not in {entry.slug for entry in REPOSITORY_CATALOG}


@pytest.mark.parametrize("slug", RETIRED)
def test_get_client_explains_the_retirement(slug):
    """A saved routine naming a retired source gets the reason, not 'unknown'.

    The sweep engine catches this ValueError and records its text against the
    source, so this string is user-visible in the run report.
    """
    with pytest.raises(ValueError) as excinfo:
        get_client(slug)
    message = str(excinfo.value)
    assert "Unknown repository" not in message
    assert RETIRED_REPOSITORIES[slug] in message


def test_unknown_slug_still_says_unknown():
    """Retirement wording must not swallow the genuine typo case."""
    with pytest.raises(ValueError, match="Unknown repository: not_a_source"):
        get_client("not_a_source")


@pytest.mark.parametrize("slug", RETIRED)
def test_registry_refuses_to_register_a_retired_slug(slug):
    with pytest.raises(ValueError, match="retired"):
        register_client(slug, object)
    assert slug not in list_repositories()


@pytest.mark.parametrize("module", ["api_ieee", "api_repec", "api_ssrn"])
def test_importing_a_retired_client_module_registers_nothing(module):
    """The modules are kept on disk for reference; importing must be inert."""
    importlib.import_module(f"implementation_scripts.{module}")
    for slug in RETIRED:
        assert slug not in api_registry.list_repositories()


def test_ieee_no_longer_has_a_required_credential():
    """The sweep engine's key gate must not name a source it can never reach."""
    from implementation_scripts.sweep_engine import _REQUIRED_CREDENTIALS

    assert "ieee" not in _REQUIRED_CREDENTIALS
