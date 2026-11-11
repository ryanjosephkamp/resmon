"""Run-local map membership, joining only copies with the same recorded DOI."""
from __future__ import annotations

from .source_coverage import parameters


def membership(rows: list[dict], raw_parameters: object) -> dict:
    """Keep every stored id, and group exact DOI copies for one map mark.

    Similar titles alone do not establish that two source records are the
    same paper. They stay separate. No rows in the corpus are merged.
    """
    groups: dict[str, dict] = {}
    seen_sources: list[str] = []
    for row in rows:
        slug = row['source_repository']
        if slug not in seen_sources:
            seen_sources.append(slug)
        doi = str(row.get('doi') or '').strip().lower()
        for prefix in ('https://doi.org/', 'http://doi.org/', 'doi:'):
            if doi.startswith(prefix):
                doi = doi[len(prefix):].strip()
        key = f'doi:{doi}' if doi.startswith('10.') and '/' in doi else f'id:{row["id"]}'
        group = groups.setdefault(key, {'id': int(row['id']), 'copies': [], 'sources': []})
        group['copies'].append(int(row['id']))
        if slug not in group['sources']:
            group['sources'].append(slug)
    params = parameters(raw_parameters)
    selected = params.get('repositories')
    order = list(dict.fromkeys(selected)) if isinstance(selected, list) and all(isinstance(s, str) for s in selected) else []
    order.extend(s for s in seen_sources if s not in order)
    return {'ids': [int(row['id']) for row in rows], 'papers': list(groups.values()), 'sources': order}
