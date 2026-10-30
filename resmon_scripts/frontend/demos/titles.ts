/** What a demo is called, where it sits in the tour, and the line under its title. */
export interface DemoTitle {
  /** The slug files are named by: `today`, `deep-dive`. */
  slug: string;
  /** Its place in the tour, from 1. */
  number: number;
  title: string;
  line: string;
}

/** The tour's order, its titles, and the line under each. Tutorials.tsx says the same in its own words. */
export const DEMOS: readonly DemoTitle[] = [
  { slug: 'today', number: 1, title: 'Today', line: 'What is new since you last looked, on a map of your whole collection.' },
  { slug: 'deep-dive', number: 2, title: 'A Deep Dive', line: 'One source, asked in depth, and its papers on a map of their own.' },
  { slug: 'deep-sweep', number: 3, title: 'A Deep Sweep', line: 'Several sources at once, and how each one answered.' },
  { slug: 'watches', number: 4, title: 'Watches', line: 'A search that runs on a schedule, and the calendar of what is due.' },
  { slug: 'library', number: 5, title: 'Library', line: 'Your own PDFs, read in focus mode.' },
  { slug: 'health', number: 6, title: 'Health', line: 'What every source did on recent runs, and what needs attention.' },
  { slug: 'getting-around', number: 7, title: 'Getting around', line: 'The command palette, the shortcuts, and a swipe back.' },
];
