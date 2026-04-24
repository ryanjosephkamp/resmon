"""Envelope encryption for ``resmon-cloud`` credentials (IMPL-31).

Implements the scheme specified in `resmon_routines_and_accounts.md` §9.2:

1. Per-credential **DEK** — a fresh 32-byte random key generated at
   credential-write time (one DEK per credential row; rotation is trivially
   achieved by rewriting the row).
2. The DEK encrypts the plaintext value with **XChaCha20-Poly1305** (via
   :mod:`nacl.bindings`, which exposes libsodium's IETF XChaCha20-Poly1305
   AEAD construction — 32-byte key, 24-byte nonce, 16-byte Poly1305 tag).
3. The DEK is then wrapped by the **KEK** held in a managed KMS, via the
   pluggable :class:`KMSClient` interface. The production deployment points
   at AWS KMS / GCP KMS / Cloudflare KMS (backend chosen per
   ``RESMON_KMS_BACKEND`` + ``KMS_KEY_ID``); hermetic CI uses the in-memory
   :class:`LocalKMSClient` that derives the wrap key from a process-scoped
   master key.

Logging discipline (§9.4 V-D3):

* This module does **not** configure any logger and contains exactly one
  ``logging.getLogger`` call. No code path in this file ever calls
  ``logger.info`` or ``logger.debug`` on plaintext, ciphertext, DEKs, or
  KEK material.
* Callers are expected to pass plaintext values only into :func:`seal` /
  :func:`encrypt_credential`. Plaintext must never be placed on a log
  record, an ``HTTPException.detail`` string, or any other stringified
  output path.
"""

from __future__ import annotations

import logging
import os
import secrets
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Optional

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_encrypt,
)


logger = logging.getLogger(__name__)

DEK_BYTES = crypto_aead_xchacha20poly1305_ietf_KEYBYTES  # 32
NONCE_BYTES = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES  # 24


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def generate_dek() -> bytes:
    """Return a fresh 32-byte XChaCha20-Poly1305 key from the OS CSPRNG."""
    return secrets.token_bytes(DEK_BYTES)


def generate_nonce() -> bytes:
    """Return a fresh 24-byte XChaCha20-Poly1305 nonce from the OS CSPRNG."""
    return secrets.token_bytes(NONCE_BYTES)


def seal(plaintext: bytes, dek: bytes, *, aad: bytes = b"") -> tuple[bytes, bytes]:
    """AEAD-encrypt ``plaintext`` under ``dek`` and return ``(ciphertext, nonce)``.

    A fresh nonce is generated per call. ``aad`` is authenticated but not
    encrypted and is used by the credentials endpoint to bind each row to
    its ``(user_id, key_name)`` tuple so a ciphertext cannot be silently
    moved between rows.
    """
    if len(dek) != DEK_BYTES:
        raise ValueError(f"DEK must be {DEK_BYTES} bytes, got {len(dek)}")
    nonce = generate_nonce()
    ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext, aad, nonce, dek
    )
    return ciphertext, nonce


def open_(ciphertext: bytes, nonce: bytes, dek: bytes, *, aad: bytes = b"") -> bytes:
    """AEAD-decrypt ``ciphertext`` under ``dek``. Raises on tamper or bad key."""
    if len(dek) != DEK_BYTES:
        raise ValueError(f"DEK must be {DEK_BYTES} bytes, got {len(dek)}")
    if len(nonce) != NONCE_BYTES:
        raise ValueError(f"Nonce must be {NONCE_BYTES} bytes, got {len(nonce)}")
    return crypto_aead_xchacha20poly1305_ietf_decrypt(
        ciphertext, aad, nonce, dek
    )


# ---------------------------------------------------------------------------
# KMS interface + local stub
# ---------------------------------------------------------------------------


class KMSError(RuntimeError):
    """Raised when a wrap/unwrap operation fails."""


class KMSClient(ABC):
    """Pluggable KMS interface for DEK wrap / unwrap.

    Production implementations wrap the DEK using a managed KMS (AWS KMS
    ``Encrypt``/``Decrypt``, GCP KMS ``encrypt``/``decrypt``, or Cloudflare
    KMS equivalents) keyed on ``kek_id``. The interface is intentionally
    minimal so that the production backend can be swapped without touching
    the credential endpoint logic.
    """

    @abstractmethod
    def wrap_dek(self, dek: bytes, kek_id: str) -> bytes:
        """Return the opaque wrapped form of ``dek`` under KEK ``kek_id``."""

    @abstractmethod
    def unwrap_dek(self, wrapped: bytes, kek_id: str) -> bytes:
        """Return the raw DEK given the wrapped blob and ``kek_id``."""


