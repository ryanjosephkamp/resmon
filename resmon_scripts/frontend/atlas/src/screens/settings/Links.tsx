import { useEffect, useState } from 'react';
import { bridge, isMac } from '../../bridge';
import { SEARCH_NAMES, useWebLinks, type WebLinkSearch } from '../../shell/webLinks';

/**
 * Settings › Links: where a web link you follow opens, how resmon's browser
 * opens it, and what its address field searches with. A right-click on a link
 * still offers each way, whatever is chosen here.
 */
export function Links() {
  const { stored, loaded, save, saveError, loadError } = useWebLinks();
  const mac = isMac();
  const [browserName, setBrowserName] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    let live = true;
    void bridge()?.defaultBrowser?.().then((name) => { if (live) setBrowserName(name); }, () => undefined);
    return () => { live = false; };
  }, []);
  const yours = browserName ? `Your Default Browser (${browserName})` : 'Your Default Browser';
  const inResmon = stored.open_in === 'resmon';
  return (
    <section className="settings-group links-settings" aria-labelledby="links-title">
      <h2 id="links-title" className="group-title">Links</h2>
      <p className="group-lede">
        Where a link to a web page opens when you click it, such as a paper’s page at its source or a license.
        Right-click a link for the other ways, whatever you choose here. Kept in resmon’s own database, so every
        window and every launch opens links the same way.
      </p>
      <div className="settings-form">
        <fieldset className="choices" data-links="open-in" disabled={!loaded}>
          <legend className="field-title">Open web links in</legend>
          <label className="choice">
            <input type="radio" name="links-open-in" value="resmon" checked={inResmon}
              onChange={() => { save({ ...stored, open_in: 'resmon' }); setSaid('Web links open in resmon’s browser.'); }} />
            <span>resmon’s Browser</span>
          </label>
          <label className="choice">
            <input type="radio" name="links-open-in" value="browser" checked={!inResmon}
              onChange={() => { save({ ...stored, open_in: 'browser' }); setSaid(`Web links open in ${browserName ?? 'your default browser'}.`); }} />
            <span>{yours}</span>
          </label>
          <p className="form-hint">
            resmon’s browser is a window of its own beside resmon, with Back, Forward, Reload, and an address
            field. Its Open in Your Browser button hands the page to your own browser.
          </p>
        </fieldset>

        {mac && (
          <fieldset className="choices" data-links="new" disabled={!loaded || !inResmon}>
            <legend className="field-title">In resmon’s browser, open each link in</legend>
            <label className="choice">
              <input type="radio" name="links-new" value="window" checked={stored.new === 'window'}
                onChange={() => { save({ ...stored, new: 'window' }); setSaid('Each link opens in a new window.'); }} />
              <span>A New Window</span>
            </label>
            <label className="choice">
              <input type="radio" name="links-new" value="tab" checked={stored.new === 'tab'}
                onChange={() => { save({ ...stored, new: 'tab' }); setSaid('Each link opens in a new tab of resmon’s browser.'); }} />
              <span>A New Tab</span>
            </label>
            <p className="form-hint">
              Tabs gather in one window of resmon’s browser, apart from resmon’s own windows. ⌘T opens an empty
              tab there, and the Window menu merges, moves, and shows its tabs.
            </p>
          </fieldset>
        )}

        <label className="form-field" data-links="search">
          <span className="form-label">Search from the address field with</span>
          <select value={stored.search} disabled={!loaded}
            onChange={(event) => {
              const search = event.target.value as WebLinkSearch;
              save({ ...stored, search });
              setSaid(`The address field searches with ${SEARCH_NAMES[search]}.`);
            }}>
            {(Object.keys(SEARCH_NAMES) as WebLinkSearch[]).map((search) => (
              <option key={search} value={search}>{SEARCH_NAMES[search]}</option>
            ))}
          </select>
          <span className="form-hint">
            What you type there that is not an address. A DOI, such as 10.1038/nphys1170, opens at doi.org.
          </span>
        </label>
      </div>
      <p className="sr-only" role="status">{said}</p>
      {(saveError || loadError) && (
        <p className="field-error" role="alert">
          {saveError
            ? `The engine did not store that (${saveError.message}). Settings shows what it holds.`
            : `The engine did not answer (${loadError?.message}). Changes cannot be saved until it does.`}
        </p>
      )}
    </section>
  );
}
