import { Fragment, memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { bridge } from '../../bridge';
import { Icon } from '../../shell/Icon';
import { AtlasCover, PdfCover, ProjectCover, TextCover, type Atlas } from './Cover';
import {
  dayOf, fileLabel, paperLabel, projectCounts, shortWho, sourceUrl, yearOf,
  type LibraryFileRow, type Project, type QueueEntry,
} from './galleryModel';
import { kindOf, LIBRARY, sizeWords, type Version } from './libraryApi';
import { hostWords, licenseWords, pending, requestWords, useGetPdf, type FullTextStatus } from '../fulltext/fullText';

export function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** Select mode, as each card sees it. */
export interface Picking { on: boolean; picked: boolean; onPick: (key: string, range: boolean) => void }

/**
 * A card's cover: the way into it (Read, Open), or, in select mode, the way to
 * pick it. Hover darkens the cover's edge and underlines the title; keyboard
 * focus is the accent's outline around the cover. Nothing lifts.
 */
function Thumb({ to, label, picking, pickKey, children }: {
  to: string; label: string; picking: Picking; pickKey: string; children: ReactNode;
}) {
  if (picking.on) {
    return (
      <button type="button" className="thumb" aria-pressed={picking.picked} aria-label={`Pick ${label}`}
        onClick={(e: MouseEvent) => picking.onPick(pickKey, e.shiftKey)}>
        <span className="pick" aria-hidden="true"><span className={picking.picked ? 'tick on' : 'tick'} /></span>
        {children}
      </button>
    );
  }
  return <Link className="thumb" to={to} aria-label={label}>{children}</Link>;
}

/** The phone width's More: the card's quieter actions, in a small menu under the button. */
function More({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span className="card-more" ref={box}>
      <button type="button" className="iconbtn sm" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && <span className="card-menu" role="menu">{children(() => setOpen(false))}</span>}
    </span>
  );
}

function openExternal(url: string): void {
  void bridge()?.openPath?.(url);
}

