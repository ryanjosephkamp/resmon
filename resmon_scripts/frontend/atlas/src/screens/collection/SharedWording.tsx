import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { count, number, publishedWords, when } from '../today/format';
import { SearchTabs } from './SearchTabs';
import { saveFile } from '../runs/downloads';
import { pageCsv, pageMarkdown, pairCsv, pairMarkdown, wordingGroups } from './wordingExport';
import './sharedWording.css';
import { useCollection } from '../../collections/current';
import { joined, useRoving } from '../../charts/roving';
import { tipWords, useChartTip } from '../../charts/ChartTip';
import {
  WORDING_KEY, comparedWords, pairLine, pairParam, percentWords, progressWords, readPair, segments,
  type SharedWordingBrief, type SharedWordingOverview, type SharedWordingPair,
  matchesPairFilter, wordingChartRows, SHARE_BANDS, PAIR_KINDS,
} from './wordingModel';

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Search › Shared wording: abstracts in the collection that share passages
 * word for word, and the side-by-side view of a pair.
 *
 * The engine does the measuring (`shared_wording.py`) and says what each
 * number means; this screen states those definitions beside the numbers, says
 * what the scan compared and what it did not, lists the pairs in their groups
 * (the two set-aside groups with their reason), and draws a pair's shared
 * passages in both texts. It never says why two texts share wording.
 */
