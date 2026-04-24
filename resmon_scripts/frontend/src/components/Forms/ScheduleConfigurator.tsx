import React, { useMemo, useState } from 'react';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  cron: string;
  onChange: (cron: string) => void;
}

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 10 minutes', cron: '*/10 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 8 AM', cron: '0 8 * * *' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
  { label: 'Every Monday 9 AM', cron: '0 9 * * 1' },
  { label: 'Every weekday 8 AM', cron: '0 8 * * 1-5' },
  { label: 'First of month', cron: '0 0 1 * *' },
];

const FIELDS = ['Minute', 'Hour', 'Day (month)', 'Month', 'Day (week)'] as const;

type CustomUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

const UNIT_OPTIONS: { value: CustomUnit; label: string }[] = [
  { value: 'minutes', label: 'Minute(s)' },
  { value: 'hours', label: 'Hour(s)' },
  { value: 'days', label: 'Day(s)' },
  { value: 'weeks', label: 'Week(s)' },
  { value: 'months', label: 'Month(s)' },
  { value: 'years', label: 'Year(s)' },
];

function parseCustomCron(cron: string): { n: number; unit: CustomUnit } | null {
  const trimmed = cron.trim().replace(/\s+/g, ' ');
  // minutes
  if (trimmed === '* * * * *') return { n: 1, unit: 'minutes' };
  let m = trimmed.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m) return { n: parseInt(m[1], 10), unit: 'minutes' };
  // hours
  if (trimmed === '0 * * * *') return { n: 1, unit: 'hours' };
  m = trimmed.match(/^0 \*\/(\d+) \* \* \*$/);
  if (m) return { n: parseInt(m[1], 10), unit: 'hours' };
  // days
  if (trimmed === '0 0 * * *') return { n: 1, unit: 'days' };
  m = trimmed.match(/^0 0 \*\/(\d+) \* \*$/);
  if (m) {
    const d = parseInt(m[1], 10);
    // weeks (count>=2) are encoded as days */(count*7)
    if (d >= 14 && d % 7 === 0) return { n: d / 7, unit: 'weeks' };
    return { n: d, unit: 'days' };
  }
  // weeks (count=1)
  if (trimmed === '0 0 * * 1') return { n: 1, unit: 'weeks' };
  // months
  if (trimmed === '0 0 1 * *') return { n: 1, unit: 'months' };
  m = trimmed.match(/^0 0 1 \*\/(\d+) \*$/);
  if (m) return { n: parseInt(m[1], 10), unit: 'months' };
  // years
  if (trimmed === '0 0 1 1 *') return { n: 1, unit: 'years' };
  return null;
}

function buildCustomCron(n: number, unit: CustomUnit): string {
  const count = Math.max(1, Math.floor(n || 1));
  switch (unit) {
    case 'minutes':
      return count === 1 ? '* * * * *' : `*/${count} * * * *`;
    case 'hours':
      return count === 1 ? '0 * * * *' : `0 */${count} * * *`;
    case 'days':
      return count === 1 ? '0 0 * * *' : `0 0 */${count} * *`;
    case 'weeks': {
      // 5-field cron cannot express true week intervals. Approximate as
      // every (count*7) days of the month; for count=1 use the weekly
      // form (every Monday at 00:00) which is exact.
      if (count === 1) return '0 0 * * 1';
      return `0 0 */${count * 7} * *`;
    }
    case 'months':
      return count === 1 ? '0 0 1 * *' : `0 0 1 */${count} *`;
    case 'years':
      // 5-field cron has no year field; closest expressible schedule is
      // once a year on Jan 1. The N multiplier is not supported.
      return '0 0 1 1 *';
    default:
      return '0 * * * *';
  }
}

