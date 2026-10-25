# resmon_scripts/implementation_scripts/response_models.py
"""What the HTTP routes answer with, declared so a client can be generated.

``docs/api-contract/`` describes what each of the 185 routes *accepts* in full,
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
2. **Adding.** A declared field the handler did *not* return is serialized at
   its default — so ``detail: Optional[str] = None`` puts ``"detail": null``
   into every body of a route that only sometimes carries a detail. A caller
   testing ``"detail" in body`` now sees it always.
3. **Coercing.** A declared ``int`` fed the string ``"5"`` is serialized as
   ``5``. The key survives; its type does not.

``LosslessModel`` closes the first two by construction:

* ``extra="allow"`` keeps every undeclared **key**, so a field nobody modeled
  reaches the client rather than vanishing. The model is then a *lower bound*
  on the body — every declared field is really there, and there may be more —
  which is what ``additionalProperties: true`` says in the generated schema.
  That is honest, and it is the only claim the code can support: no test can
  prove a handler never adds a key.
* Routes declare ``response_model_exclude_unset=True``, so a field the handler
  did not return is not invented at its default. Together with ``extra=allow``
  the serialized body is the set of keys the handler produced, exactly.

**The key survives; the value is re-serialized, and for three types that is
visible.** An extra does not pass through untouched: it is written by
pydantic's inference serializer, where an unmodeled route's body is written by
FastAPI's ``jsonable_encoder``, and the two disagree in a small, knowable set
of cases. Measured, in every position an extra can occupy — top level, inside a
list, inside a dict, and on a nested model:

``Decimal("1.50")``
    Unmodeled, ``jsonable_encoder`` makes it the float ``1.5``. Through a
    model, pydantic keeps the trailing zero and makes it the string
    ``"1.50"`` — so it stops being a number.
``PurePosixPath("/a/b")``
    Unmodeled, the string ``"/a/b"``. Through a model,
    ``PydanticSerializationError``, which is a 500.
``float("inf")``, ``float("nan")``
    Unmodeled, a 500: ``json.dumps`` refuses a non-finite float. Through a
    model, ``null``, with nothing said.

Two of those deserve their warning label. A ``PurePath`` raises where the
concrete ``Path``/``PosixPath`` beside it serializes perfectly well, so the
failing case and the working one look alike in a diff. And ``inf``/``nan`` go
the *other* way: the model turns a loud 500 into a quiet ``null``, which is the
only place on this list where adding a model makes a wrong answer more likely
rather than less.

None of the three is reachable in the routes modeled today — there is no
``Decimal`` and no ``PurePath`` anywhere in the backend, and ``math.inf``
appears only inside ``api_base``'s rate-limiter arithmetic, never in a response
dict. This is written down for whoever models the rest, because the
claim "an extra passes through unchanged" is the natural thing to assume and it
is wrong. ``test_what_an_undeclared_value_does_and_does_not_survive`` keeps this
table honest.

The third is not closed by construction — a wrong annotation is a wrong
annotation — and is closed by test instead:
``verification_scripts/test_response_models.py`` drives every modeled route
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

Seven slices. The first shipped the mechanism; the other six are the rollout,
and the authoritative list of which routes are modeled is
``verification_scripts/test_response_models.py``'s ``THE_MODELED_SURFACE`` —
declared there rather than here, because the thing worth guarding is that the
*application* and the declaration agree, and a declaration living in the module
the application imports could not say anything the application did not already
say.

* **Watch profiles**, the eleven routes under ``/api/profiles``. The pilot.
* **Settings**, seventeen routes: a GET and a PUT for each of the eight stored
  groups, plus the agent-CLI probe. Each group has its own model because each
  group really is a different shape — six of them are maps of stored strings,
  ``notifications`` coerces two of them to a bool and an enum before answering,
  ``execution`` answers integers, and ``embeddings`` answers a page.
* **Reading queue**, four routes: a page with counts, the entry a 201 returns,
  the entry a status change returns, and a delete acknowledgement.
* **The watchdog and the first-run card**, five routes.
* **Process identity and the catalogs**, five routes — including the two that
  answer a *bare list* rather than an object, which is the shape the structural
  guards have the least to say about. See ``test_response_models.py``'s
  ``SCALAR_LIST_ROUTES``.
* **Saved configurations**, six routes — including the body that is assembled
  from whichever fields the caller sent, which is what
  ``response_model_exclude_unset=True`` exists for.
* **The scheduler**, one route: whether this database's active routines will
  fire. It was born with its model rather than given one later, and its two
  closed vocabularies are ``Literal`` types, so a state the handler invents is
  a 500 in the equality sweep rather than a word the renderer has no sentence
  for.

Why some fields here are declared ``dict`` and not a model
----------------------------------------------------------

A handful of fields carry a shape that genuinely varies by the row's kind. A
watchdog finding's ``evidence`` is the clear case: it holds a different key
set for each of the seven finding kinds, so there is no field list to write
down and ``dict`` — "an object whose keys this contract does not enumerate" —
is the honest description.

**A field whose *type* varies is not that case, and an earlier draft of this
docstring said it was.** A finding's ``scope`` holds a string id for a source
and an integer id for a routine, and this file claimed that declaring
``id: str`` would "quietly coerce ``1`` into ``"1"``". It would not, and the
reason is worth knowing because hazard 3 above is real: **pydantic's coercion
is directional.** Measured on the pinned pydantic 2.12.4::

    int  <- "5"     ->  5        quiet, and this is hazard 3
    int  <- True    ->  1        quiet
    bool <- "true"  ->  True     quiet
    str  <- 5       ->  ValidationError, 'string_type'
    str  <- True    ->  ValidationError, 'string_type'

So a declared ``int`` or ``bool`` really will swallow a string and change its
type without a word — but a declared ``str`` fed anything else **raises**,
which is a ``ResponseValidationError``, which is a 500, and which the equality
sweep in ``verification_scripts/test_response_models.py`` reaches before any
user does. ``OnboardingStep.done`` is the worked example: declared ``bool``,
fed ``None``, it 500'd rather than lying.

The rule that follows is: a field whose type varies wants a **wider
annotation**, not none at all. ``Union[str, int]`` carries both and keeps each
value's runtime type — ``1`` stays an ``int``, ``"arxiv"`` stays a ``str``.
Reaching for ``dict`` because a type varies gives up a shape the client could
have had, for a hazard that does not exist in that direction.

``scope`` is still ``dict`` here, and that is a scheduling decision rather than
a technical one: it was typed that way on a wrong premise, the mistake was
found in review after the slice was accepted, and widening it to a real
``WatchdogFindingScope`` adds a model nobody has reviewed. The next author to
touch the watchdog should type it. Nothing is lost in the meantime —
``extra="allow"`` carries every key and ``jsonable_encoder`` carries every
value — but the client gets ``object`` where it could have had a shape.

Where a field is declared ``dict``, the model's own docstring says which of
these two reasons applies.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "AiCliProbe",
    "AiCliStatus",
    "AiSettings",
    "AssistantSettings",
    "CloudSettings",
    "ConfigurationCreated",
    "ConfigurationDeleted",
    "ConfigurationExport",
    "ConfigurationImportResult",
    "ConfigurationUpdated",
    "CredentialPresence",
    "CredentialsPresence",
    "EmailSettings",
    "EmbeddingCapability",
    "EmbeddingCoverage",
    "EmbeddingIndexState",
    "EmbeddingJobRun",
    "EmbeddingJobStatus",
    "EmbeddingLaneView",
    "EmbeddingProviderAnswer",
    "EmbeddingSettingsPage",
    "EmbeddingSettingsSaved",
    "EmbeddingSettingsValues",
    "ExecutionSettings",
    "ExecutionSettingsSaved",
    "Health",
    "LosslessModel",
    "NotificationSettings",
    "OnboardingCounts",
    "OnboardingDismissed",
    "OnboardingState",
    "OnboardingStep",
    "ReadingQueueCounts",
    "ReadingQueueDocument",
    "ReadingQueueEntry",
    "ReadingQueuePage",
    "ReadingQueueRemoval",
    "RendererHeartbeat",
    "RepositoryCatalogEntry",
    "RepositoryEntitySearch",
    "RoutineFiring",
    "RoutineFiringReason",
    "RoutineWatchingProfile",
    "RuntimeIdentity",
    "SavedConfiguration",
    "SchedulerState",
    "SchedulerStatus",
    "SettingsSaved",
    "StarterWatchProfile",
    "StarterWatchProfileList",
    "StorageSettings",
    "VectorExtensionStatus",
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
    "WatchdogCounts",
    "WatchdogFinding",
    "WatchdogMuteAck",
    "WatchdogReport",
    "WatchdogThresholds",
    "WatchdogUnjudged",
    "WatchdogWatching",
]


class LosslessModel(BaseModel):
    """A response model that cannot drop a key it did not think of.

    Every response model in resmon inherits this, including the nested ones:
    ``extra="allow"`` on the outer model does nothing for a key inside a list
    of inner ones, and the inner model is exactly where a field is most easily
    forgotten. ``test_response_models.py`` walks the whole reachable graph from
    each route and fails on a model that does not carry this config, so the
    rule is enforced rather than remembered.

    It guarantees the **key**, not the bytes of its value: an extra is written
    by pydantic's inference serializer rather than by ``jsonable_encoder``, and
    the module docstring above has the three measured cases where those two
    disagree. A route whose body can hold a ``Decimal``, a ``PurePath`` or a
    non-finite float needs that table read before it is modeled.
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
    no ``id``, no timestamps, and a ``source_file`` instead. Modeling it as a
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
    ``response_model_exclude_unset=True`` — as every modeled route does —
    so an absent ``detail`` stays absent instead of being serialized as
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


