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

No resmon code produces any of the three in a route modeled today — there is
no ``Decimal`` and no ``PurePath`` anywhere in the backend, and ``math.inf``
appears only inside ``api_base``'s rate-limiter arithmetic, never in a response
dict. A non-finite float can still arrive from a file or a row edited by hand,
in a field declared ``Any``; ``AssistantMessage`` and ``BundleReport`` say
where. This is written down for whoever models the rest, because the
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
set for each of the eight finding kinds, so there is no field list to write
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

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "AiCliProbe",
    "AiCliStatus",
    "AiSettings",
    "AssistantSettings",
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

    ``checked_documents`` counts only the papers a check looked at. Those it
    found nothing to ask about (``no_identifier_documents``) and those a
    service failed on (``errored_documents``) are counted apart, because
    neither was cleared.
    """

    findings: list[WatchProfileLifecycleFinding]
    matched_documents: int
    checked_documents: int
    no_identifier_documents: int
    errored_documents: int
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


class Appearance(LosslessModel):
    """``GET`` and ``PUT /api/appearance``: the theme and the accent chosen.

    ``accent`` is a lowercase ``#rrggbb``, or null when none has been chosen and
    the interface draws its own default. The PUT answers what it stored, so a
    caller can see the lowercasing rather than assume it.
    """

    theme: Literal["system", "light", "dark"]
    accent: Optional[str]


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


class AiCliSignIn(LosslessModel):
    """``GET /api/ai/cli/sign-in``: what the command said about its own sign-in.

    ``state`` is ``signed_in`` or ``signed_out`` only when the command said so,
    ``expired`` when its words say the sign-in it had expired, ``unknown`` when
    it answered without saying (``said`` then holds its own words), ``missing``
    when resmon did not find the command, and ``failed`` when it could not be
    run. ``email``, ``plan`` and ``method`` are present only when the command
    reported them. ``message`` is one sentence for a person. ``command`` is the
    status command as it would be typed. Nothing in this answer is stored.
    """

    provider: str
    state: Literal["signed_in", "signed_out", "expired", "unknown", "missing", "failed"]
    message: str
    email: Optional[str]
    plan: Optional[str]
    method: Optional[str]
    said: Optional[str]
    command: str
    path: Optional[str]
    checked_at_utc: str


class AiCliSignInOpened(LosslessModel):
    """``POST /api/ai/cli/sign-in``: whether the command's own login was opened.

    ``how`` is ``terminal`` when a Terminal window was asked to run it,
    ``copy`` when the person runs ``command`` themselves, and ``none`` when
    there is no command to run. ``message`` says which, in a sentence.
    """

    provider: str
    opened: bool
    how: Literal["terminal", "copy", "none"]
    command: str
    path: Optional[str]
    message: str


class AiLastAnsweredEntry(LosslessModel):
    """The model that last answered one requested model on one command.

    ``requested`` is the alias or id that was asked for, ``""`` where the
    command chose. ``model`` is what the answer reported, ``name`` the same in
    a person's words. ``where`` is ``ask`` or ``summaries``.
    """

    provider: str
    requested: str
    model: str
    name: str
    where: Literal["ask", "summaries"]
    observed_at_utc: str


class AiLastAnswered(LosslessModel):
    """``GET /api/ai/last-answered``: one entry per command and requested model."""

    entries: list[AiLastAnsweredEntry]


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


class MapRegion(LosslessModel):
    """One region of the collection map: a disc on the plate, and its name.

    ``label`` and ``terms`` are the words most distinctive of the region's
    papers, so they are always lexical, whatever basis placed the papers.
    """

    id: int
    label: str
    terms: list[str]
    x: float
    y: float
    r: float
    size: int


class MapPoints(LosslessModel):
    """Every paper on the plate, one entry per paper in each list, in id order.

    Columns rather than one object per paper: at 100,000 papers this is the
    difference between a few megabytes and a few dozen."""

    id: list[int]
    x: list[float]
    y: list[float]
    region: list[int]
    seen_day: list[int]


class MapUnplaced(LosslessModel):
    """Papers in the collection that are not on the plate, and why."""

    no_text: int
    not_embedded: int


class CollectionMap(LosslessModel):
    """``GET /api/map``: where every paper sits, and on what basis.

    ``basis`` says what nearness means on this map: ``embeddings`` (the set
    model's vectors) or ``words`` (word statistics computed on this machine).
    It describes the points served, which during a refit can differ from the
    basis the next map will have.
    """

    state: Literal["empty", "fitting", "failed", "ready"]
    basis: Optional[Literal["embeddings", "words"]]
    model: Optional[str]
    fitted_at: Optional[str]
    fitted_count: int
    placed_since_fit: int
    refitting: bool
    error: Optional[str]
    embedding_coverage: Optional[EmbeddingCoverage]
    unplaced: MapUnplaced
    regions: list[MapRegion]
    points: MapPoints


class TodaySourceNote(LosslessModel):
    """A source that did not answer on a watch's last run, or whose answer is unknown.

    ``source`` is the slug; ``name`` is the source as a person knows it, a
    withdrawn one included. ``category`` is ``non_answer`` (it did not answer)
    or ``unknown`` (resmon cannot say whether it answered), and ``label`` the
    short words for the particular outcome.
    """

    source: str
    name: str
    category: Literal["non_answer", "unknown"]
    label: str
    note: str


class TodayRun(LosslessModel):
    """A watch's most recent run."""

    execution_id: int
    status: str
    started_at: Optional[str]
    ended_at: Optional[str]
    result_count: int
    new_result_count: int
    sources_total: int
    sources_answered: int
    sources_not_answered: list[TodaySourceNote]


class TodayWatch(LosslessModel):
    """A routine, with what it found since the last look.

    ``next_fire_at`` is what the job store holds, not a promise that anything
    will fire it: ``/api/scheduler/status`` says whether something will.
    """

    id: int
    name: str
    is_active: bool
    new_count: int
    last_run: Optional[TodayRun]
    next_fire_at: Optional[str]
    #: Every paper this watch's runs have ever returned, for its outline on the plate.
    members: list[int]


class TodayPaper(LosslessModel):
    """A paper resmon first collected since the last look.

    ``abstract_lede`` is the opening of the abstract as the source gave it,
    never a summary; resmon does not keep summaries per paper.
    """

    id: int
    title: str
    authors: Optional[str]
    source: str
    publication_date: Optional[str]
    first_seen_at: Optional[str]
    abstract_lede: Optional[str]
    url: Optional[str]
    doi: Optional[str]
    watches: list[int]
    queue_status: Optional[str]


class Today(LosslessModel):
    """``GET /api/today``.

    ``window`` is ``since_last_look`` when a look is recorded and
    ``first_look`` when none is, in which case ``since`` is seven days before
    ``now`` and the interface says so. ``papers`` holds at most 1,000, newest
    first; ``total`` counts them all.
    """

    now: str
    since: Optional[str]
    window: Literal["since_last_look", "first_look"]
    total: int
    papers: list[TodayPaper]
    from_searches: int
    watches: list[TodayWatch]


class DocumentBrief(LosslessModel):
    """``POST /api/documents/briefs``: one line about a paper, for a hover."""

    id: int
    title: str
    authors: Optional[str]
    source: str
    publication_date: Optional[str]
    first_seen_at: Optional[str]


class TodayLooked(LosslessModel):
    """``POST /api/today/looked``: the moment recorded."""

    looked_at: str


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

    ``evidence`` holds a different key set for each of the eight finding kinds,
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
    skipped_fires_window_days: int


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
    result_order: Literal["newest_first", "relevance", "unstated"]
    result_order_established: str
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


# ===========================================================================
# Runs: starting one, reading one, stopping one, starting it again
# ===========================================================================

class RunStarted(LosslessModel):
    """``POST /api/search/dive`` and ``POST /api/search/sweep``.

    ``duplicate`` is present only when ``request_id`` matched a submission
    already made, and the id is that earlier run's: a retried click starts
    nothing new. Absent rather than ``false`` on a first submission.
    """

    execution_id: int
    duplicate: Optional[bool] = None


class RunCoverageCounts(LosslessModel):
    """How the selected sources split. ``genuine_empty`` and ``partial`` are
    subsets of ``answered``, not further categories."""

    answered: int
    non_answer: int
    unknown: int
    genuine_empty: int
    partial: int


class RunCoverageSource(LosslessModel):
    """One source's recorded outcome on one run, from ``source_coverage.outcome``.

    ``category`` is ``answered``, ``non_answer`` or ``unknown``; ``label`` is
    the short reason a person reads, and ``note`` the sentence that explains
    it. A selected source with no recorded row is ``unknown`` with
    ``outcome_recorded`` false, and every recorded field ``None``: nothing about
    an attempt, a failure or an empty answer can be inferred from silence.
    """

    source: str
    category: str
    label: str
    note: str
    outcome_recorded: bool
    status: Optional[str]
    result_count: Optional[int]
    zero_reason: Optional[str]
    recorded_at: Optional[str]
    genuine_empty: bool
    partial: bool


class RunCoverage(LosslessModel):
    """Which sources answered a run, as ``source_coverage.build`` accounts for it.

    The same object the Results page, a delivery envelope and the search
    record read, built from saved facts at read time. ``summary`` is the one
    sentence; ``sources`` is the run's selection, in its order, and
    ``additional_sources`` what was recorded outside it.
    """

    execution_id: int
    basis: str
    basis_label: str
    selection_known: bool
    total: int
    counts: RunCoverageCounts
    summary: str
    sources: list[RunCoverageSource]
    additional_sources: list[RunCoverageSource]
    notes: list[str]


class RunSourceOutcomes(LosslessModel):
    """The compact per-run count the list shows on each row.

    ``could_not_answer`` counts the zeros that were not answers; ``not_recorded``
    the zeros resmon never observed, deliberately folded into neither.
    """

    selected: int
    answered: int
    could_not_answer: int
    not_recorded: int
    sources_that_could_not_answer: list[str]


class RunColumns(LosslessModel):
    """The ``executions`` row as stored, in column order, and its configuration's name.

    ``parameters`` and ``progress_events`` are the stored JSON **text**, not
    parsed objects; ``query``, ``keywords`` and ``repositories`` on the models
    below are what the engine parsed out of ``parameters`` for a reader.
    ``interrupted_reason`` is set only on an interrupted run: ``owner_dead``
    (the process running it stopped), ``daemon_restart`` (resmon was shut
    down) or ``unknown``.
    """

    id: int
    execution_type: str
    routine_id: Optional[int]
    saved_configuration_id: Optional[int]
    parameters: Optional[str]
    start_time: Optional[str]
    end_time: Optional[str]
    status: str
    result_count: Optional[int]
    new_result_count: Optional[int]
    log_path: Optional[str]
    result_path: Optional[str]
    error_message: Optional[str]
    progress_events: Optional[str]
    current_stage: Optional[str]
    owner_pid: Optional[int]
    owner_runtime_id: Optional[str]
    last_seen_at_utc: Optional[str]
    interrupted_reason: Optional[str]
    restarted_from: Optional[int]
    cancel_reason: Optional[str]
    dedup_total: Optional[int]
    dedup_new: Optional[int]
    dedup_duplicates: Optional[int]
    dedup_invalid: Optional[int]
    dedup_cross_source: Optional[int]
    request_id: Optional[str]
    saved_configuration_name: Optional[str]


class RunRow(RunColumns):
    """One row of ``GET /api/executions``, newest first."""

    coverage: RunCoverage
    query: Optional[str]
    keywords: Optional[list[str]]
    repositories: Optional[list[str]]
    total_results: Optional[int]
    new_results: Optional[int]
    source_outcomes: Optional[RunSourceOutcomes]


class RunAiLaneModel(LosslessModel):
    """A model an agent CLI reported for a lane's calls.

    ``model`` is the id as the command reported it, ``name`` the same id in a
    person's words ("Haiku 4.5"), or the id itself where resmon does not
    recognize its shape. ``calls`` is how many of the lane's calls named it.
    """

    model: str
    name: str
    calls: int


class RunAiLane(LosslessModel):
    """One summary lane a run tried, as ``execution_ai`` records it.

    ``outcome`` is ``ok`` (every paper it was given), ``partial``, ``failed``,
    ``skipped`` (an earlier lane covered everything) or ``running`` (the process
    stopped while the lane held the work). ``credential_alias`` names a keyring
    slot, never a key. ``model`` is what was asked for, often an alias;
    ``answered_by`` is what the lane's command reported answered, biggest
    writer first, and is empty where nothing was reported.
    """

    lane_index: int
    lane_label: str
    lane_kind: Literal["subscription", "api_key", "local"]
    provider: str
    model: Optional[str]
    credential_alias: Optional[str]
    outcome: Literal["running", "ok", "partial", "failed", "skipped"]
    error_kind: Optional[str]
    http_status: Optional[int]
    safe_message: Optional[str]
    docs_attempted: int
    docs_succeeded: int
    started_at: str
    ended_at: Optional[str]
    answered_by: list[RunAiLaneModel]


class Run(RunColumns):
    """``GET /api/executions/{exec_id}``: the row, which backend answered, the
    runs restarted from it (the reverse of ``restarted_from``), and the summary
    lanes it tried."""

    identity: RuntimeIdentity
    coverage: RunCoverage
    query: Optional[str]
    keywords: Optional[list[str]]
    repositories: Optional[list[str]]
    total_results: Optional[int]
    new_results: Optional[int]
    source_outcomes: Optional[RunSourceOutcomes]
    restarted_into: list[int]
    ai_lanes: list[RunAiLane]


class ActiveRuns(LosslessModel):
    """``GET /api/executions/active``: the runs this backend is running now."""

    active_ids: list[int]


class RunReport(LosslessModel):
    """``GET /api/executions/{exec_id}/report``: the Markdown report as written."""

    report_text: str


class RunLog(LosslessModel):
    """``GET /api/executions/{exec_id}/log``: the run's log as written."""

    log_text: str


class RunCancelRequested(LosslessModel):
    """``POST /api/executions/{exec_id}/cancel``. Cancellation is cooperative:
    this says it was asked for, not that the run has stopped."""

    status: Literal["cancellation_requested"]


class RunRestarted(LosslessModel):
    """``POST /api/executions/{exec_id}/restart``: a new run with the old one's
    parameters, linked back to it. ``duplicate`` as on ``RunStarted``."""

    execution_id: int
    restarted_from: Optional[int]
    ai_enabled: bool
    duplicate: Optional[bool] = None


# ===========================================================================
# The collection: searching it, a paper's account, and the same work twice
# ===========================================================================

class PaperColumns(LosslessModel):
    """A ``documents`` row as stored, in column order.

    ``authors`` and ``categories`` are the stored text, not parsed lists.
    ``pub_sort`` is the generated sort key (the publication date, or an empty
    string where there is none) that keyset paging orders by.
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
    metadata_hash: str
    first_seen_at: str
    pub_sort: str


class ExplorerPaper(PaperColumns):
    """One row of an Explorer page. ``distance`` is present only under the
    similarity sort, and ``None`` for a paper with no vector yet, which is
    listed after every ranked one rather than dropped."""

    distance: Optional[float] = None


class ExplorerPage(LosslessModel):
    """``POST /api/explorer/search``.

    ``total`` is the count of every match, capped at ``count_cap`` when
    ``total_is_capped``. Under ``sort == "similarity"`` the phrase ranks the
    filtered set rather than filtering it, and ``ranked_count``,
    ``unranked_count`` and ``model`` say how; ``similarity_unavailable`` says
    why a requested ranking was refused and the page fell back to newest.
    Each of those four is absent when it does not apply.
    """

    results: list[ExplorerPaper]
    next_cursor: Optional[Any]
    has_more: bool
    total: int
    total_is_capped: bool
    count_cap: int
    used_full_text_index: bool
    page_size: int
    sort: str
    ranked_count: Optional[int] = None
    unranked_count: Optional[int] = None
    model: Optional[str] = None
    similarity_unavailable: Optional[str] = None


class Paper(PaperColumns):
    """``GET /api/documents/{doc_id}``: one paper as stored, and its place in the
    reading queue (``to_read``, ``read``, or ``None`` when it is not saved)."""

    queue_status: Optional[str]


class RunPaper(PaperColumns):
    """One of a run's papers, and where it stands in the reading queue
    (``to_read``, ``read``, or ``None`` when it is not saved)."""

    queue_status: Optional[str]


class RunPapersPage(LosslessModel):
    """``GET /api/executions/{exec_id}/documents``: one page of a run's papers."""

    papers: list[RunPaper]
    total: int
    limit: int
    offset: int
    only_new: bool


class PaperWhyDocument(LosslessModel):
    id: int
    title: str
    source_repository: str
    doi: Optional[str]
    publication_date: Optional[str]
    first_seen_at: Optional[str]


class PaperWhySource(LosslessModel):
    """The source the paper came from, and whether resmon or the source decided
    the match: ``resmon_filtered_locally`` is false for a relevance-ranked
    upstream, which resmon cannot speak about with certainty."""

    slug: str
    name: str
    keyword_combination: str
    keyword_combination_notes: str
    resmon_filtered_locally: bool


class PaperWhyRun(LosslessModel):
    execution_id: int
    execution_type: str
    start_time: Optional[str]
    routine_name: Optional[str]
    keywords: list[str]


class PaperWhyKeyword(LosslessModel):
    """One requested keyword: whether it is in the fields resmon holds, which
    ones, and those named in words (``where``)."""

    keyword: str
    matched: bool
    fields: list[str]
    where: str
    contains_operators: bool


class PaperWhy(LosslessModel):
    """``GET /api/documents/{doc_id}/why``: what resmon can say about why a
    paper is in the corpus, and ``what_resmon_cannot_see`` -- the limits of
    that account, stated rather than implied."""

    document: PaperWhyDocument
    source: PaperWhySource
    runs: list[PaperWhyRun]
    keywords: list[PaperWhyKeyword]
    matched_count: int
    keyword_count: int
    verdict: str
    headline: str
    what_resmon_cannot_see: list[str]
    fields_checked: list[str]


class PaperLink(LosslessModel):
    """Another record that looks like the same work, and why: ``method`` is
    ``shared_doi`` or ``vector+title``; ``label`` is the sentence a person reads."""

    id: int
    title: str
    source_repository: str
    kind: str
    score: Optional[float]
    method: str
    label: str


class PaperLinks(LosslessModel):
    """``POST /api/links/for-documents``: the links of each asked-for paper,
    keyed by its id as a string. A paper with none is absent."""

    links: dict[str, list[PaperLink]]


class CollapsePreview(LosslessModel):
    """``POST /api/links/collapse-preview``: which rows a per-view fold would
    keep, and which it would fold into each kept one. It hides nothing itself."""

    keep: list[int]
    folded: dict[str, list[int]]


class EmbeddingStatus(EmbeddingJobStatus):
    """``GET /api/embeddings/status``: the backfill, the coverage, the vector
    extension and index, the configured lane, and whether ranking by meaning
    is available now (and if not, why)."""

    lane: Optional[EmbeddingLaneView]
    capability: EmbeddingCapability


# ===========================================================================
# Watches: a routine, its schedule, its runs and papers, where its reports go,
# and whether it finds what was meant
# ===========================================================================

class MissedFires(LosslessModel):
    """Fires that did not run, counted in pairs with the time beside each count.

    ``count`` is every recorded miss. ``overlap_skipped`` is the subset refused
    because the routine's previous run was still going; the rest came due while
    resmon was not running, and ``last_closed_miss_due_at_utc`` is the latest of
    those. A routine that has missed none answers with zeros, not an absent key.
    """

    count: int
    last_due_at_utc: Optional[str]
    overlap_skipped: int
    last_overlap_skipped_due_at_utc: Optional[str]
    last_closed_miss_due_at_utc: Optional[str]


class MissedFire(LosslessModel):
    """One fire that came due and did not run, and what became of it since."""

    id: int
    routine_id: int
    due_at_utc: str
    observed_at_utc: Optional[str]
    disposition: Optional[str]


class DateWindowComputed(LosslessModel):
    """The dates a moving window asked for, or would ask for now, and how.

    ``mode`` is the watch's choice (``date_window`` in its parameters):
    ``since_previous_run`` or ``last_days``. ``basis`` is how the start was
    reached: ``previous_run`` (that run's start, less ``overlap_days``),
    ``no_previous_run`` (no earlier run in which a source answered, so the last
    ``default_days``) or ``last_days`` (``days`` before the run). ``date_to`` is
    always ``None``: the window has no end. ``sentence`` says all of it, dates
    included, in the words a run's record and a watch's page show.
    """

    mode: Literal["since_previous_run", "last_days"]
    basis: Literal["previous_run", "no_previous_run", "last_days"]
    date_from: str
    date_to: Optional[str]
    days: Optional[int]
    previous_execution_id: Optional[int]
    previous_start_time: Optional[str]
    overlap_days: Optional[int]
    default_days: Optional[int]
    computed_at: str
    sentence: str


class RoutineRow(LosslessModel):
    """One row of ``GET /api/routines``: the ``routines`` row as stored, and
    what its latest run did.

    The five switches are SQLite's ``0`` and ``1`` here, as this list has always
    sent them; the single-routine read below coerces them to booleans. Typed as
    sent rather than as meant, so neither body changes. ``parameters``,
    ``ai_settings`` and ``storage_settings`` are the stored JSON text, not
    parsed objects. ``last_execution`` repeats ``last_executed_at`` under the
    name the classic table reads.
    """

    id: int
    name: str
    schedule_cron: str
    parameters: str
    is_active: int
    email_enabled: int
    email_ai_summary_enabled: int
    ai_enabled: int
    notify_on_complete: int
    ai_settings: Optional[str]
    storage_settings: Optional[str]
    intent: Optional[str]
    execution_location: Optional[str]
    created_at: str
    updated_at: str
    last_executed_at: Optional[str]
    last_execution: Optional[str]
    last_status: Optional[str]
    missed_fires: MissedFires


class Routine(LosslessModel):
    """``GET /api/routines/{routine_id}``: one routine, its switches as
    booleans, and every fire it missed, oldest first. ``date_window_next`` is
    present only for a watch whose window moves (``date_window`` in its
    parameters): the dates a run starting now would ask for."""

    id: int
    name: str
    schedule_cron: str
    parameters: str
    is_active: bool
    email_enabled: bool
    email_ai_summary_enabled: bool
    ai_enabled: bool
    notify_on_complete: bool
    ai_settings: Optional[str]
    storage_settings: Optional[str]
    intent: Optional[str]
    execution_location: Optional[str]
    created_at: str
    updated_at: str
    last_executed_at: Optional[str]
    missed_fires: MissedFires
    missed_fire_details: list[MissedFire]
    date_window_next: Optional[DateWindowComputed] = None


class RoutineCreated(LosslessModel):
    """``POST /api/routines``. ``entity`` is present only for a routine that
    watches a person, and ``entity_warning`` only when none of its sources can
    be asked about one: the routine is still created, and the sentence says it
    will find nothing until a source that can is added."""

    id: int
    name: str
    entity: Optional[dict[str, Any]] = None
    entity_warning: Optional[str] = None


class RoutineUpdated(LosslessModel):
    """``PUT /api/routines/{routine_id}``: the id and each column the request
    changed, as stored. Absent where unchanged; ``intent`` is ``None`` where
    the request cleared it. Switches are stored ``0`` or ``1`` and the JSON
    columns as text, which is what this answer repeats."""

    id: int
    name: Optional[str] = None
    schedule_cron: Optional[str] = None
    parameters: Optional[str] = None
    intent: Optional[str] = None
    is_active: Optional[int] = None
    email_enabled: Optional[int] = None
    email_ai_summary_enabled: Optional[int] = None
    ai_enabled: Optional[int] = None
    ai_settings: Optional[str] = None
    storage_settings: Optional[str] = None
    notify_on_complete: Optional[int] = None


class RoutineActivation(LosslessModel):
    """``POST /api/routines/{routine_id}/activate`` and ``/deactivate``. Only
    the schedule changes: the routine and its runs stay."""

    id: int
    is_active: bool


class RoutineRunStarted(LosslessModel):
    """``POST /api/routines/{routine_id}/run``: a run started now, outside the
    schedule, or queued to start when a slot frees.

    ``was_inactive`` says the routine was not scheduled and ran once because it
    was asked to, and ``detail`` says so in a sentence. At the run limit the
    answer is a 202 with ``execution_id`` null, ``queued`` true and
    ``queue_position`` (1 is next): the run starts on its own. A routine
    already running is refused with a 409 whose detail names that run, and so
    is a fire the full queue turned away; both are error bodies, not this one.
    """

    execution_id: Optional[int]
    routine_id: int
    was_inactive: bool
    missed_fires_marked_ran_late: int
    detail: str
    queued: Optional[bool] = None
    queue_position: Optional[int] = None


class RoutineDocuments(LosslessModel):
    """``GET /api/routines/{routine_id}/documents``: the papers this routine's
    runs collected, newest run first, each once.

    ``total`` counts every one; ``document_ids`` stops at ``limit``. Only ids:
    what a screen marks on the collection map, not a page of records.
    """

    routine_id: int
    document_ids: list[int]
    total: int
    limit: int


class DeliveryTarget(LosslessModel):
    """A destination a routine's reports go to. ``enabled`` is stored ``0`` or
    ``1``; ``mode`` is ``automatic`` or ``review`` (each delivery waits for a
    person)."""

    id: int
    routine_id: int
    channel: str
    target: str
    enabled: int
    mode: str
    created_at_utc: str
    updated_at_utc: str


class DeliveryTargets(LosslessModel):
    """``GET /api/routines/{routine_id}/delivery-targets``, and the channels
    resmon can act on today, so a screen offers exactly those."""

    routine_id: int
    targets: list[DeliveryTarget]
    shipped_channels: list[str]


class DeliveryTargetAdded(LosslessModel):
    """``POST /api/routines/{routine_id}/delivery-targets``."""

    id: int
    routine_id: int


class Delivery(LosslessModel):
    """One report's journey to one destination, as recorded.

    ``state`` is the drain's own word: ``queued``, ``awaiting_review``,
    ``delivering``, ``delivered``, ``failed`` or ``skipped``. ``target_snapshot``
    is where it was sent at the time, which survives the destination being
    removed. Each field is stored, none inferred: "delivered" is never read
    off the absence of an error.
    """

    id: int
    execution_id: int
    target_id: Optional[int]
    channel: str
    target_snapshot: str
    state: str
    attempts: int
    next_attempt_at_utc: Optional[str]
    last_error: Optional[str]
    artifact_sha256: Optional[str]
    owner_pid: Optional[int]
    owner_runtime_id: Optional[str]
    queued_at_utc: str
    delivered_at_utc: Optional[str]


class DeliverySummaryLast(LosslessModel):
    """The most recent delivery of a routine, in brief."""

    id: int
    execution_id: int
    channel: str
    state: str
    attempts: int
    last_error: Optional[str]
    delivered_at_utc: Optional[str]


class DeliverySummary(LosslessModel):
    """Enabled destinations by channel, how many deliveries wait for a person,
    and the latest one, or ``None`` where there has been none."""

    targets: dict[str, int]
    enabled_target_count: int
    awaiting_review: int
    last: Optional[DeliverySummaryLast]


class RoutineDeliveries(LosslessModel):
    """``GET /api/routines/{routine_id}/deliveries``: the record, newest
    first."""

    routine_id: int
    deliveries: list[Delivery]
    summary: DeliverySummary


class DeliveryActed(LosslessModel):
    """``POST /api/deliveries/{delivery_id}/deliver``, ``/skip`` and ``/retry``:
    the state the person's decision left it in. ``attempts`` is present only on
    a retry, which starts the count again."""

    id: int
    state: str
    attempts: Optional[int] = None


class CoveragePaper(LosslessModel):
    """One paper in a coverage list, and its distance from the intent: what was
    measured, not a verdict on whether it belongs."""

    id: int
    distance: float
    title: str
    source_repository: str
    publication_date: Optional[str]
    doi: Optional[str]
    url: Optional[str]


class CoverageDistribution(LosslessModel):
    """How far this routine's own results sit from its intent."""

    count: int
    min: float
    median: float
    p75_cutoff: float
    max: float


class RoutineCoverage(LosslessModel):
    """``GET /api/routines/{routine_id}/coverage``: is this routine finding what
    was meant, and what is it missing?

    ``intent_source`` is ``stated`` for a written intent and ``keywords`` where
    none was written and the routine's keywords stand in, which measures the
    query against what the query produced. ``cannot_see`` is the sentence that
    bounds both lists: resmon compares only against papers it already holds.
    ``reason`` says why there is nothing to measure, or is ``None``.
    ``summary`` is present whenever the audit itself ran, including to say why
    it measured nothing; ``missed_reference_distance`` (the median of this
    routine's own distances, which a missed paper must be inside) only when it
    measured. ``window_note`` is present for a watch whose window moves and
    has run with it: the earliest date its runs asked from, and that an older
    paper was never asked for.
    """

    routine_id: int
    routine_name: Optional[str]
    intent: str
    intent_source: str
    model: Optional[str]
    cannot_see: str
    results: int
    results_embedded: int
    off_target: list[CoveragePaper]
    off_target_total: int
    missed_in_corpus: list[CoveragePaper]
    missed_in_corpus_total: int
    missed_in_corpus_total_is_lower_bound: bool
    distribution: Optional[CoverageDistribution]
    reason: Optional[str]
    missed_reference_distance: Optional[float] = None
    summary: Optional[str] = None
    window_note: Optional[str] = None


class CalendarEvent(LosslessModel):
    """One event of ``GET /api/calendar/events``: a run that happened, or a fire
    a routine's schedule promises.

    A run's ``id`` is its execution id; a promised fire's is a string naming
    the routine and the time (``routine-3-2026-10-29T09:00:00-04:00``) and its
    ``status`` is ``scheduled``. Promised fires are expanded only for active
    routines, from now to a year ahead, in the machine's own timezone.
    ``saved_configuration_id`` and ``saved_configuration_name`` are present on
    runs only.
    """

    id: Union[int, str]
    title: str
    start: str
    end: str
    allDay: bool
    color: str
    execution_id: Optional[int]
    routine_id: Optional[int]
    saved_configuration_id: Optional[int] = None
    saved_configuration_name: Optional[str] = None
    type: str
    status: str
    query: Optional[str]
    total_results: Optional[int]
    new_results: Optional[int]


# ---------------------------------------------------------------------------
# The background service, the test send, and a credential stored or removed
# ---------------------------------------------------------------------------


class ServiceStatus(LosslessModel):
    """``GET /api/service/status`` — whether the unit file is installed.

    ``installed`` is the file's presence at ``unit_path`` and nothing more: an
    installed unit says nothing about whether a service is running, which is
    ``/api/service/daemon-status``'s question. ``platform`` is ``sys.platform``.
    """

    installed: bool
    unit_path: str
    platform: str


class DaemonStatus(LosslessModel):
    """``GET /api/service/daemon-status`` — the lock file, and what answered.

    ``running`` is true only when a lock names a port and that port's health
    answered 200; ``pid``, ``port``, ``version`` and ``started_at`` are the
    probe's, and the ``lock_*`` fields are the file's own, which may name a
    process that has died. ``error`` says why a lock that is present did not
    answer. ``is_self`` is present only on a probe that answered, and is true
    when the answer came from the process serving this request: a window
    attached to the service rather than beside it.
    """

    lock_present: bool
    running: bool
    pid: Optional[int]
    port: Optional[int]
    version: Optional[str]
    started_at: Optional[str]
    lock_pid: Optional[int]
    lock_port: Optional[int]
    lock_version: Optional[str]
    error: Optional[str]
    is_self: Optional[bool] = None


class ServiceInstalled(LosslessModel):
    """``POST /api/service/install`` — the unit written, and where."""

    installed: bool
    unit_path: str


class ServiceUninstalled(LosslessModel):
    """``POST /api/service/uninstall``.

    ``removed`` is whether a file was there to remove: uninstalling a service
    that was never installed answers ``installed: false`` and ``removed:
    false`` rather than an error.
    """

    installed: bool
    unit_path: str
    removed: bool


class TestEmailSent(LosslessModel):
    """``POST /api/settings/email/test`` — a send the SMTP server accepted.

    Only the first recipient is sent to, and ``recipient`` names it. Every
    failure, an incomplete configuration included, is a 400 whose ``detail``
    says which, so this body is the success case alone.
    """

    # Not a test class, whatever its name says to pytest's collector.
    __test__ = False

    success: bool
    recipient: str


class CredentialChanged(LosslessModel):
    """``PUT`` and ``DELETE /api/credentials/{key_name}``: ``{"success": true}``.

    Never the value. A ``PUT`` names its slot in the path and carries the
    value in the body; the answer says only that the keyring took it.
    """

    success: bool


# ---------------------------------------------------------------------------
# The Source wall
# ---------------------------------------------------------------------------


class SourceWallRun(LosslessModel):
    """One column of the wall: a run, oldest first."""

    execution_id: int
    execution_type: str
    status: Optional[str]
    started_at: Optional[str]
    ended_at: Optional[str]
    label: str


class SourceWallCell(LosslessModel):
    """One source's recorded answer to one run, already classified.

    ``state`` is one of ``source_wall.WALL_STATES``; ``label`` and ``note`` are
    ``source_coverage``'s own words, unedited. ``outcome_recorded`` false is a
    run with no row for this source, which reads as not recorded or, where the
    run's saved selection says so, not asked. ``in_selection`` is ``None`` when
    the run's selection cannot be read.
    """

    execution_id: int
    state: str
    label: str
    note: str
    result_count: Optional[int]
    status: Optional[str]
    zero_reason: Optional[str]
    partial: bool
    outcome_recorded: bool
    in_selection: Optional[bool]


class SourceWallSource(LosslessModel):
    """One row: a source, its cells in run order, and how many of each state."""

    slug: str
    name: str
    in_catalog: bool
    cells: list[SourceWallCell]
    counts: dict[str, int]
    latest_known_state: Optional[str]


class SourceWallLegendEntry(LosslessModel):
    state: str
    label: str
    meaning: str


class SourceWallVerdict(LosslessModel):
    """The sentence at the top. ``level`` is ``empty``, ``ok``, ``attention`` or ``unknown``."""

    level: str
    headline: str
    detail: list[str]


class SourceWallWindow(LosslessModel):
    requested: int
    returned: int
    max: int
    runs_available: int


class SourceWall(LosslessModel):
    """``GET /api/coverage/source-wall``: every source's answer to each of the last runs.

    Served classified, with every word a screen draws: the legend, the verdict
    and the notes. A renderer that re-derived a state from ``status`` and
    ``zero_reason`` would be the second place to get it wrong.
    """

    runs: list[SourceWallRun]
    sources: list[SourceWallSource]
    states: list[str]
    state_legend: list[SourceWallLegendEntry]
    totals: dict[str, int]
    verdict: SourceWallVerdict
    window: SourceWallWindow
    notes: list[str]


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
#
# Every view carries ``sample_size`` and ``sufficient``, and most carry
# ``insufficient_reason``: the sentence a screen shows instead of a chart drawn
# over too little. A model written from a well-stocked corpus would be the one
# to lose them.


class CorpusSummary(LosslessModel):
    """``GET /api/analytics/summary``. ``doi_coverage`` is ``None`` over no papers: a share of nothing."""

    documents: int
    unique_papers: int
    distinct_authors: int
    sources: int
    completed_executions: int
    first_seen: Optional[str]
    last_seen: Optional[str]
    doi_coverage: Optional[float]
    sample_size: int
    sufficient: bool


class SourceContributionRow(LosslessModel):
    source: str
    total: int
    unique_papers: int
    duplicated: int
    unique_share: Optional[float]


class SourceContribution(LosslessModel):
    """``GET /api/analytics/source-contribution``: overlap needs two sources to compare."""

    sources: list[SourceContributionRow]
    sample_size: int
    sufficient: bool
    insufficient_reason: Optional[str]


class DiscoveryLagRow(LosslessModel):
    """One source's lag, in days. ``None`` below the minimum sample, rather than a median of three."""

    source: str
    sample_size: int
    sufficient: bool
    median_days: Optional[float]
    fastest_days: Optional[float]
    slowest_days: Optional[float]


class DiscoveryLag(LosslessModel):
    """``GET /api/analytics/discovery-lag``."""

    sources: list[DiscoveryLagRow]
    sample_size: int
    sufficient: bool
    minimum_sample: int
    insufficient_reason: Optional[str]


class RoutineHealthRun(LosslessModel):
    start_time: Optional[str]
    new_results: int
    total_results: int


class RoutineHealthRow(LosslessModel):
    """One watch: what its completed runs found, and its fires that did not run."""

    routine_id: int
    name: str
    missed_fires: int
    last_missed_fire_at: Optional[str]
    schedule_cron: str
    is_active: bool
    runs: int
    series: list[RoutineHealthRun]
    runs_since_new: int
    last_new_result_at: Optional[str]
    total_new: int
    status: str
    sample_size: int
    sufficient: bool


class RoutineHealth(LosslessModel):
    """``GET /api/analytics/routine-health``."""

    routines: list[RoutineHealthRow]
    minimum_runs: int
    stale_after: int
    sample_size: int
    sufficient: bool
    insufficient_reason: Optional[str]


class PublicationVolumeMonth(LosslessModel):
    """One month: its total and each group's count; groups outside the top eight are ``other``."""

    month: str
    total: int
    groups: dict[str, int]


class PublicationVolume(LosslessModel):
    """``GET /api/analytics/publication-volume``, by ``source`` or ``category``."""

    group_by: str
    groups: list[str]
    series: list[PublicationVolumeMonth]
    sample_size: int
    sufficient: bool
    insufficient_reason: Optional[str]


class AnalyticsOverview(LosslessModel):
    """``GET /api/analytics/overview``: the five views in one round trip."""

    summary: CorpusSummary
    source_contribution: SourceContribution
    discovery_lag: DiscoveryLag
    routine_health: RoutineHealth
    publication_volume: PublicationVolume


class KeywordScope(LosslessModel):
    """``corpus``, or ``execution`` with the run's id."""

    type: str
    execution_id: Optional[int] = None


class KeywordContributionRow(LosslessModel):
    """One keyword: papers it matched, and how many no other keyword did.

    ``unique_share`` is ``None`` below ``minimum_sample_for_share`` matches.
    """

    keyword: str
    matched: int
    unique: int
    shared: int
    contains_operators: bool
    unique_share: Optional[float]


class KeywordContribution(LosslessModel):
    """``GET /api/analytics/keyword-contribution``. Not part of the overview: it reads every paper once."""

    scope: KeywordScope
    keywords: list[KeywordContributionRow]
    documents_considered: int
    documents_matched: int
    documents_unexplained: int
    sample_size: int
    minimum_sample_for_share: int
    sufficient: bool
    insufficient_reason: Optional[str]
    fields_checked: list[str]


# ---------------------------------------------------------------------------
# The owned Library
# ---------------------------------------------------------------------------
#
# Every Library body carries ``version: 1`` and the vault it was read from, and
# none carries an absolute path except ``open``'s, which exists to hand one to
# the desktop's own opener. ``availability: not_checked`` says a listing reads
# recorded metadata and did not hash the files.


class LibraryCounts(LosslessModel):
    """What the database records the vault holding; ``basis`` says it was not re-measured."""

    items: int
    retained_bytes: int
    basis: str


class LibraryLimits(LosslessModel):
    file_bytes: int
    batch_files: int
    vault_bytes: int
    items: int


class LibraryVault(LosslessModel):
    """The vault by its id and folder name: never its absolute root."""

    vault_id: str
    label: str
    created_at_utc: str


class LibraryStatus(LosslessModel):
    """``GET /api/library`` and ``POST /api/library/vault``.

    ``status`` is ``unconfigured``, ``ready``, ``busy``, ``mismatch``,
    ``needs_attention`` or ``unavailable``; ``reason`` is present only for the
    two that came from a refusal.
    """

    version: int
    vault: Optional[LibraryVault]
    status: str
    counts: LibraryCounts
    limits: LibraryLimits
    reason: Optional[str] = None


class LibraryPaperLink(LosslessModel):
    """A paper the owner associated a file with: an association, not an identification."""

    document_id: int
    title: Optional[str]
    identity_scope: str
    basis: str


class LibraryFile(LosslessModel):
    id: int
    file_id: str
    version_id: str
    vault_id: str
    sha256: str
    byte_size: int
    media_type: str
    original_name: str
    relative_path: str
    created_at_utc: str
    paper_links: list[LibraryPaperLink]
    availability: str


class LibraryFiles(LosslessModel):
    """``GET /api/library/files``: a descending page under a fixed ceiling, ``through_id``."""

    version: int
    vault_id: str
    files: list[LibraryFile]
    through_id: int
    next_before_id: Optional[int]
    has_more: bool


class LibraryImported(LosslessModel):
    """``POST /api/library/files``: 201 for a new copy, 200 for the same bytes already kept."""

    version: int
    vault_id: str
    file: LibraryFile
    created: bool
    duplicate: bool
    linked_document_ids: list[int]


class LibraryFileDetail(LosslessModel):
    version: int
    vault_id: str
    file: LibraryFile


class LibraryLinked(LosslessModel):
    version: int
    vault_id: str
    file_id: str
    version_id: str
    document_id: int
    paper_links: list[LibraryPaperLink]


class LibraryOpened(LosslessModel):
    """``POST /api/library/files/{file_id}/open``: the verified path, for the desktop's opener only."""

    version: int
    vault_id: str
    file_id: str
    version_id: str
    path: str


class LibraryInventory(LosslessModel):
    """``GET /api/library/export``: the inventory as a JSON document in ``text``, and its file name."""

    version: int
    vault_id: str
    format: str
    filename: str
    content_type: str
    text: str


class LibraryText(LosslessModel):
    """``GET /api/library/files/{file_id}/text``: a retained TXT or MD file's bytes as literal text."""

    version: int
    kind: str
    vault_id: str
    file_id: str
    version_id: str
    sha256: str
    media_type: str
    encoding: str
    normalization: str
    byte_size: int
    line_count: int
    text: str


# ---------------------------------------------------------------------------
# Evidence projects
# ---------------------------------------------------------------------------
#
# Every Evidence body is an envelope: ``contract_version: 1``, the vault, and
# the project where there is one. Lists page by ascending id under a fixed
# ceiling and say what their ``total`` counts (``count_basis``). A file's
# membership and a note's ``resolution`` say ``not_checked``: a list reads
# records, and does not re-hash the bytes they name.


class EvidenceProject(LosslessModel):
    """A project row as stored, with its current counts."""

    id: int
    project_id: str
    vault_id: str
    name: str
    revision: int
    created_at_utc: str
    updated_at_utc: str
    file_count: int
    note_count: int


class EvidenceFileRecord(LosslessModel):
    """The exact Library file and version a membership or a note is pinned to."""

    file_id: str
    version_id: str
    vault_id: str
    sha256: str
    byte_size: int
    media_type: str
    original_name: str
    created_at_utc: str


class EvidenceMembership(LosslessModel):
    id: int
    project_id: str
    file_id: str
    version_id: str
    added_at_utc: str


class EvidenceMember(EvidenceMembership):
    """A membership with its file's record, as a list shows it."""

    file: EvidenceFileRecord
    availability: str


class EvidenceNote(LosslessModel):
    """A plain note, or a passage pinned to a page, an extraction contract,
    the page text's hash and exact codepoint offsets. The anchor fields are
    ``None`` on a plain note. ``membership_state`` says whether its file is
    still in the project."""

    id: int
    note_id: str
    project_id: str
    file_id: str
    version_id: str
    kind: str
    body: str
    page_number: Optional[int]
    extraction_contract: Optional[str]
    page_text_sha256: Optional[str]
    start_codepoint: Optional[int]
    end_codepoint: Optional[int]
    quote: Optional[str]
    revision: int
    created_at_utc: str
    updated_at_utc: str
    file: EvidenceFileRecord
    membership_state: str
    resolution: str


class EvidenceProjects(LosslessModel):
    """``GET /api/evidence/projects``."""

    contract_version: int
    vault_id: str
    projects: list[EvidenceProject]
    through_id: int
    next_after_id: Optional[int]
    has_more: bool
    total: int
    count_basis: str


class EvidenceProjectDetail(LosslessModel):
    """``POST /api/evidence/projects``, ``GET`` and ``PATCH .../{project_id}``."""

    contract_version: int
    vault_id: str
    project_id: str
    project: EvidenceProject


class EvidenceMembers(LosslessModel):
    """``GET .../{project_id}/files``, at the project's current revision."""

    contract_version: int
    vault_id: str
    project_id: str
    revision: int
    files: list[EvidenceMember]
    through_id: int
    next_after_id: Optional[int]
    has_more: bool
    total: int
    count_basis: str


class EvidenceMemberAdded(LosslessModel):
    """``POST .../{project_id}/files``: ``added`` is false when the file was already a member."""

    contract_version: int
    vault_id: str
    project_id: str
    project: EvidenceProject
    membership: EvidenceMembership
    added: bool


class EvidenceMemberRemoved(LosslessModel):
    """``DELETE .../{project_id}/files/{file_id}``: membership only; the file and its notes stay."""

    contract_version: int
    vault_id: str
    project_id: str
    project: EvidenceProject
    removed: bool


class EvidenceNotes(LosslessModel):
    """``GET .../{project_id}/notes``."""

    contract_version: int
    vault_id: str
    project_id: str
    revision: int
    notes: list[EvidenceNote]
    through_id: int
    next_after_id: Optional[int]
    has_more: bool
    total: int
    count_basis: str


class EvidenceNoteSaved(LosslessModel):
    """``POST .../{project_id}/notes`` and ``PATCH .../notes/{note_id}``."""

    contract_version: int
    vault_id: str
    project_id: str
    project: EvidenceProject
    note: EvidenceNote


class EvidencePageText(LosslessModel):
    """``GET .../{project_id}/reader/{file_id}?representation=text``: one page's canonical text.

    ``status`` is ``extracted``, ``no_text``, ``unsupported``, ``malformed``,
    ``limit_exceeded``, ``timeout`` or ``unavailable``, and only ``extracted``
    carries a ``page_text_sha256`` a passage can be pinned to. ``examined_pages``
    names the page read; every other page is ``not_examined``. ``coverage`` is
    the sentence a reader shows: canonical text may omit or reshape a page.
    ``representation=pdf`` answers with the verified bytes instead, outside
    this model.
    """

    contract_version: int
    vault_id: str
    project_id: str
    file_id: str
    version_id: str
    sha256: str
    media_type: str
    status: str
    page_number: int
    page_count: Optional[int]
    text: str
    extraction_contract: str
    page_text_sha256: Optional[str]
    examined_pages: list[int]
    remaining_pages: str
    coverage: str


# ---------------------------------------------------------------------------
# Selected-evidence answers
# ---------------------------------------------------------------------------

class SelectedRequested(LosslessModel):
    """The public half of the runtime choice a request was made with.

    ``requested_model`` and ``requested_effort`` are what was asked for. What a
    runtime reported it used is in the answer's ``reports``, kept apart, because
    the two are different facts. Each ``*_basis`` says where a choice came
    from: ``explicit``, a settings or runtime default, or ``not_supported``.
    """

    binding_basis: str
    effort_basis: str
    model_basis: str
    provider: str
    requested_effort: Optional[str]
    requested_model: Optional[str]
    runtime: str
    version: int


class SelectedSource(LosslessModel):
    """One selected segment, ``S01`` to ``S24``: an exact version's page text, or a range of it.

    ``text`` is the literal selected text. ``start_codepoint`` and
    ``end_codepoint`` are global Unicode codepoint offsets on the page, end
    exclusive, never UTF-16 indices. ``page_count`` is ``None`` where a PDF's
    count is not known.
    """

    byte_size: int
    end_codepoint: int
    extraction_contract: str
    file_id: str
    media_type: str
    original_name: str
    page_count: Optional[int]
    page_number: int
    page_text_sha256: str
    project_id: str
    sha256: str
    source_id: str
    source_sha256: str
    start_codepoint: int
    text: str
    vault_id: str
    version_id: str


class SelectedNoteAnchor(LosslessModel):
    """Where a selected passage note is pinned: one page's text, by hash and codepoint range."""

    end_codepoint: int
    extraction_contract: str
    page_number: int
    page_text_sha256: str
    quote: str
    start_codepoint: int


class SelectedNote(LosslessModel):
    """An owner note chosen for a request. ``provenance`` is ``owner_note``: a saved local note, not document evidence."""

    anchor: Optional[SelectedNoteAnchor]
    body: str
    created_at_utc: str
    file_id: str
    kind: str
    note_id: str
    provenance: str
    revision: int
    updated_at_utc: str
    version_id: str


class SelectedCoverageFile(LosslessModel):
    """Which pages of one selected version were sent or checked, and how many were not examined.

    ``known_page_count`` and ``unexamined_page_count`` are ``None`` where the
    page count is not known.
    """

    anchor_checked_pages: list[int]
    file_id: str
    known_page_count: Optional[int]
    selected_pages: list[int]
    unexamined_page_count: Optional[int]
    version_id: str


class SelectedCoverage(LosslessModel):
    """What a request carries, counted: files, pages, segments, source bytes and codepoints, and notes."""

    file_count: int
    files: list[SelectedCoverageFile]
    note_bytes: int
    note_count: int
    page_count: int
    segment_count: int
    source_bytes: int
    source_codepoints: int


class SelectedDisclosure(LosslessModel):
    """What sending a request reveals and reads, said before consent.

    ``custom_endpoint`` is true when the request goes to a custom API base
    URL. The two reads are always true: the selected file bytes are read to
    check their digest, and a selected PDF page's structure is examined.
    """

    custom_endpoint: bool
    limitations: str
    pdf_structure_examined_for_selected_pages: bool
    retained_digest_reads_selected_file_bytes: bool
    source_strings_may_contain_private_material: str


class SelectedPayload(LosslessModel):
    """The exact payload a request sends, which ``request_sha256`` covers.

    ``response_contract`` is the fixed description of the answer shape the
    runtime is asked for, sent with every request.
    """

    coverage: SelectedCoverage
    disclosure: SelectedDisclosure
    instruction: str
    mode: str
    notes: list[SelectedNote]
    profile: str
    project_id: str
    project_revision: int
    requested: SelectedRequested
    response_contract: dict[str, Any]
    sources: list[SelectedSource]
    system_sha256: str
    system_version: str
    vault_id: str
    version: int


class SelectedRequest(LosslessModel):
    """A request, immutable once admitted: the payload, the system text, and the exact user prompt with their hashes.

    This model and every one inside it declare their fields in sorted key
    order, because a saved request, result, report or usage is canonical
    JSON with sorted keys, and those are the bytes ``request_sha256`` covers.
    A preview's request is the one place the order differs: it is the
    assembly's own dictionary, not yet canonicalized.
    """

    payload: SelectedPayload
    request_sha256: str
    system_sha256: str
    system_text: str
    user_prompt: str
    user_sha256: str


class SelectedCitation(LosslessModel):
    """An exact range of a selected source.

    It identifies selected text and nothing more: that the quote supports the
    item it is attached to is not checked.
    """

    end_codepoint: int
    quote: str
    source_id: str
    start_codepoint: int


class SelectedItem(LosslessModel):
    """One item of an answer: ``source_statement``, ``interpretation``, ``note_summary`` or ``question``.

    A source statement or interpretation carries citations; a note summary
    carries ``note_ids`` instead and cites no document.
    """

    citations: list[SelectedCitation]
    kind: str
    note_ids: list[str]
    text: str


class SelectedSection(LosslessModel):
    """A section of an answer: ``summary``, ``details``, ``limitations`` or ``questions``."""

    items: list[SelectedItem]
    kind: str


class SelectedResult(LosslessModel):
    """The validated answer. ``status`` is ``answer`` or ``insufficient_evidence``."""

    limitations: list[str]
    mode: str
    request_sha256: str
    sections: list[SelectedSection]
    status: str
    version: int


class SelectedReport(LosslessModel):
    """A model name the runtime reported, where it reported it, and when. Not the model that was asked for."""

    model: str
    observed_at_utc: str
    source: str


class SelectedUsageReported(LosslessModel):
    """Token counts a runtime reported. Only the counts it reported are present."""

    cache_creation_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class SelectedUsage(LosslessModel):
    """Usage as reported. ``provenance`` is ``runtime_report`` and ``billing`` is ``unknown``: no cost is known."""

    billing: str
    provenance: str
    reported: SelectedUsageReported


class SelectedAnswer(LosslessModel):
    """``POST .../answers`` (202), ``GET .../answers/{answer_id}`` and ``POST .../cancel``: one saved answer.

    ``state`` is ``admitted`` or ``running``, then one of ``succeeded``,
    ``refused``, ``failed``, ``cancelled`` or ``interrupted``. ``result`` is
    present only for ``succeeded`` and ``refused``; ``validation`` is then
    ``exact_text_identity_only_support_unchecked``, and otherwise
    ``unvalidated``. ``current_originals`` is ``not_rechecked``: the saved
    excerpts are not a fresh check of the files. ``partial_text`` is what
    arrived before the end, unvalidated.
    """

    id: int
    answer_id: str
    vault_id: str
    project_id: str
    project_revision: int
    mode: str
    state: str
    request_sha256: str
    partial_text: str
    cleanup_state: str
    created_at_utc: str
    started_at_utc: Optional[str]
    finished_at_utc: Optional[str]
    error_code: Optional[str]
    error_message: Optional[str]
    request: SelectedRequest
    result: Optional[SelectedResult]
    reports: list[SelectedReport]
    usage: Optional[SelectedUsage]
    contract_version: int
    validation: str
    current_originals: str
    limitations: str


class SelectedPreview(LosslessModel):
    """``POST .../answer-previews``: the exact request a Send would make, before any runtime is called.

    It lives in the serving process until ``expires_at_utc`` and is lost on
    restart. ``owner_runtime_id`` names the process that holds it.
    """

    contract_version: int
    preview_id: str
    vault_id: str
    project_id: str
    owner_runtime_id: str
    expires_at_utc: str
    request_sha256: str
    request: SelectedRequest


class SelectedAnswerRow(LosslessModel):
    """One answer in a project's history, without its request or result."""

    id: int
    answer_id: str
    request_sha256: str
    mode: str
    state: str
    created_at_utc: str
    finished_at_utc: Optional[str]
    cleanup_state: str


class SelectedAnswers(LosslessModel):
    """``GET .../answers``: a project's answers, oldest first, at most 50 a page."""

    contract_version: int
    vault_id: str
    project_id: str
    answers: list[SelectedAnswerRow]
    through_id: int
    next_after_id: Optional[int]
    has_more: bool
    total: int
    count_basis: str


# ---------------------------------------------------------------------------
# The assistant
# ---------------------------------------------------------------------------
#
# Two facts sit side by side in these bodies and are kept apart: what a turn
# *requested* of a runtime, and what the runtime *reported* it used. A request
# is not proof of what ran. Tokens and cost are what a runtime reported, and
# ``None`` means it reported nothing, which is not zero.


class AssistantRuntimeStatus(LosslessModel):
    """Whether the runtime Settings selects can take a turn, and why or why not, in one sentence.

    ``path`` is where the Claude CLI executable was found and ``how`` how it
    was found (``configured``, ``known-location``, ``path``); an available
    API-key runtime has no path and says ``api_key``. Both are ``None`` when
    the runtime is not available. A found executable is not a sign-in and a
    stored key is not an accepted one: ``available`` says a turn can be
    attempted, not that it will be answered.
    """

    kind: str
    available: bool
    reason: str
    path: Optional[str]
    how: Optional[str]


class AssistantToolCalling(LosslessModel):
    """The selected provider's tool calling, as two separate facts.

    ``state`` is about the provider's own API (``yes``, ``no`` or
    ``unknown``); ``assistant`` is whether resmon's assistant drives it
    (``api_key_runtime``, ``cli_runtime`` or ``no``). A provider can support
    tool calling that resmon does not use, so the two are never merged.
    """

    state: str
    reason: str
    assistant: str
    assistant_reason: str


class AssistantOtherRuntime(LosslessModel):
    """A runtime Settings does not select, listed with its reason rather than left out.

    The first entry is the other of resmon's two runtimes and the second is
    the Codex CLI, which is never available. ``installed`` is not a finding
    to rely on in either. On the first it is always true, whatever was found.
    On the Codex entry it is whether an executable sits where Codex is looked
    for, and when an agent-CLI path is configured that path is the only place
    looked, so a configured Claude CLI makes Codex read as installed.
    ``available`` and ``reason`` are the fields to read.
    """

    kind: str
    installed: bool
    available: bool
    reason: str


class AssistantDefaultRequest(LosslessModel):
    """The choice a new conversation gets from Settings when it names none.

    ``model`` and ``effort`` are ``None`` when Settings leaves them to the
    runtime, whose own default resmon does not know.
    """

    version: int
    runtime: str
    provider: str
    model: Optional[str]
    effort: Optional[str]


class AssistantConnection(LosslessModel):
    """One connection the composer can offer.

    ``runtime`` is ``None``, and ``implemented`` false, for a provider resmon
    lists but has no assistant for (Ollama, Codex). ``family`` is the request
    shape resmon's own loop builds and is present only on API-key
    connections. ``available`` checks local prerequisites only, an executable
    found or a key stored, never sign-in or whether a model is accepted.
    """

    runtime: Optional[str]
    provider: str
    label: str
    implemented: bool
    available: bool
    reason: str
    effort_supported: bool
    family: Optional[str] = None


class AssistantComposerChoices(LosslessModel):
    """What the composer may ask for: connections, Claude model aliases and effort levels.

    ``default_request`` is ``None``, and ``default_error`` says why, when the
    stored settings do not make a valid choice. The aliases are suggestions:
    the CLI decides at use time whether it accepts one, and ``limitations``
    says so in the words the composer shows.
    """

    version: int
    default_request: Optional[AssistantDefaultRequest]
    default_error: Optional[str]
    connections: list[AssistantConnection]
    claude_aliases: list[str]
    claude_efforts: list[str]
    limitations: str


class AssistantStatus(LosslessModel):
    """``GET /api/assistant/status``: whether the assistant can run, and every runtime it considered.

    ``runtime`` is the one Settings selects, and ``available`` and ``reason``
    repeat its own. ``others`` lists the rest with their reasons, Codex
    included, because a runtime left out reads as one resmon never noticed.
    ``model`` and ``effort`` are what Settings asks for, not what a runtime
    uses; ``None`` or empty means none is set, and an API-key runtime has no
    effort at all. ``contract_version`` is the MCP contract's version, or
    ``unknown`` when the server module cannot be imported.
    """

    runtime: AssistantRuntimeStatus
    available: bool
    reason: str
    model: Optional[str]
    effort: Optional[str]
    kinds: list[str]
    provider: str
    provider_source: str
    tool_calling: AssistantToolCalling
    others: list[AssistantOtherRuntime]
    composer_choices: AssistantComposerChoices
    contract_version: str


class AssistantRequested(LosslessModel):
    """What a turn asked a runtime for, which is not what the runtime used.

    ``requested_model`` and ``requested_effort`` are ``None`` when the request
    left the choice to the runtime. Each ``*_basis`` says where a choice came
    from: ``explicit``, ``settings_default``, ``runtime_default``, or, for
    effort on an API key, ``not_supported``. ``binding_basis`` is ``new``, or
    ``legacy_confirmed`` for a conversation saved before choices were, whose
    next turn the person confirmed.
    """

    version: int
    runtime: str
    provider: str
    requested_model: Optional[str]
    requested_effort: Optional[str]
    model_basis: str
    effort_basis: str
    binding_basis: str


class AssistantChoices(AssistantRequested):
    """A conversation's saved choices: the request every turn makes, and when it was fixed."""

    created_at_utc: str


class AssistantUnreadable(LosslessModel):
    """A stored value resmon could not read, said so rather than dropped or guessed.

    It stands in for a conversation's choices, a turn's request, or a turn's
    reports when the stored row fails validation on the way out: a row a
    future version wrote, or a hand-edited database. The rest of the
    conversation still reads; only that part is withheld. It is its own model,
    in a union with the readable one, so a typed client has to tell the two
    apart before it reads a field, and ``unreadable`` is the only key it has.
    """

    unreadable: Literal[True]


class AssistantSession(LosslessModel):
    """``POST /api/assistant/sessions`` (201): one conversation.

    ``cli_session_id`` is the id resmon hands the Claude CLI to resume, and
    ``None`` on the API-key runtime, which keeps no session of its own.
    ``model`` is the model the conversation asked for, ``None`` for the
    runtime's default. ``title`` is the one given at creation, else the
    first message's opening words, else ``New conversation``. ``choices`` is
    ``None`` for a conversation saved before choices were (schema 15), which
    cannot send again until the person confirms new ones.
    """

    id: int
    runtime: str
    cli_session_id: Optional[str]
    model: Optional[str]
    title: str
    created_at: str
    updated_at: str
    choices: Optional[Union[AssistantChoices, AssistantUnreadable]]


class AssistantSessionListed(AssistantSession):
    """One conversation in ``GET /api/assistant/sessions``.

    ``cost_usd`` is the sum of the costs its runtime reported, ``None`` when
    no turn reported one. Turns that reported nothing add nothing to the sum,
    so it can be a partial total; the conversation's own ``totals`` says how
    many turns it covers.
    """

    message_count: int
    cost_usd: Optional[float]


class AssistantSessions(LosslessModel):
    """``GET /api/assistant/sessions``: at most ``limit`` conversations, most recently active first."""

    sessions: list[AssistantSessionListed]


class AssistantSessionBrowsed(LosslessModel):
    """One conversation in a browse page.

    Not an ``AssistantSession``: a browse row carries no ``cli_session_id``
    and orders its keys differently, and one model cannot keep both orders.
    """

    id: int
    runtime: str
    model: Optional[str]
    created_at: str
    updated_at: str
    message_count: int
    title: str
    choices: Optional[Union[AssistantChoices, AssistantUnreadable]]


class AssistantSessionPage(LosslessModel):
    """``GET /api/assistant/sessions/browse``: conversations newest created first, a page at a time.

    ``through_id`` fixes which conversations the paging covers, so one created
    while paging does not shift the pages; it fixes the ids, not what the rows
    say. ``next_before_id`` is the next page's cursor, ``None`` on the last.
    """

    sessions: list[AssistantSessionBrowsed]
    through_id: int
    next_before_id: Optional[int]
    has_more: bool


class AssistantMessage(LosslessModel):
    """One stored message: ``user``, ``assistant``, or ``system`` for a notice shown during a turn.

    ``tool_calls`` and ``tool_results`` are the JSON stored with an assistant
    message, parsed and otherwise untouched: a list, ``None`` when the turn
    used no tool, or ``{"unreadable": true}`` when the stored text does not
    parse. They are ``Any`` rather than a list of models because the column
    holds whatever a runtime returned, in the shape the version that wrote it
    used, and a typed list would turn such a row into a 500 where it is a
    transcript today. An ``Any`` value is written by pydantic's serializer,
    not ``jsonable_encoder``; for parsed JSON the two agree, and the parse
    refuses ``NaN`` and ``Infinity``, so the module docstring's non-finite
    case is reachable only through an out-of-range literal such as ``1e999``
    in a hand-edited row. Tool data can hold sensitive text and is returned
    as stored.

    The tokens and ``cost_usd`` are what the runtime reported for the turn,
    ``None`` where it reported nothing. A reported cost does not establish
    what was billed.
    """

    id: int
    role: str
    content: str
    tool_calls: Any
    tool_results: Any
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cost_usd: Optional[float]
    created_at: str


class AssistantTotals(LosslessModel):
    """What a conversation's assistant turns reported, summed.

    ``reported_turns`` counts the ``turns`` that reported a cost, and is what
    says whether ``cost_usd`` is a total or a partial one. Each sum is
    ``None`` when no turn reported that figure.
    """

    turns: int
    reported_turns: int
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cost_usd: Optional[float]


class AssistantSnapshot(LosslessModel):
    """The SQLite read a transcript or an export was taken from.

    ``basis`` is ``persisted_messages_only``: a turn still streaming is not in
    it. ``last_message_id`` is ``None`` for a conversation with no messages.
    """

    captured_at_utc: str
    basis: str
    message_count: int
    last_message_id: Optional[int]


class AssistantModelReport(LosslessModel):
    """A model name a runtime reported during a turn, where it reported it, and when.

    ``source`` names the field it came from, such as
    ``claude_system_init_model``. It is what the runtime said, kept beside the
    request and never merged with it. No runtime reports effort.
    """

    sequence: int
    model: str
    source: str
    observed_at_utc: str
    name: str


class AssistantAnsweredBy(LosslessModel):
    """Which reported model answered a turn, chosen from its reports.

    ``source`` is the report it was taken from: ``claude_result_model_usage``
    (the models the turn was billed for) first, the provider's reply next, and
    the model the CLI announced as it started last. ``name`` is ``model`` in a
    person's words, or ``model`` itself where its shape is not recognized.
    """

    model: str
    name: str
    source: str


class AssistantTurnFailure(LosslessModel):
    """A turn that produced no answer, kept as a failure and never as one.

    ``code`` is ``cli_auth`` when the command said it is not signed in or its
    sign-in expired, ``stopped`` when the turn was stopped, and ``failed``
    otherwise. ``message`` is the sentence the panel showed. ``partial_text``,
    ``tool_calls`` and ``tool_results`` are what the turn wrote and called
    before it ended. ``cost_usd`` is present only when the runtime reported a
    cost above zero for it.
    """

    code: Literal["cli_auth", "stopped", "failed"]
    message: str
    detail: Optional[str]
    partial_text: str
    tool_calls: Any
    tool_results: Any
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cost_usd: Optional[float]
    failed_at_utc: str


class AssistantTurnChoices(LosslessModel):
    """One turn's request, and the reports its runtime made, kept apart.

    ``assistant_message_id`` is ``None`` until an answer is stored, and stays
    so for a turn that never got one; ``failure`` then says why, where the turn
    ended in a failure resmon recorded. ``answered_by`` is the model the
    reports say answered, for a turn that has an answer, and ``None``
    otherwise. ``requested`` and ``reported`` are each
    ``AssistantUnreadable`` when their stored JSON fails validation, and both
    are, with ``assistant_message_id`` cleared, when the row points at
    messages outside this conversation.
    """

    user_message_id: int
    assistant_message_id: Optional[int]
    version: int
    created_at_utc: str
    requested: Union[AssistantRequested, AssistantUnreadable]
    reported: Union[list[AssistantModelReport], AssistantUnreadable]
    answered_by: Optional[AssistantAnsweredBy]
    failure: Optional[AssistantTurnFailure]


class AssistantActivity(LosslessModel):
    """What this process saw of a conversation when the request arrived.

    Observed separately from the transcript and not atomic with it, which
    ``basis`` says. ``turn_claimed`` is whether a turn holds the
    conversation's event bus, and ``cli_running`` whether a CLI process is
    alive for it. Both are this process's memory and say nothing about
    another process.
    """

    observed_at_utc: str
    turn_claimed: bool
    cli_running: bool
    basis: str


class AssistantTranscript(LosslessModel):
    """``GET /api/assistant/sessions/{session_id}``: a conversation as one SQLite read, and what is running now.

    ``session`` through ``turn_choices`` come from one read snapshot;
    ``running`` and ``activity_observation`` are observed afterwards and are
    not atomic with it. ``running`` is ``activity_observation.cli_running``.
    """

    session: AssistantSession
    messages: list[AssistantMessage]
    totals: AssistantTotals
    snapshot: AssistantSnapshot
    choices_version: int
    turn_choices: list[AssistantTurnChoices]
    running: bool
    activity_observation: AssistantActivity


class AssistantExport(LosslessModel):
    """``GET /api/assistant/sessions/{session_id}/export``: a saved conversation as a file's text.

    ``format`` is ``json`` or ``markdown``. ``text`` is the whole file, at most
    8 MiB, and carries its own limitations: persisted messages only, and
    completion unknown. ``filename`` and ``content_type`` are for saving it;
    the backend writes no file. ``snapshot`` is the read it was taken from.
    """

    session_id: int
    format: str
    filename: str
    content_type: str
    text: str
    snapshot: AssistantSnapshot


class AssistantSessionDeleted(LosslessModel):
    """``DELETE /api/assistant/sessions/{session_id}``: the conversation, its messages and its choices are gone."""

    deleted: int


class AssistantTurnCancelled(LosslessModel):
    """``POST /api/assistant/sessions/{session_id}/cancel``. Idempotent, and it says which happened.

    ``cancelled`` is true only when a Claude CLI process running for the
    conversation was killed. An API-key turn runs no such process, so the
    answer is false whether or not one is running. ``permissions_denied``
    counts the approval cards still waiting for the conversation, now denied.
    """

    cancelled: bool
    permissions_denied: int


class AssistantPermissionDecision(LosslessModel):
    """``POST /api/assistant/permissions``: the answer the permission server hands the CLI.

    Called by ``assistant_permission_server.py``, not the renderer, and held
    open until the person answers or five minutes pass. ``decision`` is
    ``allow`` or ``deny``; a timeout, a panel that was not open to ask, and a
    cancelled conversation all deny, and ``message`` says which.
    """

    decision: str
    message: str
    request_id: str


class AssistantPermissionAnswered(LosslessModel):
    """``POST /api/assistant/permissions/{request_id}``: the panel's Allow or Deny, recorded once.

    A second answer to the same request is a 409, so ``decision`` is the one
    that stands.
    """

    request_id: str
    decision: str


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
#
# A bundle is a folder holding a snapshot of the database, the Library vault's
# bytes, optionally the reports, and ``manifest.json`` with a SHA-256 for each
# file. What the bodies below can establish: what was written and what its
# hashes were, what a later recomputation of those hashes found, and what a
# backend start recorded when it applied or refused a staged restore. None of
# them shows that a restore will succeed before it has run.
#
# Two rules decide how loosely a field is typed. A value resmon computed in
# this request is typed exactly. A value copied from a manifest is typed as
# loosely as the handler copies it when the route reads a folder the person
# chose, because that folder need not hold a bundle this resmon wrote, and the
# route's job is to say what is wrong with it rather than fail. Files resmon
# keeps in its own state directory (the staged pointer and the restore record)
# outlive the version that wrote them, so a field a release added after 2.3.0
# is optional and absent from what 2.3.0 wrote.


class BackupFile(LosslessModel):
    """One file a bundle carries: its path inside the bundle, its size in bytes, and its SHA-256."""

    path: str
    size: int
    sha256: str


class ForeignKeyViolation(LosslessModel):
    """One reference ``PRAGMA foreign_key_check`` found to a parent row that is not there.

    ``rowid`` is ``None`` for a table without rowids, where two references
    cannot be told apart. ``fkid`` is the foreign key's index on its table, as
    SQLite numbers it.
    """

    table: str
    rowid: Optional[int]
    parent: str
    fkid: int


class BackupExclusions(LosslessModel):
    """What a bundle deliberately does not carry.

    ``credentials`` names the keyring entries this machine held when the
    backup ran, names only and never a value; a restore cannot bring them
    back. A name the keyring would not answer for is left out, so the list can
    be short. ``process_state`` names files that exist only while a backend
    runs. ``state_dir`` is the state directory the backup ran with, or
    ``None``.
    """

    credentials: list[str]
    process_state: list[str]
    state_dir: Optional[str]
    note: str


class BackupManifest(LosslessModel):
    """A bundle's manifest as ``POST /api/backup`` returns it: what was written.

    Everything up to ``elapsed_seconds`` is what ``manifest.json`` in the
    bundle holds; the file stores it with its keys sorted. ``path``,
    ``manifest_sha256`` and ``fk_violations_message`` are added after the
    file is written. The table counts and the foreign-key findings are read
    from the bundle's own snapshot of the database, not the live one. A
    manifest records what was written and the hashes taken as it was written;
    it does not show that a restore will succeed.
    ``POST /api/backup/verify`` recomputes the hashes, and a restore runs its
    own checks when it applies.

    ``vault_id`` is ``None`` when no Library vault is configured, and the
    bundle then carries no vault. ``includes_reports`` is whether reports were
    asked for; a reports folder that is missing or empty adds no files and
    still reads true. ``table_counts`` maps each application table to its row
    count; a table that could not be counted is left out, and
    ``table_count_denominator`` is how many were counted. ``fk_violations``
    lists at most 100 references, ``fk_violations_total`` counts all of them,
    and ``fk_violations_rows`` counts the distinct rows SQLite identified them
    by. ``fk_violations_message`` is ``""`` when there are none.
    ``elapsed_seconds`` is how long the backup took, to the millisecond.
    """

    manifest_version: int
    app_version: str
    schema_version: int
    created_at_utc: str
    vault_id: Optional[str]
    includes_reports: bool
    table_counts: dict[str, int]
    table_count_denominator: int
    files: list[BackupFile]
    fk_violations: list[ForeignKeyViolation]
    fk_violations_total: int
    fk_violations_rows: int
    excluded: BackupExclusions
    elapsed_seconds: float
    path: str
    manifest_sha256: str
    fk_violations_message: str


class BackupWritten(LosslessModel):
    """``POST /api/backup``: one bundle written, and its manifest.

    ``path`` is the bundle's folder, ``resmon-backup-<UTC stamp>``, inside the
    export directory Settings names, or inside the operating system's
    temporary folder when Settings names none. It is also recorded as the last
    backup.
    """

    success: bool
    path: str
    manifest: BackupManifest


class BundleVaultDestination(LosslessModel):
    """Where a restore would put the bundle's vault on this machine by default, and whether that folder is usable.

    ``root_path`` is the vault path the bundle's own database records,
    ``parent`` the folder that would hold it and ``name`` its folder name.
    ``parent_exists`` and ``parent_writable`` are checked on this machine
    during the request. A missing parent is the ordinary case for a bundle
    from another machine and is not a problem: a restore can be given another
    parent.
    """

    root_path: str
    parent: str
    name: str
    parent_exists: bool
    parent_writable: bool


class BundleWillNotRestore(LosslessModel):
    """What a restore of this bundle will not bring back.

    ``credentials`` and ``process_state`` are copied from the bundle's
    manifest as the handler finds them, which is why they are ``Any``: for a
    bundle resmon wrote, both are lists of names. ``note`` is fixed text about
    runs that were running and deliveries that were being sent.
    """

    credentials: list[Any]
    process_state: list[Any]
    note: str


class BundleReport(LosslessModel):
    """``POST /api/backup/verify``: every hash in a bundle recomputed, and what a restore would and would not do.

    It changes nothing. ``ok`` is true when ``problems`` is empty: every file
    the manifest names is present at its recorded size and hash, the layout is
    a version this resmon reads, and the schema is not newer than this
    resmon's. That is the bundle agreeing with its own manifest; it is not a
    restore that has succeeded, and the restore verifies again and runs its own
    checks when a start applies it.

    ``manifest`` is the bundle's ``manifest.json`` exactly as read, keys
    sorted as the file stores them. It is declared ``dict`` because its shape
    is whatever the file holds: this route reads a folder the person chose,
    which need not hold a bundle this resmon wrote, and reports what is wrong
    with it rather than failing. For a bundle this version wrote it holds
    ``BackupManifest``'s fields except the three added after the file was
    written, and one resmon 2.3.0 wrote has no ``fk_violations_rows``.
    Python's JSON parser accepts ``NaN`` and ``Infinity``, so one written
    into a manifest by hand, where the handler only copies it, is answered
    here as ``null`` where the route answered 500 before it was modeled.
    ``manifest_sha256`` is the hash of the file itself.

    ``files_checked`` counts the files that matched and ``files_in_manifest``
    the files listed. ``schema_relation`` compares the bundle's schema with
    this resmon's: ``same``, ``older``, ``newer`` (a problem) or ``unknown``
    (a problem). ``vault_relation`` compares the bundle's vault with the one
    configured here: ``same``, ``different``, ``none_configured`` or
    ``none_in_backup``.

    The foreign-key fields come from the manifest: ``fk_violations`` as listed
    there, hence ``Any``; ``fk_violations_total`` as an integer;
    ``fk_violations_rows`` ``None`` for a bundle written before resmon counted
    rows. Orphan rows never make ``ok`` false; ``needs_fk_acceptance`` says a
    restore must be told to accept them. ``vault_destination`` is ``None``
    when the bundle carries no vault or its database records no vault path.
    """

    path: str
    manifest: dict[str, Any]
    manifest_sha256: str
    files_checked: int
    files_in_manifest: int
    schema_relation: str
    vault_relation: str
    problems: list[str]
    fk_violations: list[Any]
    fk_violations_total: int
    fk_violations_rows: Optional[int]
    fk_violations_message: str
    needs_fk_acceptance: bool
    vault_destination: Optional[BundleVaultDestination]
    ok: bool
    will_not_restore: BundleWillNotRestore


class BackupSummary(LosslessModel):
    """The last bundle this resmon recorded writing, read from that bundle's manifest during the request.

    ``files`` is the number of files the manifest lists. Nothing is re-hashed
    here, so a bundle damaged since it was written reads the same; only
    ``POST /api/backup/verify`` checks the bytes. The other fields are the
    manifest's own values, ``None`` where it records none.
    ``fk_violations_total`` is ``0`` when the manifest records none, and
    ``fk_violations_rows`` is ``None`` for a bundle written before resmon
    counted rows.
    """

    path: str
    created_at_utc: Optional[str]
    app_version: Optional[str]
    schema_version: Optional[int]
    vault_id: Optional[str]
    files: int
    includes_reports: Optional[bool]
    fk_violations_total: int
    fk_violations_rows: Optional[int]


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
#
# ``POST /api/restore`` replaces nothing. It verifies a bundle and writes a
# pointer, and the restore runs when a backend next starts, before anything
# opens the database. What happened then is a record in the state directory,
# which is what ``GET /api/backup/last`` reads back.


class RestorePointer(LosslessModel):
    """A staged restore: the pointer the next backend start acts on.

    Nothing has moved while this exists. ``bundle`` is the bundle's resolved
    path and ``manifest_sha256`` the manifest's hash when it was staged; a
    start that finds a different manifest refuses the restore.
    ``accept_fk_violations`` is whether the person accepted the bundle's
    orphan rows. ``vault_parent`` is the folder the vault is to go into on
    this machine, ``None`` for the path the bundle's database records; a
    pointer resmon 2.3.0 staged has no such key.
    """

    bundle: str
    manifest_sha256: str
    accept_fk_violations: bool
    vault_parent: Optional[str] = None
    staged_at_utc: str


class RestorePointerUnreadable(LosslessModel):
    """A staged-restore pointer whose file is not valid JSON.

    The next start records it as a failed restore, ``pointer_unreadable``,
    and clears it; nothing is restored from it.
    """

    bundle: None
    manifest_sha256: None
    unreadable: Literal[True]


class RestoreStaged(LosslessModel):
    """``POST /api/restore``: a verified bundle staged; the restore itself runs when a backend next starts.

    Nothing has been replaced when this answers. ``staged`` is the pointer
    written, and ``report`` the verification it was staged on, the same
    report ``POST /api/backup/verify`` answers. ``next_step`` is one sentence
    on what will apply the restore on this machine (reopening resmon, or
    restarting the background service that holds the database), decided from
    the daemon lock as it stood during the request.
    """

    success: bool
    staged: RestorePointer
    report: BundleReport
    next_step: str


class RestoredVault(LosslessModel):
    """What an applied restore did with the Library vault.

    ``restored`` is false, with ``reason`` ``no_vault_in_backup``, when the
    bundle carried no vault. Otherwise ``root_path`` is where the vault now is
    and ``replaced_kept_at`` where the vault that was there before was moved,
    ``None`` when that folder held none. A record resmon 2.3.0 wrote has no
    ``replaced_kept_at``.
    """

    restored: bool
    reason: Optional[str] = None
    root_path: Optional[str] = None
    replaced_kept_at: Optional[str] = None


class RestoreRewrites(LosslessModel):
    """What a restore changed in the restored database because it described a process rather than the corpus.

    ``executions_interrupted`` counts runs that were ``running`` in the bundle
    and are now ``interrupted`` with reason ``unknown``, since no process can
    be asked about them; ``deliveries_requeued`` counts deliveries that were
    being sent and are queued again.
    """

    executions_interrupted: int
    deliveries_requeued: int


class RestoreSucceeded(LosslessModel):
    """The record of a staged restore a backend start applied.

    Read from the state directory, where it outlives the version that wrote
    it: ``undo_includes_vault``, ``vault_parent`` and ``fk_violations_rows``
    are absent from a record resmon 2.3.0 wrote. ``ok`` says the restore's own
    checks passed: SQLite's ``integrity_check``, and its foreign-key check
    unless the orphan rows were accepted. It does not say the corpus is as the
    person remembers it.

    ``undo_copy`` is the folder the replaced database was moved to, and with
    it the replaced vault when ``undo_includes_vault``; ``None`` when there
    was nothing to move. Nothing removes it but
    ``POST /api/restore/undo-copy/delete``. ``credentials_to_reenter`` and
    the ``fk_violations*`` fields are copied from the bundle's verification
    report, so the list fields are ``Any`` as they are there, with the same
    caveat ``BundleReport`` gives for a ``NaN`` in a file edited by hand.
    ``schema_relation`` is the bundle's schema against the version that
    applied it. ``acknowledged`` turns true when the person dismisses the
    card, and ``at_utc`` is when the record was written.
    """

    ok: Literal[True]
    bundle: str
    undo_copy: Optional[str]
    undo_includes_vault: Optional[bool] = None
    schema_relation: str
    vault: RestoredVault
    vault_parent: Optional[str] = None
    rewrites: RestoreRewrites
    credentials_to_reenter: list[Any]
    fk_violations: list[Any]
    fk_violations_total: int
    fk_violations_rows: Optional[int] = None
    fk_violations_message: str
    acknowledged: bool
    at_utc: str


class RestoreFailed(LosslessModel):
    """The record of a staged restore a backend start refused or could not finish.

    ``reason`` is a code and ``message`` the sentence for it: among them
    ``bundle_missing``, ``verification_failed``, ``manifest_changed``,
    ``database_in_use``, ``pointer_unreadable``, a verification refusal such
    as ``not_a_bundle``, or ``restore_failed`` for an error that carried no
    code. ``undone`` is present, and true, when the restore had begun moving
    files and its undo ran; ``vault_copy_kept`` is then the path of a vault
    copy the undo could not put back by itself, normally ``None``, and is
    absent from a record resmon 2.3.0 wrote. ``acknowledged`` is absent until
    the person dismisses the card.
    """

    ok: Literal[False]
    reason: str
    message: str
    bundle: str
    undone: Optional[bool] = None
    vault_copy_kept: Optional[str] = None
    at_utc: str
    acknowledged: Optional[bool] = None


class BackupLast(LosslessModel):
    """``GET /api/backup/last``: the last bundle, a staged restore, the last restore's record, and the undo copies.

    ``last_backup`` is ``None`` when no backup is recorded, or when the
    recorded bundle's manifest is gone or unreadable;
    ``last_backup_path_recorded`` is the recorded path either way, ``None``
    when there is none. ``pending_restore`` is the staged pointer, its
    unreadable form, or ``None``; ``pending_restore_runs_when`` is the sentence
    on what will apply it, ``None`` when nothing is staged, and
    ``pending_restore_runs_on`` the same answer as a code: ``app_restart``
    (this window's own backend applies it when resmon next starts),
    ``service_restart`` (the background service this window uses holds the
    database, so it applies when that service restarts) or ``service_stopped``
    (another live service holds the database, and nothing restores until it is
    stopped); ``None`` when nothing is staged. ``last_restore``
    is the record of the last restore a start acted on, applied or refused,
    and ``None`` when there is none or its file is not a JSON object.
    ``undo_copies`` lists the folders restores set aside, sorted by name,
    which is the UTC time each was made. ``drive_upload_retired`` is true
    while this database still has the removed upload to Google Drive after
    each run switched on, until ``POST
    /api/backup/drive-upload-notice/acknowledge``; nothing uploads either way.

    A pointer or record edited by hand into a shape no resmon wrote matches
    neither model of its union, and this route then answers 500 rather than a
    body.
    """

    last_backup: Optional[BackupSummary]
    last_backup_path_recorded: Optional[str]
    pending_restore: Optional[Union[RestorePointer, RestorePointerUnreadable]]
    pending_restore_runs_when: Optional[str]
    pending_restore_runs_on: Optional[Literal["app_restart", "service_restart", "service_stopped"]]
    last_restore: Optional[Union[RestoreSucceeded, RestoreFailed]]
    undo_copies: list[str]
    drive_upload_retired: bool


class RestoreCancelled(LosslessModel):
    """``POST /api/restore/cancel``: no restore is staged now.

    ``success`` is true whether or not one was staged, and nothing had moved.
    """

    success: bool


class RestoreUndoCopiesDeleted(LosslessModel):
    """``POST /api/restore/undo-copy/delete``: the folders restores set aside, deleted.

    ``deleted`` is how many folders were listed for deletion. Each is removed
    with errors ignored, so it counts folders asked to go, not folders proven
    gone; ``GET /api/backup/last`` lists what is still there.
    """

    success: bool
    deleted: int


class RestoreAcknowledged(LosslessModel):
    """``POST /api/restore/acknowledge``: the card about the last restore dismissed.

    ``acknowledged`` is false when there was no record to dismiss, and true
    when the record was rewritten with ``acknowledged: true``.
    """

    success: bool
    acknowledged: bool


class DriveUploadNoticeAcknowledged(LosslessModel):
    """``POST /api/backup/drive-upload-notice/acknowledge``: the notice that the upload to Google Drive is gone, dismissed.

    The removed upload's two settings are deleted, so ``GET
    /api/backup/last`` answers ``drive_upload_retired: false`` from then on.
    ``acknowledged`` is whether the upload was switched on when this was
    asked; ``success`` is true either way.
    """

    success: bool
    acknowledged: bool


# ---------------------------------------------------------------------------
# The Danger Zone
# ---------------------------------------------------------------------------
#
# One model per route, because each answers a different set of counts and a
# shared model would put every count into the schema of routes that never
# send it. Each count is of what the route deleted as it counts it. The two
# key counts are not counts of keys that existed: they are the number of
# names whose slots were cleared, the same on every call.


class AiKeysErased(LosslessModel):
    """``POST /api/admin/erase-ai-keys``: every AI provider key slot cleared.

    ``ai_keys_removed`` is the number of AI provider keys that were stored and
    are now gone, the legacy ``ai_api_key`` slot included. A name that held no
    key is not counted, so with none stored it is 0. This route takes no
    ``confirm``.
    """

    success: bool
    ai_keys_removed: int


class RepositoryKeysErased(LosslessModel):
    """``POST /api/admin/erase-repo-keys``: every repository key slot the catalog names cleared.

    ``repo_keys_removed`` is the number of repository keys that were stored
    and are now gone; a name that held no key is not counted. This route takes
    no ``confirm``.
    """

    success: bool
    repo_keys_removed: int


class ConfigurationsErased(LosslessModel):
    """``POST /api/admin/erase-configs``: every saved configuration deleted.

    A routine configuration takes the routine it is linked to with it.
    ``configs_removed`` counts configurations; the routines deleted with them
    are not counted.
    """

    success: bool
    configs_removed: int


class ExecutionsErased(LosslessModel):
    """``POST /api/admin/erase-executions``: every run record deleted, with the run's links to its papers.

    The papers stay, and so do report files on disk. ``executions_removed``
    counts runs.
    """

    success: bool
    executions_removed: int


class ExecutionDataErased(LosslessModel):
    """``POST /api/admin/erase-execution-data``: every saved configuration and every run record deleted.

    The counts are as ``ConfigurationsErased`` and ``ExecutionsErased`` count
    them. Settings, keys and papers are kept.
    """

    success: bool
    configs_removed: int
    executions_removed: int


class AppDataErased(LosslessModel):
    """``POST /api/admin/erase-app-data``: papers, configurations, runs, and every AI and repository key.

    Settings, the SMTP password and the Library's files are kept. The key
    counts are of keys found and removed, as ``AiKeysErased`` and
    ``RepositoryKeysErased`` count them.
    """

    success: bool
    configs_removed: int
    executions_removed: int
    documents_removed: int
    ai_keys_removed: int
    repo_keys_removed: int


class CorpusErased(LosslessModel):
    """``POST /api/admin/erase-corpus``: every collected paper deleted, with what hangs off each.

    Runs, configurations, keys and the Library's files are kept.
    ``documents_removed`` counts papers.
    """

    success: bool
    documents_removed: int


class SettingsReset(LosslessModel):
    """``POST /api/admin/reset-settings``: every stored setting cleared, and every AI, repository and SMTP key.

    ``settings_cleared`` counts the stored settings deleted; the schema
    version marker is kept and not counted. The key counts are of keys found
    and removed, and ``smtp_credentials_removed`` counts the SMTP password the
    same way, apart from the AI and repository keys. Configurations, runs and
    papers are kept.
    """

    success: bool
    settings_cleared: int
    ai_keys_removed: int
    repo_keys_removed: int
    smtp_credentials_removed: int


class FactoryReset(LosslessModel):
    """``POST /api/admin/factory-reset``: papers, configurations, runs, settings, and AI, repository and SMTP keys.

    The counts are as the single-purpose routes and ``SettingsReset`` count
    them, so the key counts are of keys found and removed. It does not clear a
    Google Drive sign-in stored by the removed upload or a delivery target's
    webhook secret, and it does not touch the Library's files, report files on
    disk, or a restore's undo copies.
    """

    success: bool
    configs_removed: int
    executions_removed: int
    documents_removed: int
    settings_cleared: int
    ai_keys_removed: int
    repo_keys_removed: int
    smtp_credentials_removed: int


# ===========================================================================
# Corpus lifecycle: retractions, concerns, corrections, and newer versions
# ===========================================================================
#
# Every event here is a row resmon recorded from a notice it can link to:
# ``notice_url`` is ``NOT NULL`` in ``document_lifecycle`` and is required on
# every model below, because an event without its notice is resmon asserting a
# retraction on its own authority. ``severity`` and a check's ``status`` are
# closed by ``CHECK`` constraints in the schema, so they are ``Literal`` here:
# a value the table cannot hold is a 500 in the equality sweep rather than a
# word the renderer has no sentence for.

LifecycleSeverity = Literal["critical", "caution", "informational"]


class LifecycleEvent(LosslessModel):
    """One recorded event on a paper: a row of ``document_lifecycle``.

    ``label`` is the upstream's own wording, verbatim; ``provider_source`` is
    who registered the notice where Crossref says (``retraction-watch`` or
    ``publisher``).
    """

    document_id: int
    kind: str
    severity: LifecycleSeverity
    notice_key: str
    label: Optional[str]
    notice_doi: Optional[str]
    notice_url: str
    notice_date: Optional[str]
    detail: Optional[str]
    provider: str
    provider_source: Optional[str]
    first_seen_at: str


class LifecycleFinding(LifecycleEvent):
    """An event in the corpus report, with the paper it is on."""

    title: str
    document_doi: Optional[str]
    source_repository: str
    document_url: Optional[str]
    publication_date: Optional[str]


class LifecycleCounts(LosslessModel):
    """Recorded events by severity, over the whole corpus."""

    critical: int
    caution: int
    informational: int


class LifecycleCoverage(LosslessModel):
    """How much of the corpus the recorded events cover.

    The four counts partition ``corpus``. ``no_identifier`` papers were never
    looked at, because nothing could be asked about them; ``errored`` papers
    were asked about and a service failed on them; ``unchecked`` papers have
    not been asked about yet.
    """

    corpus: int
    checked: int
    no_identifier: int
    errored: int
    unchecked: int
    last_checked_at: Optional[str]
    recheck_after_days: int


class LifecycleCheckError(LosslessModel):
    """A paper a service failed on part-way, recorded as errored."""

    document_id: int
    title: Optional[str]
    error: Optional[str]


class LifecycleUnanswered(LosslessModel):
    """A service that did not answer, and the papers that left unchecked.

    Those papers are not recorded at all and are asked about again on the next
    run, so they count among ``coverage.unchecked``, never among the clear.
    """

    service: str
    name: str
    papers: int
    reason: Optional[str]


class LifecycleRunOutcomes(LosslessModel):
    """How each check a run recorded ended, by ``document_lifecycle_checks.status``."""

    ok: int
    no_identifier: int
    error: int


class LifecycleRunResult(LosslessModel):
    """The account of the most recent run to finish, in this engine.

    ``checked_now`` counts every paper the run recorded, and ``outcomes``
    divides it: only ``ok`` papers were looked at. ``stopped`` is true when the
    run was stopped before it had asked about everything it selected, and
    ``not_asked`` is how many papers it never asked about as a result.
    """

    checked_now: int
    outcomes: LifecycleRunOutcomes
    remaining: int
    errors: list[LifecycleCheckError]
    unanswered: list[LifecycleUnanswered]
    stopped: bool
    not_asked: int
    checked_at: str


class LifecycleRunState(LosslessModel):
    """Whether a check is running in this engine, and how the last one ended.

    Held in the engine's memory: an engine started since the last check has
    ``last`` null, and the recorded coverage is then the whole account.
    ``error`` is a run that failed outright, with nothing to report.
    """

    running: bool
    started_at: Optional[str]
    last: Optional[LifecycleRunResult]
    error: Optional[str]
    stop_requested: bool


class LifecycleReport(LosslessModel):
    """``GET /api/lifecycle``: every recorded event, the coverage, and the run.

    ``sufficient`` is false until at least one paper has been checked: an empty
    ``findings`` on an unchecked corpus is not "nothing has been retracted".
    """

    findings: list[LifecycleFinding]
    counts: LifecycleCounts
    coverage: LifecycleCoverage
    sufficient: bool
    run: LifecycleRunState


class LifecycleCheckStarted(LosslessModel):
    """``POST /api/lifecycle/check``: the check was started in the background."""

    status: Literal["started"]
    limit: int
    run_until_done: bool


class LifecycleStopAnswer(LosslessModel):
    """``POST /api/lifecycle/stop``: asked to stop, or nothing was running."""

    status: Literal["idle", "stopping"]


class LifecycleCheckState(LosslessModel):
    """When a paper was last checked, and how that check ended."""

    checked_at: str
    status: Literal["ok", "no_identifier", "error"]


class LifecycleForDocuments(LosslessModel):
    """``POST /api/lifecycle/for-documents``: events and check state for a page.

    Both maps are keyed by the paper's id as a string. A paper absent from
    ``events`` has nothing recorded against it; absent from ``checked`` as
    well, it has never been checked, which is the different fact.
    """

    events: dict[str, list[LifecycleEvent]]
    checked: dict[str, LifecycleCheckState]


# ---------------------------------------------------------------------------
# Shared wording (``implementation_scripts/shared_wording.py``)
# ---------------------------------------------------------------------------


class SharedWordingSettings(LosslessModel):
    """The method's thresholds, as the scan that answered used them."""

    phrase_words: int
    min_words: int
    common_works: int
    shown_longest: int
    shown_share: float


class SharedWordingDefinitions(LosslessModel):
    """Each number's definition, one sentence each, for the screen to show beside it."""

    longest: str
    share: str
    authors: str


class SharedWordingJob(LosslessModel):
    """A scan in the background: ``kind`` is ``full`` or ``new`` (papers since the last answer)."""

    running: bool
    kind: Optional[Literal["full", "new"]]
    stage: Optional[str]
    done: int
    total: int
    started_at: Optional[str]
    finished_at: Optional[str]
    cancelled: bool
    error: Optional[str]
    found: Optional[int]


class SharedWordingNotCompared(LosslessModel):
    """Papers the scan read and did not compare, by reason."""

    no_abstract: int = 0
    too_short: int = 0


class SharedWordingScan(LosslessModel):
    """The stored answer's own record: when, what kind of pass, and what it compared."""

    kind: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]
    seconds: Optional[float]
    full_scan_at: Optional[str]
    considered: Optional[int]
    compared: Optional[int]
    not_compared: Optional[SharedWordingNotCompared]
    method_version: Optional[int]


