import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../api/client';

/**
 * Today, before its plate and index exist: one real read from the engine, so
 * the path from this renderer to the backend is proved on the first screen.
 */
export function Today() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => answer(engine().GET('/api/health')) });
  return (
    <section className="page page-narrow" aria-labelledby="page-title">
      <h1 id="page-title" className="page-title">Today</h1>
      <p className="page-lede" role="status">
        {health.isPending && 'Reaching the engine…'}
        {health.isError && `The engine did not answer: ${health.error.message}`}
        {health.isSuccess && `Connected to the engine${health.data.version ? `, version ${health.data.version}` : ''}.`}
      </p>
    </section>
  );
}