# ===========================================================================
# Settings — the eight stored groups, and the agent-CLI probe beside them
# ===========================================================================
#
# ``_SETTINGS_GROUPS`` in ``resmon.py`` is the key list for each group, and
# ``_get_settings_group`` answers ``""`` rather than ``null`` for a key nobody
# has stored — so every field of the six plain groups below is a ``str`` that
# may be empty, never an optional one. ``test_response_models.py`` asserts each
# of those models declares exactly the group's own key list, so a setting added
# to the group and not to the model is a red test rather than a key that only
# ``extra="allow"`` is holding up.

class EmailSettings(LosslessModel):
    """``GET /api/settings/email`` — the SMTP destination, never the password.

    The password lives in the keyring and is reported by ``/api/credentials``
    as present or absent. No field here has ever held a credential value and
    none may.
    """

    smtp_server: str
    smtp_port: str
    smtp_username: str
    smtp_from: str
    smtp_to: str


class AiSettings(LosslessModel):
    """``GET /api/settings/ai`` — the AI lane, as sixteen stored strings.

    ``ai_chain`` and ``ai_default_models`` are JSON *documents* stored as text,
    and they are declared ``str`` here because that is what the endpoint
    answers: the renderer parses them. Declaring them as objects would be this
    contract describing a shape the route does not send.
    """

    ai_provider: str
    ai_model: str
    ai_local_model: str
    ai_summary_length: str
    ai_tone: str
    ai_extraction_goals: str
    ai_temperature: str
    ai_show_audit_prefix: str
    ai_custom_base_url: str
    ai_custom_header_prefix: str
    ai_default_models: str
    ai_chain: str
    ai_local_endpoint: str
    ai_cli_path: str
    ai_subscription_doc_cap: str
    ai_effort: str


