import { useMutation, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { ACTIVE_KEY } from './active';

/** A separate mutation for each control keeps one source's refusal beside that source. */
export function SourceStop({ runId, slug, name, title, available = true, onSaid }: {
  runId: number; slug?: string; name?: string; title?: string; available?: boolean; onSaid?: (key: string, sentence: string) => void;
}) {
  const client = useQueryClient();
  const stop = useMutation({
    mutationFn: () => answer(engine().POST('/api/executions/{exec_id}/stop-sources', {
      params: { path: { exec_id: runId } }, body: slug ? { sources: [slug] } : { all: true },
    })),
    onSuccess: (said) => onSaid?.(slug ?? 'unfinished', said.detail),
    onError: (error) => onSaid?.(slug ?? 'unfinished', error instanceof EngineError && error.detail ? error.detail : error.message),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ACTIVE_KEY });
      void client.invalidateQueries({ queryKey: ['run', runId] });
    },
  });
  const label = slug ? 'Stop This Source' : 'Stop Unfinished Sources';
  const error = stop.error;
  const said = error instanceof EngineError && error.detail ? error.detail : error?.message;
  if (!available && !said && !stop.isSuccess && !stop.isPending) return null;
  return (
    <div className="source-stop">
      {available && <button type="button" className="btn sm" disabled={stop.isPending || stop.isSuccess}
        aria-label={slug ? `${label}: ${name ?? slug}` : title ? `${label}: ${title}` : label} onClick={() => stop.mutate()}>{label}</button>}
      {said && <p className={error instanceof EngineError && error.status === 409 ? 'active-note' : 'field-error'}
        role={error instanceof EngineError && error.status === 409 ? 'status' : 'alert'}>{said}</p>}
      {stop.isSuccess && <p className="active-note" role="status">{stop.data.detail}</p>}
    </div>
  );
}

export function StopUnfinished({ runId, available, title, onSaid }: {
  runId: number; available: boolean; title?: string; onSaid?: (key: string, sentence: string) => void;
}) {
  return <SourceStop key={runId} runId={runId} available={available} title={title} onSaid={onSaid} />;
}