export const PaperCard = memo(function PaperCard({ entry, atlas, vault, sourceName, picking, narrow, onRemove, onChanged, fullText }: {
  entry: QueueEntry; atlas: Atlas | null; vault: string | null; sourceName: (slug: string) => string;
  picking: Picking; narrow: boolean; onRemove: (entry: QueueEntry) => void; onChanged: () => void;
  /** Whether an open copy can be got, and the latest request for it (``/api/full-text/for-documents``). */
  fullText?: FullTextStatus;
}) {
  const doc = entry.document;
  const title = doc?.title ?? `Paper ${entry.document_id}`;
  const now = new Date();
  const label = paperLabel(entry, now);
  const source = doc ? sourceName(doc.source_repository) : '';
  const year = yearOf(doc?.publication_date);
  const pdf = entry.pdf && vault && entry.pdf.vault_id === vault ? entry.pdf : null;
  const read = entry.status === 'read';
  const url = sourceUrl(doc);
  const to = pdf ? `/library/files/${pdf.file_id}?paper=${entry.document_id}` : `/papers/${entry.document_id}`;
  // Each card's own: a Mark pending on one paper leaves every other card's controls as they are.
  const mark = useMutation({
    mutationFn: () => answer(engine().PUT('/api/reading-queue/{document_id}', {
      params: { path: { document_id: entry.document_id } }, body: { status: read ? 'to_read' : 'read' },
    })),
    onSuccess: onChanged,
  });
  const markWords = read ? 'Mark unread' : 'Mark read';
  // Get the PDF where a source states an open license for a copy and the card
  // has no PDF yet; while it downloads, the card says so, and once it lands the
  // queue is read again and the card becomes a PDF card with its cover.
  const get = useGetPdf();
  const request = fullText?.download ?? null;
  const getting = pending(request) || get.isPending;
  const canGet = !pdf && !!fullText?.downloadable && !fullText.in_library;
  const failed = request?.state === 'failed' ? `The last try failed: ${requestWords(request)} ` : '';
  const getWords = canGet && fullText?.best
    ? `${failed}Get the PDF from ${hostWords(fullText.best.host)} (${licenseWords(fullText.best)})` : 'Get the PDF';
  // In the label's own line while it goes, so the card does not change height.
  const gettingLine = !pdf && request && pending(request) ? requestWords(request) : null;
  const venue = [source, (doc?.categories ?? '').split(/[;,]/)[0]?.trim()].filter(Boolean).join(' · ');
  return (
    <article className={`card${picking.on ? ' selecting' : ''}${picking.picked ? ' picked' : ''}`} data-document={entry.document_id}
      data-status={entry.status}>
      <Thumb to={to} label={title} picking={picking} pickKey={`p:${entry.document_id}`}>
        {pdf
          ? <PdfCover version={pdf as Version} label={title} />
          : <AtlasCover atlas={atlas} documentId={entry.document_id} title={title} who={doc?.authors ?? 'Authors not recorded'}
            venue={venue || source} year={year} />}
      </Thumb>
      <div className="cap">
        <h3 className="card-title">{title}</h3>
        <p className="meta">
          {!narrow && <><span className="who">{shortWho(doc?.authors)}</span><span className="sep" /></>}
          <span>{source}</span>
          {year && <><span className="sep" /><span>{year}</span></>}
        </p>
        {gettingLine
          ? <p className="card-label card-getting" role="status" data-fulltext={request?.state} title={gettingLine}>{gettingLine}</p>
          : (
            <p className="card-label">
              {label.from ? <>From {label.name ? <span className="it">{label.from}</span> : label.from}{label.day ? ` · ${label.day}` : ''}</> : `Saved ${label.day ?? ''}`}
            </p>
          )}
        <div className="card-acts">
          <Link className="btn sm" to={to}>Read</Link>
          {narrow ? (
            <>
              <span className="grow" />
              <button type="button" className="iconbtn sm" aria-label={markWords} aria-pressed={read} title={markWords}
                disabled={mark.isPending} onClick={() => mark.mutate()}><Icon name="check" /></button>
              <More label={`More for ${title}`}>
                {(close) => (
                  <>
                    {canGet && (
                      <button type="button" role="menuitem" disabled={getting} data-fulltext="get"
                        onClick={() => { close(); get.mutate(entry.document_id); }}>{getting ? 'Getting the PDF' : 'Get the PDF'}</button>
                    )}
                    {url && <button type="button" role="menuitem" onClick={() => { close(); openExternal(url); }}>Open at {source}</button>}
                    <button type="button" role="menuitem" onClick={() => { close(); onRemove(entry); }}>Remove from {read ? 'Read' : 'To read'}</button>
                  </>
                )}
              </More>
            </>
          ) : (
            <>
              <button type="button" className="btn quiet sm" disabled={mark.isPending} onClick={() => mark.mutate()}>{markWords}</button>
              <span className="grow" />
              {canGet && (
                <button type="button" className="iconbtn sm" aria-label={getting ? 'Getting the PDF' : getWords}
                  title={getting ? 'Getting the PDF' : getWords} disabled={getting} data-fulltext="get"
                  onClick={() => get.mutate(entry.document_id)}><Icon name="download" /></button>
              )}
              {url && (
                <button type="button" className="iconbtn sm" aria-label={`Open at ${source}`} title={`Open at ${source}`}
                  onClick={() => openExternal(url)}><Icon name="open" /></button>
              )}
              <button type="button" className="iconbtn sm" aria-label={`Remove from ${read ? 'Read' : 'To read'}`}
                title={`Remove from ${read ? 'Read' : 'To read'}`} onClick={() => onRemove(entry)}><Icon name="close" /></button>
            </>
          )}
        </div>
        {(mark.error || get.error) && <p className="field-error" role="alert">{errorWords(mark.error ?? get.error)}</p>}
      </div>
    </article>
  );
});

