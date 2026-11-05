import { count } from '../screens/today/format';

/**
 * How a sentence names the collection shown: by its name where there are
 * several collections, and as "your collection" where it is the only one.
 */
export interface CollectionWords {
  /** Whether the collection is named: there are several. */
  named: boolean;
  /** "your collection", or its name. */
  name: string;
  /** The same at the start of a sentence: "Your collection", or its name. */
  Name: string;
  /** *n* of its papers: "your 5 papers", or "the 5 papers in Photonics". */
  papers: (n: number) => string;
}

export function collectionWords(name: string | null, several: boolean): CollectionWords {
  // The default collection keeps its name, "Your collection", as words in a sentence too.
  if (!several || !name || name.trim().toLowerCase() === 'your collection') {
    return { named: false, name: 'your collection', Name: 'Your collection', papers: (n) => `your ${count(n, 'paper')}` };
  }
  return { named: true, name, Name: name, papers: (n) => `the ${count(n, 'paper')} in ${name}` };
}

/** The words of the only collection, which is "your collection". */
export const YOUR_COLLECTION: CollectionWords = collectionWords(null, false);
