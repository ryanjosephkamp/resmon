# resmon_scripts/implementation_scripts/credential_manager.py
"""Secure credential management via OS-native keyring."""

import logging
import os
import threading
import time

import keyring
import httpx

from .config import APP_NAME

logger = logging.getLogger(__name__)

# Service name used for all keyring operations
_SERVICE = APP_NAME  # "resmon"


# ---------------------------------------------------------------------------
# Bounded keyring access
# ---------------------------------------------------------------------------
#
# OS keyring backends can block indefinitely. On macOS ``SecItemCopyMatching``
# waits on a GUI authorisation prompt; if nobody answers it, the call never
# returns. Because several request paths read credentials (``GET
# /api/cloud/status`` is the worst offender, since it runs on every Cloud
# settings render), an unbounded call there hangs the HTTP request and holds an
# ASGI worker thread with it. The same block made the verification suite hang
# forever rather than fail.
#
# Every keyring call is therefore run on a short-lived daemon thread and
# joined with a timeout. A stuck OS call cannot be cancelled, but the caller is
# released: the orphaned thread finishes in the background once the prompt is
# answered or the backend gives up.
#
# Reads degrade to "credential not present" for callers that just want a value —
# the caller behaves exactly as it would for an unset key. Writes and deletes
# raise, because silently reporting success for a credential that was never
# stored would be a lie the user acts on.
#
# But "absent" and "unreadable" are NOT the same thing, and conflating them is
# its own lie. On macOS the keychain binds access to an app's code signature,
# so an unsigned build — which ships a differently-signed interpreter on every
# release — is denied access to items an earlier build stored, and the denial
# arrives as a prompt no background process can answer. The user's keys are
# right there and the app reports "no key set". ``probe_credential`` exists so
# callers that report status to a human can tell the truth instead.
#
# The breaker below exists because the timeout alone is not enough: a presence
# sweep over fifteen credential names would pay it once per stored key. After a
# read times out, subsequent READS fail fast for a cooldown window. Writes and
# deletes always attempt — those are user-initiated, a prompt may well surface
# for a foreground action, and failing one instantly would be its own lie.

_KEYRING_TIMEOUT_SEC = float(os.environ.get("RESMON_KEYRING_TIMEOUT", "5.0"))
_KEYRING_COOLDOWN_SEC = float(os.environ.get("RESMON_KEYRING_COOLDOWN", "30.0"))

_breaker_lock = threading.Lock()
_keyring_blocked_until: float = 0.0


class KeyringTimeout(RuntimeError):
    """Raised when an OS keyring write or delete exceeds its time budget."""


def _breaker_is_open() -> bool:
    with _breaker_lock:
        return time.monotonic() < _keyring_blocked_until


def _trip_breaker() -> None:
    global _keyring_blocked_until
    with _breaker_lock:
        _keyring_blocked_until = time.monotonic() + _KEYRING_COOLDOWN_SEC


def _reset_breaker() -> None:
    global _keyring_blocked_until
    with _breaker_lock:
        _keyring_blocked_until = 0.0


def keyring_is_responsive() -> bool:
    """False while reads are failing fast after a recent timeout."""
    return not _breaker_is_open()


def _call_keyring(op: str, fn, *args, honour_breaker: bool = False):
    """Run ``fn(*args)`` on a daemon thread, bounded by the keyring timeout.

    Returns ``(ok, value)``. ``ok`` is False only on timeout. Exceptions raised
    by the backend propagate to the caller unchanged. With ``honour_breaker``
    the call short-circuits while the breaker is open — reads pass True, so a
    sweep costs one timeout rather than one per stored credential.
    """
    if honour_breaker and _breaker_is_open():
        return False, None

    box: dict = {}

    def _target() -> None:
        try:
            box["value"] = fn(*args)
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread
            box["error"] = exc

    worker = threading.Thread(target=_target, daemon=True, name=f"keyring-{op}")
    worker.start()
    worker.join(_KEYRING_TIMEOUT_SEC)

    if worker.is_alive():
        logger.warning(
            "OS keyring %s exceeded %.1fs and was abandoned (service=%s). "
            "If a keychain authorisation prompt is open, answering it will "
            "unblock subsequent calls.",
            op, _KEYRING_TIMEOUT_SEC, _SERVICE,
        )
        _trip_breaker()
        return False, None

    if "error" in box:
        raise box["error"]
    _reset_breaker()
    return True, box.get("value")