class CloudSettings(LosslessModel):
    """``GET /api/settings/cloud`` — the Google Drive backup lane's two keys."""

    cloud_provider: str
    cloud_auto_backup: str


class StorageSettings(LosslessModel):
    """``GET /api/settings/storage``."""

    pdf_policy: str
    txt_policy: str
    archive_after_days: str
    export_directory: str


class AssistantSettings(LosslessModel):
    """``GET /api/settings/assistant``."""

    assistant_runtime: str
    assistant_provider: str
    assistant_model: str
    assistant_effort: str


class NotificationSettings(LosslessModel):
    """``GET /api/settings/notifications`` — the one group that is not strings.

    The handler reads the same stored text as every other group and then
    *answers* a bool and a three-valued mode, defaulting ``notify_manual`` to
    true on a first load. So this model is ``bool`` and ``str`` where its
    siblings are ``str`` and ``str``, and a model copied from one of them would
    have turned ``true`` into ``"true"`` without dropping anything.
    """

    notify_manual: bool
    notify_automatic_mode: str


class ExecutionSettings(LosslessModel):
    """``GET /api/settings/execution`` — two integers, parsed and bounded."""

    max_concurrent_executions: int
    routine_fire_queue_limit: int


class SettingsSaved(LosslessModel):
    """What the six plain settings PUTs answer: ``{"success": true}``.

    One model for six routes rather than six identical ones. The two PUTs that
    answer more than this —  embeddings and execution — have their own, because
    a shared model that declared their extra keys would put those keys into the
    schema of four routes that never send them.
    """

    success: bool


