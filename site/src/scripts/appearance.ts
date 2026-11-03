/**
 * The top bar's appearance control: the theme, and the accent's hue.
 *
 * Both are kept in this browser for the next visit, under one key, with the
 * dial's tones already worked out, so the small script in every page's head
 * (`Base.astro`) can set them before the first paint. Where storage is
 * refused, as a private window may, a choice lasts for the visit. Nothing
 * leaves the browser.
 */
import { DEFAULT_HUE, DIAL_PROPERTIES, TRACK, dialProperties, hueName } from '../lib/dial';

type Theme = 'system' | 'light' | 'dark';
interface Kept {
  theme: Theme;
  /** Null while the dial is at rest, on the app's own amber. */
  hue: number | null;
}

const KEY = 'resmon:appearance';
const root = document.documentElement;

function read(): Kept {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const theme: Theme = kept?.theme === 'light' || kept?.theme === 'dark' ? kept.theme : 'system';
    const hue = Number.isInteger(kept?.hue) && kept.hue >= 0 && kept.hue < 360 ? kept.hue : null;
    return { theme, hue };
  } catch {
    return { theme: 'system', hue: null };
  }
}

let state = read();

function apply(next: Kept): void {
  state = next;
  if (next.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = next.theme;
  const tones = next.hue === null ? null : dialProperties(next.hue);
  for (const name of DIAL_PROPERTIES) {
    const value = tones?.[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  try {
    if (next.theme === 'system' && next.hue === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ ...next, ...(tones ? { tones } : {}) }));
  } catch {
    // Storage refused: the choice holds until the page is left.
  }
  // The plate is drawn on a canvas, which reads its colors once; this tells it to read them again.
  document.dispatchEvent(new CustomEvent('resmon:appearance'));
}

// The tones are worked out again on every page, so a stored set always matches this page's dial.
apply(state);

const control = document.querySelector<HTMLElement>('[data-appearance]');
const button = control?.querySelector<HTMLButtonElement>('.appearance-button');
const panel = control?.querySelector<HTMLElement>('.appearance-panel');
const dial = control?.querySelector<HTMLInputElement>('.dial input');
const named = control?.querySelector<HTMLElement>('.hue-name');
const reset = control?.querySelector<HTMLButtonElement>('.hue-reset');
const themes = [...(control?.querySelectorAll<HTMLInputElement>('input[name="theme"]') ?? [])];

if (control && button && panel && dial && named && reset) {
  dial.style.setProperty('--track', TRACK);

  const sync = () => {
    for (const radio of themes) radio.checked = radio.value === state.theme;
    const hue = state.hue ?? DEFAULT_HUE;
    dial.value = String(hue);
    named.textContent = hueName(hue);
    dial.setAttribute('aria-valuetext', `${hueName(hue)}, ${hue} degrees`);
    reset.disabled = state.hue === null;
  };

  const open = (shown: boolean) => {
    panel.hidden = !shown;
    button.setAttribute('aria-expanded', String(shown));
  };

  button.addEventListener('click', () => open(panel.hidden));
  for (const radio of themes) {
    radio.addEventListener('change', () => {
      if (radio.checked) apply({ ...state, theme: radio.value as Theme });
    });
  }
  dial.addEventListener('input', () => {
    const hue = Number(dial.value);
    apply({ ...state, hue: hue === DEFAULT_HUE ? null : hue });
    sync();
  });
  reset.addEventListener('click', () => {
    apply({ ...state, hue: null });
    sync();
    dial.focus();
  });
  // The panel closes on Escape, back to its button, or on a click anywhere else.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    open(false);
    button.focus();
  });
  document.addEventListener('click', (event) => {
    if (!panel.hidden && event.target instanceof Node && !control.contains(event.target)) open(false);
  });

  sync();
  control.hidden = false;
}
