import React, { useCallback, useEffect, useState } from 'react';
import { apiClient, getBaseUrl } from '../../api/client';

/**
 * The reproducible search record for one execution.
 *
 * Systematic reviewers assemble exactly this by hand, in spreadsheets, months
 * after the search. resmon has recorded all of it since the beginning; this is
 * the report format.
 *
 * The design problem is not layout, it is labelling. resmon's counters do not
 * map cleanly onto PRISMA's boxes, and a table that printed them under PRISMA
 * headings would be publishing a claim resmon cannot support:
 *
 *   - It **flags** cross-source duplicates and keeps both rows. It does not
 *     remove them. "Duplicates removed: 8" would describe an operation that
 *     never happened.
 *   - "Already held from an earlier run" has no PRISMA box at all — it is an
 *     artefact of monitoring over time, not a step in a one-shot search.
 *   - A figure that was never measured is shown as *not recorded*, never as 0,
 *     because a reviewer reads 0 as a measurement.
 *
 * So each row carries its PRISMA box (or says it has none), and the meanings
 * and caveats are rendered in the same panel as the numbers rather than behind
 * a disclosure. They travel into the Markdown export for the same reason.
 */

interface SourceRow {
  source: string;
  records_identified: number;
  status: string;
  note: string | null;
}

interface DedupBlock {
  count: number | null;
  prisma: string | null;
  meaning: string;
  recorded?: boolean;
  not_recorded_reason?: string | null;
}

interface Record {
  generated_at: string;
  software: { name: string; version: string; citation: string };
  search: {
    execution_id: number;
    run_at: string;
    completed_at: string | null;
    status: string;
    keywords: string[];
    query_as_sent: string | null;
    date_from: string | null;
    date_to: string | null;
    max_results_per_source: number | null;
    routine_name: string | null;
    routine_schedule: string | null;
    configuration_name: string | null;
  };
  sources: SourceRow[];
  identification: {
    records_identified: number;
    sources_searched: number;
    sources_that_answered: number;
    prisma: string;
  };
  deduplication: {
    records_processed: number | null;
    cross_source_duplicates: DedupBlock;
    already_held: DedupBlock;
    discarded_unusable: DedupBlock;
    records_added: DedupBlock;
  };
  caveats: string[];
}

const nf = new Intl.NumberFormat();

/** Keeps "we did not measure this" visibly distinct from "there were none". */
const count = (value: number | null): React.ReactNode =>
  value === null
    ? <em className="record-absent">not recorded</em>
    : nf.format(value);

const SearchRecord: React.FC<{ executionId: number }> = ({ executionId }) => {
  const [data, setData] = useState<Record | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiClient.get<Record>(
        `/api/executions/${executionId}/search-record`));
    } catch (err: any) {
      setError(err?.message || 'Could not build the search record.');
    }
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <p className="text-muted">Building the record…</p>;

  const { search, identification, deduplication: dd } = data;
  const window = [search.date_from, search.date_to].filter(Boolean).join(' to ');

  const rows: Array<{ label: string; block: DedupBlock }> = [
    { label: 'Duplicates of a record from another source', block: dd.cross_source_duplicates },
    { label: 'Discarded as unusable', block: dd.discarded_unusable },
    { label: 'Added to the corpus', block: dd.records_added },
    { label: 'Already held from an earlier run', block: dd.already_held },
  ];

  return (
    <div className="search-record">
      <div className="search-record-head">
        <p className="text-muted">
          The complete, dated account of this search, in the shape a PRISMA flow
          diagram needs. Everything here was recorded when the search ran.
        </p>
        {/*
          A plain link, not a scripted download: this opens the backend's own
          markdown response, which sets its own Content-Disposition.
        */}
        <a
          className="btn btn-sm"
          href={`${getBaseUrl()}/api/executions/${executionId}/search-record?format=markdown`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Download as Markdown
        </a>
      </div>

      <h4>The search</h4>
      <div className="meta-grid">
        <div className="meta-row">
          <span className="meta-key">Run at</span>
          <span className="meta-value">{search.run_at}</span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Search terms</span>
          <span className="meta-value">
            {search.keywords.length ? search.keywords.join(', ') : '—'}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Publication window</span>
          <span className="meta-value">{window || 'unbounded'}</span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Per-source cap</span>
          <span className="meta-value">
            {search.max_results_per_source ?? '—'}
          </span>
        </div>
        {search.routine_name && (
          <div className="meta-row">
            <span className="meta-key">Routine</span>
            <span className="meta-value">
              {search.routine_name} ({search.routine_schedule})
            </span>
          </div>
        )}
        <div className="meta-row">
          <span className="meta-key">Software</span>
          <span className="meta-value">{data.software.citation}</span>
        </div>
      </div>

      <h4>Records identified, by database</h4>
      <p className="record-prisma">PRISMA: {identification.prisma}</p>
      <table className="simple-table">
        <thead>
          <tr><th>Database</th><th>Records</th><th>Outcome</th></tr>
        </thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source} className={s.status === 'ok' ? '' : 'record-quiet'}>
              <td>{s.source}</td>
              <td>{nf.format(s.records_identified)}</td>
              <td>{s.status === 'ok' ? 'answered' : s.status.replace(/_/g, ' ')}</td>
            </tr>
          ))}
          <tr className="record-total">
            <td><strong>Total</strong></td>
            <td><strong>{nf.format(identification.records_identified)}</strong></td>
            <td>
              {identification.sources_that_answered} of{' '}
              {identification.sources_searched} sources answered
            </td>
          </tr>
        </tbody>
      </table>

      {/* A source that contributed nothing is part of the record. A strategy
          listing it as searched would overstate its coverage. */}
      {data.sources.some((s) => s.note) && (
        <ul className="record-notes">
          {data.sources.filter((s) => s.note).map((s) => (
            <li key={s.source}><strong>{s.source}</strong> — {s.note}</li>
          ))}
        </ul>
      )}

      <h4>What happened to those records</h4>
      <table className="simple-table">
        <thead>
          <tr><th>Figure</th><th>Count</th><th>PRISMA box</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Records processed</td>
            <td>{count(dd.records_processed)}</td>
            <td>—</td>
          </tr>
          {rows.map(({ label, block }) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{count(block.count)}</td>
              <td>
                {block.prisma || <em className="record-absent">no PRISMA equivalent</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Rendered with the numbers, not behind a disclosure. A reader who takes
          the table and leaves these behind would misreport the search. */}
      <ul className="record-meanings">
        {rows.map(({ label, block }) => (
          <li key={label}>
            <strong>{label}</strong> — {block.meaning}
            {block.not_recorded_reason && (
              <span className="record-warn"> {block.not_recorded_reason}</span>
            )}
          </li>
        ))}
      </ul>

      <h4>What these numbers do not mean</h4>
      <ul className="record-caveats">
        {data.caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </div>
  );
};

export default SearchRecord;
