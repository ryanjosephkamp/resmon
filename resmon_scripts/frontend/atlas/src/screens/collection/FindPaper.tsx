import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { useCollection } from '../../collections/current';
import { WallMark } from '../health/WallMark';
import { PaperFullText } from '../fulltext/GetPdf';
import {
  KIND_WORDS, differencesWords, errorWords, findLeadWords, hostWords, licenseWords, outcomeWords, sentenceCase,
  type FindResult, type FindSourceResult,
} from '../fulltext/fullText';
import { authors, publishedWords } from '../today/format';
import { instant } from '../watches/model';
import { SearchTabs } from './SearchTabs';

/** How long a typed query rests before the page asks what it reads as. */
const PLAN_REST_MS = 250;
/** How often a find still going is read again. */
const WHILE_ASKING_MS = 1000;
/** How many earlier finds the page lists. */
const EARLIER = 8;

/** The Source wall's state each outcome is drawn as, so a find speaks the wall's marks. */
const WALL_STATE: Record<string, string> = {
  found: 'answered', not_found: 'answered_empty', did_not_answer: 'failed', not_asked: 'not_selected',
};

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * A reason read on from the source's name, which heads the line in bold:
 * "arXiv can be asked by…" rather than "arXiv arXiv can be asked by…".
 */
export function afterName(name: string, why: string): string {
  return why.startsWith(`${name} `) || why.startsWith(`${name}'s `) ? why.slice(name.length) : ` ${why}`;
}