class ExecutionSettingsSaved(LosslessModel):
    """``PUT /api/settings/execution`` echoes what it stored.

    The echo is the point: the handler clamps nothing and refuses out-of-range
    values with a 400, so a caller comparing what came back with what it sent
    can tell a stored value from an ignored one.
    """

    success: bool
    max_concurrent_executions: int
    routine_fire_queue_limit: int


class AiCliProbe(LosslessModel):
    """One agent CLI, and where resmon looked for it.

    ``found`` is detection, never a login check — the endpoint does not run the
    binary — and ``login_checked`` is the field that says so out loud. It is
    always ``false`` today, and it is in the body rather than in the
    documentation because a client that reads ``found`` as "ready" is making a
    claim resmon has not checked.

    ``path`` and ``how`` are ``None`` on a machine where the CLI is absent,
    which is most CI runners; ``tried`` is the candidate list, and it is here
    because "not found" alone does not tell a user that resmon looked in the
    wrong place.
    """

    provider: str
    path: Optional[str]
    how: Optional[str]
    found: bool
    tried: list[str]
    detail: str
    login_checked: bool


class AiCliStatus(LosslessModel):
    """``GET /api/settings/ai/cli-status``."""

    providers: list[AiCliProbe]


# ---------------------------------------------------------------------------
# Embeddings — the settings page that is a page rather than a map
# ---------------------------------------------------------------------------

class EmbeddingSettingsValues(LosslessModel):
    """The stored ``embedding_*`` keys, owned by ``EMBEDDING_SETTING_KEYS``."""

    embedding_enabled: str
    embedding_provider: str
    embedding_model: str
    embedding_endpoint: str
    embedding_base_url: str
    embedding_batch_size: str
    embedding_dims: str
    embedding_input_limit: str


class EmbeddingProviderAnswer(LosslessModel):
    """Whether one provider can embed at all, and what that rests on.

    Every provider resmon lists appears here, including the ones that cannot
    embed, because the interface states the limitation rather than omitting the
    option. ``evidence`` is the observation behind ``state`` — a dated request
    and its status — and it is a field a model written from the UI's needs
    would have dropped, which would have left "Anthropic does not offer an
    embeddings API" as an assertion with nothing behind it.
    """

    provider: str
    state: str
    reason: str
    evidence: Optional[str]
    offered: bool
    default_model: Optional[str]
    suggested_models: list[str]


class EmbeddingLaneView(LosslessModel):
    """The configured lane. ``null`` on the route above means the feature is off.

    ``credential_alias`` is a keyring slot *name*. No field here holds a key
    value, in the same way ``EmbeddingLane`` itself does not.
    """

    kind: str
    provider: str
    model: str
    endpoint: Optional[str]
    base_url: Optional[str]
    credential_alias: Optional[str]
    batch_size: int
    dims: Optional[int]
    input_limit: Optional[int]


class VectorExtensionStatus(LosslessModel):
    """Whether sqlite-vec loaded in *this* process, and why not when it did not.

    Returned by ``/api/health`` and twice inside the embeddings page. One model
    for all three, because they are one function's output: ``extension`` is the
    loaded version or ``None``, and exactly one of the two fields is ever set.
    """

    extension: Optional[str]
    reason: Optional[str]


class EmbeddingCoverage(LosslessModel):
    """How much of the corpus is embedded, read from the database not a counter.

    From the database so the numbers are right after a restart, after a cancel,
    and for a corpus somebody else's run embedded.
    """

    embedded: int
    total: int
    model: Optional[str]


class EmbeddingIndexState(LosslessModel):
    """What the vector index currently holds."""

    model: Optional[str]
    dims: Optional[int]
    rows: int


class EmbeddingJobRun(LosslessModel):
    """The backfill job's own state, running or not.

    ``skipped_no_text`` is separate from ``processed`` on purpose: a document
    with nothing to embed is not a failure and is not progress, and folding the
    two together would make a corpus of metadata-only records look embedded.
    """

    running: bool
    model: Optional[str]
    processed: int
    total: int
    skipped_no_text: int
    started_at: Optional[str]
    finished_at: Optional[str]
    cancelled: bool
    reason: Optional[str]


