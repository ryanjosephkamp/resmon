import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EngineError } from '../../api/client';
import { bridge } from '../../bridge';

interface Action {
  id: string;
  label: string;
  route: string;
  /** What it removes, in one line. */
  removes: string;
  /** Everything a person should read before confirming. */
  warning: string;
  /** Whether the engine requires the word CONFIRM in the body. */
  typed: boolean;
}

const KEPT = 'Your Library (its files, links, Evidence projects and saved notes) stays.';

/**
 * Every action, the engine's route for it, and what it does, in the order of
 * how much each erases. The engine's own handlers are the authority; these
 * sentences say what those handlers delete and nothing they do not.
 */
const ACTIONS: readonly Action[] = [
  {
    id: 'ai_keys', label: 'Erase all AI API keys', route: '/api/admin/erase-ai-keys', typed: false,
    removes: 'Every AI provider key saved in this computer’s keychain.',
    warning: `Every saved AI provider key on this computer is deleted from the keychain. Summaries and Ask stop working on a hosted provider until you add a key again in Settings › AI. ${KEPT}`,
  },
  {
    id: 'repo_keys', label: 'Erase all repo API keys', route: '/api/admin/erase-repo-keys', typed: false,
    removes: 'Every source key saved in this computer’s keychain.',
    warning: `Every saved source key on this computer is deleted from the keychain. A source that needs a key is recorded as not asked until you add it again in Settings › Sources. ${KEPT}`,
  },
  {
    id: 'configs', label: 'Erase all configs', route: '/api/admin/erase-configs', typed: true,
    removes: 'Every saved search, and every watch linked to a saved configuration.',
    warning: `Every saved search is deleted, and so is every watch linked to a saved configuration: their scheduled runs stop. Runs that already happened are kept, without the link to what they came from. ${KEPT}`,
  },
  {
    id: 'executions', label: 'Erase execution history', route: '/api/admin/erase-executions', typed: true,
    removes: 'Every run, and the run counter. The papers they found are kept.',
    warning: `Every run is deleted from the run log and the run counter starts again at 1. Reports and logs on disk are no longer reachable from resmon. The papers those runs found stay in your collection. ${KEPT}`,
  },
  {
    id: 'corpus', label: 'Erase the paper corpus', route: '/api/admin/erase-corpus', typed: true,
    removes: 'Every paper resmon has collected, with its retraction and version records. Runs, watches, settings and keys are kept.',
    warning: 'Every paper in your collection is deleted: everything Search finds, Today maps and Analytics measures, and every '
      + 'retraction or version notice recorded against them. Runs stay, with no papers. Nothing here brings them back: asking '
      + 'again collects what the sources hold now, and every “first seen” date starts over. Your Library stays; its links to '
      + 'the deleted papers are removed.',
  },
  {
    id: 'execution_data', label: 'Erase all execution data', route: '/api/admin/erase-execution-data', typed: true,
    removes: 'Erase all configs and Erase execution history together. Papers, settings and keys are kept.',
    warning: `Every saved search, every watch linked to one, and every run are deleted, and the run counter starts again. Keys, settings and your collected papers stay. ${KEPT}`,
  },
  {
    id: 'app_data', label: 'Erase all app data', route: '/api/admin/erase-app-data', typed: true,
    removes: 'Every key, saved search, run and paper. Settings other than AI are kept.',
    warning: 'Every key (AI and sources), every saved search, every watch linked to one, every run and every collected paper '
      + 'is deleted. Settings other than AI stay; AI goes back to having no keys. Your Library stays; its links to the deleted '
      + 'papers are removed.',
  },
  {
    id: 'reset_settings', label: 'Reset all settings', route: '/api/admin/reset-settings', typed: true,
    removes: 'Every setting back to its default, and every key and the email password erased. Runs and saved searches are kept.',
    warning: `Every Settings group goes back to its defaults, and every saved key (AI, sources) and the email password are erased. Saved searches and runs stay. ${KEPT}`,
  },
  {
    id: 'factory', label: 'Factory reset', route: '/api/admin/factory-reset', typed: true,
    removes: 'Every key, saved search, run, paper and setting on this computer. The Library is kept.',
    warning: 'Every key, every saved search, every run, every paper in your collection and every setting on this computer is '
      + 'erased. This cannot be undone. Your Library stays; its links to the deleted papers are removed.',
  },
];

