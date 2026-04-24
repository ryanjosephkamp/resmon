"""``/api/v2/credentials`` endpoints (IMPL-31).

Implements §9.3 of ``resmon_routines_and_accounts.md``:

* ``GET    /api/v2/credentials``              → ``{key_name: True, ...}``
* ``PUT    /api/v2/credentials/{key_name}``   → body ``{value: str}``; server
  envelope-encrypts and stores ``(ciphertext, nonce, wrapped_dek, kek_id)``.
* ``DELETE /api/v2/credentials/{key_name}``   → destroys row + wrapped DEK.

No endpoint exposes plaintext, ciphertext, or DEK material. HTTP responses
and log records are scrubbed of all secret values by construction: the
plaintext value is consumed exactly once on the PUT path (into
:func:`cloud.crypto.encrypt_credential`) and is never reused, logged, or
echoed back.

Storage abstraction
-------------------

The endpoints talk to an abstract :class:`CredentialStore` rather than to
Postgres directly. The production path uses :class:`PostgresCredentialStore`
(RLS-scoped via :func:`cloud.db.rls_session`). Hermetic tests inject
:class:`InMemoryCredentialStore` via ``app.state.credential_store``, which
mirrors the exact column layout (``ciphertext``, ``nonce``, ``wrapped_dek``,
``kek_id``) so the §9.4 V-D1 grep test can inspect the persisted blob
directly.
"""

from __future__ import annotations

import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .auth import CurrentUser, get_current_user
from .crypto import Envelope, KMSClient, build_kms_client, encrypt_credential


logger = logging.getLogger(__name__)

_DEFAULT_KEK_ID = "resmon-local-dev"


# ---------------------------------------------------------------------------
# Body models
# ---------------------------------------------------------------------------


class CredentialPutBody(BaseModel):
    value: str = Field(..., min_length=1, max_length=8192)


# ---------------------------------------------------------------------------
# Storage abstraction
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StoredRow:
    """Exact persisted shape — mirrors the ``credentials`` table."""

    user_id: uuid.UUID
    key_name: str
    ciphertext: bytes
    nonce: bytes
    wrapped_dek: bytes
    kek_id: str


class CredentialStore(ABC):
    """Minimal interface the credentials endpoints rely on."""

    @abstractmethod
    def list_keys(self, user_id: uuid.UUID) -> list[str]:
        ...

    @abstractmethod
    def put(self, row: StoredRow) -> None:
        ...

    @abstractmethod
    def delete(self, user_id: uuid.UUID, key_name: str) -> bool:
        ...

    def read_row(
        self, user_id: uuid.UUID, key_name: str
    ) -> Optional["StoredRow"]:
        """Return the full stored row for worker-side decryption.

        Default implementation returns ``None`` so stores that deliberately
        hide credential bytes from the request path remain compliant.
        """
        return None

    def dump_all_bytes(self) -> bytes:  # pragma: no cover - test helper only
        """Return every byte this store holds — used by V-D1 plaintext grep."""
        raise NotImplementedError


class InMemoryCredentialStore(CredentialStore):
    """Dict-backed store for hermetic tests and local ``sqlite`` dev runs."""

    def __init__(self) -> None:
        self._rows: Dict[tuple[uuid.UUID, str], StoredRow] = {}

    def list_keys(self, user_id: uuid.UUID) -> list[str]:
        return sorted(k for (uid, k) in self._rows if uid == user_id)

    def put(self, row: StoredRow) -> None:
        self._rows[(row.user_id, row.key_name)] = row

    def delete(self, user_id: uuid.UUID, key_name: str) -> bool:
        return self._rows.pop((user_id, key_name), None) is not None

    def read_row(
        self, user_id: uuid.UUID, key_name: str
    ) -> Optional[StoredRow]:
        return self._rows.get((user_id, key_name))

    def dump_all_bytes(self) -> bytes:
        """Concatenate every persisted column — surrogate for ``pg_dump``."""
        chunks: list[bytes] = []
        for row in self._rows.values():
            chunks.append(str(row.user_id).encode("utf-8"))
            chunks.append(row.key_name.encode("utf-8"))
            chunks.append(row.ciphertext)
            chunks.append(row.nonce)
            chunks.append(row.wrapped_dek)
            chunks.append(row.kek_id.encode("utf-8"))
        return b"".join(chunks)


