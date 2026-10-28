import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent,
} from 'react';
import { DEFAULT_ACCENT, SUGGESTED_ACCENTS, normalizeHex } from '../theme/accent';
import { Icon } from '../shell/Icon';
import { clamp01, hexToHsv, hsvToHex, type Hsv } from './hsv';

export interface AccentPickerHandle { focus: () => void }

interface Props {
  /** The color being drawn: a preview while one is open, else the stored one. */
  value: string;
  /** Whether nothing has been chosen, so the default is in use. */
  isDefault: boolean;
  /** Draw a color without storing it. */
  onPreview: (hex: string) => void;
  /** Store a color, or null for the default. */
  onCommit: (hex: string | null) => void;
}

/** How long a keyboard change waits for the next key before it is stored. */
const SETTLE_MS = 400;

/**
 * Any color: a saturation-and-brightness field over a hue strip, a hex field,
 * and a few suggestions. Dragging draws the color live and stores it when the
 * pointer lets go; the arrow keys do the same, stored once they pause.
 */
export const AccentPicker = forwardRef<AccentPickerHandle, Props>(function AccentPicker(
  { value, isDefault, onPreview, onCommit },
  ref,
) {
  const field = useRef<HTMLDivElement>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const [hexError, setHexError] = useState<string | null>(null);
  const pending = useRef<{ hex: string; timer: number } | null>(null);
  const dragging = useRef(false);
  // The last color drawn, and the latest commit callback. Refs, because a
  // pointer-up or a timer can run before the render that would hand a fresh
  // closure the newest of either.
  const lastShown = useRef(value);
  const commitRef = useRef(onCommit);
  useEffect(() => { commitRef.current = onCommit; });

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus() }), []);

  // A value from outside (a suggestion, the default, the stored value coming
  // back) moves the picker, keeping its hue where the new color has none.
  useEffect(() => {
    setHsv((current) => (hsvToHex(current) === value ? current : hexToHsv(value, current.h)));
    lastShown.current = value;
    setHexText(value);
    setHexError(null);
  }, [value]);

  const flush = () => {
    const waiting = pending.current;
    if (!waiting) return;
    window.clearTimeout(waiting.timer);
    pending.current = null;
    commitRef.current(waiting.hex);
  };

  // Leaving the screen mid-change stores what was last drawn.
  useEffect(() => () => {
    const waiting = pending.current;
    if (!waiting) return;
    window.clearTimeout(waiting.timer);
    pending.current = null;
    commitRef.current(waiting.hex);
  }, []);

  const show = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    lastShown.current = hex;
    setHexText(hex);
    setHexError(null);
    onPreview(hex);
    return hex;
  };

  const showAndSettle = (next: Hsv) => {
    const hex = show(next);
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = { hex, timer: window.setTimeout(flush, SETTLE_MS) };
  };

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    show({
      h: hsv.h,
      s: clamp01((event.clientX - box.left) / box.width),
      v: clamp01(1 - (event.clientY - box.top) / box.height),
    });
  };

  const onFieldKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: clamp01(hsv.s - step) },
      ArrowRight: { s: clamp01(hsv.s + step) },
      ArrowUp: { v: clamp01(hsv.v + step) },
      ArrowDown: { v: clamp01(hsv.v - step) },
      Home: { s: 0 },
      End: { s: 1 },
      PageUp: { v: 1 },
      PageDown: { v: 0 },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    showAndSettle({ ...hsv, ...move });
  };

  const commitHex = () => {
    const hex = normalizeHex(hexText);
    if (!hex) {
      setHexError('Not a color. Use six hex digits, like #ff8a3d.');
      return;
    }
    setHexError(null);
    if (hex !== value) {
      show(hexToHsv(hex, hsv.h));
      onCommit(hex);
    } else {
      setHexText(hex);
    }
  };

  const current = hsvToHex(hsv);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const hueStyle = { '--hue': `${hsv.h}` } as CSSProperties;

  return (
    <div className="picker" style={hueStyle}>
      <div
        ref={field}
        className="picker-field"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${pct(hsv.s)}, brightness ${pct(hsv.v)}`}
        aria-describedby="picker-keys"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          dragging.current = true;
          fromPointer(event);
        }}
        onPointerMove={(event) => { if (dragging.current) fromPointer(event); }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(lastShown.current);
        }}
        onPointerCancel={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(lastShown.current);
        }}
        onKeyDown={onFieldKey}
      >
        <span
          className="picker-thumb"
          style={{ left: pct(hsv.s), top: pct(1 - hsv.v), background: current }}
          aria-hidden="true"
        />
      </div>
      <p id="picker-keys" className="sr-only">
        Left and right change saturation, up and down change brightness; hold Shift for larger steps.
      </p>

      <input
        className="picker-hue"
        type="range"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h) % 360}
        aria-label="Hue"
        aria-valuetext={`Hue ${Math.round(hsv.h) % 360} degrees`}
        onChange={(event) => showAndSettle({ ...hsv, h: Number(event.target.value) })}
        onPointerUp={flush}
      />

      <div className="picker-row">
        <label className="picker-hex">
          <span className="picker-swatch" style={{ background: current }} aria-hidden="true" />
          <span className="sr-only">Hex color</span>
          <input
            value={hexText}
            onChange={(event) => setHexText(event.target.value)}
            onBlur={commitHex}
            onKeyDown={(event) => { if (event.key === 'Enter') commitHex(); }}
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            aria-invalid={hexError ? true : undefined}
            aria-describedby={hexError ? 'picker-hex-error' : undefined}
          />
        </label>
        <button
          type="button"
          className="btn quiet sm"
          onClick={() => onCommit(null)}
          disabled={isDefault}
          title={`The default, ${DEFAULT_ACCENT}`}
        >
          <Icon name="reset" size={14} />
          Use the default
        </button>
      </div>
      {hexError && <p id="picker-hex-error" className="field-error" role="alert">{hexError}</p>}

      <div className="picker-suggestions" role="group" aria-label="Suggestions">
        {SUGGESTED_ACCENTS.map((suggestion) => (
          <button
            key={suggestion.hex}
            type="button"
            className="picker-suggestion"
            style={{ background: suggestion.hex }}
            aria-label={suggestion.name}
            aria-pressed={current === suggestion.hex}
            title={`${suggestion.name}, ${suggestion.hex}`}
            onClick={() => onCommit(suggestion.hex)}
          />
        ))}
      </div>
    </div>
  );
});
