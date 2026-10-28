/**
 * The interface's few line icons, drawn on a 16-unit grid with one stroke
 * weight so they sit beside 13–14 px type. Decorative by default: a control
 * that uses one carries its own accessible name.
 */
const PATHS = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  // Sliders rather than a cog: at 16 px a cog and the sun are the same drawing.
  settings: <><path d="M2 4.5h7M12.5 4.5H14M2 11.5h2M7.5 11.5H14" /><circle cx="10.75" cy="4.5" r="1.75" /><circle cx="5.75" cy="11.5" r="1.75" /></>,
  drop: <path d="M8 1.75s-4.25 4.6-4.25 7.6a4.25 4.25 0 0 0 8.5 0c0-3-4.25-7.6-4.25-7.6Z" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1.06 1.06M4.46 11.54 3.4 12.6M12.6 12.6l-1.06-1.06M4.46 4.46 3.4 3.4" /></>,
  moon: <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />,
  system: <><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" /><path d="M5.5 14h5M8 11.25V14" /></>,
  check: <path d="m3.25 8.5 3 3 6.5-7" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  reset: <><path d="M2.75 8a5.25 5.25 0 1 0 1.54-3.71" /><path d="M2.5 2.5v2.75h2.75" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  bookmark: <path d="M4 2.5h8v11L8 10.75 4 13.5Z" />,
  bookmarked: <path d="M4 2.5h8v11L8 10.75 4 13.5Z" fill="currentColor" />,
  open: <><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" /><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></>,
  fault: <><circle cx="8" cy="8" r="5.75" /><path d="M4 12 12 4" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  stop: <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5" />,
  back: <path d="M13 8H3M7 4 3 8l4 4" />,
  download: <><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7" /><path d="M2.75 13.25h10.5" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: 14 | 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