const ScheduleConfigurator: React.FC<Props> = ({ cron, onChange }) => {
  const parts = cron.split(/\s+/);
  while (parts.length < 5) parts.push('*');

  const matchingPreset = useMemo(
    () => PRESETS.find((p) => p.cron === cron),
    [cron],
  );

  // Derive the initial Custom N/unit from the incoming cron so that
  // editing a routine with a Custom schedule preserves the saved
  // choices instead of reverting to the default "1 Hour(s)".
  const initialCustom = useMemo(() => parseCustomCron(cron), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [showCustom, setShowCustom] = useState<boolean>(!matchingPreset);
  const [customN, setCustomN] = useState<number>(initialCustom?.n ?? 1);
  // Separate text state so the user can transiently clear the input
  // while typing. The numeric ``customN`` is what drives the cron.
  const [customNText, setCustomNText] = useState<string>(String(initialCustom?.n ?? 1));
  const [customUnit, setCustomUnit] = useState<CustomUnit>(initialCustom?.unit ?? 'hours');

  const updatePart = (idx: number, val: string) => {
    const next = [...parts];
    next[idx] = val || '*';
    onChange(next.join(' '));
  };

  const applyCustom = (n: number, unit: CustomUnit) => {
    setCustomN(n);
    setCustomNText(String(n));
    setCustomUnit(unit);
    onChange(buildCustomCron(n, unit));
  };

  // Highlight the Custom button whenever the user is in Custom mode,
  // regardless of whether the generated cron happens to coincide with a
  // preset (e.g. ``Hour(s) × 1`` → ``0 * * * *`` === ``Every hour``).
  const customActive = showCustom;
  const presetActive = !showCustom && !!matchingPreset;

  return (
    <div className="form-field">
      <label className="form-label">
        Schedule (Cron)
        <InfoTooltip text="Standard 5-field cron expression: minute hour day-of-month month day-of-week. Example: '0 8 * * 1-5' fires at 08:00 on weekdays. Pick a preset from the dropdown, or switch to Custom to build it with the simple interval builder." />
      </label>
      <div className="cron-presets">
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            className={`btn btn-sm ${presetActive && cron === p.cron ? 'btn-active' : ''}`}
            onClick={() => {
              setShowCustom(false);
              onChange(p.cron);
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`btn btn-sm ${customActive ? 'btn-active' : ''}`}
          onClick={() => {
            setShowCustom(true);
            // Seed the cron with the current N/unit so the preview
            // immediately reflects the Custom mode.
            onChange(buildCustomCron(customN, customUnit));
          }}
        >
          Custom
        </button>
      </div>
      {customActive && (
        <div
          className="cron-custom"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            flexWrap: 'wrap',
          }}
        >
          <span>Repeat every</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="form-input form-input-sm"
            style={{ width: 80 }}
            value={customNText}
            onChange={(e) => {
              const raw = e.target.value;
              // Allow the field to be transiently empty while the user
              // is editing. Only accept digits; anything else is
              // rejected (so ``1.5`` / ``-1`` / ``abc`` cannot appear).
              if (raw === '') {
                setCustomNText('');
                return;
              }
              if (!/^\d+$/.test(raw)) return;
              const n = parseInt(raw, 10);
              if (!Number.isFinite(n) || n < 1) {
                // Accept the text (e.g. "0") but don't rebuild the cron
                // until it becomes a valid natural number.
                setCustomNText(raw);
                return;
              }
              applyCustom(n, customUnit);
            }}
            onBlur={() => {
              // On blur, if the field is empty or invalid, snap back to
              // the last valid numeric value so the cron stays coherent.
              if (customNText === '' || !/^\d+$/.test(customNText) || parseInt(customNText, 10) < 1) {
                setCustomNText(String(customN));
              }
            }}
          />
          <select
            className="form-input form-input-sm"
            value={customUnit}
            onChange={(e) => applyCustom(customN, e.target.value as CustomUnit)}
          >
            {UNIT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {customUnit === 'years' && (
            <span className="text-muted" style={{ fontSize: 12 }}>
              Cron supports yearly only; the count is ignored for Year(s).
            </span>
          )}
          {customUnit === 'weeks' && customN > 1 && (
            <span className="text-muted" style={{ fontSize: 12 }}>
              Approximated as every {customN * 7} days of the month.
            </span>
          )}
        </div>
      )}
      <div className="cron-fields">
        {FIELDS.map((label, idx) => (
          <div key={label} className="cron-field">
            <label className="form-label-sm">{label}</label>
            <input
              type="text"
              className="form-input form-input-sm"
              value={parts[idx]}
              onChange={(e) => updatePart(idx, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="cron-preview">
        <span className="text-muted">Expression:</span>{' '}
        <code className="cron-code">{cron}</code>
      </div>
    </div>
  );
};

export default ScheduleConfigurator;