/** Each count the engine answers, by the name this screen gives the thing. */
const COUNTED: Record<string, string> = {
  ai_keys: 'AI keys', repo_keys: 'source keys', configs: 'saved configurations', executions: 'runs', documents: 'papers',
};

/** What the engine said it removed, in words: every `<thing>_removed` count it answered, and nothing it did not. */
export function removedWords(body: unknown): string {
  if (!body || typeof body !== 'object') return 'Done.';
  const parts = Object.entries(body as Record<string, unknown>)
    .filter(([key, value]) => key.endsWith('_removed') && typeof value === 'number')
    .map(([key, value]) => {
      const thing = key.replace(/_removed$/, '');
      return `${value} ${COUNTED[thing] ?? thing.replace(/_/g, ' ')}`;
    });
  return parts.length ? `Removed ${parts.join(', ')}.` : 'Done.';
}

/**
 * The admin routes are answered raw: they refuse with the engine's own
 * sentence (the word was not CONFIRM, a run is in progress), and that
 * sentence is what is shown.
 */
async function call(route: string, typed: boolean, word: string): Promise<{ status: number; body: unknown }> {
  const port = bridge()?.getBackendPort() ?? '';
  if (!port) throw new EngineError(0, 'This window has no backend connection yet.');
  const token = bridge()?.getApiToken();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typed ? JSON.stringify({ confirm: word }) : '{}',
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

function refusalWords(body: unknown, status: number): string {
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : null;
  return typeof detail === 'string' ? detail : `The engine refused it (HTTP ${status}).`;
}

/**
 * Danger zone: the erasures, each behind its own confirmation. Nothing here
 * runs on one click: the warning opens first, and the ones that delete what
 * resmon collected need the word CONFIRM typed, which the engine checks again
 * itself.
 */
export function DangerZone() {
  return (
    <section className="settings-group danger" aria-labelledby="danger-title" aria-busy={false}>
      <h2 id="danger-title" className="group-title">Danger zone</h2>
      <p className="group-lede">
        Erasures cannot be undone from inside resmon. A backup made before one can bring back what the backup holds,
        which never includes keys or passwords.
      </p>
      <ol className="danger-list">
        {ACTIONS.map((action) => <DangerRow key={action.id} action={action} />)}
      </ol>
    </section>
  );
}

function DangerRow({ action }: { action: Action }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = !action.typed || word === 'CONFIRM';
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const { status, body } = await call(action.route, action.typed, word);
      if (status >= 200 && status < 300) {
        setSaid({ ok: true, text: removedWords(body) });
        setOpen(false);
        setWord('');
        // Everything read before this may now describe what no longer exists.
        await client.invalidateQueries();
      } else {
        setSaid({ ok: false, text: refusalWords(body, status) });
      }
    } catch (error) {
      setSaid({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="danger-row" data-danger={action.id}>
      <div className="danger-head">
        <div>
          <p className="danger-name">{action.label}</p>
          <p className="danger-removes">{action.removes}</p>
        </div>
        {!open && (
          <button type="button" className="btn sm danger" aria-label={action.label} onClick={() => { setSaid(null); setOpen(true); }}>
            {action.id === 'reset_settings' || action.id === 'factory' ? 'Reset…' : 'Erase…'}
          </button>
        )}
      </div>
      {open && (
        <form className="danger-confirm" role="group" aria-label={`Confirm: ${action.label}`} onSubmit={confirm}>
          <p>{action.warning}</p>
          {action.typed && (
            <label className="form-field" htmlFor={`danger-${action.id}`}>
              <span className="form-label">Type CONFIRM to go ahead</span>
              <input id={`danger-${action.id}`} value={word} autoComplete="off" spellCheck={false} placeholder="Type CONFIRM"
                onChange={(e) => setWord(e.target.value)} autoFocus />
            </label>
          )}
          <div className="form-actions">
            <button type="submit" className="btn danger" disabled={!ready || busy}>{busy ? 'Erasing' : 'Confirm'}</button>
            <button type="button" className="btn quiet" onClick={() => { setOpen(false); setWord(''); }}>Cancel</button>
          </div>
        </form>
      )}
      {said && <p className={said.ok ? 'settings-said' : 'field-error'} role={said.ok ? 'status' : 'alert'}>{said.text}</p>}
    </li>
  );
}
