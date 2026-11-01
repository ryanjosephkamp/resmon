import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { queueWords } from '../collection/Paper';
import { PaperLifecycle } from '../lifecycle/LifecycleMarks';
import { runKind } from '../runs/model';
import { authors, publishedWords, when } from '../today/format';
import { invalidateFor } from '../today/freshness';

/** A web address the app may hand to its link window: http and https only. */
export function webLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The PDF of an arXiv record, from its abstract page's address: arXiv serves
 * every paper's PDF at `/pdf/` beside `/abs/`. Null for anything else, since
 * resmon stores no PDF address and does not guess one.
 */
export function arxivPdf(url: string | null | undefined): string | null {
  const page = webLink(url);
  if (!page) return null;
  const parsed = new URL(page);
  if (!/(^|\.)arxiv\.org$/.test(parsed.hostname) || !parsed.pathname.startsWith('/abs/')) return null;
  return `https://arxiv.org/pdf/${parsed.pathname.slice('/abs/'.length)}`;
}

interface Props {
  id: number;
  /** Where it sits: its grid cell, and its region's name when it has one. */
  cell: string | null;
  region: string | null;
  sourceName: (slug: string) => string;
  /** The words on the way back: "Back to the list". */
  backLabel: string;
  /** Set in a page that scrolls, beside its map, rather than as a column the window's height. */
  inline?: boolean;
  onBack: () => void;
  onShow: () => void;
}

/**
 * A paper chosen on a map, beside it: the record as resmon holds it, the runs
 * that found it, its links, and what can be done with it here. The same facts
 * and the same actions as its own page (`/papers/:id`), which is one click on.
 */