class LocalKMSClient(KMSClient):
    """In-memory KMS stub for hermetic tests and local dev.

    The master key lives in process memory only and is derived from the
    ``RESMON_LOCAL_KMS_MASTER`` environment variable (hex-encoded) if set,
    otherwise a fresh per-process random key is generated — which means
    wrapped DEKs do not survive a process restart. Acceptable for tests,
    unacceptable for production, hence the explicit warning on construction.

    The wrap primitive is XChaCha20-Poly1305 under the master key, with the
    ``kek_id`` bound as AAD so rotating ``kek_id`` deterministically
    invalidates old wrapped DEKs.
    """

    def __init__(self, master_key: Optional[bytes] = None) -> None:
        if master_key is None:
            env_val = os.environ.get("RESMON_LOCAL_KMS_MASTER")
            if env_val:
                master_key = bytes.fromhex(env_val)
            else:
                master_key = secrets.token_bytes(DEK_BYTES)
                logger.warning(
                    "LocalKMSClient: no RESMON_LOCAL_KMS_MASTER set; "
                    "generated an ephemeral master key for this process. "
                    "This backend is for tests and local dev only."
                )
        if len(master_key) != DEK_BYTES:
            raise ValueError(
                f"LocalKMSClient master key must be {DEK_BYTES} bytes"
            )
        self._master = master_key

    def wrap_dek(self, dek: bytes, kek_id: str) -> bytes:
        if len(dek) != DEK_BYTES:
            raise KMSError(f"DEK must be {DEK_BYTES} bytes for wrapping")
        aad = kek_id.encode("utf-8")
        try:
            ct, nonce = seal(dek, self._master, aad=aad)
        except Exception as exc:  # pragma: no cover - defensive
            raise KMSError(f"DEK wrap failed: {type(exc).__name__}") from exc
        # Wrapped blob format: ``nonce || ciphertext`` (24 + 32 + 16 = 72 bytes).
        return nonce + ct

    def unwrap_dek(self, wrapped: bytes, kek_id: str) -> bytes:
        if len(wrapped) < NONCE_BYTES + DEK_BYTES:
            raise KMSError("Wrapped DEK payload is too short")
        nonce, ct = wrapped[:NONCE_BYTES], wrapped[NONCE_BYTES:]
        aad = kek_id.encode("utf-8")
        try:
            return open_(ct, nonce, self._master, aad=aad)
        except Exception as exc:
            raise KMSError(f"DEK unwrap failed: {type(exc).__name__}") from exc


# ---------------------------------------------------------------------------
# KMS factory
# ---------------------------------------------------------------------------


KMSFactory = Callable[[Optional[str]], KMSClient]


_KMS_FACTORIES: dict[str, KMSFactory] = {
    "local": lambda _kek_id: LocalKMSClient(),
}


def register_kms_backend(name: str, factory: KMSFactory) -> None:
    """Register a :class:`KMSClient` factory callable under ``name``.

    Deployments call this at startup to install the concrete AWS / GCP /
    Cloudflare client. The factory receives ``kek_id`` and must return a
    :class:`KMSClient`. This keeps the heavy cloud SDKs out of the default
    import graph so CI stays fast and hermetic.
    """
    _KMS_FACTORIES[name] = factory


def _get_env_backend() -> str:
    return (os.environ.get("RESMON_KMS_BACKEND") or "local").strip().lower()


def build_kms_client(kek_id: Optional[str] = None) -> KMSClient:
    """Return the :class:`KMSClient` selected by ``RESMON_KMS_BACKEND``.

    Recognized backends:

    * ``"local"`` (default) — :class:`LocalKMSClient` (tests, dev).
    * ``"aws"`` / ``"gcp"`` / ``"cloudflare"`` — production backends. These
      are **not** shipped in this file so that importing ``cloud.crypto``
      does not pull in ``boto3`` / ``google-cloud-kms`` / a Cloudflare SDK
      for every CI run. Deployments register the concrete class through
      :func:`register_kms_backend` at app startup.
    """
    backend = _get_env_backend()
    factory = _KMS_FACTORIES.get(backend)
    if factory is None:
        raise KMSError(
            f"Unknown KMS backend {backend!r}. "
            "Register the production factory via cloud.crypto.register_kms_backend()."
        )
    return factory(kek_id)


# ---------------------------------------------------------------------------
# Envelope API
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Envelope:
    """Persisted shape of an encrypted credential (mirrors the DB row)."""

    ciphertext: bytes
    nonce: bytes
    wrapped_dek: bytes
    kek_id: str


def encrypt_credential(
    plaintext: str,
    kms: KMSClient,
    kek_id: str,
    *,
    aad: bytes = b"",
) -> Envelope:
    """Generate a fresh DEK, seal ``plaintext``, wrap the DEK, and package."""
    if not isinstance(plaintext, str):
        raise TypeError("plaintext must be str")
    dek = generate_dek()
    try:
        ciphertext, nonce = seal(plaintext.encode("utf-8"), dek, aad=aad)
        wrapped_dek = kms.wrap_dek(dek, kek_id)
    finally:
        # Best-effort scrub of the raw DEK from our local reference.
        dek = b"\x00" * DEK_BYTES  # noqa: F841
    return Envelope(
        ciphertext=ciphertext,
        nonce=nonce,
        wrapped_dek=wrapped_dek,
        kek_id=kek_id,
    )


def decrypt_credential(
    envelope: Envelope,
    kms: KMSClient,
    *,
    aad: bytes = b"",
) -> str:
    """Unwrap the DEK and open the ciphertext. Returns the plaintext string."""
    dek = kms.unwrap_dek(envelope.wrapped_dek, envelope.kek_id)
    try:
        plaintext = open_(envelope.ciphertext, envelope.nonce, dek, aad=aad)
    finally:
        dek = b"\x00" * DEK_BYTES  # noqa: F841
    return plaintext.decode("utf-8")