class SharedWordingSide(LosslessModel):
    """One paper of a pair, as a list row names it."""

    id: int
    title: Optional[str]
    publication_date: Optional[str]
    source_repository: Optional[str]


class SharedWordingBrief(LosslessModel):
    """A pair in a list: left is the earlier publication date, only as a reading order."""

    a: int
    b: int
    category: Literal["different_authors", "same_authors", "authors_unknown", "same_work", "notice"]
    reasons: list[str]
    reason_words: Optional[str]
    longest: int
    share: float
    authors_in_common: int
    left: SharedWordingSide
    right: SharedWordingSide


class SharedWordingGroup(LosslessModel):
    """One group of pairs. ``pairs`` holds at most 500; ``count`` counts them all."""

    category: Literal["different_authors", "same_authors", "authors_unknown", "same_work", "notice"]
    label: str
    note: str
    count: int
    pairs: list[SharedWordingBrief]


class SharedWording(LosslessModel):
    """``GET /api/shared-wording``.

    ``state`` is ``never`` (no scan stored), ``other_version`` (the stored
    answer came from another version of the method and is not shown), or
    ``ready``. ``withheld`` counts stored pairs not shown because a paper's text
    changed or the paper left; ``arrived_since`` counts papers the stored answer
    has not compared because they arrived after it.
    """

    state: Literal["never", "other_version", "ready"]
    method_version: int
    settings: SharedWordingSettings
    definitions: SharedWordingDefinitions
    limits: list[str]
    job: SharedWordingJob
    scan: Optional[SharedWordingScan]
    withheld: int
    arrived_since: int
    groups: list[SharedWordingGroup]