export function MapPaper({ id, cell, region, sourceName, backLabel, inline = false, onBack, onShow }: Props) {
  const client = useQueryClient();
  const [now] = useState(() => new Date());
  const paper = useQuery({
    queryKey: ['paper', id],
    queryFn: () => answer(engine().GET('/api/documents/{doc_id}', { params: { path: { doc_id: id } } })),
  });
  const why = useQuery({
    queryKey: ['paper-why', id],
    queryFn: () => answer(engine().GET('/api/documents/{doc_id}/why', { params: { path: { doc_id: id } } })),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['paper', id] });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void invalidateFor(client, 'paper-changed');
  };
  // Each takes the paper's id, so a pending action is read only for the paper it was asked about.
  const save = useMutation({
    mutationFn: (doc: number) => answer(engine().POST('/api/reading-queue', { body: { document_id: doc } })),
    onSuccess: refresh,
  });
  const mark = useMutation({
    mutationFn: ({ doc, status }: { doc: number; status: 'read' | 'to_read' }) => answer(engine().PUT(
      '/api/reading-queue/{document_id}', { params: { path: { document_id: doc } }, body: { status } },
    )),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (doc: number) => answer(engine().DELETE('/api/reading-queue/{document_id}', {
      params: { path: { document_id: doc } },
    })),
    onSuccess: refresh,
  });

  const runs = useMemo(() => why.data?.runs ?? [], [why.data]);
  // Set in a page whose columns have stacked (a narrow window), the paper opens below its map: brought into view.
  const own = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = own.current;
    if (!inline || !node) return;
    const { top } = node.getBoundingClientRect();
    if (top < 0 || top > window.innerHeight * 0.6) {
      node.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, [inline]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onBack();
  };
  // A reading-queue button that had the keyboard is replaced by the next one
  // (Save to read by Mark read), or disabled while its request is out, and the
  // keyboard falls to the page, where Escape reached nothing. While it is
  // there, Escape still returns; once the request is answered, the keyboard is
  // given back to the actions.
  const back = useRef(onBack);
  useEffect(() => { back.current = onBack; }, [onBack]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], :popover-open')) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      event.preventDefault();
      back.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const actions = useRef<HTMLDivElement>(null);
  const acted = useRef(false);

  const data = paper.data;
  const status = data?.queue_status ?? null;
  const pending = (save.isPending && save.variables === id) || (mark.isPending && mark.variables?.doc === id)
    || (remove.isPending && remove.variables === id);
  const failure = (save.variables === id ? save.error : null) ?? (mark.variables?.doc === id ? mark.error : null)
    ?? (remove.variables === id ? remove.error : null);
  useEffect(() => {
    if (pending || !acted.current) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    actions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [pending, status]);
  const doi = data?.doi ? webLink(`https://doi.org/${data.doi}`) : null;
  const page = webLink(data?.url);
  const pdf = arxivPdf(data?.url);
  const source = data ? sourceName(data.source_repository) : '';

  return (
    <section ref={own} className={inline ? 'index map-paper inline' : 'index map-paper'} aria-labelledby="map-paper-title"
      data-map-paper={id} onKeyDown={onKeyDown}>
      <header className="index-bar">
        <button type="button" className="btn sm quiet map-paper-back" onClick={onBack} aria-keyshortcuts="Escape">
          <Icon name="back" size={14} />{backLabel}
        </button>
        <Link to={`/papers/${id}`} className="btn sm">Open its page</Link>
      </header>
      <div className="index-scroll map-paper-scroll">
        <p className="map-paper-place">
          {cell ? (
            <button type="button" className="cell" onClick={onShow} aria-label={`Show it on the map, at ${cell}`}>{cell}</button>
          ) : 'Not on this map'}
          {region && <span className="it"> {region}</span>}
        </p>
        {paper.isPending && <p className="record-cap" id="map-paper-title">Reading paper {id}.</p>}
        {paper.isError && (
          <p className="record-cap" role="alert" id="map-paper-title">
            Paper {id} could not be read: {paper.error.message}.
          </p>
        )}
        {data && (
          <>
            <h2 className="map-paper-title" id="map-paper-title">{data.title}</h2>
            <p className="sr-only" aria-live="polite">Chosen on the map: {data.title}</p>
            <div className="meta paper-meta">
              <span className="who">{authors(data.authors)}</span>
              <span className="sep" />
              <span>{source}</span>
              {data.publication_date && (<><span className="sep" /><span>Published {publishedWords(data.publication_date)}</span></>)}
            </div>
            <p className="map-paper-found">
              Collected {when(data.first_seen_at, now)} <span className="sep-dot" aria-hidden="true">·</span>{' '}
              <span className="num" title="Its number in this collection only">Paper {data.id}</span>
            </p>

            <div className="paper-actions" data-queue={status ?? 'none'} ref={actions}
              onFocus={() => { acted.current = true; }}
              onBlur={(event) => { if (event.relatedTarget) acted.current = actions.current?.contains(event.relatedTarget) ?? false; }}>
              {status === null ? (
                <button type="button" className="btn primary sm" disabled={pending} onClick={() => save.mutate(id)}>
                  <Icon name="bookmark" size={14} />Save to read
                </button>
              ) : (
                <>
                  <span className="queue-state">In the reading queue · {queueWords(status)}</span>
                  <button type="button" className="btn sm" disabled={pending}
                    onClick={() => mark.mutate({ doc: id, status: status === 'read' ? 'to_read' : 'read' })}>
                    {status === 'read' ? 'Mark unread' : 'Mark read'}
                  </button>
                  <button type="button" className="btn sm quiet" disabled={pending} onClick={() => remove.mutate(id)}>
                    Remove
                  </button>
                </>
              )}
              {failure && <p className="field-error" role="alert">{failure.message}</p>}
            </div>

            {(doi || page || pdf) && (
              <ul className="map-paper-links" aria-label="Links">
                {doi && (
                  <li><a href={doi} target="_blank" rel="noreferrer"><Icon name="open" size={14} />doi:{data.doi}</a></li>
                )}
                {page && (
                  <li><a href={page} target="_blank" rel="noreferrer"><Icon name="open" size={14} />At {source}</a></li>
                )}
                {pdf && (
                  <li><a href={pdf} target="_blank" rel="noreferrer"><Icon name="download" size={14} />PDF at arXiv</a></li>
                )}
              </ul>
            )}

            <PaperLifecycle id={data.id} />

            <section className="paper-section" aria-label="Abstract">
              <h2>Abstract <span>as {source} gave it</span></h2>
              {data.abstract
                ? <p className="paper-abstract map-paper-abstract">{data.abstract}</p>
                : <p className="record-cap">{source} gave no abstract for it.</p>}
            </section>

            <section className="paper-section" aria-label="Found by">
              <h2>Found by</h2>
              {why.isPending && <p className="record-cap">Reading the runs that found it.</p>}
              {why.isError && <p className="record-cap">The runs that found it could not be read ({why.error.message}).</p>}
              {why.data && runs.length === 0 && (
                <p className="record-cap">No run recorded finding it: it came into the collection another way.</p>
              )}
              {runs.length > 0 && (
                <ul className="paper-links map-paper-runs">
                  {runs.map((run) => (
                    <li key={run.execution_id}>
                      <Link to={`/runs/${run.execution_id}`}>
                        {run.routine_name ?? runKind(run.execution_type)}
                      </Link>
                      <span>
                        {run.routine_name ? 'Watch run' : `Run ${run.execution_id}`}, {when(run.start_time, now)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