class EmbeddingJobStatus(LosslessModel):
    """``run``, ``coverage``, ``extension`` and ``index`` together."""

    run: EmbeddingJobRun
    coverage: EmbeddingCoverage
    extension: VectorExtensionStatus
    index: EmbeddingIndexState


class EmbeddingCapability(LosslessModel):
    """Whether this backend can rank by similarity at all, and what by.

    ``available`` needs both a loadable extension and rows in the index; either
    missing means the sort option and the similar-papers panel are *absent*
    rather than present and empty. ``reason`` is the sentence the Settings page
    shows instead, and it is the field this model exists to keep.
    """

    available: bool
    extension: Optional[str]
    reason: Optional[str]
    model: Optional[str]
    indexed: int


class EmbeddingSettingsPage(LosslessModel):
    """``GET /api/settings/embeddings`` — the stored keys plus everything the
    tab needs in order to render honestly."""

    settings: EmbeddingSettingsValues
    providers: list[EmbeddingProviderAnswer]
    lane: Optional[EmbeddingLaneView]
    capability: EmbeddingCapability
    status: EmbeddingJobStatus


class EmbeddingSettingsSaved(LosslessModel):
    """``PUT /api/settings/embeddings`` — the ack, and what the lane can now do.

    The capability rides on the write because a model change rebuilds the
    index, and a client that had to re-read the page to learn that would render
    a stale answer in between.
    """

    success: bool
    capability: EmbeddingCapability


# ===========================================================================
# Reading queue
# ===========================================================================

class ReadingQueueDocument(LosslessModel):
    """The stored paper a queue entry points at.

    ``authors`` is the raw column, a JSON array stored as text; the renderer
    parses it. Every other nullable column of ``documents`` is optional here
    because it is nullable there.
    """

    id: int
    source_repository: str
    external_id: str
    doi: Optional[str]
    title: str
    authors: Optional[str]
    abstract: Optional[str]
    publication_date: Optional[str]
    url: Optional[str]
    categories: Optional[str]
    first_seen_at: str


class ReadingQueueEntry(LosslessModel):
    """One saved paper. ``read_at`` is ``None`` until it is marked read.

    ``document`` is absent from the entry a write returns and present in the
    entry a page lists, which is why it is optional: the writes answer with the
    queue row alone and the caller already has the paper it just saved.
    """

    document_id: int
    status: str
    saved_at: str
    updated_at: str
    read_at: Optional[str]
    document: Optional[ReadingQueueDocument] = None


class ReadingQueueCounts(LosslessModel):
    """How many are in each state, over the whole queue and not this page."""

    to_read: int
    read: int
    all: int


class ReadingQueuePage(LosslessModel):
    """``GET /api/reading-queue``.

    ``status`` echoes the filter that produced the page and is ``None`` when
    the caller asked for both, so a client can tell "everything" from
    "everything that happens to be unread".
    """

    entries: list[ReadingQueueEntry]
    total: int
    limit: int
    offset: int
    status: Optional[str]
    counts: ReadingQueueCounts


class ReadingQueueRemoval(LosslessModel):
    """``DELETE /api/reading-queue/{document_id}``. The paper is not touched."""

    removed: bool
    document_id: int


# ===========================================================================
# The watchdog, and the first-run card
# ===========================================================================

class WatchdogFinding(LosslessModel):
    """One thing the watchdog can say is wrong, with what it rests on.

    ``scope`` and ``evidence`` are declared ``dict`` rather than modeled, for
    two different reasons, and only one of them is good.

    ``evidence`` holds a different key set for each of the seven finding kinds,
    so there is no field list to write down and ``dict`` is the description
    that fits.

    ``scope`` is ``dict`` because a source's scope carries a **string** id and
    a routine's carries an **integer** one, and this docstring used to claim
    that a model declaring either would silently coerce the other. It would
    not: on the pinned pydantic 2.12.4, ``id: str`` fed ``1`` raises rather
    than stringifying it, so the mistake would be a 500 the equality sweep
    catches and not a wrong body nobody notices. ``Union[str, int]`` is the
    right annotation, keeps both runtime types, and would give a client a real
    shape instead of ``object``. It is not here because the premise was found
    to be wrong after this slice was reviewed, and adding an unreviewed model
    to an accepted change is the worse trade. See the module docstring.

    ``what_to_do`` is a field, not prose the renderer composes, because the
    sentence depends on the finding and a generic one would be advice resmon
    has not earned.
    """

    key: str
    severity: str
    kind: str
    scope: dict
    title: str
    detail: str
    what_to_do: str
    evidence: dict
    muted: bool
    muted_at: Optional[str]


