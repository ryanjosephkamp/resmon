# resmon_scripts/implementation_scripts/response_models.py
"""What the HTTP routes answer with, declared so a client can be generated.

``docs/api-contract/`` describes what each of the 184 routes *accepts* in full,
and described what they *answer* with not at all: no route declared a
``response_model``, so ``openapi.json`` gave every 200 body the empty schema
``{}``. A typed client generated from that contract would have had types for
every request and none for any reply, which is the half that matters to a
renderer.

This module holds the response models, and the base class that makes adding one
safe.

The hazard, and why the base class exists
-----------------------------------------

**FastAPI's ``response_model`` filters the response.** A key the handler
returned that the model does not declare is dropped from the body, silently and
with a 200. On routes whose bodies are dicts assembled across several modules,
that is a functionality decrease waiting for somebody to forget a field — and
functionality here does not decrease without the owner's sign-off.

There are three ways a ``response_model`` changes a body, and only the first is
the one people think of:

1. **Dropping.** A key not declared on the model disappears. Pydantic's default
   ``extra="ignore"`` does this.
2. **Adding.** A declared field the handler did *not* return is serialised at
   its default — so ``detail: Optional[str] = None`` puts ``"detail": null``
   into every body of a route that only sometimes carries a detail. A caller
   testing ``"detail" in body`` now sees it always.
3. **Coercing.** A declared ``int`` fed the string ``"5"`` is serialised as
   ``5``. The key survives; its type does not.

``LosslessModel`` closes the first two by construction:

* ``extra="allow"`` keeps every undeclared key, so a field nobody modelled
  travels through unchanged rather than vanishing. The model is then a *lower
  bound* on the body — every declared field is really there, and there may be
  more — which is what ``additionalProperties: true`` says in the generated
  schema. That is honest, and it is the only claim the code can support: no
  test can prove a handler never adds a key.
* Routes declare ``response_model_exclude_unset=True``, so a field the handler
  did not return is not invented at its default. Together with ``extra=allow``
  the serialised body is the set of keys the handler produced, exactly.

The third is not closed by construction — a wrong annotation is a wrong
annotation — and is closed by test instead:
``verification_scripts/test_response_models.py`` drives every modelled route
over HTTP, captures what the handler returned on that same request, and asserts
the body a client receives equals ``jsonable_encoder`` of that raw value, key
for key and type for type. The same file asserts that every response model
reachable from a route carries ``extra="allow"``, and that every route carrying
a response model also sets ``response_model_exclude_unset=True`` — so the next
model added is held to this standard whether or not its author read this
docstring.

What the models are *not*
-------------------------

They are not validation of the backend's own correctness. A model that declares
a field the handler stopped producing does not fail: the field is simply absent
from the body, as it is absent from the handler. The schema's ``required`` list
is therefore an upper bound on what a given reply carries, and a field that is
genuinely conditional — ``WatchProfileDeleted.detail`` is the one here — is
declared optional so the schema says so.

Scope today
-----------

J07, *Watch profiles*: the eleven routes under ``/api/profiles``. One slice,
chosen because it contains every shape the other 173 routes are made of — a
wrapped list, a nested object, a map with caller-supplied keys, a page with
counts beside it, and a body assembled conditionally. The rest of the surface
is unmodelled and still answers ``{}`` in the contract, which ``http.md`` now
counts rather than asserts.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "LosslessModel",
    "RoutineWatchingProfile",
    "StarterWatchProfile",
    "StarterWatchProfileList",
    "WatchProfile",
    "WatchProfileDeleted",
    "WatchProfileExport",
    "WatchProfileIdentifier",
    "WatchProfileImportFailure",
    "WatchProfileImportResult",
    "WatchProfileLifecycle",
    "WatchProfileLifecycleFinding",
    "WatchProfileList",
    "WatchProfileMatchPage",
    "WatchProfileMatchRef",
    "WatchProfileMatchRow",
    "WatchProfileMatchesByDocument",
    "WatchProfileName",
]


class LosslessModel(BaseModel):
    """A response model that cannot drop a field it did not think of.

    Every response model in resmon inherits this, including the nested ones:
    ``extra="allow"`` on the outer model does nothing for a key inside a list
    of inner ones, and the inner model is exactly where a field is most easily
    forgotten. ``test_response_models.py`` walks the whole reachable graph from
    each route and fails on a model that does not carry this config, so the
    rule is enforced rather than remembered.
    """

    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------------------
# A profile, as it is stored
# ---------------------------------------------------------------------------

class WatchProfileName(LosslessModel):
    """One spelling of the watched name.

    ``script`` is empty rather than guessed when the value is not ASCII — see
    ``watch_profiles._clean_names`` — so it is a string that may be empty, not
    an optional one.
    """

    value: str
    script: str


class WatchProfileIdentifier(LosslessModel):
    """An identifier and the place the user says they got it from."""

    value: str
    cited: str


class WatchProfile(LosslessModel):
    """A stored watch profile, as every read of one returns it.

    ``identifiers`` is keyed by scheme — ``watch_profiles.IDENTIFIER_SCHEMES``
    is the closed list of four, and a key outside it never reaches storage.
    The map is declared open here because the schema cannot say "one of these
    four keys, each optional" without also saying the keys are required, and
    the runtime constraint lives in ``_clean_identifiers`` where it belongs.

    ``basis_warning`` is the field this journey exists to carry: a sentence
    when every match for this profile will be name-only, ``None`` when the
    profile can do better. It is computed on every read, never stored, and it
    is the field a careless model would have dropped.
    """

    id: int
    kind: str
    display_name: str
    names: list[WatchProfileName]
    identifiers: dict[str, WatchProfileIdentifier]
    affiliations: list[str]
    field_hints: list[str]
    notes: Optional[str]
    created_at: str
    updated_at: str
    basis_warning: Optional[str]


class WatchProfileList(LosslessModel):
    """``GET /api/profiles``."""

    profiles: list[WatchProfile]


class StarterWatchProfile(LosslessModel):
    """One of the curated profiles that ship with the app.

    Not a ``WatchProfile``: a starter is a file on disk, not a row, so it has
    no ``id``, no timestamps, and a ``source_file`` instead. Modelling it as a
    profile with optional ids would have told a client the two are the same
    thing, which is the drift this contract exists to stop.
    """

    kind: str
    display_name: str
    names: list[WatchProfileName]
    identifiers: dict[str, WatchProfileIdentifier]
    affiliations: list[str]
    field_hints: list[str]
    notes: Optional[str]
    source_file: str
    basis_warning: Optional[str]


class StarterWatchProfileList(LosslessModel):
    """``GET /api/profiles/starter``."""

    profiles: list[StarterWatchProfile]


class WatchProfileExport(LosslessModel):
    """``GET /api/profiles/{profile_id}/export`` — the interchange format.

    Ids and timestamps are deliberately absent, because a profile exported from
    one resmon and imported into another is the same *person* and not the same
    row. ``schema`` is ``watch_profiles.JSON_SCHEMA_VERSION`` and is what the
    importer refuses on.
    """

    # The wire key is ``schema``. It cannot be the attribute name: pydantic
    # warns that a field called ``schema`` shadows ``BaseModel.schema``, the
    # deprecated method, and the warning is an error under the suite's filters.
    # The alias is what keeps the body's key spelled the way the handler spells
    # it; ``populate_by_name`` lets either spelling validate.
    schema_: int = Field(alias="schema")
    kind: str
    display_name: str
    names: list[WatchProfileName]
    identifiers: dict[str, WatchProfileIdentifier]
    affiliations: list[str]
    field_hints: list[str]
    notes: Optional[str]

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ---------------------------------------------------------------------------
# Deleting one, and what it leaves pointing at nothing
# ---------------------------------------------------------------------------

class RoutineWatchingProfile(LosslessModel):
    """A routine whose ``parameters.entity`` points at the profile being deleted.

    ``mode`` comes out of the routine's JSON blob and is whatever is in there,
    so it is optional: a blob with an ``entity`` and no ``mode`` is a real
    shape, not a broken one.
    """

    id: int
    name: str
    is_active: bool
    mode: Optional[str]


class WatchProfileDeleted(LosslessModel):
    """``DELETE /api/profiles/{profile_id}``.

    **The conditionally assembled one.** ``detail`` is added by the handler
    only when something was watching the profile, and the route therefore sets
    ``response_model_exclude_unset=True`` — as every modelled route does —
    so an absent ``detail`` stays absent instead of being serialised as
    ``null``. A client distinguishing "no routines were affected" from "one was
    and here is the sentence" by key presence keeps working.
    """

    deleted: int
    routines_watching: list[RoutineWatchingProfile]
    detail: Optional[str] = None


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

class WatchProfileImportFailure(LosslessModel):
    """One entry of an import file that could not be read, and why.

    ``index`` is its position in the submitted list, because the point of
    reporting per profile rather than failing the batch is telling the user
    which line to look at.
    """

    index: int
    reason: str


class WatchProfileImportResult(LosslessModel):
    """``POST /api/profiles/import``."""

    imported: list[WatchProfile]
    failed: list[WatchProfileImportFailure]


# ---------------------------------------------------------------------------
# Matches
# ---------------------------------------------------------------------------

class WatchProfileMatchRef(LosslessModel):
    """A profile that matched one paper, and the basis it matched on.

    The basis rides on every match everywhere it is returned. A match with no
    basis is the claim resmon refuses to make: that a paper is by this person,
    rather than that a paper has this name on it.
    """

    profile_id: int
    display_name: str
    basis: str
    matched_author: str
    evidence: Optional[str]


class WatchProfileMatchesByDocument(LosslessModel):
    """``POST /api/profiles/matches/for-documents``.

    **The map with caller-supplied keys.** ``matches`` is keyed by document id
    as a string — the handler builds it with ``str(row["document_id"])`` —
    and holds only the documents that matched something, so a key's absence
    means "nothing matched", not "not asked about".
    """

    matches: dict[str, list[WatchProfileMatchRef]]


class WatchProfileMatchRow(LosslessModel):
    """One paper matched to a profile, as the matches page lists it.

    Every nullable column of ``documents`` is optional here because it is
    nullable there: ``title`` and ``source_repository`` are ``NOT NULL`` in the
    schema and the rest are not.
    """

    document_id: int
    basis: str
    matched_author: str
    evidence: Optional[str]
    first_seen_at: str
    title: str
    source_repository: str
    doi: Optional[str]
    url: Optional[str]
    publication_date: Optional[str]


class WatchProfileMatchPage(LosslessModel):
    """``GET /api/profiles/{profile_id}/matches``.

    ``by_basis`` is a count per basis over the whole profile, not over this
    page, which is why it sits beside ``total`` rather than being derived from
    ``matches``.
    """

    matches: list[WatchProfileMatchRow]
    total: int
    by_basis: dict[str, int]


# ---------------------------------------------------------------------------
# Lifecycle findings on a profile's papers
# ---------------------------------------------------------------------------

class WatchProfileLifecycleFinding(LosslessModel):
    """A retraction or other lifecycle notice on a paper this profile matched.

    A join over findings resmon already holds, never a new claim. Every field
    that carries the notice is here — ``notice_url`` is ``NOT NULL`` in
    ``document_lifecycle`` and the DOI and date are not — because a finding
    rendered without its notice link is resmon asserting a retraction on its
    own authority, which it does not do.

    ``basis`` and ``matched_author`` come from the match, not the finding, so a
    finding on a ``name_only`` match is visibly a finding on a paper that
    merely has this name on it.
    """

    document_id: int
    kind: str
    severity: str
    label: Optional[str]
    notice_doi: Optional[str]
    notice_url: str
    notice_date: Optional[str]
    provider: str
    provider_source: Optional[str]
    first_seen_at: str
    title: str
    doi: Optional[str]
    source_repository: str
    basis: str
    matched_author: str


class WatchProfileLifecycle(LosslessModel):
    """``GET /api/profiles/{profile_id}/lifecycle``.

    ``checked_documents`` beside ``matched_documents`` is the coverage half:
    a profile whose papers have never been through a lifecycle check has no
    findings *because nothing looked*, which is a different fact from having
    none. ``coverage_note`` says that in a sentence rather than leaving it to
    be inferred from two numbers, and a model that dropped it would have turned
    the one into the other.
    """

    findings: list[WatchProfileLifecycleFinding]
    matched_documents: int
    checked_documents: int
    coverage_note: str
