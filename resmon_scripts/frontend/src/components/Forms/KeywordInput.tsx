import React, { useState } from 'react';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  keywords: string[];
  onChange: (keywords: string[]) => void;
}

const KeywordInput: React.FC<Props> = ({ keywords, onChange }) => {
  const [input, setInput] = useState('');

  // Strip matching outer quotation marks (", ', or the smart variants) so that
  // users can wrap multi-word keywords in quotes without the quotes ending up
  // in the displayed tag. An unquoted entry (even one containing spaces) is
  // accepted as-is so that already-well-formed multi-word input still works.
  const normalize = (raw: string): string => {
    const t = raw.trim();
    if (t.length < 2) return t;
    const first = t[0];
    const last = t[t.length - 1];
    const matchingPairs: Array<[string, string]> = [
      ['"', '"'],
      ["'", "'"],
      ['\u201C', '\u201D'], // “ ”
      ['\u2018', '\u2019'], // ‘ ’
    ];
    for (const [open, close] of matchingPairs) {
      if (first === open && last === close) {
        return t.slice(1, -1).trim();
      }
    }
    return t;
  };

  const addKeyword = () => {
    const normalized = normalize(input);
    if (normalized && !keywords.includes(normalized)) {
      onChange([...keywords, normalized]);
    }
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKeyword();
    }
  };

  const removeKeyword = (kw: string) => {
    onChange(keywords.filter((k) => k !== kw));
  };

  return (
    <div className="form-field">
      <label className="form-label">
        Keywords
        <InfoTooltip text="Terms sent to the repository API. Type one keyword and press Enter (or click +) to add it as a chip. Multi-word phrases may be wrapped in quotes (“…”). The chips are joined with spaces to build the final query string." />
      </label>
      <div className="keyword-input-row">
        <input
          type="text"
          className="form-input"
          placeholder={'Type keyword and press Enter. Use quotes for terms with spaces in them, e.g., "cell biology".'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="button" className="btn btn-sm" onClick={addKeyword}>Add</button>
      </div>
      {keywords.length > 0 && (
        <div className="keyword-tags">
          {keywords.map((kw) => (
            <span key={kw} className="keyword-tag">
              {kw}
              <button type="button" className="keyword-remove" onClick={() => removeKeyword(kw)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default KeywordInput;