function useResting(value: string, ms: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setRested(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return rested;
}

/**
 * Look Up a Paper: one paper, by DOI, arXiv id, PMID or title, asked of every
 * source that can look it up. A find is a run, so the Runs tab lists it and
 * Health counts each source's answer; this page says what each source said.
 */
export function FindPaper() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const runId = Number(params.get('run')) || null;
  // A `resmon://find` link (from the Save to resmon extension, say) fills the field and names its page; it asks nothing.
  const linked = runId === null ? params.get('q') : null;
  const from = runId === null ? params.get('from') : null;
  const { id: collection, name: collectionName } = useCollection();
  // What is being typed; null until something is, so a find opened from Runs
  // or from Earlier finds reads in the field as it was asked.
  const [typing, setTyped] = useState<string | null>(null);
  /** The sources a person left out of this find; every one that can look it up is asked otherwise. */
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  // Each link starts afresh: what was typed for an earlier find, or left out of it, would hide what it asks.
  const sentLink = linked === null ? null : `${linked}\n${from ?? ''}\n${params.get('sent') ?? ''}`;
  const [seenLink, setSeenLink] = useState(sentLink);
  if (sentLink !== seenLink) {
    setSeenLink(sentLink);
    setTyped(null);
    setLeftOut(new Set());
  }

  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const nameOf = useMemo(() => {
    const names = new Map((catalog.data ?? []).map((e) => [e.slug, e.name]));
    return (slug: string) => names.get(slug) ?? slug;
  }, [catalog.data]);

  const run = useQuery({
    queryKey: ['find-run', runId], enabled: runId !== null,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}', { params: { path: { exec_id: runId! } } })),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? WHILE_ASKING_MS : false),
  });
  const going = run.data?.status === 'running';
  const result = useQuery({
    queryKey: ['find-result', runId, run.data?.status], enabled: runId !== null && !!run.data && !going,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}/find', { params: { path: { exec_id: runId! } } })),
  });
  const typed = typing ?? result.data?.query.typed ?? run.data?.query ?? linked ?? '';
  const rested = useResting(typed.trim(), PLAN_REST_MS);
  const plan = useQuery({
    queryKey: ['find-plan', rested], enabled: rested.length > 0,
    queryFn: () => answer(engine().GET('/api/find/plan', { params: { query: { q: rested } } })),
    retry: false,
  });

  const referenceId = result.data?.reference_document_id ?? null;
  const reference = useQuery({
    queryKey: ['paper', referenceId], enabled: referenceId !== null,
    queryFn: () => answer(engine().GET('/api/documents/{doc_id}', { params: { path: { doc_id: referenceId! } } })),
  });
  const earlier = useQuery({
    queryKey: ['executions', 'finds', runId],
    queryFn: () => answer(engine().GET('/api/executions', { params: { query: { type: 'find_paper', limit: EARLIER } } })),
  });

  const planned = plan.data && rested === typed.trim() ? plan.data : null;
  const asking = planned ? planned.asked.filter((s) => !leftOut.has(s)) : [];
  const start = useMutation({
    mutationFn: () => answer(engine().POST('/api/find', {
      body: {
        query: typed.trim(), request_id: crypto.randomUUID(),
        // The sources named only when some were left out: otherwise the engine asks every one that can.
        ...(planned && leftOut.size ? { repositories: asking } : {}),
        ...(collection === null ? {} : { collection }),
      },
    })),
    onSuccess: (started) => {
      if (started.execution_id) setParams({ run: String(started.execution_id) });
      void client.invalidateQueries({ queryKey: ['executions'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!typed.trim() || start.isPending || (planned && !asking.length)) return;
    start.mutate();
  };
  const flip = (slug: string) => setLeftOut((was) => {
    const next = new Set(was);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });

  return (
    <div className="page find-page" aria-busy={start.isPending || going}>
      <SearchTabs />
      <h1 className="page-title">Look Up a Paper</h1>
      <p className="page-lede"><strong>See every source that holds a paper you already know.</strong></p>
      <p className="page-lede">
        One paper, by its DOI, arXiv id, PMID, or title, asked of every source that can look it up. Each source’s
        answer is kept as a run, and the copies found are added to {collectionName ?? 'the collection this window shows'}. Copies that share a DOI
        are linked as one paper; a copy that does not carry that DOI is not.
      </p>

      <form className="find-form" onSubmit={submit} role="search" aria-label="Look Up a Paper">
        <label className="terms find-terms">
          <span className="sr-only">A DOI, an arXiv id, a PMID, or a title</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={500} autoComplete="off"
            spellCheck={false} placeholder="10.1371/journal.pone.0000308, arXiv:1706.03762, PMID:17375194, or a title"
            data-find="query" />
        </label>
        <button type="submit" className="btn primary" disabled={!typed.trim() || start.isPending || (!!planned && !asking.length)}
          data-find="go">{start.isPending ? 'Asking' : 'Find'}</button>
      </form>
      {linked && (
        <p className="form-hint find-from" data-find="from">
          A link asked resmon to look this up{from ? <>. It names the page it came from: <span className="find-from-page">{from}</span></> : ''}.
          Nothing is looked up until you press Find, and nothing is saved until you choose.
        </p>
      )}
      <div className="find-plan" aria-live="polite">
        {planned && (
          <>
            <p className="find-reads" data-find="reads" data-kind={planned.kind}>
              Reads as {planned.kind === 'title' ? 'a title' : `${planned.kind === 'arxiv' ? 'an' : 'a'} ${KIND_WORDS[planned.kind]}`}
              {planned.kind !== 'title' && <> <code className="find-value">{planned.value}</code></>}.{' '}
              {planned.asked.length
                ? `${planned.asked.length} ${planned.asked.length === 1 ? 'source' : 'sources'} can look it up${leftOut.size ? `, and ${asking.length} will be asked` : ''}.`
                : `No source can look up a ${KIND_WORDS[planned.kind]}.`}
            </p>
            {planned.asked.length > 0 && (
              <div className="find-picks" role="group" aria-label="The sources to ask">
                {planned.asked.map((slug) => (
                  <button key={slug} type="button" className="find-pick" aria-pressed={!leftOut.has(slug)} data-source={slug}
                    title={leftOut.has(slug) ? `Ask ${nameOf(slug)} too` : `Leave ${nameOf(slug)} out`} onClick={() => flip(slug)}>
                    {nameOf(slug)}
                  </button>
                ))}
              </div>
            )}
            {planned.not_asked.length > 0 && (
              <details className="find-not-asked">
                <summary>{planned.not_asked.length} {planned.not_asked.length === 1 ? 'source is' : 'sources are'} not asked, and why</summary>
                <ul>{planned.not_asked.map((n) => <li key={n.source}><b>{nameOf(n.source)}</b>{afterName(nameOf(n.source), n.why)}</li>)}</ul>
              </details>
            )}
          </>
        )}
        {plan.isError && rested && <p className="field-error" role="alert">{errorWords(plan.error)}</p>}
      </div>
      {start.error && <p className="field-error" role="alert">{errorWords(start.error)}</p>}
      {start.data?.queued && <p className="settings-said" role="status">{start.data.detail} It is listed on <Link to="/runs">Runs</Link>.</p>}

      {runId !== null && run.isError && <p className="field-error" role="alert">Find {runId} could not be read ({errorWords(run.error)}).</p>}
      {runId !== null && run.data && run.data.execution_type !== 'find_paper' && (
        <p className="field-error" role="alert">Run {runId} is not a find. <Link to={`/runs/${runId}`}>Open the Run</Link>.</p>
      )}
      {going && run.data && <Asking run={run.data} nameOf={nameOf} />}
      {result.data && run.data && !going && (
        <FoundIt result={result.data} run={run.data} nameOf={nameOf} reference={reference.data ?? null} />
      )}

      {earlier.data && earlier.data.filter((r) => r.id !== runId).length > 0 && (
        <section className="find-earlier" aria-labelledby="find-earlier">
          <h2 id="find-earlier" className="group-title">Earlier Finds</h2>
          <ul>
            {earlier.data.filter((r) => r.id !== runId).map((r) => {
              const day = instant(r.start_time);
              return (
                <li key={r.id}>
                  <Link to={`/search/find?run=${r.id}`} onClick={() => setTyped(null)}>{r.query ?? `Find ${r.id}`}</Link>
                  <span>{day ? DAY.format(day) : ''}{r.status !== 'completed' ? ` · ${r.status}` : ''}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

type RunData = { id: number; coverage: { sources: { source: string; outcome_recorded: boolean }[] } };

/** While a find goes: each source asked, drawn as being asked or as answered. */
function Asking({ run, nameOf }: { run: RunData; nameOf: (slug: string) => string }) {
  const sources = run.coverage.sources;
  const done = sources.filter((s) => s.outcome_recorded).length;
  return (
    <section className="find-result" aria-label="Asking the sources" data-find="asking">
      <p className="find-status" role="status">Asking {sources.length} {sources.length === 1 ? 'source' : 'sources'}: {done} answered so far.</p>
      <ul className="find-sources">
        {sources.map((s) => (
          <li key={s.source} className="find-source" data-outcome={s.outcome_recorded ? 'answered' : 'asking'}>
            <WallMark state={s.outcome_recorded ? 'answered_empty' : 'asking'} />
            <span className="find-source-name">{nameOf(s.source)}</span>
            <span className="find-outcome">{s.outcome_recorded ? 'Answered' : 'Being asked'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type ReferencePaper = { id: number; title: string; authors?: string | null; publication_date?: string | null; doi?: string | null; url?: string | null; source_repository: string };

/**
 * A find's answer: the paper as its reference copy has it, Get the PDF, and
 * each source's row. A find that did not finish says so first, with the rows
 * it recorded, if any.
 */
function FoundIt({ result, run, nameOf, reference }: {
  result: FindResult; run: { status: string; error_message?: string | null };
  nameOf: (slug: string) => string; reference: ReferencePaper | null;
}) {
  const found = result.counts.found ?? 0;
  const finished = run.status === 'completed';
  return (
    <section className="find-result" aria-label="What each source said" data-find="result" data-found={found}
      data-status={run.status}>
      <p className={`find-status${finished ? '' : ' find-unfinished'}`} role={finished ? undefined : 'alert'}>
        {findLeadWords(run, result)}{' '}<Link to={`/runs/${result.execution_id}`}>Open the Run</Link>
      </p>
      {reference && (
        <div className="find-paper" data-find="paper">
          <Link className="find-paper-title" to={`/papers/${reference.id}`}>{reference.title}</Link>
          <p className="meta">
            <span className="who">{authors(reference.authors)}</span>
            {reference.publication_date && <><span className="sep" /><span>{publishedWords(reference.publication_date)}</span></>}
            {reference.doi && <><span className="sep" /><span>doi:{reference.doi}</span></>}
            <span className="sep" /><span>as {nameOf(reference.source_repository)} has it</span>
          </p>
          <PaperFullText id={reference.id} sourceUrl={reference.url ?? null} sourceName={nameOf(reference.source_repository)} />
        </div>
      )}
      {result.sources.length > 0 && (
        <ul className="find-sources">
          {result.sources.map((s) => <SourceRow key={s.source} source={s} />)}
        </ul>
      )}
    </section>
  );
}

function SourceRow({ source }: { source: FindSourceResult }) {
  const differs = source.outcome === 'found' ? differencesWords(source) : null;
  const copy = source.open_copy;
  return (
    <li className="find-source" data-outcome={source.outcome} data-source={source.source}>
      <WallMark state={WALL_STATE[source.outcome] ?? 'unknown'} />
      <span className="find-source-name">
        {source.document_id ? <Link to={`/papers/${source.document_id}`}>{source.name}</Link> : source.name}
      </span>
      <span className="find-outcome">
        {outcomeWords(source)}
        {source.why_not_asked && <span className="find-why">{sentenceCase(source.why_not_asked)}</span>}
      </span>
      {source.outcome === 'found' && (
        <span className="find-details">
          {differs ? <span className="find-differs">{source.reference ? differs : `Differs: ${differs}`}</span>
            : <span className="find-differs">Agrees with the reference copy</span>}
          <span className="find-copy" data-copy={copy ? (copy.downloadable ? 'downloadable' : 'not-downloadable') : 'none'}>
            {copy
              ? `${copy.downloadable ? 'Open copy' : 'Copy'} at ${hostWords(copy.host)}, ${licenseWords(copy)}`
              : 'No open copy reported'}
          </span>
        </span>
      )}
    </li>
  );
}