# ---------------------------------------------------------------------------
# Credential-name whitelists
# ---------------------------------------------------------------------------
#
# ``AI_CREDENTIAL_NAMES`` enumerates every BYOK LLM-provider key slot
# (ADQ-AI9). These names are accepted by the ``PUT /api/credentials/{name}``
# endpoint in ``resmon.py`` and by ``GET /api/credentials`` presence checks.
# ``SMTP_CREDENTIAL_NAMES`` covers transactional-email credentials.

AI_CREDENTIAL_NAMES: frozenset[str] = frozenset({
    "openai_api_key",
    "anthropic_api_key",
    "google_api_key",
    "xai_api_key",
    "meta_api_key",
    "deepseek_api_key",
    "alibaba_api_key",
    "custom_llm_api_key",
})

SMTP_CREDENTIAL_NAMES: frozenset[str] = frozenset({"smtp_password"})


def allowed_credential_names() -> frozenset[str]:
    """Return the union of all non-catalog credential names."""
    return AI_CREDENTIAL_NAMES | SMTP_CREDENTIAL_NAMES


# ---------------------------------------------------------------------------
# Core CRUD
# ---------------------------------------------------------------------------

def store_credential(key_name: str, value: str) -> None:
    """Store a credential securely in the OS keyring.

    Credentials are never logged or included in error messages.
    """
    ok, _ = _call_keyring("set_password", keyring.set_password, _SERVICE, key_name, value)
    if not ok:
        raise KeyringTimeout(
            f"Timed out storing credential {key_name!r} in the OS keyring after "
            f"{_KEYRING_TIMEOUT_SEC:.0f}s. The credential was not saved."
        )
    logger.info("Credential stored: %s (service=%s)", key_name, _SERVICE)


# Outcomes of a credential probe. "unreadable" means the keyring did not
# answer — the credential may well be there.
PRESENT = "present"
ABSENT = "absent"
UNREADABLE = "unreadable"


def probe_credential(key_name: str) -> str:
    """Return PRESENT, ABSENT or UNREADABLE for ``key_name``.

    Unlike :func:`get_credential`, this never collapses "the keyring would not
    answer" into "the user has not set this". Anything reporting credential
    status to a human should use it.
    """
    ok, value = _call_keyring(
        "get_password", keyring.get_password, _SERVICE, key_name,
        honour_breaker=True,
    )
    if not ok:
        return UNREADABLE
    return PRESENT if value is not None else ABSENT


def get_credential(key_name: str) -> str | None:
    """Retrieve a credential from the OS keyring. Returns None if not found.

    A keyring that will not answer is reported as absent here, which is the
    safe direction for callers that need a *value*: they behave exactly as
    they would for an unset key instead of blocking. Callers that report
    status to a human want :func:`probe_credential` instead.
    """
    ok, value = _call_keyring(
        "get_password", keyring.get_password, _SERVICE, key_name,
        honour_breaker=True,
    )
    if not ok:
        return None
    if value is None:
        logger.debug("Credential not found: %s (service=%s)", key_name, _SERVICE)
    return value


def delete_credential(key_name: str) -> None:
    """Remove a credential from the OS keyring."""
    try:
        ok, _ = _call_keyring("delete_password", keyring.delete_password, _SERVICE, key_name)
        if not ok:
            raise KeyringTimeout(
                f"Timed out deleting credential {key_name!r} from the OS keyring "
                f"after {_KEYRING_TIMEOUT_SEC:.0f}s. It may still be present."
            )
        logger.info("Credential deleted: %s (service=%s)", key_name, _SERVICE)
    except keyring.errors.PasswordDeleteError:
        logger.debug("Credential already absent: %s (service=%s)", key_name, _SERVICE)


