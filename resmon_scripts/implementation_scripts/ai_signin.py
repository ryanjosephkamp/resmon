# resmon_scripts/implementation_scripts/ai_signin.py
"""Checking, and starting, an agent CLI's own sign-in.

resmon never holds a provider credential for Claude Code or Codex: the
command the person installed keeps its own login, and resmon runs it. So
resmon cannot sign anyone in, and does not try. What it can do is the two
things a person would otherwise do in a terminal:

**Check.** ``claude auth status --json`` and ``codex login status`` answer
from the command's own stored login, with no model call and no cost. They run
here in the environment the lanes run in (``assistant_runtime._child_env``),
so the answer is about the login a lane would actually find. The output is
read for what is safe to show (signed in or not, the account's email and plan
when the command gives them) and nothing else is kept: no cache, no log of the
output, no file.

The shape of ``claude auth status --json`` is not documented anywhere resmon
can rely on, so it is read defensively: only fields that are present, under
the names such a field plausibly has, and the command's own words when none
of them is. "Signed in" is said only when the command said so.

**Start the command's own login.** The browser sign-in happens between the
person and the provider, in a terminal the command runs in. On macOS resmon
writes a small ``.command`` script into its state directory and hands it to
``open``: Terminal runs ``.command`` files, so this needs no Automation
permission. On Windows and Linux the exact command is returned to be copied.
Linux has no terminal every desktop ships, and on Windows a command line built
for ``cmd`` around a path with spaces is easy to get subtly wrong and has not
been run on Windows here, so neither is guessed at.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .ai_errors import sanitize

logger = logging.getLogger(__name__)

__all__ = [
    "PROVIDERS",
    "check_sign_in",
    "login_argv",
    "open_sign_in",
    "parse_status",
    "sign_in_script",
    "status_argv",
]

PROVIDERS = ("claude_code", "codex")

_NAMES = {"claude_code": "Claude Code", "codex": "Codex"}

# The status command answers from a file or the keychain. Ten seconds is far
# past what it takes, and short enough that Settings is not left waiting on a
# command that has hung.
STATUS_TIMEOUT_SECONDS = 10

# How much of the command's own words is shown when they are not a state
# resmon recognizes.
_SAID_LIMIT = 300


def status_argv(provider: str, binary: str) -> list[str]:
    """The command that reports the sign-in, with no model call."""
    if provider == "codex":
        return [binary, "login", "status"]
    return [binary, "auth", "status", "--json"]


def login_argv(provider: str, binary: str) -> list[str]:
    """The command's own login. Claude Code's default is the subscription (``--claudeai``)."""
    if provider == "codex":
        return [binary, "login"]
    return [binary, "auth", "login"]


def shown_command(argv: list[str], platform: Optional[str] = None) -> str:
    """*argv* as it would be typed in this platform's shell."""
    if (platform or sys.platform) == "win32":
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


# ---------------------------------------------------------------------------
# Reading what the status command said
# ---------------------------------------------------------------------------

# Field names that may hold each fact, most likely first. A field absent from
# the output is simply not there; nothing is inferred from its absence.
_SIGNED_IN_FIELDS = ("loggedIn", "logged_in", "isLoggedIn", "signedIn", "signed_in",
                     "authenticated", "isAuthenticated")
_EMAIL_FIELDS = ("email", "emailAddress", "email_address", "accountEmail", "userEmail")
_PLAN_FIELDS = ("subscriptionType", "subscription_type", "subscription", "plan",
                "planType", "plan_type", "accountType")
_METHOD_FIELDS = ("authMethod", "auth_method", "method", "loginMethod")
_NESTED = ("account", "user", "auth", "oauthAccount", "organization")

_SIGNED_OUT_WORDS = ("not logged in", "not signed in", "logged out", "signed out",
                     "no credentials", "please log in", "please run /login",
                     "run `codex login`", "not authenticated", "unauthenticated")
_EXPIRED_WORDS = ("expired", "could not be refreshed", "failed to authenticate",
                  "re-authenticate", "log in again", "sign in again")
_SIGNED_IN_PREFIXES = ("logged in", "signed in")


def _field(data: dict, names: tuple[str, ...]) -> Any:
    """The first of *names* present in *data* or one level down, else ``None``."""
    for name in names:
        if name in data:
            return data[name]
    for nest in _NESTED:
        inner = data.get(nest)
        if isinstance(inner, dict):
            for name in names:
                if name in inner:
                    return inner[name]
    return None


def _text(value: Any, limit: int = 120) -> Optional[str]:
    """A short string field, sanitized, or ``None``."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())[:limit]
    return sanitize(cleaned) or None


def _said(text: str) -> Optional[str]:
    """The command's own words, first lines, trimmed and sanitized."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not lines:
        return None
    return sanitize(" ".join(lines)[:_SAID_LIMIT])


