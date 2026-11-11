import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Icon } from '../../shell/Icon';
import { findHits, findPattern, findText } from './findModel';

/** Find in the text actually on screen, keeping the rich and plain views' ranges separate. */
export function TextFind({ content, onClose, ready = true }: { content: RefObject<HTMLDivElement | null>; onClose: () => void; ready?: boolean }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const root = content.current;
    if (!root) return undefined;
    const read = () => {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement?.closest('.katex-mathml, .record-cap, .field-error') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const pattern = findPattern(query);
      const hits = pattern ? findHits(findText(nodes.map((node) => ({ str: node.data, hasEOL: false }))), pattern) : [];
      setRanges(hits.map((hit) => {
        const range = document.createRange();
        range.setStart(nodes[hit.from[0]]!, hit.from[1]);
        range.setEnd(nodes[hit.to[0]]!, hit.to[1]);
        return range;
      }));
      setAt(0);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [content, query]);
  useEffect(() => {
    const current = ranges[at];
    current?.startContainer.parentElement?.scrollIntoView?.({ block: 'nearest' });
    if (typeof Highlight === 'undefined' || !CSS.highlights) return undefined;
    // A legal 256 KiB file can hold more matches than V8 permits arguments
    // in one call. Add the full set individually, as the PDF finder does.
    const all = new Highlight();
    const now = new Highlight();
    ranges.forEach((range, index) => (index === at ? now : all).add(range));
    CSS.highlights.set('ev-find', all);
    CSS.highlights.set('ev-find-current', now);
    return () => { CSS.highlights.delete('ev-find'); CSS.highlights.delete('ev-find-current'); };
  }, [ranges, at]);
  const step = (direction: number) => { if (ranges.length) setAt((n) => (n + direction + ranges.length) % ranges.length); };
  return <div className="ev-find" role="search" aria-label="Find in this file">
    <label htmlFor={id} className="sr-only">Find in the File</label>
    <input id={id} ref={input} value={query} maxLength={200} spellCheck={false} autoComplete="off"
      onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      }} />
    <span role="status" aria-label="Find matches" className="ev-find-count num">{!ready ? 'File text is not available yet' : query.trim() ? ranges.length ? `${at + 1} of ${ranges.length}` : 'No matches' : ''}</span>
    <button type="button" className="btn sm quiet" aria-label="Previous Match" disabled={!ranges.length} onClick={() => step(-1)}><Icon name="back" /></button>
    <button type="button" className="btn sm quiet" aria-label="Next Match" disabled={!ranges.length} onClick={() => step(1)}><Icon name="chevron" /></button>
    <button type="button" className="btn sm quiet" aria-label="Close Find" onClick={onClose}><Icon name="close" /></button>
  </div>;
}
