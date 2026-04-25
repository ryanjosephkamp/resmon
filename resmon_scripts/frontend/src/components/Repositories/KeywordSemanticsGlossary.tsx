import React, { useState } from 'react';

/**
 * Consolidated glossary of the keyword-combination terms surfaced on the
 * Repositories & API Keys page and (in tooltip form) on the Deep Dive,
 * Deep Sweep, and Routines pages. Grounded in
 * `.ai/prep/keyword_booleans_overview.md`.
 *
 * Layout: grouped, card-grid format. Entries are organised into three
 * conceptual categories (boolean-combination semantics, ranking &
 * confidence labels, and underlying search platforms) so users can scan
 * by relationship instead of alphabetically. Each term is rendered as
 * a labelled card with a colour-coded badge and a short definition.
 */
type Category = 'combination' | 'ranking' | 'platform';

interface Entry {
  term: string;
  category: Category;
  short: string;
  definition: string;
}

const ENTRIES: Entry[] = [
  {
    term: 'Implicit AND',
    category: 'combination',
    short: 'All terms required',
    definition:
      'The upstream API parses space-separated terms as if they were joined by AND without the user typing the operator. Every term must appear in a matching record. Example: arXiv, PubMed.',
  },
  {
    term: 'Explicit AND',
    category: 'combination',
    short: 'User-typed AND',
    definition:
      'The user must literally type the word AND between terms for the API to require all of them. resmon does not insert AND on the user\u2019s behalf, so this only applies if you place AND inside a single keyword chip.',
  },
  {
    term: 'Implicit OR',
    category: 'combination',
    short: 'Any term eligible',
    definition:
      'The upstream API parses space-separated terms as if they were joined by OR without the user typing the operator. A record matching any one term is eligible. Example: Lucene/Solr defaults on most repositories.',
  },
  {
    term: 'Explicit OR',
    category: 'combination',
    short: 'Client-side OR',
    definition:
      'The combination is OR but is performed by resmon itself, not the upstream API. resmon\u2019s bioRxiv/medRxiv client filters returned records client-side and keeps a paper if any space-separated term appears in its title or abstract.',
  },
  {
    term: 'Relevance-ranked',
    category: 'ranking',
    short: 'Score-ordered, not strict',
    definition:
      'The upstream API does not enforce a strict boolean; it returns records ordered by a relevance score that rewards matches across more of the supplied terms. Records matching only one term can still appear, just lower in the list.',
  },
  {
    term: 'upstream-default, unverified',
    category: 'ranking',
    short: 'Confidence label',
    definition:
      'resmon forwards the keyword string verbatim to a search box whose exact combination semantics are not authoritatively documented. The repository likely returns relevance-ranked results, but the precise behavior should be confirmed against current upstream behavior before drawing strict conclusions.',
  },
  {
    term: 'Lucene',
    category: 'platform',
    short: 'Full-text search library',
    definition:
      'A widely used full-text search library underpinning many repository APIs. Its default operator is OR; explicit AND, OR, NOT, quoted phrases, and field qualifiers are supported when typed inside a single keyword chip.',
  },
  {
    term: 'Solr',
    category: 'platform',
    short: 'Lucene over HTTP',
    definition:
      'A search platform built on Lucene that exposes the same query syntax over HTTP. Repositories backed by Solr (e.g. HAL, NASA ADS, Springer Nature) inherit Lucene\u2019s OR-by-default semantics with relevance ranking.',
  },
];

const CATEGORY_META: Record<Category, { label: string; description: string; accent: string }> = {
  combination: {
    label: 'Boolean combination',
    description: 'How the upstream API joins your space-separated keywords.',
    accent: '#2563eb',
  },
  ranking: {
    label: 'Ranking & confidence',
    description: 'How matches are ordered and how sure resmon is about the semantics.',
    accent: '#7c3aed',
  },
  platform: {
    label: 'Underlying search platforms',
    description: 'Engines that several repositories share, which determines their default semantics.',
    accent: '#0d9488',
  },
};

const CATEGORY_ORDER: Category[] = ['combination', 'ranking', 'platform'];

const KeywordSemanticsGlossary: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ marginBottom: open ? 12 : 0 }}
      >
        {open ? 'Hide' : 'Show'} keyword-combination glossary
      </button>
      {open && (
        <div data-testid="keyword-glossary" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {CATEGORY_ORDER.map((cat) => {
            const meta = CATEGORY_META[cat];
            const items = ENTRIES.filter((e) => e.category === cat);
            return (
              <section
                key={cat}
                aria-label={meta.label}
                style={{ borderLeft: `3px solid ${meta.accent}`, paddingLeft: 12 }}
              >
                <h4 style={{ margin: '0 0 2px 0', fontSize: '0.95rem', color: meta.accent }}>
                  {meta.label}
                </h4>
                <div style={{ fontSize: '0.8rem', opacity: 0.75, marginBottom: 8 }}>
                  {meta.description}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 8,
                  }}
                >
                  {items.map((e) => (
                    <div
                      key={e.term}
                      style={{
                        border: '1px solid var(--border-color, #e5e7eb)',
                        borderRadius: 6,
                        padding: '8px 10px',
                        background: 'var(--surface-2, rgba(127,127,127,0.04))',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: meta.accent,
                            color: '#fff',
                            fontSize: '0.78rem',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {e.term}
                        </span>
                        <span style={{ fontSize: '0.78rem', opacity: 0.75, fontStyle: 'italic' }}>
                          {e.short}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.85rem', lineHeight: 1.45 }}>{e.definition}</div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default KeywordSemanticsGlossary;