def _from_text(text: str) -> tuple[str, Optional[str]]:
    """``(state, method)`` from plain words, ``unknown`` when they are none of these."""
    lowered = text.lower()
    if any(word in lowered for word in _EXPIRED_WORDS):
        return "expired", None
    if any(word in lowered for word in _SIGNED_OUT_WORDS):
        return "signed_out", None
    for line in (l.strip() for l in text.splitlines()):
        low = line.lower()
        for prefix in _SIGNED_IN_PREFIXES:
            if low.startswith(prefix):
                # "Logged in using ChatGPT" -> "ChatGPT". The rest of a line
                # such as "Logged in using an API key - sk-...***" is dropped:
                # the method is what is worth showing, and a key, even a masked
                # one, is not.
                rest = line[len(prefix):].strip()
                for lead in ("using ", "with ", "via ", "as "):
                    if rest.lower().startswith(lead):
                        rest = rest[len(lead):]
                        break
                method = rest.split(" - ")[0].split(" (")[0].strip(" .:")
                return "signed_in", (_text(method, 60) if method and "@" not in method else None)
    return "unknown", None


def parse_status(provider: str, stdout: str, stderr: str, returncode: Optional[int]) -> dict:
    """What a status command said, as the fields resmon shows. Pure.

    ``state`` is ``signed_in``, ``signed_out``, ``expired`` or ``unknown``.
    ``unknown`` carries ``said``, the command's own words, because "resmon could
    not tell" is the honest answer and the person can read the rest.
    """
    out = stdout or ""
    err = stderr or ""
    result: dict = {"state": "unknown", "email": None, "plan": None, "method": None, "said": None}

    payload: Any = None
    stripped = out.strip()
    if stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except ValueError:
            payload = None

    if isinstance(payload, dict):
        flag = _field(payload, _SIGNED_IN_FIELDS)
        if isinstance(flag, bool):
            result["state"] = "signed_in" if flag else "signed_out"
        if result["state"] == "signed_in" or flag is None:
            result["email"] = _text(_field(payload, _EMAIL_FIELDS))
            result["plan"] = _text(_field(payload, _PLAN_FIELDS), 60)
            result["method"] = _text(_field(payload, _METHOD_FIELDS), 60)
        if result["state"] == "unknown":
            # A JSON answer with no yes-or-no in it. Its words may still say
            # signed out; nothing short of the command's own yes says signed in.
            state, _ = _from_text(err + "\n" + json.dumps(payload))
            if state in ("signed_out", "expired"):
                result["state"] = state
        if result["state"] == "signed_out":
            # Expired is the more useful thing to say, where the words say it.
            state, _ = _from_text(err + "\n" + stripped)
            if state == "expired":
                result["state"] = "expired"
        if result["state"] == "unknown":
            # The JSON itself is not repeated: it is the command's data, not a
            # sentence, and only the fields above are known to be safe to show.
            result["said"] = _said(err)
        return result

    state, method = _from_text(out + "\n" + err)
    if state == "signed_in" and returncode not in (0, None):
        # Words that say signed in from a command that failed are not trusted.
        state, method = "unknown", None
    result["state"] = state
    result["method"] = method
    if state == "unknown":
        result["said"] = _said(err) or _said(out)
    return result


def _sentence(provider: str, parsed: dict) -> str:
    """One sentence for the person, from the parsed state."""
    name = _NAMES.get(provider, provider)
    state = parsed["state"]
    if state == "signed_in":
        who = f" as {parsed['email']}" if parsed.get("email") else ""
        plan = f" ({parsed['plan']})" if parsed.get("plan") else ""
        method = f", with {parsed['method']}" if parsed.get("method") and not parsed.get("email") else ""
        return f"The {name} command is signed in{who}{plan}{method}."
    if state == "expired":
        return f"The {name} command’s sign-in has expired. Sign in again through it."
    if state == "signed_out":
        return f"The {name} command on this computer is not signed in."
    said = parsed.get("said")
    named = f" It named the account {parsed['email']}." if parsed.get("email") else ""
    return (f"The {name} command did not say whether it is signed in.{named} It said: {said}"
            if said else f"The {name} command did not say whether it is signed in.{named}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def check_sign_in(
    provider: str,
    binary: Optional[str],
    *,
    not_found: str = "",
    run: Callable[..., Any] = subprocess.run,
    env: Optional[dict] = None,
) -> dict:
    """Run the status command for *provider* at *binary* and say what it said.

    Never raises. ``binary`` is ``None`` when discovery found nothing, and
    ``not_found`` is the sentence discovery gave. The output is parsed and let
    go; only the returned fields leave this function, and nothing is logged
    but the state.
    """
    command = shown_command(status_argv(provider, binary or _default_name(provider)))

    def answer(state: str, message: str, parsed: Optional[dict] = None) -> dict:
        # In the order the response model declares, which is the order the
        # body is written in.
        parsed = parsed or {}
        return {"provider": provider, "state": state, "message": message,
                "email": parsed.get("email"), "plan": parsed.get("plan"),
                "method": parsed.get("method"), "said": parsed.get("said"),
                "command": command, "path": binary, "checked_at_utc": _now()}

    if provider not in PROVIDERS:
        return answer("failed", "resmon does not know that command.")
    if not binary:
        return answer("missing", not_found or f"resmon did not find the {_NAMES[provider]} command.")
    if env is None:
        from .assistant_runtime import _child_env  # noqa: PLC0415 - the lanes' own environment

        env = _child_env()
    try:
        completed = run(
            status_argv(provider, binary), capture_output=True, text=True,
            stdin=subprocess.DEVNULL, timeout=STATUS_TIMEOUT_SECONDS, env=env, check=False,
        )
    except subprocess.TimeoutExpired:
        logger.info("%s sign-in check timed out", provider)
        return answer("failed", (f"The {_NAMES[provider]} command did not answer within "
                                 f"{STATUS_TIMEOUT_SECONDS} seconds, so resmon could not tell whether "
                                 f"it is signed in."))
    except OSError as exc:
        logger.info("%s sign-in check could not start: %s", provider, type(exc).__name__)
        return answer("failed", f"resmon could not run the {_NAMES[provider]} command at {binary}.")
    parsed = parse_status(provider, completed.stdout or "", completed.stderr or "", completed.returncode)
    logger.info("%s sign-in check: %s", provider, parsed["state"])
    return answer(parsed["state"], _sentence(provider, parsed), parsed)


