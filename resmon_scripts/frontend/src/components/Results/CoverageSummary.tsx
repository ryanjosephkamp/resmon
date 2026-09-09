import React from 'react';
import { SourceCoverage } from '../../api/searchRecord';

const CoverageSummary: React.FC<{ coverage: SourceCoverage; onDetails?: () => void; details?: boolean }> = ({ coverage, onDetails, details = false }) => (
  <section className="coverage-summary" aria-label={`Source coverage for execution ${coverage.execution_id}`}>
    <h4>Source coverage · Execution #{coverage.execution_id}</h4>
    <p className="coverage-counts">{coverage.summary}</p>
    <p>Genuine empty answers: {coverage.counts.genuine_empty} (included in answered).</p>
    <p>{coverage.notes[0]}</p>
    {coverage.additional_sources.length > 0 && <p>{coverage.additional_sources.length} additional recorded sources outside saved selection; excluded from selected counts.</p>}
    {!details && coverage.notes.filter(n => n.startsWith('This run')).map(n => <p key={n}>{n}</p>)}
    {onDetails && <button type="button" className="btn btn-sm" onClick={onDetails}>View source details</button>}
    {details && <>
      <ul>{coverage.notes.slice(1).map(n => <li key={n}>{n}</li>)}</ul>
      {([['Coverage basis', coverage.sources], ['Additional recorded sources outside saved selection', coverage.additional_sources]] as const).map(([title, rows]) => rows.length > 0 && <div key={title}>
        <h5>{title}</h5>
        <table className="coverage-table"><thead><tr><th>Source</th><th>Category</th><th>Returned records</th><th>Recorded at</th><th>Reason</th></tr></thead>
          <tbody>{rows.map(s => <tr key={s.source}><td>{s.source}</td><td>{s.category.replace('_', ' ')}</td><td>{s.result_count ?? 'not recorded'}</td><td>{s.recorded_at ?? 'not recorded'}</td><td>{s.note}</td></tr>)}</tbody>
        </table>
      </div>)}
    </>}
  </section>
);
export default CoverageSummary;