# ---------------------------------------------------------------------------
# Legacy-key migration (Update 2 — Feature 1)
# ---------------------------------------------------------------------------
#
# Earlier pre-release builds may have stored the AI summarization API key
# under a single global ``ai_api_key`` slot rather than the per-provider
# ``{provider}_api_key`` scheme used today. This helper performs a one-shot
# transparent migration on startup: if the legacy slot exists and the
# user has already chosen a provider, the value is re-keyed under the
# matching per-provider slot and the legacy slot is cleared. Idempotent
# and safe to call on every startup; returns ``True`` only when an actual
# migration was performed.

_LEGACY_GLOBAL_AI_KEY = "ai_api_key"


def _per_provider_slot_for(provider: str) -> str | None:
    """Return the per-provider keyring slot for ``provider`` or ``None``.

    ``local`` and unknown providers have no remote API key slot.
    """
    p = (provider or "").strip().lower()
    if not p or p == "local":
        return None
    if p == "custom":
        return "custom_llm_api_key"
    name = f"{p}_api_key"
    return name if name in AI_CREDENTIAL_NAMES else None


def migrate_legacy_global_ai_key(provider: str | None) -> bool:
    """Re-key any legacy global ``ai_api_key`` into ``{provider}_api_key``.

    Returns ``True`` if a value was migrated, ``False`` otherwise. The
    legacy slot is cleared only after a successful write to the target
    slot. If ``provider`` is empty / ``local`` / unknown, the legacy
    slot is left in place so the user can reattempt after selecting a
    provider. Raw credential values are never logged.
    """
    legacy = get_credential(_LEGACY_GLOBAL_AI_KEY)
    if not legacy:
        return False
    target = _per_provider_slot_for(provider or "")
    if target is None:
        logger.info(
            "Legacy global AI key present but no eligible provider slot "
            "(provider=%r); leaving legacy slot in place.",
            provider,
        )
        return False
    # Don't clobber a key already stored under the target slot.
    if get_credential(target):
        logger.info(
            "Legacy global AI key present but target slot %s already has a "
            "value; clearing legacy slot.",
            target,
        )
        delete_credential(_LEGACY_GLOBAL_AI_KEY)
        return False
    store_credential(target, legacy)
    delete_credential(_LEGACY_GLOBAL_AI_KEY)
    logger.info(
        "Migrated legacy global AI key into per-provider slot %s.", target,
    )
    return True


# ---------------------------------------------------------------------------
# Ephemeral (per-execution) credentials
# ---------------------------------------------------------------------------
#
# Some callers (Deep Dive / Deep Sweep) let the user supply an API key only
# for the duration of a single execution without persisting it to the OS
# keyring.  Those values are held in-process, keyed by ``exec_id``, and are
# never logged.  The ``get_credential_for`` accessor consults the ephemeral
# store first and falls back to the persisted keyring value.

_EPHEMERAL_CREDENTIALS: dict[int, dict[str, str]] = {}


def push_ephemeral(exec_id: int, creds: dict[str, str] | None) -> None:
    """Register per-execution credentials for ``exec_id``.

    Empty or ``None`` values are ignored.  Existing entries for ``exec_id``
    are replaced (the caller owns the lifetime of the execution).  Raw
    values are never logged.
    """
    cleaned: dict[str, str] = {}
    if creds:
        for k, v in creds.items():
            if v is None:
                continue
            v_str = str(v).strip()
            if not v_str:
                continue
            cleaned[k] = v_str
    if cleaned:
        _EPHEMERAL_CREDENTIALS[exec_id] = cleaned
        logger.info(
            "Ephemeral credentials registered for exec_id=%s (%d key(s))",
            exec_id, len(cleaned),
        )
    else:
        # Drop any stale registration to keep the store tidy.
        _EPHEMERAL_CREDENTIALS.pop(exec_id, None)


def pop_ephemeral(exec_id: int) -> None:
    """Remove any ephemeral credentials registered for ``exec_id``."""
    existed = _EPHEMERAL_CREDENTIALS.pop(exec_id, None) is not None
    if existed:
        logger.info("Ephemeral credentials cleared for exec_id=%s", exec_id)