class WatchdogUnjudged(LosslessModel):
    """Something the watchdog is watching and cannot judge yet.

    The other half of an empty findings list: silence from a monitor means
    either "nothing is wrong" or "nothing has been measured", and this list is
    the second. ``runs_not_a_measurement`` is present on a source row and
    absent on a routine row, so it is optional and the route excludes unset.
    """

    scope: dict
    reason: str
    runs_recorded: int
    runs_needed: int
    runs_not_a_measurement: Optional[int] = None


class WatchdogCounts(LosslessModel):
    """``alarms`` is the badge: broken plus unusual, muted ones excluded."""

    broken: int
    unusual: int
    advice: int
    muted: int
    alarms: int


class WatchdogWatching(LosslessModel):
    """How many sources and active routines the counts above are over."""

    sources: int
    routines: int


class WatchdogThresholds(LosslessModel):
    """The numbers every rule above was judged against.

    Returned rather than documented, so a user reading "has failed on its last
    3 runs" can see that 3 is the threshold and not a coincidence.
    """

    consecutive_errors: int
    consecutive_zeros: int
    min_baseline_runs: int
    flatline_runs: int
    overdue_cadence_multiple: int
    overdue_floor_days: float
    cadence_lag_multiple: float
    min_runs_for_cadence: int


class WatchdogReport(LosslessModel):
    """``GET /api/watchdog``.

    ``sufficient`` is false when there is no history to reason over at all. The
    interface then says "nothing to check yet" rather than "all clear", which
    would be a claim the watchdog has not earned — and it is exactly the field
    a model written from the happy path would have left out.
    """

    checked_at: str
    findings: list[WatchdogFinding]
    counts: WatchdogCounts
    not_enough_data: list[WatchdogUnjudged]
    watching: WatchdogWatching
    thresholds: WatchdogThresholds
    sufficient: bool


class WatchdogMuteAck(LosslessModel):
    """``POST /api/watchdog/mute`` and ``/unmute``, which differ only in ``status``."""

    status: str
    finding_key: str


class OnboardingCounts(LosslessModel):
    """What the install already has. All three zero is what ``show`` keys on."""

    documents: int
    executions: int
    routines: int


class OnboardingStep(LosslessModel):
    """One first-run step, as a fact rather than as prose.

    ``done`` is **three-valued**, and declaring it ``bool`` is a real mistake
    that this file made and ``test_onboarding.py`` caught: the two credential
    steps call ``_credential_present``, which answers ``None`` when the keyring
    will not say. An unsigned macOS build is denied the items an earlier build
    stored, and "no key" there would tell somebody to add a key they already
    have — so the backend declines to answer, and the model has to be able to
    carry that. ``done: bool`` did not merely mis-describe it; it turned a 200
    into a ``ResponseValidationError``, which is a 500.

    ``detail`` says which machine it looked on, and for the agent-CLI step it
    is detection and not a login check. The card renders it verbatim; it is not
    a key a client may synthesize.
    """

    id: str
    done: Optional[bool]
    detail: str


class OnboardingState(LosslessModel):
    """``GET /api/onboarding``."""

    show: bool
    dismissed: bool
    counts: OnboardingCounts
    steps: list[OnboardingStep]


class OnboardingDismissed(LosslessModel):
    """``POST /api/onboarding/dismiss``."""

    dismissed: bool


# ===========================================================================
# Process identity, and the catalogs
# ===========================================================================

class RuntimeIdentity(LosslessModel):
    """Which backend, over which corpus — the attach-or-spawn answer.

    This is the shape that exists because an MCP server once fell back to the
    default port and answered every question truthfully about the wrong corpus.
    ``corpus_id`` and ``build_id`` are ``None`` where the install has not
    recorded one; ``runtime_id`` is per process and always present.
    """

    contract_version: int
    runtime_id: str
    schema_version: int
    corpus_id: Optional[str]
    build_id: Optional[str]


