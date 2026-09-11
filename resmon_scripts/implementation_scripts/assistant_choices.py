"""Versioned assistant requests, never an account/model compatibility catalog.

Only configured route locators enter the private comparison digest. Credentials,
corpus contents and runtime reports do not establish that route's identity.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata
from datetime import datetime, timezone
from typing import Optional

from .ai_models import CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_ALIASES
from .assistant_tool_calling import PROVIDER_TOOL_CALLING

REQUEST_FIELDS = ('version', 'runtime', 'provider', 'requested_model',
                  'requested_effort', 'model_basis', 'effort_basis', 'binding_basis')
REPORT_SOURCES = ('claude_system_init_model', 'api_response_model',
                  'google_response_modelVersion')
LIMITS = (
    'Local prerequisites are not authentication or account/model compatibility. '
    'Claude suggestions are aliases; the CLI checks model/effort acceptance at use time. '
    'An omitted CLI flag leaves its native default unknown. '
    'A saved connection does not pin an account, executable build or alias resolution.'
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {'version', 'runtime', 'provider', 'model', 'effort'}:
        raise ValueError('Supply the complete versioned connection, model and effort choice.')
    if type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Unsupported choices version.')
    runtime, provider, model, effort = (value[k] for k in ('runtime', 'provider', 'model', 'effort'))
    if runtime not in ('claude_cli', 'api_key') or not isinstance(provider, str):
        raise ValueError('Unknown assistant connection.')
    if runtime == 'claude_cli':
        if provider != 'claude_code':
            raise ValueError('The Claude CLI connection requires claude_code.')
    elif provider not in PROVIDER_TOOL_CALLING or not PROVIDER_TOOL_CALLING[provider].offered:
        raise ValueError('This API provider has no assistant adapter.')
    if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 512
                              or any(unicodedata.category(c).startswith('C') for c in model)):
        raise ValueError('Model must be a nonempty ID of at most 512 characters without controls.')
    if runtime == 'api_key' and model is None:
        raise ValueError('An API connection needs an explicit model ID.')
    if effort is not None and (not isinstance(effort, str) or effort not in CLAUDE_EFFORT_LEVELS):
        raise ValueError('Unsupported requested effort.')
    if runtime == 'api_key' and effort is not None:
        raise ValueError('Effort is not supported by this API adapter.')
    return dict(value)


def defaults(settings: dict) -> dict:
    from .assistant_runtime import assistant_provider

    runtime = settings.get('assistant_runtime') or 'claude_cli'
    return validate({'version': 1, 'runtime': runtime,
                     'provider': 'claude_code' if runtime == 'claude_cli' else assistant_provider(settings),
                     'model': settings.get('assistant_model') or None,
                     'effort': (settings.get('assistant_effort') or None) if runtime == 'claude_cli' else None})


def route_digest(settings: dict, runtime: str, provider: str) -> str:
    if runtime == 'claude_cli':
        locator = ['configured_cli', settings.get('ai_cli_path') or '', 'auto' if not settings.get('ai_cli_path') else 'explicit']
    elif provider == 'custom':
        locator = ['custom_endpoint', settings.get('ai_custom_base_url') or '']
    else:
        locator = ['built_in_provider', provider]
    raw = json.dumps(['resmon-assistant-route-v1', runtime, provider, locator], ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def resolve(settings: dict, value: Optional[dict] = None, *, legacy: bool = False) -> dict:
    choice = defaults(settings) if value is None else validate(value)
    return {'version': 1, 'runtime': choice['runtime'], 'provider': choice['provider'],
            'requested_model': choice['model'], 'requested_effort': choice['effort'],
            'model_basis': ('settings_default' if value is None else 'explicit') if choice['model'] is not None else 'runtime_default',
            'effort_basis': ('not_supported' if choice['runtime'] == 'api_key' else
                             ('settings_default' if value is None else 'explicit') if choice['effort'] is not None else 'runtime_default'),
            'binding_basis': 'legacy_confirmed' if legacy else 'new',
            'route_digest': route_digest(settings, choice['runtime'], choice['provider']),
            'created_at_utc': now()}


def request_projection(binding: dict) -> dict:
    # Explicit allowlist; never forward the row, even if a future column appears.
    validate({'version': binding['version'], 'runtime': binding['runtime'], 'provider': binding['provider'],
              'model': binding['requested_model'], 'effort': binding['requested_effort']})
    if binding['model_basis'] not in ('explicit', 'settings_default', 'runtime_default') or binding['effort_basis'] not in ('explicit', 'settings_default', 'runtime_default', 'not_supported') or binding['binding_basis'] not in ('new', 'legacy_confirmed'):
        raise ValueError('Unreadable choice provenance.')
    return {k: binding[k] for k in REQUEST_FIELDS}


def public_binding(binding: Optional[dict]) -> Optional[dict]:
    if binding is None:
        return None
    try:
        return {**request_projection(binding), 'created_at_utc': binding['created_at_utc']}
    except (KeyError, ValueError, TypeError):
        return {'unreadable': True}


def report(model: object, source: str) -> Optional[dict]:
    if source not in REPORT_SOURCES or not isinstance(model, str) or not model.strip():
        return None
    return {'model': model, 'source': source, 'observed_at_utc': now()}


def descriptor(settings: dict, *, backend_port: Optional[int] = None) -> dict:
    from .assistant_runtime import ClaudeCliRuntime
    from .assistant_api_runtime import ApiKeyRuntime

    try:
        default, default_error = defaults(settings), None
    except ValueError as exc:
        default, default_error = None, str(exc)
    cli = ClaudeCliRuntime(cli_path=settings.get('ai_cli_path')).status()
    connections = [{'runtime': 'claude_cli', 'provider': 'claude_code', 'label': 'Claude Code',
                    'implemented': True, 'available': cli.available,
                    'reason': 'CLI executable found; sign-in and model acceptance are unverified.' if cli.available else 'Claude CLI executable not found. Configure it in Settings → AI.',
                    'effort_supported': True}]
    for provider, capability in PROVIDER_TOOL_CALLING.items():
        if capability.offered:
            # The placeholder checks connection prerequisites, not a model list.
            runtime = ApiKeyRuntime(provider=provider, model='model-id-required', backend_port=backend_port,
                                    custom_base_url=settings.get('ai_custom_base_url'))
            state = runtime.status()
            connections.append({'runtime': 'api_key', 'provider': provider, 'label': provider,
                                'implemented': True, 'available': state.available,
                                'reason': 'Key configured; authentication and model acceptance are unverified.' if state.available else state.reason,
                                'effort_supported': False, 'family': capability.family})
        elif capability.assistant == 'no':
            connections.append({'runtime': None, 'provider': provider, 'label': 'Ollama' if provider == 'local' else 'Codex',
                                'implemented': False, 'available': False,
                                'reason': capability.assistant_reason, 'effort_supported': False})
    return {'version': 1, 'default_request': default, 'default_error': default_error,
            'connections': connections, 'claude_aliases': list(CLAUDE_MODEL_ALIASES),
            'claude_efforts': list(CLAUDE_EFFORT_LEVELS), 'limitations': LIMITS}
