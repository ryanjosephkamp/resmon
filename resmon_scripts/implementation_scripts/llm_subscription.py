# resmon_scripts/implementation_scripts/llm_subscription.py
"""Driving an installed agent CLI as a summarization lane.

resmon runs the CLI the user already installed and authenticated — ``claude -p``
for Claude Code, ``codex exec`` for Codex — so the work draws on their existing
Claude Max or ChatGPT plan instead of a metered API key. resmon never embeds
provider OAuth, never sees the credential, and never authenticates on the user's
behalf. If the CLI is not logged in, that is reported; it is not worked around.

Three things shape this module.

**Extraction is defensive, and failure is honest.** An agent CLI emits prose,
banners, progress and a final answer. Both CLIs happen to offer a structured
route out — ``claude --output-format json`` returns a single JSON object, and
``codex exec -o FILE`` writes just the final message — and both are used, because
scraping an agent's console output for "the summary part" is how you end up
storing a banner as a paper's summary. When the structured route yields nothing
usable the answer is *"the CLI returned something we could not use"*. It is never
a salvaged fragment presented as a real summary.

**The CLI is run with no tools and no context.** Abstracts are untrusted text
fetched from the internet, and an agent CLI can execute commands on the user's
machine. Feeding one into the other without constraint would make every abstract
in every sweep a prompt-injection vector against the user's filesystem. So each
call runs in a fresh empty directory, with tools switched off (``--tools ""``)
or the sandbox pinned read-only (``-s read-only``), and with the *user's* project
configuration left out of it. A summarizer needs no tools; taking them away
costs nothing and closes the hole.

**The constitution travels above the abstract, not beside it.**
``SUMMARIZE_ABSTRACT`` opens by telling the model to follow the attached
constitution, so a lane that does not attach one is instructing the model to
obey a document it was never given — and an agent CLI, told to follow something
it cannot find, will go looking for it. With tools off it cannot look, so it
*fabricates* the search and its results and returns them as the summary. That
was shipped behaviour until this was fixed; see
``workspace/audits/subscription-lane-constitution-2026-09-03.md``.

Each CLI therefore gets the constitution through its own system-level channel
rather than inlined into the prompt beside the untrusted abstract: ``claude``
takes ``--append-system-prompt``, and ``codex`` — which has no equivalent flag —
reads an ``AGENTS.md`` that resmon writes into the temporary working directory
it controls. Both were verified against the installed CLIs. Keeping the rules
above the abstract rather than next to it means injected text in an abstract is
arguing with a system instruction, not with a peer.

**It is slow and it spends a window the user also works in.** That is a product
fact, not an implementation detail: the lane carries a per-execution document cap
(see ``ai_lanes.DEFAULT_SUBSCRIPTION_DOC_CAP``), the interface says what a run
will consume before it runs, and it is not the default for bulk summarization.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
from typing import Optional

from .ai_errors import AIError, AIErrorKind
from .prompt_templates import (
    BATCH_SUMMARY_SCHEMA,
    SUMMARIZE_ABSTRACT,
    SUMMARIZE_ABSTRACTS_BATCH,
    SYSTEM_PREAMBLE,
    length_band,
    render_batch_documents,
)

logger = logging.getLogger(__name__)

__all__ = [
    "SubscriptionLLMClient",
    "DEFAULT_CLI_TIMEOUT_SECONDS",
    "DEFAULT_BATCH_BASE_SECONDS",
    "DEFAULT_BATCH_PER_DOCUMENT_SECONDS",
]

# Agent CLIs are far slower per call than a direct API request: there is a
# process to start, a session to establish and an agent loop to run. Five
# minutes is generous for one abstract and still bounded, so a wedged CLI
# cannot hold a sweep open indefinitely.
DEFAULT_CLI_TIMEOUT_SECONDS = 300

# A batched call is one process for N documents, so its budget scales with N
# rather than being the single-document number reused. ``base`` covers what a
# call costs before any summarizing happens -- process start, session setup,
# reading the constitution -- and is the part batching exists to pay once.
#
# The numbers are set against the wall-clock figures
# ``verification_scripts/measure_subscription_batching.py`` produces, rounded
# up generously: a timeout that fires on a merely slow run costs a batch split
# and then N spawns, which is the outcome batching exists to avoid.
DEFAULT_BATCH_BASE_SECONDS = 120
DEFAULT_BATCH_PER_DOCUMENT_SECONDS = 45


class _CLITimeout(Exception):
    """The CLI did not answer in time.

    Private, and distinct from the ``AIError`` a timeout eventually becomes,
    because the batch path needs to tell a timeout apart from every other
    document-local failure: a timeout is the one that is worth retrying with a
    smaller batch, and everything else is not.
    """

# Substrings that mean "nobody is logged into this CLI" rather than "this
# request failed". Matched case-insensitively against the CLI's own output.
#
# The first entry is the exact wording observed from `claude -p` on an expired
# session; the rest are the ordinary shapes. This is a heuristic over another
# tool's prose, so it is deliberately narrow: over-matching would demote a
# working lane for the whole run, which is the more expensive mistake.
_AUTH_MARKERS = (
    "failed to authenticate",
    "oauth session expired",
    "not logged in",
    "please log in",
    "please run `claude login`",
    "run `codex login`",
    "authentication required",
    "unauthorized",
    "invalid api key",
    "no credentials found",
)

# Substrings that mean the plan's usage window is exhausted.
_QUOTA_MARKERS = (
    "usage limit",
    "rate limit",
    "quota",
    "too many requests",
    "resets at",
)


class SubscriptionLLMClient:
    """Summarize through an installed agent CLI.

    Exposes ``summarize(text, prompt_params) -> str`` plus ``model`` and
    ``provider``, which is the whole contract ``SummarizationPipeline`` needs —
    so a subscription lane drops into a chain exactly where an API-key or local
    lane would.
    """

    # An explicit opt-in rather than a ``hasattr(client, "summarize_many")``
    # sniff. Duck-typing on a method name is how a ``MagicMock`` — which
    # answers to every attribute — silently became a batching client in the
    # suite, and a test double that claims a capability it does not have is
    # the shape of failure this project keeps paying for. Identity against
    # ``True`` so a truthy stand-in does not qualify either.
    supports_batch_calls = True

    def __init__(
        self,
        provider: str,
        binary_path: str,
        model: Optional[str] = None,
        timeout: int = DEFAULT_CLI_TIMEOUT_SECONDS,
        lane_label: str = "",
        effort: Optional[str] = None,
    ) -> None:
        self.provider = provider
        self.binary_path = binary_path
        self.model = model
        self.timeout = timeout
        self.effort = (effort or "").strip() or None
        self.lane_label = lane_label or provider
        # Cancellation. A batch is one long-running process, so "cancel the
        # sweep" has to reach inside a call rather than only between them --
        # otherwise a user who cancels waits out a ten-document batch. The
        # engine calls ``cancel()`` from its heartbeat thread; the lock is
        # what makes that safe against the thread doing the spawning.
        self._lock = threading.Lock()
        self._active: set = set()
        self._cancelled = False
        # How many batches had to fall back to per-document calls. Reported on
        # the lane rather than inferred, because "batching worked" and
        # "batching was silently abandoned" produce identical summaries.
        self.batch_fallbacks = 0
        self.batch_splits = 0
        self.batch_calls = 0
        # What the CLI said each call cost. Appended to, never read by the
        # summarization path -- it changes no behaviour.
        #
        # It exists because the document cap and the not-default-for-bulk guard
        # were always about the **plan's usage window**, which is spent in
        # tokens, and resmon had no way to see that number even though claude
        # reports it in every envelope. Measuring batching on wall-clock
        # instead answered a question nobody was asking.
        self.telemetry: list[dict] = []
        self._batch_documents = 1
        logger.info(
            "SubscriptionLLMClient initialized: provider=%s, binary=%s, model=%s",
            provider, binary_path, model or "(CLI default)",
        )

    # ------------------------------------------------------------------
    # Summarize
    # ------------------------------------------------------------------

    def summarize(self, text: str, prompt_params: dict | None = None) -> str:
        """Run one document through the CLI and return the summary text."""
        prompt = self._build_prompt(text, prompt_params)

        # A fresh empty directory per call. The agent gets no repository and
        # none of the user's project configuration — no CLAUDE.md, and no
        # AGENTS.md but the one resmon writes there itself to carry the
        # constitution on the codex path. Nothing of the user's to find even if
        # the abstract asks it to go looking.
        with tempfile.TemporaryDirectory(prefix="resmon-ai-") as workdir:
            try:
                if self.provider == "codex":
                    return self._run_codex(prompt, workdir)
                return self._run_claude_code(prompt, workdir)
            except _CLITimeout as timed_out:
                raise self._error(
                    AIErrorKind.UNKNOWN,
                    f"The {self.provider} CLI did not answer within "
                    f"{timed_out.args[0]} seconds for this document.",
                ) from None

    def _build_prompt(self, text: str, prompt_params: dict | None) -> str:
        defaults = {
            "tone": "technical",
            "length": "standard",
            "extraction_goals": "key findings, methodology, contributions",
        }
        params = {**defaults, **{k: v for k, v in (prompt_params or {}).items() if v}}
        params.setdefault("abstract", text)
        params.setdefault("word_count_band", length_band(params.get("length", "")))
        return SUMMARIZE_ABSTRACT.format(**params)

    # ------------------------------------------------------------------
    # Summarize many, in one call
    # ------------------------------------------------------------------

    def summarize_many(
        self, texts: list[str], prompt_params: dict | None = None,
    ) -> list[Optional[str]]:
        """Summarize *texts* in one CLI call. ``None`` where a document failed.

        The contract that makes this composable with the chain:

        * **Lane-fatal failures raise.** Authentication, quota, a missing
          binary — anything that will fail identically for the next document —
          comes out as an ``AIError`` and demotes the lane. None of the
          documents is retried on this lane, because there is nothing here to
          retry against.
        * **Everything else returns ``None`` in that document's slot.** The
          caller retries those documents individually, once. One malformed
          answer costs a batch, not the run.

        A timeout is the one failure worth answering with a smaller batch
        rather than with N individual calls: the batch is halved and each half
        re-sent, recursively. N spawns is therefore the ceiling and not the
        default.
        """
        texts = list(texts)
        if not texts:
            return []
        return self._batched(texts, prompt_params)

    def _batched(
        self, texts: list[str], prompt_params: dict | None,
    ) -> list[Optional[str]]:
        try:
            return self._one_batch_call(texts, prompt_params)
        except _CLITimeout:
            if len(texts) == 1:
                logger.warning(
                    "%s did not answer within the batch timeout for a single "
                    "document; giving up on it.", self.provider,
                )
                return [None]
            mid = len(texts) // 2
            self.batch_splits += 1
            logger.info(
                "%s batch of %d timed out; halving to %d + %d rather than "
                "falling straight to one call per document.",
                self.provider, len(texts), mid, len(texts) - mid,
            )
            return (
                self._batched(texts[:mid], prompt_params)
                + self._batched(texts[mid:], prompt_params)
            )

    def _one_batch_call(
        self, texts: list[str], prompt_params: dict | None,
    ) -> list[Optional[str]]:
        prompt = self._build_batch_prompt(texts, prompt_params)
        timeout = self.batch_timeout(len(texts))
        self.batch_calls += 1
        # How many documents this call carries, so the telemetry row can be
        # divided by it. Set here rather than threaded through every extractor
        # because the extractors already take enough arguments.
        self._batch_documents = len(texts)

        with tempfile.TemporaryDirectory(prefix="resmon-ai-") as workdir:
            try:
                if self.provider == "codex":
                    payload = self._run_codex_batch(prompt, workdir, timeout)
                else:
                    payload = self._run_claude_code_batch(prompt, workdir, timeout)
            except AIError as exc:
                # Lane-fatal goes straight up: the next document will fail the
                # same way, so retrying any of them here would only spend the
                # window rediscovering it.
                if exc.lane_fatal:
                    raise
                logger.warning(
                    "%s batch of %d failed document-locally (%s); the "
                    "documents will be retried individually.",
                    self.provider, len(texts), exc.kind.value,
                )
                self.batch_fallbacks += 1
                return [None] * len(texts)

        mapped = self._map_batch(payload, len(texts))
        if any(m is None for m in mapped):
            self.batch_fallbacks += 1
        return mapped

    def batch_timeout(self, count: int) -> int:
        """Seconds to allow one batched call of *count* documents."""
        return int(
            DEFAULT_BATCH_BASE_SECONDS
            + DEFAULT_BATCH_PER_DOCUMENT_SECONDS * max(1, count)
        )

    def _build_batch_prompt(
        self, texts: list[str], prompt_params: dict | None,
    ) -> str:
        defaults = {
            "tone": "technical",
            "length": "standard",
            "extraction_goals": "key findings, methodology, contributions",
        }
        params = {**defaults, **{k: v for k, v in (prompt_params or {}).items() if v}}
        return SUMMARIZE_ABSTRACTS_BATCH.format(
            count=len(texts),
            tone=params["tone"],
            length=params["length"],
            word_count_band=length_band(str(params.get("length", ""))),
            extraction_goals=params["extraction_goals"],
            documents=render_batch_documents(texts),
        )

    def _map_batch(self, payload, count: int) -> list[Optional[str]]:
        """Turn the CLI's validated object into one slot per document.

        Three rules, and the second is the one that matters:

        * A **missing** entry is fine. That document is retried individually.
        * A **duplicate or out-of-range index** discards the whole batch. If
          the model emitted index 3 twice, one of those summaries belongs to a
          different paper and there is no way to tell which — and storing a
          summary against the wrong paper is a quieter, worse failure than
          storing none. Every document in the batch is retried individually.
        * An **empty summary** is a missing one.
        """
        out: list[Optional[str]] = [None] * count
        items = payload.get("summaries") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            logger.warning(
                "%s returned no 'summaries' array; retrying the batch "
                "individually.", self.provider,
            )
            return out

        seen: set = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            index = item.get("index")
            summary = item.get("summary")
            # ``bool`` is an ``int`` in Python and True would read as index 1.
            if not isinstance(index, int) or isinstance(index, bool):
                logger.warning(
                    "%s returned a non-integer index; discarding the batch.",
                    self.provider,
                )
                return [None] * count
            if not 0 <= index < count:
                logger.warning(
                    "%s returned index %r for a batch of %d; the mapping "
                    "cannot be trusted, so the whole batch is retried "
                    "individually.", self.provider, index, count,
                )
                return [None] * count
            if index in seen:
                logger.warning(
                    "%s returned index %d twice; one of those summaries "
                    "belongs to another paper, so the whole batch is retried "
                    "individually.", self.provider, index,
                )
                return [None] * count
            seen.add(index)
            if isinstance(summary, str) and summary.strip():
                out[index] = summary.strip()

        missing = [i for i, value in enumerate(out) if value is None]
        if missing:
            logger.info(
                "%s returned %d of %d summaries; %d will be retried "
                "individually.",
                self.provider, count - len(missing), count, len(missing),
            )
        return out

    # ------------------------------------------------------------------
    # Cancellation
    # ------------------------------------------------------------------

    def cancel(self) -> None:
        """Terminate any call in flight and refuse to start another.

        A batched call is one process holding N documents, so cancellation
        that only takes effect between calls would leave a user waiting out a
        whole batch after pressing cancel. Idempotent, and safe to call from a
        thread other than the one running the CLI.
        """
        with self._lock:
            self._cancelled = True
            active = list(self._active)
        for process in active:
            try:
                process.terminate()
            except Exception:  # pragma: no cover - process already gone
                logger.debug("Could not terminate %s", process, exc_info=True)

    # ------------------------------------------------------------------
    # Per-provider invocation
    # ------------------------------------------------------------------

    def _run_claude_code(self, prompt: str, workdir: str) -> str:
        """``claude -p --output-format json``.

        ``--tools ""`` disables every built-in tool, ``--strict-mcp-config``
        keeps the user's MCP servers out of a summarization call, and
        ``--disable-slash-commands`` stops an abstract's text being read as a
        command. ``--append-system-prompt`` carries the summarization
        constitution, which the user prompt tells the model to follow. ``--bare`` is deliberately *not* used: it makes the CLI read
        ``ANTHROPIC_API_KEY`` only and never touch OAuth or the keychain, which
        would defeat the entire purpose of a subscription lane.
        """
        completed = self._execute(self._claude_argv(prompt), workdir, self.timeout)
        return self._extract_claude_code(completed)

    def _claude_argv(self, prompt: str, schema: Optional[dict] = None) -> list[str]:
        """The argv both the single and batched claude calls are built from.

        One function so a flag cannot be present on one path and absent on the
        other. That is exactly how ``--append-system-prompt`` came to be
        missing from two lanes.
        """
        argv = [
            self.binary_path,
            "-p",
            "--output-format", "json",
            "--tools", "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--append-system-prompt", str(SYSTEM_PREAMBLE),
        ]
        if schema is not None:
            # Inline JSON, not a path: `--json-schema <schema>` takes the
            # document itself (verified against claude 2.1.258, whose --help
            # gives an inline object as its example).
            argv += ["--json-schema", json.dumps(schema)]
        if self.model:
            argv += ["--model", self.model]
        if self.effort:
            argv += ["--effort", self.effort]
        argv.append(prompt)
        return argv

    def _run_claude_code_batch(self, prompt: str, workdir: str, timeout: int) -> dict:
        """One ``claude`` call for N documents, returning the validated object.

        With ``--json-schema`` the CLI puts the validated object in the result
        envelope's ``structured_output`` field as well as serialising it into
        ``result``. ``structured_output`` is what is read: it is already
        parsed, and a ``result`` string is what an unvalidated answer also
        looks like.
        """
        completed = self._execute(
            self._claude_argv(prompt, BATCH_SUMMARY_SCHEMA), workdir, timeout,
        )
        raw = (completed.stdout or "").strip()
        if not raw:
            self._raise_for_output(completed, "")

        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            self._raise_for_output(completed, raw)

        if not isinstance(payload, dict):
            self._raise_for_output(completed, raw)

        self._record_claude_telemetry(payload, self._batch_documents)

        # is_error first, before any shape check. An authentication failure
        # arrives with is_error true and subtype still "success", so a count
        # check that ran first would report a lane-fatal auth problem as a
        # document-local malformed answer and keep re-presenting a dead
        # session once per document.
        if payload.get("is_error"):
            result = payload.get("result")
            self._raise_for_output(
                completed, result if isinstance(result, str) else raw,
            )

        if payload.get("subtype") == "error_max_structured_output_retries":
            # The CLI could not get the model to satisfy the schema. Document-
            # local: the same documents may well succeed one at a time.
            raise self._error(
                AIErrorKind.UNKNOWN,
                f"The {self.provider} CLI could not produce output matching "
                f"the summary schema for this batch.",
            )

        structured = payload.get("structured_output")
        if not isinstance(structured, dict):
            # A `success` with no structured_output is a failure, not an
            # answer -- documented as such by the Agent SDK, and the reason
            # this does not fall back to parsing `result` by hand.
            raise self._error(
                AIErrorKind.UNKNOWN,
                f"The {self.provider} CLI reported success but returned no "
                f"validated output for this batch.",
            )
        return structured

    def _run_codex(self, prompt: str, workdir: str) -> str:
        """``codex exec -o FILE``.

        ``-o`` writes the agent's final message to a file, which sidesteps the
        banner, the session header and the token accounting that ``codex exec``
        prints to stdout. ``-s read-only`` pins the sandbox regardless of what
        the user's own ``~/.codex/config.toml`` sets — a summarization call has
        no business writing anything. ``--skip-git-repo-check`` is required
        because the temporary working directory is deliberately not a
        repository.

        codex has no ``--append-system-prompt``, so the constitution goes into
        an ``AGENTS.md`` that resmon writes into that working directory — the
        channel codex itself uses for standing instructions. Verified against
        codex-cli reading it from a non-repository directory under
        ``-s read-only``. The file is resmon's own; the user's ``AGENTS.md`` is
        still nowhere near this call, because the directory is a fresh
        temporary one.
        """
        with open(os.path.join(workdir, "AGENTS.md"), "w", encoding="utf-8") as handle:
            handle.write(str(SYSTEM_PREAMBLE))

        out_path = os.path.join(workdir, "resmon-summary.txt")
        completed = self._execute(
            self._codex_argv(prompt, workdir, out_path), workdir, self.timeout,
        )
        return self._extract_codex(completed, out_path)

    def _codex_argv(
        self,
        prompt: str,
        workdir: str,
        out_path: str,
        schema_path: Optional[str] = None,
    ) -> list[str]:
        """The argv both the single and batched codex calls are built from."""
        argv = [
            self.binary_path,
            "exec",
            "--color", "never",
            "--skip-git-repo-check",
            "-s", "read-only",
            "-C", workdir,
            "-o", out_path,
        ]
        if schema_path is not None:
            # codex takes a *path*, where claude takes the document inline.
            # Verified against codex-cli 0.153.0-alpha.5:
            # `--output-schema <FILE>  Path to a JSON Schema file`.
            argv += ["--output-schema", schema_path]
        if self.model:
            argv += ["-m", self.model]
        if self.effort:
            argv += ["-c", f"model_reasoning_effort={self.effort}"]
        argv.append(prompt)
        return argv

    def _run_codex_batch(self, prompt: str, workdir: str, timeout: int) -> dict:
        """One ``codex`` call for N documents, returning the validated object.

        codex writes the final message to the ``-o`` file, and with
        ``--output-schema`` that message *is* the JSON object. There is no
        envelope to read it out of, which is why this parses the file rather
        than stdout.
        """
        with open(os.path.join(workdir, "AGENTS.md"), "w", encoding="utf-8") as handle:
            handle.write(str(SYSTEM_PREAMBLE))

        schema_path = os.path.join(workdir, "resmon-summary-schema.json")
        with open(schema_path, "w", encoding="utf-8") as handle:
            json.dump(BATCH_SUMMARY_SCHEMA, handle)

        out_path = os.path.join(workdir, "resmon-summaries.json")
        completed = self._execute(
            self._codex_argv(prompt, workdir, out_path, schema_path), workdir, timeout,
        )

        self._record_codex_telemetry(completed, self._batch_documents)

        try:
            with open(out_path, "r", encoding="utf-8") as handle:
                message = handle.read().strip()
        except OSError:
            message = ""

        if not message:
            # No final message means the run did not get as far as answering.
            # stdout carries the banner and any error text, so it is what gets
            # classified -- and it is never read as a summary.
            self._raise_for_output(completed, "")

        try:
            payload = json.loads(message)
        except (json.JSONDecodeError, TypeError):
            raise self._error(
                AIErrorKind.UNKNOWN,
                f"The {self.provider} CLI returned output that is not the "
                f"summary schema for this batch.",
            ) from None
        if not isinstance(payload, dict):
            raise self._error(
                AIErrorKind.UNKNOWN,
                f"The {self.provider} CLI returned output that is not the "
                f"summary schema for this batch.",
            )
        return payload

    # ------------------------------------------------------------------
    # Running the process
    # ------------------------------------------------------------------

    def _execute(
        self, argv: list[str], workdir: str, timeout: Optional[int] = None,
    ) -> subprocess.CompletedProcess:
        """Spawn the CLI and wait for it, registering it so it can be killed.

        ``Popen`` rather than ``subprocess.run`` for one reason: a batched call
        is a single process holding ten documents, and cancellation has to be
        able to reach into it. ``run`` gives no handle to terminate. The
        registration and the cancelled-flag check are both under the lock, so a
        ``cancel()`` arriving between the check and the spawn still finds the
        process in ``_active``.
        """
        timeout = self.timeout if timeout is None else timeout
        try:
            with self._lock:
                if self._cancelled:
                    raise self._error(
                        AIErrorKind.UNKNOWN,
                        f"The run was cancelled before the {self.provider} CLI "
                        f"was started.",
                    )
                process = subprocess.Popen(
                    argv,
                    cwd=workdir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    # Closed stdin. Both CLIs will otherwise sit waiting to read
                    # a prompt from it -- codex says so out loud ("Reading
                    # additional input from stdin...") -- and a sweep that
                    # blocks forever on a pipe is indistinguishable from one
                    # that has crashed.
                    stdin=subprocess.DEVNULL,
                )
                self._active.add(process)
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise
            finally:
                with self._lock:
                    self._active.discard(process)
            return subprocess.CompletedProcess(
                argv, process.returncode, stdout=stdout, stderr=stderr,
            )
        except FileNotFoundError:
            raise self._error(
                AIErrorKind.CLI_MISSING,
                f"The {self.provider} command was not found at {self.binary_path}. "
                f"Set its full path in Settings, or install it.",
            ) from None
        except PermissionError:
            raise self._error(
                AIErrorKind.CLI_MISSING,
                f"resmon is not allowed to run {self.binary_path}.",
            ) from None
        except subprocess.TimeoutExpired:
            # Raised as the private ``_CLITimeout`` so the batch path can tell
            # it apart from every other document-local failure: a timeout is
            # the one worth answering with a smaller batch. ``summarize``
            # converts it back into the AIError it has always been.
            #
            # Document-local on purpose. A timeout is not evidence the lane is
            # dead -- one unusually long paper can cause it -- and demoting a
            # working subscription lane over a single slow document would
            # silently downgrade every summary after it. The per-execution
            # document cap already bounds what repeated timeouts can cost.
            raise _CLITimeout(timeout) from None
        except OSError as exc:
            raise self._error(
                AIErrorKind.CLI_MISSING,
                f"The {self.provider} CLI could not be started: {exc}",
            ) from None

    # ------------------------------------------------------------------
    # Extraction
    # ------------------------------------------------------------------

    def _extract_claude_code(self, completed: subprocess.CompletedProcess) -> str:
        raw = (completed.stdout or "").strip()

        if not raw:
            self._raise_for_output(completed, "")

        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            # Asked for JSON and did not get it. Rather than hunting for a
            # summary in whatever did arrive, say what happened.
            self._raise_for_output(completed, raw)

        if not isinstance(payload, dict):
            self._raise_for_output(completed, raw)

        self._record_claude_telemetry(payload, 1)

        result = payload.get("result")

        # `is_error` is the field that matters, and it is not the obvious one:
        # an authentication failure comes back with is_error true while
        # `subtype` still reads "success". Keying on subtype would store the
        # error message as the paper's summary.
        if payload.get("is_error"):
            self._raise_for_output(
                completed, result if isinstance(result, str) else raw,
            )

        if isinstance(result, str) and result.strip():
            return result.strip()

        self._raise_for_output(completed, raw)

    def _extract_codex(
        self, completed: subprocess.CompletedProcess, out_path: str,
    ) -> str:
        self._record_codex_telemetry(completed, 1)
        try:
            with open(out_path, "r", encoding="utf-8") as handle:
                message = handle.read().strip()
        except OSError:
            message = ""

        if message:
            return message

        # No final message file means the run did not get as far as answering.
        # stdout carries the banner and any error text, so it is what gets
        # classified -- but it is never returned as a summary.
        self._raise_for_output(completed, "")

    # ------------------------------------------------------------------
    # What the call cost
    # ------------------------------------------------------------------

    def _record_claude_telemetry(self, payload: dict, documents: int) -> None:
        """Keep the usage fields ``claude`` reports in its result envelope.

        Recorded whatever the outcome: a failed call still spends the window,
        and a measurement that counted only successes would understate what
        batching costs when it falls back.
        """
        usage = payload.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        self.telemetry.append({
            "provider": self.provider,
            "documents": documents,
            "duration_ms": payload.get("duration_ms"),
            "duration_api_ms": payload.get("duration_api_ms"),
            "total_cost_usd": payload.get("total_cost_usd"),
            "num_turns": payload.get("num_turns"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        })

    def _record_codex_telemetry(
        self, completed: subprocess.CompletedProcess, documents: int,
    ) -> None:
        """Keep what ``codex`` reports, which is less.

        There is no result envelope on the ``-o`` path -- the file holds the
        answer and nothing else -- so the only figure available is the token
        total codex prints to stdout. No cost, no cache breakdown, no
        per-turn detail. Recorded as ``None`` rather than omitted, so a table
        can say *this CLI does not report it* instead of leaving a blank that
        reads as zero.
        """
        tokens = None
        for line in (completed.stdout or "").splitlines():
            stripped = line.strip().replace(",", "")
            if stripped.isdigit():
                tokens = int(stripped)
        self.telemetry.append({
            "provider": self.provider,
            "documents": documents,
            "duration_ms": None,
            "duration_api_ms": None,
            "total_cost_usd": None,
            "num_turns": None,
            "input_tokens": None,
            "output_tokens": None,
            "cache_creation_input_tokens": None,
            "cache_read_input_tokens": None,
            "tokens_used": tokens,
        })

    # ------------------------------------------------------------------
    # Failure classification
    # ------------------------------------------------------------------

    def _raise_for_output(
        self, completed: subprocess.CompletedProcess, message: str,
    ) -> None:
        """Classify a failed run and raise. Never returns."""
        stderr = (completed.stderr or "").strip()
        haystack = " ".join(p for p in (message, stderr) if p).lower()

        if any(marker in haystack for marker in _AUTH_MARKERS):
            raise self._error(
                AIErrorKind.CLI_AUTH,
                self._first_line(message or stderr)
                or f"The {self.provider} CLI is not logged in.",
            )

        if any(marker in haystack for marker in _QUOTA_MARKERS):
            raise self._error(
                AIErrorKind.QUOTA,
                self._first_line(message or stderr)
                or f"The {self.provider} plan's usage limit has been reached.",
            )

        detail = self._first_line(message or stderr)
        suffix = f" It said: {detail}" if detail else ""
        raise self._error(
            AIErrorKind.UNKNOWN,
            f"The {self.provider} CLI returned something resmon could not use "
            f"(exit code {completed.returncode}).{suffix}",
        )

    @staticmethod
    def _first_line(text: str, limit: int = 300) -> str:
        """The first non-empty line of *text*, truncated.

        Enough to be actionable without pasting an entire agent transcript into
        a run report. ``AIError`` sanitises whatever comes back regardless.
        """
        for line in (text or "").splitlines():
            line = line.strip()
            if line:
                return line[:limit]
        return ""

    def _error(self, kind: AIErrorKind, message: str) -> AIError:
        return AIError(
            kind=kind,
            message=message,
            lane_label=self.lane_label,
            provider=self.provider,
            model=self.model or "",
        )