export const FileCard = memo(function FileCard({ file, picking, narrow, onRemove, onLink }: {
  file: LibraryFileRow; picking: Picking; narrow: boolean; onRemove: (file: LibraryFileRow) => void;
  onLink: (file: LibraryFileRow) => void;
}) {
  const navigate = useNavigate();
  const missing = file.availability === 'missing';
  const to = `/library/files/${file.file_id}`;
  const open = useMutation({
    mutationFn: async () => {
      const verified = await answer(engine().POST('/api/library/files/{file_id}/open', {
        ...LIBRARY, params: { path: { file_id: file.file_id } },
        body: { expected_vault_id: file.vault_id, expected_version_id: file.version_id },
      }));
      const failed = await bridge()?.openPath?.(verified.path);
      if (failed) throw new Error(failed);
    },
  });
  const linked = file.paper_links.length > 0;
  return (
    <article className={`card file${picking.on ? ' selecting' : ''}${picking.picked ? ' picked' : ''}`} data-file={file.file_id}
      data-media={file.media_type} data-availability={file.availability}>
      <Thumb to={to} label={file.original_name} picking={picking} pickKey={`f:${file.file_id}`}>
        {missing
          ? <div className="sheet-text missing"><p className="sheet-failed">Not in the Library folder</p></div>
          : file.media_type === 'application/pdf' ? <PdfCover version={file} label={file.original_name} /> : <TextCover version={file} />}
      </Thumb>
      <div className="cap">
        <h3 className="card-title one" title={file.original_name}>{file.original_name}</h3>
        <p className="meta"><span>{kindOf(file.media_type)}</span><span className="sep" /><span>{sizeWords(file.byte_size)}</span></p>
        <p className="card-label">{fileLabel(file)}</p>
        <div className="card-acts">
          <button type="button" className="btn sm" disabled={missing} onClick={() => navigate(to)}>Read</button>
          {!narrow && (
            <button type="button" className="btn quiet sm" onClick={() => (linked ? navigate(`${to}#links`) : onLink(file))}>
              {linked ? 'Links' : 'Link to a paper'}
            </button>
          )}
          <span className="grow" />
          {narrow ? (
            <More label={`More for ${file.original_name}`}>
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { close(); onLink(file); }}>Link to a paper</button>
                  {!missing && <button type="button" role="menuitem" onClick={() => { close(); open.mutate(); }}>Open in the system’s viewer</button>}
                  <button type="button" role="menuitem" onClick={() => { close(); onRemove(file); }}>Remove from Your files</button>
                </>
              )}
            </More>
          ) : (
            <>
              {!missing && (
                <button type="button" className="iconbtn sm" aria-label="Open in the system’s viewer" title="Open in the system’s viewer"
                  disabled={open.isPending} onClick={() => open.mutate()}><Icon name="open" /></button>
              )}
              <button type="button" className="iconbtn sm" aria-label="Remove from Your files" title="Remove from Your files"
                onClick={() => onRemove(file)}><Icon name="close" /></button>
            </>
          )}
        </div>
        {open.error && <p className="field-error" role="alert">{errorWords(open.error)}</p>}
      </div>
    </article>
  );
});

export const ProjectCard = memo(function ProjectCard({ project }: { project: Project }) {
  const counts = projectCounts(project);
  const changed = dayOf(project.updated_at_utc, new Date());
  const leaves: Version[] = project.cover_files.map((f) => ({ ...f, vault_id: project.vault_id }));
  const to = `/library/evidence?project=${encodeURIComponent(project.project_id)}`;
  return (
    <article className="card project" data-project={project.project_id}>
      <Link className="thumb" to={to} aria-label={project.name}>
        <ProjectCover name={project.name} counts={counts} changed={changed} leaves={leaves} />
      </Link>
      <div className="cap">
        <h3 className="card-title name">{project.name}</h3>
        <p className="meta">{counts.map((c, i) => <Fragment key={c}>{i > 0 && <span className="sep" />}<span>{c}</span></Fragment>)}</p>
        <p className="card-label">{changed ? `Changed ${changed}` : 'Change date not recorded'}</p>
        <div className="card-acts">
          <Link className="btn sm" to={to}>Open</Link>
          <Link className="btn quiet sm" to={`${to}&view=answers`}>Ask about it</Link>
        </div>
      </div>
    </article>
  );
});