class Health(LosslessModel):
    """``GET /api/health``.

    ``embeddings`` is attempted against a real connection on every call rather
    than read from a cached probe: it is a ``dlopen`` of a 165 KB library, and
    a health endpoint answering from memory would keep reporting a capability
    the process had lost.
    """

    status: str
    identity: RuntimeIdentity
    pid: int
    started_at: str
    version: str
    embeddings: VectorExtensionStatus


class RepositoryEntitySearch(LosslessModel):
    """How a source can be asked about a *person*, in that source's own syntax.

    ``author_syntax`` is the string ``api_base.search_entity`` puts into the
    query, and a client that rewrites it destroys it silently — which is how
    two sources reported that a researcher had published nothing for as long as
    the capability existed. ``established`` is the dated observation behind the
    rest of the row, and it is the field that makes the others checkable.
    """

    author_query: str
    identifier_query: str
    returns_orcid: bool
    returns_affiliation: bool
    author_syntax: str
    identifier_syntax: str
    established: str


class RepositorySourceNotice(LosslessModel):
    """One sentence the interface shows before a search is submitted.

    ``effect`` is the sentence itself, written as what resmon will do rather
    than as the name of the limitation, because a user cannot act on
    "year granularity" and can act on "it will search the whole of 2025".
    ``established`` is the code or the published wording the sentence was read
    from; it is not rendered beside the sentence, but it travels with it so
    that anything downstream can say where the claim came from.
    """

    kind: str
    effect: str
    established: str
    applies_when: str


class RepositoryConstraints(LosslessModel):
    """What resmon knows about a source *before* anybody presses the button.

    Deliberately not here: whether the source requires a credential. That is
    on ``api_key_requirement`` and ``credential_name`` of the entry carrying
    this object, and a second copy is the exact drift this record exists to
    prevent — the sweep engine's own list of keyed sources disagreed with the
    catalog's for three releases and a source fell through the gap.

    Also deliberately not here: whether the source is up. An outage is not
    something a user can act on while composing a query, it belongs to
    ``zero_reason`` and the source wall, and a page that warned about every
    provider's bad day would be warning about nothing.
    """

    window_effect: str
    window_rounding: str
    window_refiltered_locally: bool
    keyword_search: str
    records_per_request: Optional[int]
    notices: list[RepositorySourceNotice]
    established: str


class RepositoryCatalogEntry(LosslessModel):
    """One source, as the Repositories page renders it.

    Not decoration: ``rate_limit``, ``upstream_policy`` and
    ``keyword_combination`` are read by a user as statements of fact about
    somebody else's search engine, and ``attribution`` with its
    ``attribution_requirement`` is a license obligation rather than a courtesy
    when the requirement says ``required``. Those four are the fields a model
    written from the table's visible columns would have dropped, and dropping
    an attribution credit is the one failure mode in this file that is not
    merely a missing feature.
    """

    slug: str
    name: str
    description: str
    subject_coverage: str
    endpoint: str
    query_method: str
    rate_limit: str
    client_module: str
    api_key_requirement: str
    credential_name: Optional[str]
    website: str
    registration_url: Optional[str]
    placeholder: str
    upstream_policy: str
    parallel_safe: str
    notes: str
    keyword_combination: str
    keyword_combination_notes: str
    attribution: str
    attribution_requirement: str
    attribution_source: Optional[str]
    date_granularity: str
    entity_search: RepositoryEntitySearch
    constraints: RepositoryConstraints


class CredentialPresence(LosslessModel):
    """Whether one credential is there, never what it is.

    ``status`` is ``present``, ``absent`` or ``unreadable``, and the third is
    the one that matters: an unsigned macOS build is denied access to keychain
    items an earlier build stored, and reporting that as absent tells a user
    their keys are gone when they are merely unreachable. ``present`` is the
    older boolean, kept beside it for compatibility.
    """

    present: bool
    status: str


class CredentialsPresence(LosslessModel):
    """``GET /api/credentials``.

    ``keyring_responsive`` is false once a read has timed out, so the interface
    can say so once at the top rather than fifteen times over. The map is keyed
    by credential name — the union of the catalog's slots, the AI slots and the
    SMTP slot — and never holds a value.
    """

    keyring_responsive: bool
    credentials: dict[str, CredentialPresence]


class RendererHeartbeat(LosslessModel):
    """``POST /api/renderer/heartbeat``.

    ``ttl_sec`` is how long this ping suppresses the backend's own desktop
    notifications. It is returned rather than assumed because the renderer
    sets its interval from it, and a renderer pinging slower than the TTL
    would get both notifications.
    """

    ok: bool
    ttl_sec: float