export function SharedWording() {
  // The scan reads every abstract resmon holds; with several collections, the words say so.
  const { several } = useCollection();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = readPair(params.get('pair'));
  const band = SHARE_BANDS.find(b => b.id === params.get('band'))?.id ?? null;
  const kind = PAIR_KINDS.find(k => k.id === params.get('kind'))?.id ?? null;
  const filtered = band !== null || kind !== null;
  const changeParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  };
  const now = useMemo(() => new Date(), []);

  const overview = useQuery({
    queryKey: WORDING_KEY,
    queryFn: () => answer(engine().GET('/api/shared-wording')),
    // While a scan runs, its progress is read once a second; it ends on its own.
    refetchInterval: (query) => (query.state.data?.job.running ? 1000 : false),
  });
  const scan = useMutation({
    mutationFn: () => answer(engine().POST('/api/shared-wording/scan')),
    onSettled: () => { void client.invalidateQueries({ queryKey: WORDING_KEY }); },
  });
  const stop = useMutation({
    mutationFn: () => answer(engine().POST('/api/shared-wording/scan/cancel')),
    onSettled: () => { void client.invalidateQueries({ queryKey: WORDING_KEY }); },
  });

  const data = overview.data;
  const groups = data ? wordingGroups(data)
    .map(group => ({ ...group, pairs: group.pairs.filter(p => matchesPairFilter(p, { band, kind })) }))
    .filter(group => !filtered || group.pairs.length > 0) : [];
  const running = data?.job.running === true;
  const openPair = (pair: SharedWordingBrief) => changeParam('pair', pairParam(pair.a, pair.b));

  return (
    <div className="page wording-page" aria-busy={overview.isPending || running}>
      <SearchTabs />
      <h1 className="page-title">Shared Wording</h1>
      <p className="page-lede">
        Abstracts {several ? 'in resmon, in every collection,' : 'in your collection'} that share passages word for word. resmon measures the passages and lists the
        pairs; it does not say why two texts share wording, and it uses no model to look.
      </p>

      <p><a className="record-link" href="https://ryanjosephkamp.github.io/resmon/guide/shared-wording/" target="_blank" rel="noreferrer">How Shared Wording Works</a></p>
      {data?.state === 'ready' && !open && <div className="lib-actions wording-exports" aria-label="Export Shared Wording">
        <button type="button" className="btn sm" onClick={() => saveFile(pageCsv({ ...data, groups }), 'resmon-shared-wording.csv', 'text/csv;charset=utf-8')}>Export Page CSV</button>
        <button type="button" className="btn sm" onClick={() => saveFile(pageMarkdown({ ...data, groups }), 'resmon-shared-wording.md', 'text/markdown;charset=utf-8')}>Export Page Markdown</button>
      </div>}
      {overview.isError && <p className="field-error" role="alert">The engine did not answer ({overview.error.message}).</p>}

      {/* An open pair is read first: its own numbers carry their definitions. */}
      {data && open && (
        <PairView a={open[0]} b={open[1]} phraseWords={data.settings.phrase_words} backLabel={filtered ? 'Back to Filtered Pairs' : 'All Pairs'}
          onClose={() => changeParam('pair', null)} />
      )}
      {!open && (
        <section className="wording-scan" aria-label="The Scan" data-wording="scan" data-state={data?.state ?? 'reading'}>
          <div className="wording-bar">
            {running ? (
              <>
                <p className="wording-progress" role="status" data-wording="progress">{progressWords(data.job)}</p>
                <button type="button" className="btn" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</button>
              </>
            ) : (
              <button type="button" className="btn primary" data-wording="scan-button" disabled={!data || scan.isPending}
                onClick={() => { scan.reset(); scan.mutate(); }}>
                {data?.state === 'ready' ? 'Scan Again' : 'Scan the Collection'}
              </button>
            )}
          </div>
          {scan.error && <p className="field-error" role="alert">{refusal(scan.error)}</p>}
          {data && !running && data.job.error && <p className="field-error" role="alert">{data.job.error}</p>}
          {data && !running && data.job.cancelled && (
            <p className="settings-said" role="status">The scan was stopped. The pairs below are from the scan before it.</p>
          )}
          {data && <ScanFacts data={data} now={now} />}
        </section>
      )}

      {data?.state === 'ready' && !open && (
        <>
        <div className="wording-charts">
          <WordingChart title="Pairs by How Much They Share" rows={wordingChartRows(data).bands} selected={band}
            onChoose={value => changeParam('band', value === band ? null : value)}
            note="Share is the fraction of the shorter abstract’s phrases also found in the other, as measured in the last scan." />
          <WordingChart title="Pairs by Kind" rows={wordingChartRows(data).kinds} selected={kind}
            onChoose={value => changeParam('kind', value === kind ? null : value)}
            note="Substantive Passages counts the listed pairs outside Standard Statements, including the same-work and notice groups set aside below. These kinds do not establish why wording is shared." />
        </div>
        {filtered && <div className="wording-filter">
          <p role="status" aria-label="Pair Filter">Showing listed pairs: {[SHARE_BANDS.find(b => b.id === band)?.label, PAIR_KINDS.find(k => k.id === kind)?.label].filter(Boolean).join(' · ')}.</p>
          <button type="button" className="btn sm" onClick={() => setParams({})}>Show All Pairs</button>
        </div>}
        {filtered && !data.groups.some(g => g.pairs.some(p => matchesPairFilter(p, { band, kind })))
          && <p className="index-empty">No listed pairs match this filter.</p>}
        <div className="wording-groups" data-wording="groups">
          {groups.map((group) => (
            <section key={group.category} className="wording-group" aria-labelledby={`wording-${group.category}`}
              data-category={group.category} data-count={group.count}>
              <h2 id={`wording-${group.category}`} className="group-title">
                {group.label} <span className="seg-n">{number(filtered ? group.pairs.length : group.count)}</span>
              </h2>
              <p className="record-cap">{group.note}</p>
              {group.count === 0
                ? <p className="index-empty">None.</p>
                : (
                  <ol className="wording-list">
                    {group.pairs.map((pair) => (
                      <li key={pairParam(pair.a, pair.b)}>
                        <button type="button" className="wording-row" data-pair={pairParam(pair.a, pair.b)}
                          onClick={() => openPair(pair)}>
                          <span className="wording-titles">
                            <span className="wording-title"><small>Paper {pair.left.id} · {pair.left.publication_date ? publishedWords(pair.left.publication_date) : 'No date recorded'}</small>{pair.left.title}</span>
                            <span className="wording-title"><small>Paper {pair.right.id} · {pair.right.publication_date ? publishedWords(pair.right.publication_date) : 'No date recorded'}</small>{pair.right.title}</span>
                          </span>
                          <span className="meta">
                            <span>{pairLine(pair, data.settings.phrase_words)}</span>
                          </span>
                          {pair.reason_words && <span className="wording-reason">{pair.reason_words}</span>}
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              {!filtered && group.count > group.pairs.length && (
                <p className="index-cap">Showing the {number(group.pairs.length)} with the longest passages of {number(group.count)}.</p>
              )}
            </section>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

function WordingChart({ title, rows, selected, onChoose, note }: {
  title: string; rows: readonly { id: string; label: string; count: number }[];
  selected: string | null; onChoose: (id: string) => void; note: string;
}) {
  const tip = useChartTip();
  const roving = useRoving(rows.length);
  const largest = Math.max(1, ...rows.map(row => row.count));
  return <section className="chart-card" aria-label={title}>
    <h2 className="group-title">{title}</h2>
    <p className="chart-note">Listed pairs only; each group can be capped. {note} Choose a bar to filter the list below.</p>
    <ol className="bar-rows">
      {rows.map((row, i) => {
        const content = { name: row.label, value: count(row.count, 'pair'), opens: 'Filters the list below' };
        return <li key={row.id}><button type="button" className="bar-row wording-chart-button" aria-pressed={selected === row.id}
          aria-label={tipWords(content)} onClick={() => onChoose(row.id)} {...joined(roving.item(i), tip.mark(content))}>
          <span className="bar-name">{row.label}</span>
          <span className="chart-bar" aria-hidden="true"><span className="bar-own" style={{ width: `${100 * row.count / largest}%` }} /></span>
          <span className="bar-figure num" aria-hidden="true">{count(row.count, 'pair')}</span>
        </button></li>;
      })}
    </ol>
    <p className="chart-note">{rows.map(row => `${row.label}: ${count(row.count, 'pair')}`).join('; ')}.</p>
    {tip.layer}
  </section>;
}

function ScanFacts({ data, now }: { data: SharedWordingOverview; now: Date }) {
  const { several } = useCollection();
  const s = data.settings;
  const scan = data.scan;
  return (
    <div className="wording-facts">
      {data.state === 'never' && <p className="settings-said" data-wording="never">Nothing has been scanned yet.</p>}
      {data.state === 'other_version' && (
        <p className="settings-said" data-wording="other-version">
          The last scan was made by another version of this method (version {scan?.method_version ?? 'unknown'}; this
          is version {data.method_version}), so its pairs are not listed. Scan again to list pairs by this one.
        </p>
      )}
      {scan && data.state === 'ready' && (
        <>
          <p className="settings-said" data-wording="last-scan">
            Last {scan.kind === 'new' ? 'brought up to date' : 'scanned'} {when(scan.finished_at, now)}
            {scan.kind === 'new' && scan.full_scan_at ? `, after a run, from a full scan ${when(scan.full_scan_at, now)}` : ''}.{' '}
            <span data-wording="compared">{comparedWords(scan, s.min_words)}</span>
          </p>
          {data.arrived_since > 0 && (
            <p className="settings-said" data-wording="arrived">
              {count(data.arrived_since, 'paper', 'papers')} arrived after that and {data.arrived_since === 1 ? 'has' : 'have'} not
              been compared yet. A run that brings new papers compares them when it finishes; Scan again compares
              everything now.
            </p>
          )}
          {data.withheld > 0 && (
            <p className="settings-said" data-wording="withheld">
              {count(data.withheld, 'pair is', 'pairs are')} not listed because a paper&rsquo;s text changed, or the
              paper left {several ? 'resmon' : 'your collection'}, after the scan.
            </p>
          )}
        </>
      )}
      <dl className="facts wording-defs" aria-label="What Each Number Means">
        <div><dt>Longest Passage</dt><dd>{data.definitions.longest}</dd></div>
        <div><dt>Share</dt><dd>{data.definitions.share}</dd></div>
        <div><dt>Authors in Common</dt><dd>{data.definitions.authors}</dd></div>
        <div>
          <dt>Which Pairs Are Listed</dt>
          <dd>
            Outside Standard Statements, a pair is listed when, excluding common phrasing, it shares at least {s.shown_longest} consecutive words,
            or at least {percentWords(s.shown_share)} of the shorter abstract&rsquo;s {s.phrase_words}-word phrases with
            at least {s.shown_longest - s.phrase_words + 1} shared phrases. A phrase found in more than {s.common_works} distinct works
            is common phrasing and cannot create a substantive comparison on its own. Standard Statements groups recurring sentences
            across records with distinct authors and little other word overlap; this does not establish the sentences&rsquo; purpose
            or prove that the papers are unrelated. An abstract under {s.min_words} words is not compared.
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * A pair side by side: the engine's sentences, its numbers with their
 * definitions, both texts with the shared passages marked, and what resmon
 * cannot see. Left is the earlier publication date, only as a reading order.
 */
function PairView({ a, b, phraseWords, onClose, backLabel }: { a: number; b: number; phraseWords: number; onClose: () => void; backLabel: string }) {
  const pair = useQuery({
    queryKey: ['shared-wording-pair', a, b],
    queryFn: () => answer(engine().GET('/api/shared-wording/pairs/{a}/{b}', { params: { path: { a, b } } })),
    retry: false,
  });
  const [hover, setHover] = useState<number | null>(null);
  return (
    <section className="wording-pair" aria-label="Two Abstracts Side by Side" data-wording="pair" data-pair={pairParam(a, b)}>
      <button type="button" className="back" onClick={onClose}>{backLabel}</button>
      {pair.isPending && <p className="record-cap">Reading the two abstracts.</p>}
      {pair.isError && <p className="field-error" role="alert">{refusal(pair.error)}</p>}
      {pair.data && <PairBody pair={pair.data} phraseWords={phraseWords} hover={hover} setHover={setHover} />}
    </section>
  );
}

function PairBody({ pair, phraseWords, hover, setHover }: {
  pair: SharedWordingPair; phraseWords: number; hover: number | null; setHover: (n: number | null) => void;
}) {
  const shorter = pair.shorter === pair.left.id ? pair.left : pair.right;
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const sourceName = (slug: string | null | undefined) =>
    catalog.data?.find((entry) => entry.slug === slug)?.name ?? slug ?? 'Source not recorded';
  return (
    <>
      <h2 className="wording-pair-label" data-category={pair.category}>{pair.label}</h2>
      <div className="lib-actions wording-exports" aria-label="Export This Pair">
        <button type="button" className="btn sm" onClick={() => saveFile(pairCsv(pair), `resmon-wording-${pair.a}-${pair.b}.csv`, 'text/csv;charset=utf-8')}>Export Pair CSV</button>
        <button type="button" className="btn sm" onClick={() => saveFile(pairMarkdown(pair), `resmon-wording-${pair.a}-${pair.b}.md`, 'text/markdown;charset=utf-8')}>Export Pair Markdown</button>
      </div>
      <div className="wording-summary" data-wording="summary">
        {pair.summary.map((line) => <p key={line}>{line}</p>)}
      </div>
      <dl className="facts wording-numbers" data-state={pair.state}>
        <div>
          <dt>Longest Passage</dt>
          <dd><span className="num" data-wording="longest">{number(pair.longest)} words</span><span className="wording-def">{pair.definitions.longest}</span></dd>
        </div>
        <div>
          <dt>Share</dt>
          <dd>
            <span className="num" data-wording="share">{percentWords(pair.share)}</span>
            {' '}of the {number(pair.shorter_phrases)} {phraseWords}-word phrases of the shorter abstract (paper {shorter.id}):{' '}
            {number(pair.shared_phrases)} also appear in the other.
            <span className="wording-def">{pair.definitions.share}</span>
          </dd>
        </div>
        <div>
          <dt>Authors in Common</dt>
          <dd>
            <span data-wording="authors">
              {pair.category === 'authors_unknown'
                ? 'Cannot say: one record lists no authors.'
                : pair.authors_in_common.length === 0
                  ? 'None'
                  : pair.authors_in_common.map((x) => (x.name === x.other_name ? x.name : `${x.name} (${x.other_name})`)
                    + (x.by === 'orcid' ? ', by ORCID' : '')).join('; ')}
            </span>
            <span className="wording-def">{pair.definitions.authors}</span>
          </dd>
        </div>
      </dl>
      <div className="wording-sides">
        {(['left', 'right'] as const).map((side) => {
          const doc = pair[side];
          const spans = pair.passages.map((p, i) => ({ start: p[side][0] ?? 0, end: p[side][1] ?? 0, passage: i }));
          return (
            <article key={side} className="wording-side" data-side={side} data-paper={doc.id}>
              <h3 className="wording-side-title"><Link to={`/papers/${doc.id}`}>{doc.title}</Link></h3>
              <p className="meta wording-side-meta">
                <span>Paper {doc.id}</span><span className="sep" />
                <span>{sourceName(doc.source_repository)}</span><span className="sep" />
                <span>{doc.publication_date ? publishedWords(doc.publication_date) : 'No date recorded'}</span>
              </p>
              <p className="record-cap wording-side-authors">{doc.authors || 'Authors not recorded'}</p>
              <p className="wording-text" data-wording="text">
                {segments(doc.text, spans).map((seg, i) => (seg.passages.length
                  ? (
                    <mark key={i} className="wording-mark" data-passage={seg.passages.join(' ')}
                      data-lit={hover !== null && seg.passages.includes(hover) ? 'true' : undefined}
                      onMouseEnter={() => setHover(seg.passages[0] ?? null)} onMouseLeave={() => setHover(null)}>
                      {seg.text}
                    </mark>
                  )
                  : <span key={i}>{seg.text}</span>))}
              </p>
            </article>
          );
        })}
      </div>
      <p className="form-hint">
        Marked: the {count(pair.passages.length, 'passage')} of {phraseWords} words or more the two share. The text is shown
        as it was compared: character references decoded and markup removed. Point at a passage to find it in the other.
      </p>
      <h3 className="why-limits-label">What resmon Cannot See</h3>
      <ul className="why-limits" data-wording="limits">{pair.limits.map((line) => <li key={line}>{line}</li>)}</ul>
    </>
  );
}
