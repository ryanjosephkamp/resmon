import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { isMac, platform } from '../../bridge';
import { keysText, shortcut } from '../../shell/shortcuts';
import { useShowShortcuts } from '../../shell/shortcutsSheetContext';
import {
  buildWords, COPYRIGHT, CREDIT_LINKS, ISSUES_URL, LICENSE_TEXT, MAKER, SPONSOR_URL, UPDATE_CHECK, versionWords,
} from './aboutFacts';
import { CreditMark, Heart } from './CreditIcons';
import { keychainName } from './model';

/**
 * Settings › About resmon: who made it, which resmon this is, the license it
 * is shared under, what it keeps on this computer and what it sends
 * elsewhere, where to report a problem, and the keyboard's shortcuts.
 *
 * Every sentence here is a statement about this build, checked against the
 * code that does it: the engine's routes and clients for what is stored and
 * sent, `credential_manager` for the keychain, `backup` for what a backup
 * leaves out, and `electron/main.ts` for the update check. Nothing on this
 * page sends anything, and drawing it asks nothing of any server but the
 * engine on this computer: its marks are drawn here, not fetched, and each
 * link (the maker's, and the report link) opens its site only when clicked,
 * in a window of its own.
 */
export function About() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => answer(engine().GET('/api/health')) });
  const build = buildWords(health.data);
  const keychain = keychainName(platform());
  const showShortcuts = useShowShortcuts();
  return (
    <section className="settings-group about" aria-labelledby="about-title" aria-busy={health.isPending}>
      <h2 id="about-title" className="group-title">About resmon</h2>
      <p className="group-lede">
        Who made resmon, which copy this is, the license it is shared under, what it keeps on this computer and what it
        sends elsewhere, and where to report a problem.
      </p>

      <div className="about-part" data-about="credit">
        <h3 className="field-title">Who made it</h3>
        <div className="credit-row">
          <p className="credit-made">
            Made by <a href={MAKER.website} target="_blank" rel="noreferrer noopener" data-about="maker">{MAKER.name}</a>
          </p>
          <ul className="credit-links" aria-label={`${MAKER.name} online`}>
            {CREDIT_LINKS.map((link) => (
              <li key={link.icon}>
                <a href={link.href} target="_blank" rel="noreferrer noopener" aria-label={link.label} title={link.title}
                  data-credit={link.icon}>
                  <CreditMark icon={link.icon} />
                </a>
              </li>
            ))}
          </ul>
          <a className="credit-sponsor" href={SPONSOR_URL} target="_blank" rel="noreferrer noopener" data-about="sponsor">
            <Heart />Sponsor on GitHub
          </a>
        </div>
        <p className="form-hint">
          Each opens its site in a window of its own when clicked; nothing is asked of those sites to draw them here.
        </p>
      </div>

      <div className="about-part" data-about="version">
        <h3 className="field-title">This copy</h3>
        <dl className="facts">
          <div><dt>Version</dt><dd data-about="version-words">{versionWords(health.data, health.error)}</dd></div>
          {build && <div><dt>Build</dt><dd data-about="build">{build}</dd></div>}
          {health.data && (
            <div>
              <dt>Database</dt>
              <dd>{health.data.identity.schema_version === null ? 'Schema not recorded' : `Schema ${health.data.identity.schema_version}`}</dd>
            </div>
          )}
        </dl>
        <p className="form-hint">
          The version is the one the engine this window is using reports for itself. <Link to="/health/engine">Health ›
          This engine</Link> says which engine that is.
        </p>
      </div>

      <div className="about-part" data-about="license">
        <h3 className="field-title">License</h3>
        <p className="about-text">resmon is shared under the MIT License. {COPYRIGHT}.</p>
        <p className="about-text">
          Anyone may use, copy, change, merge, publish, distribute, sublicense, and sell copies of it, free of charge, as
          long as the copyright notice and the permission notice go with every copy. It is provided as is, without
          warranty of any kind.
        </p>
        <details className="about-license">
          <summary>The license in full</summary>
          <pre>{LICENSE_TEXT}</pre>
        </details>
      </div>

      <div className="about-part" data-about="privacy">
        <h3 className="field-title">What resmon keeps</h3>
        <ul className="about-list">
          <li>
            What resmon collects and makes is stored on this computer: the papers it finds, its runs with their reports and
            logs, your watches and saved searches, the reading queue, your conversations with the assistant, and the files
            you add to the Library. They are kept in resmon’s database, its reports folder, and the Library folder you
            chose, and leave it only in the ways listed below.
          </li>
          <li>
            Keys and passwords (sources’ API keys, AI providers’ keys, the email password, and webhook secrets) are kept
            in {keychain}, not in the database. A backup carries none of them, and neither does an
            export of saved searches; restoring a backup names the ones to enter again.
          </li>
          <li>resmon has no account and no server of its own, and it sends no record of how you use it.</li>
        </ul>

        <h3 className="field-title">What it sends, and to whom</h3>
        <ul className="about-list">
          <li>
            <b>Searches.</b> A search, whether you ask it or a watch runs it, sends its terms, dates, and limits to each
            source it asks, and to no other. A source’s API key goes only to that source. A watch that follows a person
            sends that person’s name, and any identifier you gave for them such as an ORCID, to its sources.
          </li>
          <li>
            <b>Summaries and search by meaning</b>, only once you set them up in{' '}
            <Link to="/settings/ai">Settings › AI</Link>. A run that summarizes sends each paper’s title and abstract to the
            provider set there, or set for that run or watch (Meta’s models are reached through Together AI), or to the
            Claude Code or Codex command, which passes them to Anthropic or OpenAI under your own sign-in. With an embedding
            model, each new paper’s title and abstract go to its provider after every run, and a search by meaning sends
            what you typed. A local model, such as Ollama, runs on this computer unless you give resmon another address
            for it.
          </li>
          <li>
            <b>The assistant</b>, when you send it a message. It sends your messages, and what its tools read from your
            collection, to the connection the conversation uses. An answer in Library › Evidence sends the passages you
            chose, and shows them to you first.
          </li>
          <li>
            <b>Retraction checks.</b> Checking papers for retractions and newer versions sends their DOIs, and their arXiv
            and bioRxiv ids, to Crossref, arXiv, and bioRxiv. It runs only when you start a check, or when a watch set to
            check runs.
          </li>
          <li>
            <b>Reports.</b> A report leaves this computer only where you send it. A watch’s email and webhook destinations
            are sent each of its reports when it runs, or once you release the report if you chose to review it first; a
            folder or a feed is written on this computer.
          </li>
          <li>
            <b>Backups.</b> A backup is written to the folder you choose in{' '}
            <Link to="/settings/storage">Settings › Backup</Link>, on this computer. If that is a folder Google Drive for
            desktop keeps, that app uploads it; resmon itself does not sign in to Google.
          </li>
          <li>
            <b>Updates.</b> On Windows and Linux, an installed resmon asks GitHub for a newer version about{' '}
            {UPDATE_CHECK.firstAfterSeconds} seconds after it opens and every {UPDATE_CHECK.everyHours} hours after that,
            downloads one when there is one, and installs it when you restart or quit. No setting turns this off. On macOS
            it does not check.
          </li>
          <li>
            <b>Links.</b> A link you open, such as a paper’s DOI or a tutorial, opens that site in a window of its own.
          </li>
        </ul>
      </div>

      <div className="about-part" data-about="report">
        <h3 className="field-title">Report a problem</h3>
        <p className="about-text">
          Report a problem, or ask for something, on resmon’s issues page on GitHub. Nothing is sent from here: the link
          opens the page, and you write the issue there and submit it yourself, from your own GitHub account. Giving the
          version above helps.
        </p>
        <p className="about-actions">
          <a className="btn" data-about="issues" href={ISSUES_URL} target="_blank" rel="noreferrer noopener">
            Open resmon’s issues on GitHub
          </a>
        </p>
      </div>

      {showShortcuts && (
        <div className="about-part" data-about="shortcuts">
          <h3 className="field-title">Keyboard shortcuts</h3>
          <p className="about-text">
            New Deep Dive is {keysText(shortcut('new-dive').chord, isMac())}, a new conversation in Ask
            is {keysText(shortcut('new-conversation').chord, isMac())}, and each section has its own. The full list is
            one key away from anywhere: press ?, outside a text field.
          </p>
          <p className="about-actions">
            <button type="button" className="btn" data-about="show-shortcuts" onClick={showShortcuts}>
              Keyboard shortcuts
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