class PostgresCredentialStore(CredentialStore):
    """Postgres-backed store that relies on RLS for per-user isolation.

    Not exercised in hermetic CI (no Postgres available). Covered
    indirectly by ``test_cloud_migrations.py`` under the ``@pg_required``
    gate at the migration layer; end-to-end coverage lands once a live PG
    instance is wired in.
    """

    def __init__(self, rls_session_factory):
        self._rls_session = rls_session_factory

    def list_keys(self, user_id: uuid.UUID) -> list[str]:  # pragma: no cover
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            rows = conn.execute(
                text("SELECT key_name FROM credentials ORDER BY key_name")
            ).all()
        return [r[0] for r in rows]

    def put(self, row: StoredRow) -> None:  # pragma: no cover
        from sqlalchemy import text

        with self._rls_session(row.user_id) as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO credentials
                        (user_id, key_name, ciphertext, nonce, wrapped_dek, kek_id)
                    VALUES
                        (:user_id, :key_name, :ct, :nonce, :wrapped, :kek_id)
                    ON CONFLICT (user_id, key_name) DO UPDATE SET
                        ciphertext = EXCLUDED.ciphertext,
                        nonce = EXCLUDED.nonce,
                        wrapped_dek = EXCLUDED.wrapped_dek,
                        kek_id = EXCLUDED.kek_id,
                        updated_at = now()
                    """
                ),
                {
                    "user_id": str(row.user_id),
                    "key_name": row.key_name,
                    "ct": row.ciphertext,
                    "nonce": row.nonce,
                    "wrapped": row.wrapped_dek,
                    "kek_id": row.kek_id,
                },
            )

    def delete(self, user_id: uuid.UUID, key_name: str) -> bool:  # pragma: no cover
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            res = conn.execute(
                text(
                    "DELETE FROM credentials "
                    "WHERE user_id = :user_id AND key_name = :key_name"
                ),
                {"user_id": str(user_id), "key_name": key_name},
            )
            return (res.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def _get_store(request: Request) -> CredentialStore:
    store = getattr(request.app.state, "credential_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Credential store not configured",
        )
    return store


def _get_kek_id(request: Request) -> str:
    cfg = getattr(request.app.state, "config", None)
    if cfg is not None and getattr(cfg, "kms_key_id", None):
        return str(cfg.kms_key_id)
    return _DEFAULT_KEK_ID


def _get_kms(request: Request, kek_id: str) -> KMSClient:
    kms = getattr(request.app.state, "kms_client", None)
    if kms is None:
        kms = build_kms_client(kek_id)
        request.app.state.kms_client = kms
    return kms


def _aad_for(user_id: uuid.UUID, key_name: str) -> bytes:
    """Bind ciphertext to ``(user_id, key_name)`` so rows can't be swapped."""
    return f"{user_id}:{key_name}".encode("utf-8")


def build_credentials_router() -> APIRouter:
    """Return the ``/credentials`` router. Mounted under the v2 prefix."""
    router = APIRouter()

    @router.get("/credentials")
    def list_credentials(
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict[str, bool]:
        store = _get_store(request)
        keys = store.list_keys(current_user.user_id)
        return {k: True for k in keys}

    @router.put("/credentials/{key_name}", status_code=status.HTTP_204_NO_CONTENT)
    def put_credential(
        key_name: str,
        body: CredentialPutBody,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ):
        _validate_key_name(key_name)
        store = _get_store(request)
        kek_id = _get_kek_id(request)
        kms = _get_kms(request, kek_id)
        envelope: Envelope = encrypt_credential(
            body.value,
            kms,
            kek_id,
            aad=_aad_for(current_user.user_id, key_name),
        )
        store.put(
            StoredRow(
                user_id=current_user.user_id,
                key_name=key_name,
                ciphertext=envelope.ciphertext,
                nonce=envelope.nonce,
                wrapped_dek=envelope.wrapped_dek,
                kek_id=envelope.kek_id,
            )
        )
        # Deliberately no logging of the value, ciphertext, or key material.
        logger.info(
            "Credential stored for user_id=%s key_name=%s (%d ct bytes)",
            current_user.user_id,
            key_name,
            len(envelope.ciphertext),
        )
        return None

    @router.delete(
        "/credentials/{key_name}", status_code=status.HTTP_204_NO_CONTENT
    )
    def delete_credential(
        key_name: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ):
        _validate_key_name(key_name)
        store = _get_store(request)
        existed = store.delete(current_user.user_id, key_name)
        if not existed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Credential not found",
            )
        logger.info(
            "Credential deleted for user_id=%s key_name=%s",
            current_user.user_id,
            key_name,
        )
        return None

    return router


# ---------------------------------------------------------------------------
# Key name hygiene
# ---------------------------------------------------------------------------

_MAX_KEY_NAME_LEN = 128


def _validate_key_name(name: str) -> None:
    if not name or len(name) > _MAX_KEY_NAME_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid key_name",
        )
    # Allow alnum, dot, dash, underscore. Reject anything that could collide
    # with path traversal or SQL metacharacters.
    if not all(c.isalnum() or c in "._-" for c in name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="key_name contains disallowed characters",
        )
