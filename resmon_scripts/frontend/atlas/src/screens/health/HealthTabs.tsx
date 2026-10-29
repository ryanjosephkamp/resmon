import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { WATCHDOG_KEY } from './model';

/**
 * Health's parts: what every source did, what the watchdog found, and which
 * engine this window is talking to. The watchdog's tab carries its alarms
 * (broken and unusual, muted ones excluded), the engine's own count.
 */
export function HealthTabs() {
  const report = useQuery({ queryKey: WATCHDOG_KEY, queryFn: () => answer(engine().GET('/api/watchdog')) });
  const alarms = report.data?.counts.alarms ?? 0;
  return (
    <nav className="search-tabs" aria-label="Health">
      <NavLink to="/health" end>Source wall</NavLink>
      <NavLink to="/health/watchdog">
        Watchdog{alarms > 0 && <span className="tab-count" data-health="alarms">{alarms}</span>}
      </NavLink>
      <NavLink to="/health/engine">This engine</NavLink>
    </nav>
  );
}
