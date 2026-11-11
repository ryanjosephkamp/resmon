import { useEffect, useEffectEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import { bridge } from '../bridge';
import { queueWords } from '../screens/collection/Paper';
import { errorWords } from '../screens/library/Cards';
import { UndoNotice, type Notice } from '../screens/library/UndoNotice';
import { instant } from '../screens/today/format';
import { invalidateFor } from '../screens/today/freshness';

/** A save the engine says is older than this, before the click, was already there. Its clock is this computer's. */
const ALREADY_MS = 5_000;

/**
 * Save to Read from a right-click on a link to a paper's page
 * (`electron/contextMenu.ts`): the main process names the paper, and this
 * window saves it and says what happened, with Undo for a new save. A paper
 * already saved stays as it is, and the notice says where it is.
 */
export function MenuSave() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const refresh = (id: number) => {
    void client.invalidateQueries({ queryKey: ['paper', id] });
    void client.invalidateQueries({ queryKey: ['paper-places', id] });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void client.invalidateQueries({ queryKey: ['run-papers'] });
    void invalidateFor(client, 'paper-changed');
  };
  const save = useEffectEvent(async (id: number) => {
    const asked = Date.now();
    try {
      const entry = await answer(engine().POST('/api/reading-queue', { body: { document_id: id } }));
      refresh(id);
      const title = entry.document?.title?.trim() || `Paper ${id}`;
      const earlier = instant(entry.saved_at).getTime() < asked - ALREADY_MS;
      setNotice(earlier
        ? { id: Date.now(), lead: '', name: title, rest: ` was already saved, in ${queueWords(entry.status) ?? 'the reading queue'}.`, undo: null }
        : {
            id: Date.now(), lead: 'Saved ', name: title, rest: ' to read.',
            undo: async () => {
              await answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: id } } }));
              refresh(id);
            },
          });
    } catch (error) {
      setNotice({ id: Date.now(), lead: 'The paper could not be saved to read: ', name: null, rest: `${errorWords(error)}.`, undo: null });
    }
  });
  useEffect(() => bridge()?.onSaveToRead?.((id) => { void save(id); }), []);
  return notice ? createPortal(<UndoNotice key={notice.id} notice={notice} onDone={() => setNotice(null)} />, document.body) : null;
}
