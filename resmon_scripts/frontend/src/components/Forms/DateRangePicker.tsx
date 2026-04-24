import React from 'react';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
}

const DateRangePicker: React.FC<Props> = ({
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
}) => {
  const setRelative = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    onDateFromChange(from.toISOString().slice(0, 10));
    onDateToChange(to.toISOString().slice(0, 10));
  };

  return (
    <div className="form-field">
      <label className="form-label">
        Date Range
        <InfoTooltip text="Restricts results to records published / indexed within this range. Leave blank to let the repository return any date. Some repositories (e.g. bioRxiv, medRxiv) require a range and will substitute a sensible default if none is provided." />
      </label>
      <div className="date-range-row">
        <div className="date-input-group">
          <label className="form-label-sm">From</label>
          <input
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(e) => onDateFromChange(e.target.value)}
          />
        </div>
        <div className="date-input-group">
          <label className="form-label-sm">To</label>
          <input
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(e) => onDateToChange(e.target.value)}
          />
        </div>
      </div>
      <div className="date-quick-btns">
        <button type="button" className="btn btn-sm" onClick={() => setRelative(1)}>Last 24h</button>
        <button type="button" className="btn btn-sm" onClick={() => setRelative(7)}>Last 7d</button>
        <button type="button" className="btn btn-sm" onClick={() => setRelative(14)}>Last 14d</button>
        <button type="button" className="btn btn-sm" onClick={() => setRelative(30)}>Last 30d</button>
        <button type="button" className="btn btn-sm" onClick={() => setRelative(90)}>Last 90d</button>
      </div>
    </div>
  );
};

export default DateRangePicker;
