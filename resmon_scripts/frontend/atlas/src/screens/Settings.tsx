import { useEffect, useRef, type CSSProperties } from 'react';
import { NavLink, useParams, useSearchParams } from 'react-router-dom';
import { systemName } from '../bridge';
import { AccentPicker, type AccentPickerHandle } from '../settings/AccentPicker';
import {
  DEFAULT_ACCENT, SURFACES, accentProperties, accentTones, contrast, leastContrast,
  type AccentTones, type ThemeName,
} from '../theme/accent';
import { useAppearance, type ThemeChoice } from '../theme/appearance';
import { Ai } from './settings/Ai';
import { Background } from './settings/Background';
import { Email } from './settings/Email';
import { Notifications } from './settings/Notifications';
import { GROUPS, groupPath } from './settings/model';

/** The tones of one theme as inline custom properties, for a sample drawn in it. */
function toneStyle(tones: AccentTones): CSSProperties {
  return accentProperties(tones) as CSSProperties;
}

/**
 * Stars for the miniature plates: fixed, so every card shows the same patch
 * of sky and only the theme differs. [x, y, radius, brightness].
 */
const STARS: readonly [number, number, number, number][] = [
  [18, 20, 1.1, 0.5], [31, 61, 1.5, 0.8], [44, 37, 1, 0.4], [52, 74, 1.8, 0.9],
  [63, 24, 1.2, 0.6], [71, 52, 2.1, 1], [84, 33, 1, 0.45], [92, 66, 1.4, 0.7],
  [101, 18, 1.6, 0.75], [109, 47, 1.1, 0.5], [118, 77, 1.3, 0.55], [126, 29, 1.9, 0.95],
  [137, 58, 1, 0.4], [143, 40, 1.2, 0.6], [24, 82, 1, 0.35], [76, 86, 1.1, 0.45],
];

function MiniPlate() {
  return (
    <>
      <rect width="160" height="96" fill="var(--plate)" />
      <g stroke="var(--grid)" strokeWidth="1">
        <path d="M40 0V96M80 0V96M120 0V96M0 32H160M0 64H160" />
      </g>
      <ellipse cx="72" cy="50" rx="34" ry="22" fill="none" stroke="var(--bound)" strokeDasharray="2 3" />
      <path d="M31 61 52 74 71 52 63 24" fill="none" stroke="var(--band)" strokeWidth="0.75" />
      {STARS.map(([x, y, r, b]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="var(--ink)" opacity={b} />
      ))}
      <circle cx="71" cy="52" r="5.5" fill="none" stroke="var(--accent-mark)" strokeWidth="1.25" />
      <circle cx="126" cy="29" r="5.5" fill="none" stroke="var(--accent-mark)" strokeWidth="1.25" />
    </>
  );
}

function ThemeCard({ choice, label, detail, accent, selected, onChoose }: {
  choice: ThemeChoice;
  label: string;
  detail: string;
  accent: string | null;
  selected: boolean;
  onChoose: () => void;
}) {
  const half = (theme: ThemeName) => (
    <g data-theme={theme} style={toneStyle(accentTones(accent, theme))}><MiniPlate /></g>
  );
  return (
    <label className="theme-card" data-selected={selected || undefined}>
      <input type="radio" name="theme" className="sr-only" checked={selected} onChange={onChoose} />
      <svg className="theme-mini" viewBox="0 0 160 96" aria-hidden="true">
        {choice === 'system' ? (
          <>
            <defs>
              <clipPath id="mini-left"><path d="M0 0H96L64 96H0Z" /></clipPath>
              <clipPath id="mini-right"><path d="M96 0H160V96H64Z" /></clipPath>
            </defs>
            <g clipPath="url(#mini-left)">{half('dark')}</g>
            <g clipPath="url(#mini-right)">{half('light')}</g>
          </>
        ) : half(choice)}
      </svg>
      <span className="theme-label">{label}</span>
      <span className="theme-detail">{detail}</span>
    </label>
  );
}

const ratio = (n: number) => `${n.toFixed(1)} : 1`;

/**
 * The accent as each theme will draw it, with the contrast measured, not
 * promised: links and rings against the theme's least-contrasting surface, and
 * the button's text against the button.
 */