class SharedWordingCancel(LosslessModel):
    """``POST /api/shared-wording/scan/cancel``: asked to stop, or nothing was running."""

    status: Literal["idle", "cancelling"]


class SharedWordingAuthor(LosslessModel):
    """An author in both records, and whether the ORCID or the name matched."""

    name: str
    other_name: str
    by: Literal["orcid", "name"]


class SharedWordingPassage(LosslessModel):
    """One shared passage: codepoint ``[start, end)`` in each side's ``text``, and its words."""

    left: list[int]
    right: list[int]
    words: int


class SharedWordingPairSide(SharedWordingSide):
    """One paper of a pair in full: ``text`` is its abstract as compared."""

    authors: Optional[str]
    doi: Optional[str]
    url: Optional[str]
    text: str
    words: int


class SharedWordingPair(LosslessModel):
    """``GET /api/shared-wording/pairs/{a}/{b}``.

    ``state`` is ``changed`` when a text is no longer the one compared, and
    then ``passages`` is empty and ``summary`` says so.
    """

    a: int
    b: int
    state: Literal["current", "changed"]
    category: Literal["different_authors", "same_authors", "authors_unknown", "same_work", "notice"]
    label: str
    reasons: list[str]
    reason_words: Optional[str]
    left: SharedWordingPairSide
    right: SharedWordingPairSide
    longest: int
    share: float
    shorter: int
    shorter_phrases: int
    shared_phrases: int
    common_phrases: int
    authors_in_common: list[SharedWordingAuthor]
    passages: list[SharedWordingPassage]
    summary: list[str]
    definitions: SharedWordingDefinitions
    limits: list[str]
    scanned_at: Optional[str]
    method_version: int


