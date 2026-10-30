/**
 * Deleting runs, from the run log's selection or from a run's own page.
 *
 * The engine deletes one run per request and refuses one that is still
 * running, so each is asked for in turn and its answer kept: a refusal is
 * said in the engine's own words beside the runs that went. What went leaves
 * every list that shows it at once, rather than at the list's next read.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { engine, engineSentence } from '../../api/client';
import { TODAY_KEY } from '../Today';
import { RUNS_KEY, type DeleteOutcome, type RunRow } from './model';

/** Ask the engine to delete each run, in order, and say what came of each. */
export async function deleteRuns(ids: readonly number[]): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = { deleted: [], gone: [], refused: [] };
  for (const id of ids) {
    try {
      const { error, response } = await engine().DELETE('/api/executions/{exec_id}', { params: { path: { exec_id: id } } });
      if (response.ok) outcome.deleted.push(id);
      // No such run: whatever deleted it, it is not in the engine to show.
      else if (response.status === 404) outcome.gone.push(id);
      else {
        outcome.refused.push({
          id, reason: engineSentence(error) ?? `Run ${id} was not deleted: the engine answered HTTP ${response.status}.`,
        });
      }
    } catch (failure) {
      outcome.refused.push({
        id, reason: `Run ${id} was not deleted: ${failure instanceof Error ? failure.message : String(failure)}.`,
      });
    }
  }
  return outcome;
}

export function useDeleteRuns() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteRuns,
    onSuccess: async (outcome) => {
      const removed = new Set([...outcome.deleted, ...outcome.gone]);
      if (!removed.size) return;
      // A read of the log already under way began before the delete and would
      // draw the runs again when it lands; it is called off, the runs are
      // taken out of what is drawn, and every list is read again after.
      await client.cancelQueries({ queryKey: RUNS_KEY });
      await client.cancelQueries({ queryKey: ['routine-runs'] });
      const without = (rows: RunRow[] | undefined) => rows?.filter((row) => !removed.has(row.id));
      client.setQueryData<RunRow[]>(RUNS_KEY, without);
      client.setQueriesData<RunRow[]>({ queryKey: ['routine-runs'] }, without);
      void client.invalidateQueries({ queryKey: RUNS_KEY });
      void client.invalidateQueries({ queryKey: ['routine-runs'] });
      void client.invalidateQueries({ queryKey: TODAY_KEY });
    },
  });
}
