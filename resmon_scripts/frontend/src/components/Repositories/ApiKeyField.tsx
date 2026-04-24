import React, { useEffect, useRef, useState } from 'react';

const MASK = '*'.repeat(12);

interface Props {
  /** Whether a saved key exists in the OS keyring for this credential. */
  present: boolean;
  /** Inline (uncommitted) value typed by the user, if any. */
  value: string;
  onChange: (value: string) => void;
  /** Called when the user hits Enter. Return a promise if async. */
  onSave?: (value: string) => void | Promise<void>;
  /** Called when the user clicks Clear (delete credential). */
  onClear?: () => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** When true, clicking Clear is offered even if no inline value yet. */
  allowClearWhenPresent?: boolean;
}

/**
 * Single-line API-key input.
 *
 * - Enter submits (calls onSave).
 * - When a saved key is present and the field is not focused and not
 *   being edited, a fixed 12-char mask is displayed.
 * - Escape/blur with no uncommitted input restores the mask.
 * - Raw key text is never echoed from the backend.
 */
const ApiKeyField: React.FC<Props> = ({
  present,
  value,
  onChange,
  onSave,
  onClear,
  placeholder,
  disabled,
  ariaLabel,
  allowClearWhenPresent = true,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);

  const showMask = present && !focused && !editing && value.length === 0;

  useEffect(() => {
    if (value.length === 0) setEditing(false);
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim().length > 0 && onSave) {
        void onSave(value.trim());
      }
    } else if (e.key === 'Escape') {
      onChange('');
      setEditing(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="api-key-field">
      <input
        ref={inputRef}
        type="text"
        className="form-input"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel || 'API key'}
        disabled={disabled}
        placeholder={showMask ? MASK : (placeholder || 'Enter API key')}
        value={showMask ? '' : value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => { setEditing(true); onChange(e.target.value); }}
        onKeyDown={handleKeyDown}
      />
      {present && allowClearWhenPresent && onClear && (
        <button
          type="button"
          className="btn btn-sm btn-secondary api-key-clear"
          onClick={() => void onClear()}
          disabled={disabled}
          aria-label="Clear saved API key"
        >
          Clear
        </button>
      )}
    </div>
  );
};

export default ApiKeyField;
