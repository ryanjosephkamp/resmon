import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { CommandEnterHint, commandEnterKeys } from '../../shell/CommandEnterHint';
import { commandEnter } from '../../shell/shortcuts';
import { number, publishedWords } from '../today/format';
import { WATCHES_KEY, type Coverage, type Routine } from './model';

type CoveragePaper = Coverage['off_target'][number];

/**
 * "Is this finding what I meant?": the coverage audit, and the sentence it
 * compares against.
 *
 * resmon knows nothing about what exists and is not in the collection, so
 * *missed* here means "this watch never returned it and something else found
 * it", never "missed by resmon"; the engine's own sentence says so and is
 * shown whole, not tucked away. Distance is what was measured, not relevance:
 * the far list is headed as the results furthest from the intent, which is a
 * prompt to look and not a verdict. Without a written intent the audit falls
 * back to the watch's keywords, which measures the query against what the
 * query produced, and the panel says that comparison is circular.
 *
 * Read when the tab opens, and again whenever the intent changes: the intent
 * is what the audit compares against, so an answer read before a save would
 * make the save look as if it did nothing.
 */
export function CoverageTab({ routine }: { routine: Routine }) {
  const stored = routine.intent ?? '';
  const audit = useQuery({
    queryKey: ['coverage', routine.id, stored],
    queryFn: () => answer(engine().GET('/api/routines/{routine_id}/coverage', {
      params: { path: { routine_id: routine.id } },
    })),
  });
  const data = audit.data;

  return (
    <div className="coverage" data-coverage-state={audit.isFetching ? 'reading' : audit.isSuccess ? 'read' : 'none'}>
      {/* Keyed by what is stored, so a save (or a change made elsewhere) starts the field from it. */}
      <IntentForm key={stored} routineId={routine.id} stored={stored} />

      {audit.isPending && <p className="record-cap">Checking.</p>}
      {audit.isError && <p className="record-cap">The audit could not be read ({audit.error.message}).</p>}
      {data && (
        <>
          <p className="coverage-intent" data-coverage="intent">
            Comparing against <strong>{data.intent || '(nothing)'}</strong>
            {data.intent_source === 'keywords'
              ? <> — this watch&rsquo;s <em>keywords</em>, because no intent has been written for it. That
                measures the query against results the query produced, so read it as a rough guide: write what
                the watch is for above and this becomes a real check.</>
              : <> — the intent written for this watch.</>}
          </p>
          {data.reason && <p className="record-cap" data-coverage="reason">{data.reason}</p>}
          {data.window_note && <p className="record-cap" data-coverage="window">{data.window_note}</p>}
          {data.distribution && (
            <p className="record-cap" data-coverage="distribution">
              {number(data.results_embedded)} of {number(data.results)} results are embedded. Distance from the
              intent runs {data.distribution.min.toFixed(3)} to {data.distribution.max.toFixed(3)}, median{' '}
              {data.distribution.median.toFixed(3)}; the quarter beyond {data.distribution.p75_cutoff.toFixed(3)} is
              listed below{data.model ? `, measured with ${data.model}` : ''}.
            </p>
          )}
          {data.off_target.length > 0 && (
            <>
              <h3 className="record-sub">Furthest from the intent</h3>
              <p className="record-cap">
                These sit at the far end of this watch&rsquo;s own results. A prompt to look, not a verdict: the
                model has not read them.
              </p>
              <Showing shown={data.off_target.length} total={data.off_target_total} which="off-target" />
              <CoverageList rows={data.off_target} />
            </>
          )}
          {data.missed_in_corpus.length > 0 && (
            <>
              <h3 className="record-sub">Already collected, never returned by this watch</h3>
              <p className="record-cap">
                Close to the intent, and found by another watch or search. A keyword gap is the usual reason.
              </p>
              <Showing shown={data.missed_in_corpus.length} total={data.missed_in_corpus_total}
                atLeast={data.missed_in_corpus_total_is_lower_bound} which="missed" />
              <CoverageList rows={data.missed_in_corpus} />
            </>
          )}
          <div className="coverage-limits">
            <p className="why-limits-label">What this cannot see</p>
            <p data-coverage="cannot-see">{data.cannot_see}</p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "Showing 25 of 312.", said rather than left to a list that stops: a short
 * list with no count reads as the whole answer. The missed count is a floor
 * when the engine's bounded search came back full, and then it says so.
 */
function Showing({ shown, total, atLeast = false, which }: {
  shown: number; total: number; atLeast?: boolean; which: 'off-target' | 'missed';
}) {
  if (total <= shown) return null;
  return (
    <p className="record-cap coverage-showing" data-coverage={`${which}-showing`}>
      Showing {number(shown)} of {atLeast ? 'at least ' : ''}{number(total)}.
    </p>
  );
}

function CoverageList({ rows }: { rows: readonly CoveragePaper[] }) {
  return (
    <ol className="coverage-list">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="coverage-distance num" title="Distance from the intent; smaller is closer">{row.distance.toFixed(3)}</span>
          <Link to={`/papers/${row.id}`} className="coverage-title">{row.title}</Link>
          <span className="coverage-source">{row.source_repository}{row.publication_date ? ` · ${publishedWords(row.publication_date)}` : ''}</span>
        </li>
      ))}
    </ol>
  );
}

/** The sentence the audit compares against, written in the watch's own words. */
function IntentForm({ routineId, stored }: { routineId: number; stored: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(stored);
  const save = useMutation({
    mutationFn: (intent: string) => answer(engine().PUT('/api/routines/{routine_id}', {
      params: { path: { routine_id: routineId } }, body: { intent },
    })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['routine', routineId] });
      void client.invalidateQueries({ queryKey: WATCHES_KEY });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft.trim());
  };
  return (
    <form className="intent-form" {...commandEnter()} onSubmit={submit}>
      <label htmlFor="watch-intent" className="record-sub">What this watch is really looking for</label>
      <textarea
        id="watch-intent"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="A sentence or two in your own words: what a paper this watch should find is about."
      />
      <div className="intent-actions">
        <button type="submit" className="btn sm" disabled={save.isPending || draft.trim() === stored} aria-keyshortcuts={commandEnterKeys()}>
          {save.isPending ? 'Saving' : 'Save'}
        </button>
        <CommandEnterHint />
        <span className="record-cap">
          The audit below compares against this. Leave it empty and it falls back to the watch&rsquo;s keywords.
        </span>
      </div>
      {save.error && <p className="field-error" role="alert">{save.error.message}</p>}
    </form>
  );
}
