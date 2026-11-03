import { useState, type FocusEvent, type InputHTMLAttributes } from 'react';

type Props = {
  value: number;
  min: number;
  max: number;
  onValue: (n: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'>;

/**
 * A whole number a person types freely. The field can be emptied and typed
 * again: a value is stored as soon as it is a whole number from `min` to
 * `max`, and leaving the field shows what is stored, a number past either end
 * taken to that end. Clamped on every keystroke, an emptied field became `min`
 * at once, so a 10 could not be replaced by a 5 without reading 1, then 15.
 */
export function CountField({ value, min, max, onValue, onBlur, ...rest }: Props) {
  const [text, setText] = useState(String(value));
  // A value set from outside (a reset, a form filled from a saved search) is shown as it is,
  // worked out while rendering rather than in an effect, so it never paints the old one first.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (text.trim() === '' || Number(text) !== value) setText(String(value));
  }
  const leave = (event: FocusEvent<HTMLInputElement>) => {
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) {
      const kept = Math.max(min, Math.min(max, Math.round(n)));
      if (kept !== value) onValue(kept);
      setText(String(kept));
    } else {
      setText(String(value));
    }
    onBlur?.(event);
  };
  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const n = Number(next);
        if (next.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onValue(n);
      }}
      onBlur={leave}
    />
  );
}