function AccentProof({ theme, accent }: { theme: ThemeName; accent: string | null }) {
  const tones = accentTones(accent, theme);
  const { surfaces } = SURFACES[theme];
  return (
    <figure className="proof" data-theme={theme} style={toneStyle(tones)}>
      <figcaption>{theme === 'dark' ? 'Dark' : 'Light'}</figcaption>
      <div className="proof-sample" aria-hidden="true">
        <span className="badge">3</span>
        <span className="proof-link">Open the paper</span>
        <span className="btn primary sm">Save</span>
      </div>
      <dl className="proof-figures">
        <div><dt>Links</dt><dd>{ratio(leastContrast(tones.ink, surfaces))}</dd></div>
        <div><dt>Rings</dt><dd>{ratio(leastContrast(tones.mark, surfaces))}</dd></div>
        <div><dt>Button text</dt><dd>{ratio(contrast(tones.fill, tones.onFill))}</dd></div>
      </dl>
      <p className="proof-note">
        {tones.adjusted
          ? `Drawn ${theme === 'dark' ? 'lighter' : 'deeper'} here, so it stays readable.`
          : 'Drawn exactly as chosen.'}
      </p>
    </figure>
  );
}

/**
 * Settings: one group at a time, chosen from the rail. Each group is its own
 * address (`/settings/email`), so a notification, a link from a watch or the
 * command palette can open the one it means.
 */
export function Settings() {
  const { group = '' } = useParams();
  const known = GROUPS.find((g) => g.slug === group);
  return (
    <section className="page page-settings" aria-labelledby="page-title">
      <h1 id="page-title" className="page-title">Settings</h1>
      <div className="settings-layout">
        <nav className="settings-rail" aria-label="Settings groups">
          {GROUPS.map((g) => <NavLink key={g.slug} to={groupPath(g.slug)} end>{g.label}</NavLink>)}
        </nav>
        <div className="settings-body">
          {!known && (
            <section className="settings-group">
              <h2 className="group-title">No such group</h2>
              <p className="group-lede">Settings has no group called “{group}”. The rail lists the ones there are.</p>
            </section>
          )}
          {known?.slug === '' && <Appearance />}
          {known?.slug === 'background' && <Background />}
          {known?.slug === 'email' && <Email />}
          {known?.slug === 'notifications' && <Notifications />}
          {known?.slug === 'ai' && <Ai />}
        </div>
      </div>
    </section>
  );
}

function Appearance() {
  const { stored, shown, theme, save, preview, saveError, loadError } = useAppearance();
  const picker = useRef<AccentPickerHandle>(null);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (params.get('focus') !== 'accent') return;
    picker.current?.focus();
    document.getElementById('accent')?.scrollIntoView({ block: 'start' });
    setParams({}, { replace: true });
  }, [params, setParams]);

  const chooseTheme = (choice: ThemeChoice) => save({ theme: choice });
  const system = systemName();
  const themes: { choice: ThemeChoice; label: string; detail: string }[] = [
    {
      choice: 'system',
      label: 'Follow the system',
      detail: stored.theme === 'system' ? `Now ${theme}, as ${system} is` : `Light or dark, as ${system} is`,
    },
    { choice: 'light', label: 'Light', detail: 'The printed atlas' },
    { choice: 'dark', label: 'Dark', detail: 'The night chart' },
  ];

  return (
    <section className="settings-group" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="group-title">Appearance</h2>
      <p className="group-lede">
        Kept in resmon’s own database, so it is the same on every launch and comes back with a backup.
      </p>

      <fieldset className="themes">
        <legend className="field-title">Theme</legend>
        <div className="theme-cards">
          {themes.map((t) => (
            <ThemeCard
              key={t.choice}
              {...t}
              accent={shown.accent}
              selected={stored.theme === t.choice}
              onChoose={() => chooseTheme(t.choice)}
            />
          ))}
        </div>
      </fieldset>

      <div className="accent" id="accent">
        <h3 className="field-title">Accent color</h3>
        <p className="field-lede">
          The rings around new papers, the current tab, links, and the main button on each screen.
          Any color works. Where one would be hard to read, resmon draws it lighter or deeper and
          shows you here.
        </p>
        <div className="accent-layout">
          <AccentPicker
            ref={picker}
            value={shown.accent ?? DEFAULT_ACCENT}
            isDefault={stored.accent === null}
            onPreview={(hex) => preview({ accent: hex })}
            onCommit={(hex) => save({ accent: hex })}
          />
          <div className="proofs">
            <AccentProof theme="dark" accent={shown.accent} />
            <AccentProof theme="light" accent={shown.accent} />
          </div>
        </div>
      </div>

      {(saveError || loadError) && (
        <p className="field-error" role="alert">
          {saveError
            ? `The engine did not store that (${saveError.message}). The screen shows what it holds.`
            : `The engine did not answer (${loadError?.message}). Changes cannot be saved until it does.`}
        </p>
      )}
    </section>
  );
}
