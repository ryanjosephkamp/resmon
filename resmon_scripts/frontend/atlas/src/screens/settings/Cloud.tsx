import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { PlaceHelp } from '../watches/people/People';

const CLOUD_KEY = ['cloud-status'] as const;

/**
 * Why a linked Drive cannot be used, for the codes `api_reason` carries most:
 * Google's own error reasons. Any other code (an exception's name, or
 * `http_error`) is shown as the engine gives it.
 */
const REASONS: Record<string, string> = {
  no_token: 'No Google Drive sign-in is stored.',
  accessNotConfigured: 'The Google Drive API is not enabled on the OAuth project this copy of resmon signs in with.',
  insufficientPermissions: 'The stored sign-in does not allow resmon to write files. Disconnect and connect again.',
};

function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * Settings › Cloud Storage: the reports folder, uploaded to Google Drive over
 * a Google sign-in. It uploads reports and nothing else; a full copy of
 * resmon is the Backup group's. Nothing leaves the computer while nothing is
 * connected, and the status says which it is.
 */
export function Cloud() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: CLOUD_KEY, queryFn: () => answer(engine().GET('/api/cloud/status')) });
  const refresh = () => client.invalidateQueries({ queryKey: CLOUD_KEY });
  const link = useMutation({ mutationFn: () => answer(engine().POST('/api/cloud/link')), onSuccess: refresh });
  const unlink = useMutation({ mutationFn: () => answer(engine().POST('/api/cloud/unlink')), onSuccess: refresh });
  const upload = useMutation({ mutationFn: () => answer(engine().POST('/api/cloud/backup', { body: {} })) });
  const linked = status.data?.is_linked === true;
  const error = link.error ?? unlink.error ?? upload.error;
  return (
    <section className="settings-group cloud" aria-labelledby="cloud-title" aria-busy={status.isPending}>
      <h2 id="cloud-title" className="group-title">Cloud Storage</h2>
      <p className="group-lede">
        Uploads the reports folder to Google Drive, over a Google sign-in. It uploads the reports and nothing else:
        a full copy of resmon is in <Link to="/settings/storage">Settings › Backup</Link>.
      </p>
      <PlaceHelp summary="About uploading reports to Google Drive">
        <p>
          Each run writes a report. Upload sends the reports folder to a folder under resmon in your Google Drive.
          Connecting opens Google’s own sign-in in
          your browser, and needs this copy of resmon to have been given an OAuth client by whoever built it.
        </p>
      </PlaceHelp>
      <p className="cloud-state" data-cloud="state" data-linked={linked}>
        <span className="conv-label">Google Drive</span>{' '}
        {status.isPending ? 'Asking the engine.'
          : status.isError ? `The engine did not say (${status.error.message}).`
            : !linked ? 'Not connected. Nothing is sent to Google.'
              : status.data?.api_ok ? 'Connected, and Google Drive answered.'
                : `Connected, but Google Drive cannot be used: ${REASONS[String(status.data?.api_reason)] ?? String(status.data?.api_reason)}`}
      </p>
      <div className="form-actions">
        {linked
          ? <>
              <button type="button" className="btn primary" disabled={upload.isPending || !status.data?.api_ok} onClick={() => upload.mutate()}>
                {upload.isPending ? 'Uploading' : 'Upload the reports'}
              </button>
              <button type="button" className="btn quiet" disabled={unlink.isPending} onClick={() => unlink.mutate()}>Disconnect Google Drive</button>
            </>
          : <button type="button" className="btn" disabled={link.isPending} onClick={() => link.mutate()}>
              {link.isPending ? 'Waiting for Google' : 'Connect Google Drive'}
            </button>}
      </div>
      {upload.data && (
        <p className="settings-said" role="status">
          Uploaded {upload.data.uploaded} of {upload.data.total_files} files to resmon/{upload.data.folder_name} in Google Drive.
        </p>
      )}
      {error && <p className="field-error" role="alert">{refusal(error)}</p>}
    </section>
  );
}
