import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

interface Health {
  status?: string;
  version?: string;
  pid?: number;
}

const SECTIONS = ['Today', 'Watches', 'Search', 'Library', 'Ask', 'Health'] as const;

/**
 * The Atlas shell as a scaffold: the top bar, its sections, and one real read
 * from the engine to prove the path from this renderer to the backend. The
 * screens arrive one step at a time (rebuild plan, phase 2).
 */
export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => getJson<Health>('/api/health') });
  return (
    <div className="atlas">
      <header className="atlas-bar">
        <span className="atlas-lockup" aria-label="resmon">
          <b aria-hidden="true">res</b><span aria-hidden="true">earch </span>
          <b aria-hidden="true">mon</b><span aria-hidden="true">itor</span>
        </span>
        <nav aria-label="Sections">
          <ul>
            {SECTIONS.map((name) => (
              <li key={name}><a href={`#/${name.toLowerCase()}`} aria-current={name === 'Today' ? 'page' : undefined}>{name}</a></li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="atlas-main">
        <h1>Today</h1>
        <p className="atlas-status" role="status">
          {health.isPending && 'Reaching the engine…'}
          {health.isError && `The engine did not answer: ${health.error.message}`}
          {health.isSuccess && `Connected to the engine${health.data.version ? `, version ${health.data.version}` : ''}.`}
        </p>
      </main>
    </div>
  );
}
