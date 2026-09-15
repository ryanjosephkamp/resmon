import React, { useEffect, useRef, useState } from 'react';
import type { DownloadRecord } from '../../api/client';

export default function Downloads() {
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    const initial = revision.current;
    const unsubscribe = window.resmonAPI?.onDownloadsChanged?.(next => {
      ++revision.current;
      if (live) { setRecords(next); setOpen(true); }
    });
    void window.resmonAPI?.getDownloads?.().then(next => {
      if (live && revision.current === initial) setRecords(next);
    }).catch(() => { if (live) setError('Download history is unavailable. Check the destination you selected.'); });
    return () => { live = false; unsubscribe?.(); };
  }, []);
  if (!window.resmonAPI?.getDownloads) return null;
  return <section className="downloads-panel" aria-label="Downloads">
    <div className="downloads-heading"><button aria-expanded={open} onClick={() => setOpen(value => !value)}>Downloads ({records.length})</button>
      {records[0] && <span role="status">{records[0].state === 'completed' ? 'Saved' : records[0].state === 'progressing' ? 'Saving' : 'Download '+records[0].state}: {records[0].filename}</span>}
    </div>
    {open && <div className="downloads-list">
      <p>Downloads from this app session. Completed files show their actual saved location.</p>
      {!records.length && <p>No downloads yet.</p>}
      {records.map(record => <article key={record.id} className="download-record">
        <strong>{record.filename}</strong><p>{record.state === 'completed' ? `Saved · ${record.receivedBytes.toLocaleString()} bytes` : record.state === 'progressing' ? 'Saving… completion has not been confirmed.' : `Download ${record.state}. A complete file was not confirmed.`}</p>
        {record.state === 'completed' && record.path && <><p className="download-path">{record.path}</p><button onClick={() => {
          setError('');
          void window.resmonAPI?.revealDownload?.(record.id).catch(() => setError('Could not reveal this download. Use the saved path above.'));
        }}>Show in folder</button></>}
      </article>)}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