def _default_name(provider: str) -> str:
    return "codex" if provider == "codex" else "claude"


# ---------------------------------------------------------------------------
# Starting the command's own login
# ---------------------------------------------------------------------------

def sign_in_script(provider: str, binary: str) -> str:
    """The ``.command`` script Terminal runs: the login, then where to go next.

    The path is quoted for ``sh`` (``shlex.quote``), so a binary inside a
    folder with spaces in its name is one argument. The script removes itself
    first: an open file is still read to the end after it is unlinked, and the
    state directory is not left holding a script nobody will run again.
    """
    name = _NAMES[provider]
    command = shown_command(login_argv(provider, binary), "darwin")
    return (
        "#!/bin/sh\n"
        "# Written by resmon to start this command's own sign-in. resmon does not\n"
        "# see or keep the sign-in: the command keeps it.\n"
        'rm -f -- "$0"\n'
        "clear\n"
        f"echo 'Signing in to {name} with its own login. Your browser may open.'\n"
        "echo\n"
        f"{command}\n"
        "status=$?\n"
        "echo\n"
        'if [ "$status" -eq 0 ]; then\n'
        "  echo 'Done. Return to resmon and choose Check again.'\n"
        "else\n"
        "  echo \"The command stopped with exit code $status. Return to resmon and choose Check again.\"\n"
        "fi\n"
        "echo 'You can close this window.'\n"
    )


def open_sign_in(
    provider: str,
    binary: Optional[str],
    state_dir: Path,
    *,
    not_found: str = "",
    platform: Optional[str] = None,
    opener: Callable[..., Any] = subprocess.run,
) -> dict:
    """Open the command's own login in a terminal, or say the command to run.

    ``how`` is ``terminal`` when a Terminal window was asked for, ``copy`` when
    the person runs the command themselves. Never raises.
    """
    platform = platform or sys.platform
    name = _NAMES.get(provider, provider)
    def answer(opened: bool, how: str, message: str, command: str = "") -> dict:
        # In the order the response model declares.
        return {"provider": provider, "opened": opened, "how": how, "command": command,
                "path": binary, "message": message}

    if provider not in PROVIDERS:
        return answer(False, "none", "resmon does not know that command.")
    if not binary:
        return answer(False, "none", not_found or f"resmon did not find the {name} command.")
    command = shown_command(login_argv(provider, binary), platform)
    copy = (f"Run this in a terminal to sign in to {name} with its own login, "
            f"then choose Check again.")
    cannot_open = (f"resmon could not open Terminal. Run this in a terminal to sign in "
                   f"to {name}, then choose Check again.")
    if platform != "darwin":
        return answer(False, "copy", copy, command)
    folder = Path(state_dir) / "sign-in"
    script = folder / f"resmon-sign-in-{provider.replace('_', '-')}.command"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        script.write_text(sign_in_script(provider, binary), encoding="utf-8")
        os.chmod(script, 0o700)
        completed = opener(["open", str(script)], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.info("Could not open the %s sign-in: %s", provider, type(exc).__name__)
        return answer(False, "copy", cannot_open, command)
    if getattr(completed, "returncode", 0) not in (0, None):
        try:
            script.unlink()
        except OSError:
            pass
        return answer(False, "copy", cannot_open, command)
    return answer(True, "terminal",
                  (f"Terminal is running {name}’s own sign-in. Finish it there, in the "
                   f"browser it opens, then choose Check again."), command)
