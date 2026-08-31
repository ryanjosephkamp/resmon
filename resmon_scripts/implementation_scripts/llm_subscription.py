# resmon_scripts/implementation_scripts/llm_subscription.py
"""Driving an installed agent CLI as a summarisation lane.

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
or the sandbox pinned read-only (``-s read-only``), and with the user's project
configuration left out of it. A summariser needs no tools; taking them away
costs nothing and closes the hole.

**It is slow and it spends a window the user also works in.** That is a product
fact, not an implementation detail: the lane carries a per-execution document cap
(see ``ai_lanes.DEFAULT_SUBSCRIPTION_DOC_CAP``), the interface says what a run
will consume before it runs, and it is not the default for bulk summarisation.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from typing import Optional

from .ai_errors import AIError, AIErrorKind
from .prompt_templates import SUMMARIZE_ABSTRACT, length_band

logger = logging.getLogger(__name__)

__all__ = ["SubscriptionLLMClient", "DEFAULT_CLI_TIMEOUT_SECONDS"]

# Agent CLIs are far slower per call than a direct API request: there is a
# process to start, a session to establish and an agent loop to run. Five
# minutes is generous for one abstract and still bounded, so a wedged CLI
# cannot hold a sweep open indefinitely.
DEFAULT_CLI_TIMEOUT_SECONDS = 300

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
    """Summarise through an installed agent CLI.

    Exposes ``summarize(text, prompt_params) -> str`` plus ``model`` and
    ``provider``, which is the whole contract ``SummarizationPipeline`` needs —
    so a subscription lane drops into a chain exactly where an API-key or local
    lane would.
    """

    def __init__(
        self,
        provider: str,
        binary_path: str,
        model: Optional[str] = None,
        timeout: int = DEFAULT_CLI_TIMEOUT_SECONDS,
        lane_label: str = "",
    ) -> None:
        self.provider = provider
        self.binary_path = binary_path
        self.model = model
        self.timeout = timeout
        self.lane_label = lane_label or provider
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

        # A fresh empty directory per call. The agent gets no repository, no
        # CLAUDE.md, no AGENTS.md and nothing to read even if the abstract asks
        # it to go looking.
        with tempfile.TemporaryDirectory(prefix="resmon-ai-") as workdir:
            if self.provider == "codex":
                return self._run_codex(prompt, workdir)
            return self._run_claude_code(prompt, workdir)

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
    # Per-provider invocation
    # ------------------------------------------------------------------

    def _run_claude_code(self, prompt: str, workdir: str) -> str:
        """``claude -p --output-format json``.

        ``--tools ""`` disables every built-in tool, ``--strict-mcp-config``
        keeps the user's MCP servers out of a summarisation call, and
        ``--disable-slash-commands`` stops an abstract's text being read as a
        command. ``--bare`` is deliberately *not* used: it makes the CLI read
        ``ANTHROPIC_API_KEY`` only and never touch OAuth or the keychain, which
        would defeat the entire purpose of a subscription lane.
        """
        argv = [
            self.binary_path,
            "-p",
            "--output-format", "json",
            "--tools", "",
            "--strict-mcp-config",
            "--disable-slash-commands",
        ]
        if self.model:
            argv += ["--model", self.model]
        argv.append(prompt)

        completed = self._execute(argv, workdir)
        return self._extract_claude_code(completed)

    def _run_codex(self, prompt: str, workdir: str) -> str:
        """``codex exec -o FILE``.

        ``-o`` writes the agent's final message to a file, which sidesteps the
        banner, the session header and the token accounting that ``codex exec``
        prints to stdout. ``-s read-only`` pins the sandbox regardless of what
        the user's own ``~/.codex/config.toml`` sets — a summarisation call has
        no business writing anything. ``--skip-git-repo-check`` is required
        because the temporary working directory is deliberately not a
        repository.
        """
        out_path = os.path.join(workdir, "resmon-summary.txt")
        argv = [
            self.binary_path,
            "exec",
            "--color", "never",
            "--skip-git-repo-check",
            "-s", "read-only",
            "-C", workdir,
            "-o", out_path,
        ]
        if self.model:
            argv += ["-m", self.model]
        argv.append(prompt)

        completed = self._execute(argv, workdir)
        return self._extract_codex(completed, out_path)

    # ------------------------------------------------------------------
    # Running the process
    # ------------------------------------------------------------------

    def _execute(self, argv: list[str], workdir: str) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                argv,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                # Closed stdin. Both CLIs will otherwise sit waiting to read a
                # prompt from it -- codex says so out loud ("Reading additional
                # input from stdin...") -- and a sweep that blocks forever on a
                # pipe is indistinguishable from one that has crashed.
                stdin=subprocess.DEVNULL,
                check=False,
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
            # Document-local on purpose. A timeout is not evidence the lane is
            # dead -- one unusually long paper can cause it -- and demoting a
            # working subscription lane over a single slow document would
            # silently downgrade every summary after it. The per-execution
            # document cap already bounds what repeated timeouts can cost.
            raise self._error(
                AIErrorKind.UNKNOWN,
                f"The {self.provider} CLI did not answer within "
                f"{self.timeout} seconds for this document.",
            ) from None
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
