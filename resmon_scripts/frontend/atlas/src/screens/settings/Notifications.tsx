import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { systemName } from '../../bridge';
import { WATCHES_KEY } from '../watches/model';
import type { NotificationSettings } from './model';

const KEY = ['notification-settings'] as const;

/**
 * Notifications: when resmon posts one.
 *
 * The engine decides (`_should_dispatch_desktop_notification`), and a watch
 * whose own "Notify me when it finishes" switch is on notifies whatever is
 * chosen here. So of the three stored modes, `selected` and `none` behave the
 * same, and this screen offers the two choices that differ: every watch, or
 * only the ones set to notify. A stored `none` is shown as the second, which
 * is what it does.
 */
export function Notifications() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: () => answer(engine().GET('/api/settings/notifications')) });
  const watches = useQuery({ queryKey: WATCHES_KEY, queryFn: () => answer(engine().GET('/api/routines')) });
  /**
   * The choice as made, drawn within the click. The query cache tells its
   * readers on a later tick, and a native radio is put back to its old value
   * before then, so a choice drawn from the cache alone flickers back for a
   * frame and reads as refused.
   */
  const [choice, setChoice] = useState<NotificationSettings | null>(null);
  const save = useMutation({
    mutationFn: (next: NotificationSettings) => answer(engine().PUT('/api/settings/notifications', { body: { settings: { ...next } } })),
    onSuccess: (_saved, next) => client.setQueryData(KEY, next),
    // A refusal draws what is stored again, and the error says so.
    onError: () => {
      setChoice(null);
      void client.invalidateQueries({ queryKey: KEY });
    },
  });

  const data = choice ?? settings.data;
  const everyWatch = data?.notify_automatic_mode === 'all';
  const setToNotify = (watches.data ?? []).filter((w) => w.notify_on_complete);
  const change = (patch: Partial<NotificationSettings>) => {
    if (!data) return;
    const next = { ...data, ...patch };
    setChoice(next);
    save.mutate(next);
  };

  return (
    <section className="settings-group notifications" aria-labelledby="notifications-title" aria-busy={settings.isPending || save.isPending}>
      <h2 id="notifications-title" className="group-title">Notifications</h2>
      <p className="group-lede">
        resmon posts a notification when a search or a watch finishes, and clicking it opens the run. Whether it shows,
        and how, is up to {systemName()}’s notification settings for resmon.
      </p>
      {settings.isError && <p className="field-error" role="alert">The engine did not answer ({settings.error.message}).</p>}
      {data && (
        <div className="settings-form">
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={data.notify_manual}
            data-switch="notify_manual"
            onClick={() => change({ notify_manual: !data.notify_manual })}
          >
            <span className="switch-track"><span className="switch-knob" /></span>
            When a search I start finishes
          </button>

          <fieldset className="choices" data-notify="watches">
            <legend className="field-title">When a watch finishes</legend>
            <label className="choice">
              <input type="radio" name="notify-watches" value="all" checked={everyWatch}
                onChange={() => change({ notify_automatic_mode: 'all' })} />
              <span>Every watch</span>
            </label>
            <label className="choice">
              <input type="radio" name="notify-watches" value="selected" checked={!everyWatch}
                onChange={() => change({ notify_automatic_mode: 'selected' })} />
              <span>Only the watches set to notify</span>
            </label>
            <p className="form-hint" data-notify="set-to-notify">
              {watches.data && (setToNotify.length === 0
                ? 'No watch is set to notify. A watch’s own Notify me when it finishes switch, on its page, sets it.'
                : <>
                    Set to notify, whichever you choose:{' '}
                    {setToNotify.map((w, i) => (
                      <span key={w.id}>{i > 0 && ', '}<Link to={`/watches/${w.id}`}>{w.name}</Link></span>
                    ))}.
                  </>)}
            </p>
          </fieldset>
          {save.isSuccess && !save.isPending && <p className="settings-said" role="status">Saved.</p>}
          {save.error && (
            <p className="field-error" role="alert">
              {save.error instanceof EngineError && save.error.detail ? save.error.detail : save.error.message}. The screen shows what is stored.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