# ===========================================================================
# Saved configurations
# ===========================================================================

class SavedConfiguration(LosslessModel):
    """One saved configuration, as the list returns it.

    ``parameters`` is a parsed object **here** and a JSON string on the body
    ``PUT`` answers — see ``ConfigurationUpdated``. The two really do differ,
    the list route parses the column and the write route echoes what it stored,
    and declaring both the same way would have made this contract wrong about
    one of them. It is ``Any`` rather than ``dict`` because the parse is
    best-effort: a column that will not parse is left as its original string.
    """

    id: int
    name: str
    config_type: str
    parameters: Any
    created_at: str
    updated_at: str


class ConfigurationCreated(LosslessModel):
    """``POST /api/configurations`` — 201, with the id the caller needs next."""

    id: int
    name: str
    config_type: str


class ConfigurationUpdated(LosslessModel):
    """``PUT /api/configurations/{config_id}``.

    **The body assembled from whichever fields the caller sent.** The handler
    builds ``{"id": ..., **updates}``, where ``updates`` holds only the fields
    the request carried, so a rename answers two keys and a rename-plus-rewrite
    answers three. ``response_model_exclude_unset=True`` is what keeps the
    first case two keys instead of three-with-a-null.

    ``parameters`` is a ``str`` because that is what the handler echoes: it
    stored ``json.dumps(...)`` and puts the stored text back. The list route
    answers the parsed object instead.
    """

    id: int
    name: Optional[str] = None
    parameters: Optional[str] = None


class ConfigurationDeleted(LosslessModel):
    """``DELETE /api/configurations/{config_id}``.

    Deleting a routine configuration deletes its linked routine too, and the
    body says nothing about that. It is recorded here rather than in the model
    because adding a field would be inventing one the handler does not send.
    """

    success: bool


class ConfigurationExport(LosslessModel):
    """``POST /api/configurations/export`` — where the zip was written.

    A local filesystem path, which is a desktop app's honest answer: the
    renderer reveals it in the Finder. It is the user's configured export
    directory when they have one and a temporary file when they do not.
    """

    path: str


class ConfigurationImportResult(LosslessModel):
    """``POST /api/configurations/import``.

    ``routines_created`` is separate from ``imported`` because a routine
    configuration arrives as one file and lands as two rows, and a count that
    folded them together would tell a user they had imported twice what they
    did. ``errors`` carries the files that could not be read, so a bad entry
    reports itself rather than failing the batch.
    """

    imported: int
    routines_created: int
    errors: list[str]


# ===========================================================================
# Whether routines will fire
# ===========================================================================

#: Who, if anyone, fires this database's routines, as far as this backend can
#: establish. ``fires_here`` is the only state in which this backend vouches
#: for a schedule; every other state names why it cannot, and the six differ in
#: the reason a user is given and nothing else. ``resmon.scheduler_status``
#: holds the rule that picks one.
SchedulerState = Literal[
    "fires_here",
    "no_service",
    "service_stopped",
    "service_other_version",
    "service_elsewhere",
    "service_unreachable",
    "scheduler_off",
]

#: Why one active routine will, will not, or may fire.
RoutineFiringReason = Literal[
    "scheduled",
    "not_scheduled",
    "no_scheduler_running",
    "unconfirmed",
]


class RoutineFiring(LosslessModel):
    """One active routine, and whether anything will fire it.

    ``will_fire`` is three-valued on purpose. ``True`` only where this
    backend's own scheduler holds the job; ``False`` where nothing can fire it
    as things stand; ``None`` where the answer depends on which database a
    running service serves, which no resmon so far reports. A two-valued field
    would have had to guess the third case one way or the other.
    """

    id: int
    will_fire: Optional[bool]
    reason: RoutineFiringReason


class SchedulerStatus(LosslessModel):
    """``GET /api/scheduler/status``.

    ``service_version`` is the version the running background service reported
    (or its lock recorded, where it reported none), and ``None`` where no
    service answered. ``routines`` lists the **active** routines only: an
    inactive routine is not expected to fire, and a verdict on it would invite a
    sentence about nothing.
    """

    state: SchedulerState
    app_version: str
    service_installed: bool
    service_version: Optional[str]
    routines: list[RoutineFiring]