class SharedWordingForPaper(LosslessModel):
    """``GET /api/shared-wording/papers/{document_id}``.

    ``compared`` is null when the paper arrived or changed after the scan.
    """

    document_id: int
    state: Literal["never", "other_version", "ready"]
    compared: Optional[bool]
    phrase_words: int
    pairs: list[SharedWordingBrief]


class SharedWordingFilePassage(LosslessModel):
    """A passage on this file's page: codepoint ``[start, end)`` in the page's text, and the text."""

    words: int
    start: int
    end: int
    text: str


class SharedWordingFileMatch(LosslessModel):
    """A paper's abstract or another file's page that shares wording with one of this file's pages."""

    kind: Literal["paper", "file"]
    page: int
    longest: int
    share: float
    shorter_phrases: int
    shared_phrases: int
    passages: list[SharedWordingFilePassage]
    document_id: Optional[int] = None
    title: Optional[str] = None
    publication_date: Optional[str] = None
    linked: Optional[bool] = None
    file_id: Optional[str] = None
    name: Optional[str] = None
    other_page: Optional[int] = None


class SharedWordingFileRef(LosslessModel):
    file_id: str
    version_id: str
    name: str
    media_type: str


class SharedWordingPageUnread(LosslessModel):
    page: int
    status: str


class SharedWordingFileUnread(LosslessModel):
    file_id: str
    name: str
    reason: str


class SharedWordingFileResult(LosslessModel):
    """What one comparison found, and what it read and could not read."""

    file: SharedWordingFileRef
    page_count: Optional[int]
    pages_read: int
    pages_unread: list[SharedWordingPageUnread]
    abstracts_compared: int
    files_compared: int
    files_not_read: list[SharedWordingFileUnread]
    matches: list[SharedWordingFileMatch]
    settings: SharedWordingSettings
    definitions: SharedWordingDefinitions
    limits: list[str]
    method_version: int


class SharedWordingLibrary(LosslessModel):
    """``POST`` and ``GET /api/library/files/{file_id}/shared-wording``.

    ``state`` is ``never`` (not compared since the engine started), ``running``,
    ``done`` (``result`` holds the answer), ``failed`` (``error`` says why), or
    ``cancelled``. Kept in memory only: the comparison is asked for again.
    """

    state: Literal["never", "running", "done", "failed", "cancelled"]
    file_id: str
    version_id: str
    stage: Optional[str] = None
    done: Optional[int] = None
    total: Optional[int] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    result: Optional[SharedWordingFileResult] = None
    error: Optional[str] = None
    reason: Optional[str] = None
