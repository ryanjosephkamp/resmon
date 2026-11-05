import { Link, useNavigate } from 'react-router-dom';
import { HOME } from '../routes';
import { canGo } from './history';
import './fallback.css';

/** The page in place of one that could not be drawn: what happened, and a way back. The top bar stays. */
export function PageFailed({ error }: { error: Error }) {
  const navigate = useNavigate();
  const back = canGo('back');
  return (
    <div className="page page-failed" role="alert" data-page="failed">
      <h1 className="page-title">This page could not be shown</h1>
      <p className="page-lede">
        Something on it stopped the window from drawing it. Nothing was changed, and the rest of resmon works as before.
      </p>
      <div className="page-failed-row">
        {back && <button type="button" className="btn" onClick={() => void navigate(-1)}>Back</button>}
        <Link className={back ? 'btn quiet' : 'btn'} to={HOME}>Open Today</Link>
      </div>
      <p className="form-hint">The window reported: {error.message || error.name}</p>
    </div>
  );
}
