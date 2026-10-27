import React from 'react';

/**
 * resmon's mark: a lowercase r set as a five-by-five matrix of record dots,
 * with its terminal drawn open. It is the Source wall's rule made into a
 * letter: a source that answered with nothing keeps its mark, hollow, rather
 * than disappearing. The same drawing is the app icon and the site's favicon.
 */
const R_MATRIX = ['X.XX.', 'XX..O', 'X....', 'X....', 'X....'];

const ResmonMark: React.FC<{ size?: number; className?: string }> = ({ size = 22, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 100 100"
    aria-hidden="true"
    focusable="false"
  >
    <rect width="100" height="100" rx="24" fill="#2f3fe0" />
    {R_MATRIX.flatMap((row, r) => [...row].map((cell, c) => {
      const cx = 28 + c * 11.5;
      const cy = 27 + r * 11.5;
      if (cell === 'X') return <circle key={`${r}-${c}`} cx={cx} cy={cy} r="4.7" fill="#fff" />;
      if (cell === 'O') {
        return <circle key={`${r}-${c}`} cx={cx} cy={cy} r="3.5" fill="none" stroke="#fff" strokeWidth="2.4" />;
      }
      return null;
    }))}
  </svg>
);

export default ResmonMark;
