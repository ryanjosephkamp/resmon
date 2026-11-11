import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../shell/Icon';
import { Confirm } from '../runs/Confirm';
import { invalidateFor } from '../today/freshness';
import { errorWords } from './Cards';
import {
  ASK_ABOVE, saveLabel, saveQuestion, saveRefusal, saveToRead, savedWords, undoSave, undoneWords,
  type Saved, type SaveTarget,
} from './saveToRead';
import { UndoNotice, type Notice } from './UndoNotice';

/** A save asked for: what it names, how many, and how the question names them ("all 1,204 matches"). */
export interface SaveAsk { target: SaveTarget; n: number; what: string; all: boolean }

/**
 * Save many papers to read, from wherever a list offers it: the save, the
 * question a large one asks first, its refusal in the engine's words, and the
 * notice it leaves, with Undo. Each part is drawn where the caller puts it:
 * the question and a refusal in the selection's bar, the notice at the
 * stage's foot. Everything that shows a paper's place in the reading queue is
 * read again after a save and after its Undo.
 */
export function useSaveToRead(onSaved?: (saved: Saved) => void) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<SaveAsk | null>(null);
  const noticeId = useRef(0);
  const refresh = useCallback((ids: readonly number[]) => {
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void client.invalidateQueries({ queryKey: ['run-papers'] });
    void client.invalidateQueries({ queryKey: ['paper'] });
    for (const id of ids) void client.invalidateQueries({ queryKey: ['paper-places', id] });
    void invalidateFor(client, 'paper-changed');
  }, [client]);
  const mutation = useMutation({
    mutationFn: (ask: SaveAsk) => saveToRead(ask.target),
    onSuccess: (saved) => {
      setAsking(null);
      refresh(saved.saved_ids);
      noticeId.current += 1;
      setNotice({
        id: noticeId.current, lead: savedWords(saved), name: null, rest: '',
        undo: saved.saved ? async () => {
          const undone = await undoSave(saved);
          refresh(saved.saved_ids);
          return (undone && undoneWords(undone, saved.saved)) ?? undefined;
        } : null,
      });
      onSaved?.(saved);
    },
  });
  const { mutate, reset } = mutation;
  /** Save now, or ask first when it is many. */
  const save = useCallback((ask: SaveAsk) => {
    reset();
    if (ask.n > ASK_ABOVE) setAsking(ask); else mutate(ask);
  }, [mutate, reset]);
  const cancel = useCallback(() => setAsking(null), []);

  const question: ReactNode = asking && (
    <Confirm name="save-to-read" tone="go" question={saveQuestion(asking.what)} act={saveLabel(asking.n, asking.all)}
      busy={mutation.isPending} onAct={() => mutate(asking)} onCancel={cancel} />
  );
  const refused: ReactNode = mutation.error && (
    <p className="field-error" role="alert" data-save="refused">Nothing was saved: {errorWords(mutation.error)}</p>
  );
  const toast: ReactNode = notice && (
    <UndoNotice key={notice.id} notice={notice} name="saved-to-read"
      onDone={() => setNotice((now) => (now?.id === notice.id ? null : now))} />
  );
  return { save, cancel, pending: mutation.isPending, asking: asking !== null, question, refused, notice: toast };
}

/**
 * The bar's Save to Read: "Save 3 to read", or "Save all 1,204 to read" when
 * every row of the list is picked; disabled while nothing is picked, while a
 * save or its question is open, and when it cannot be made as it stands
 * (`SaveLimit` says why).
 */
export function SaveButton({ n, all, busy, saving = false, onSave }: {
  n: number | null; all: boolean; busy: boolean;
  /** The save is on its way: the button says so. */
  saving?: boolean;
  onSave: () => void;
}) {
  const refusal = saveRefusal(n);
  return (
    <button type="button" className="btn sm" data-save="picked" disabled={!n || busy || refusal !== null}
      title={refusal ?? undefined} onClick={onSave} aria-busy={saving || undefined}>
      <Icon name="bookmark" size={14} />{saving ? 'Saving' : n ? saveLabel(n, all) : 'Save to Read'}
    </button>
  );
}

/** Why Save to Read is off for this many, on a line of its own; nothing when it is not. */
export function SaveLimit({ n }: { n: number | null }) {
  const refusal = saveRefusal(n);
  return refusal ? <p className="select-note" data-save="limit">{refusal}</p> : null;
}