def get_credential_for(exec_id: int | None, key_name: str) -> str | None:
    """Return the credential for ``key_name`` under ``exec_id`` if present.

    Lookup order: ephemeral (exec-scoped) → persisted keyring.  Returns
    ``None`` if neither is present.  ``exec_id=None`` is treated as "no
    ephemeral scope" and falls through to the keyring lookup.
    """
    if exec_id is not None:
        scope = _EPHEMERAL_CREDENTIALS.get(exec_id)
        if scope and key_name in scope:
            return scope[key_name]
    return get_credential(key_name)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Lightweight validation endpoints per provider (minimal quota usage)
_VALIDATION_ENDPOINTS: dict[str, dict] = {
    "openai": {
        "url": "https://api.openai.com/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    },
    "google": {
        "url": "https://generativelanguage.googleapis.com/v1beta/models",
        "method": "GET",
        "headers_fn": lambda key: {},
        "params_fn": lambda key: {"key": key},
    },
    "xai": {
        "url": "https://api.x.ai/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "meta": {
        # Meta defaults to Together AI's OpenAI-compatible endpoint (ADQ-AI6).
        "url": "https://api.together.xyz/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "deepseek": {
        "url": "https://api.deepseek.com/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "alibaba": {
        "url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "core": {
        "url": "https://api.core.ac.uk/v3/search/works?q=test&limit=1",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "nasa_ads": {
        "url": "https://api.adsabs.harvard.edu/v1/search/query?q=test&rows=1",
        "method": "GET",
        "headers_fn": lambda key: {"Authorization": f"Bearer {key}"},
    },
    "springer": {
        "url": "https://api.springernature.com/meta/v2/json?q=test&s=1&p=1",
        "method": "GET",
        "headers_fn": lambda key: {},  # key goes as query param
        "params_fn": lambda key: {"api_key": key},
    },
}


def validate_api_key(provider: str, key: str, base_url: str | None = None) -> bool:
    """Make a lightweight test call to verify the API key is valid.

    Returns True if the key appears valid (HTTP 200), False otherwise.
    Never raises; any 401/403/404, network, timeout, or transport error
    results in ``False``. The key value is never logged or included in
    error messages.

    ``base_url`` is honored only for ``provider == "custom"`` (IMPL-AI12):
    the probe is a ``GET {base_url}/models`` with ``Authorization: Bearer``.
    """
    if provider == "custom":
        if not base_url:
            logger.warning("Custom provider validation requires a base_url")
            return False
        probe_url = base_url.rstrip("/") + "/models"
        try:
            with httpx.Client(timeout=15) as client:
                response = client.get(
                    probe_url,
                    headers={"Authorization": f"Bearer {key}"},
                )
            if response.status_code == 200:
                logger.info("API key validation succeeded for provider 'custom'")
                return True
            logger.warning(
                "API key validation failed for provider 'custom': HTTP %d",
                response.status_code,
            )
            return False
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
            logger.error("API key validation error for provider 'custom': %s", type(exc).__name__)
            return False
        except Exception as exc:  # pragma: no cover - defensive catch-all
            logger.error(
                "Unexpected validation error for provider 'custom': %s",
                type(exc).__name__,
            )
            return False

    spec = _VALIDATION_ENDPOINTS.get(provider)
    if spec is None:
        logger.warning("No validation endpoint configured for provider '%s'", provider)
        return False

    headers = spec["headers_fn"](key)
    params = spec.get("params_fn", lambda _: {})(key)

    try:
        with httpx.Client(timeout=15) as client:
            response = client.request(
                spec["method"],
                spec["url"],
                headers=headers,
                params=params,
            )
        if response.status_code == 200:
            logger.info("API key validation succeeded for provider '%s'", provider)
            return True
        logger.warning(
            "API key validation failed for provider '%s': HTTP %d",
            provider, response.status_code,
        )
        return False
    except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
        # TransportError covers ConnectError, ReadError, and related subclasses.
        logger.error("API key validation error for provider '%s': %s", provider, type(exc).__name__)
        return False
    except Exception as exc:  # pragma: no cover - defensive catch-all
        logger.error(
            "Unexpected validation error for provider '%s': %s",
            provider, type(exc).__name__,
        )
        return False
