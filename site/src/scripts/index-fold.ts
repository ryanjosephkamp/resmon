/**
 * Under the plate, on a phone or in a narrow window, the index shows its first
 * entries and a button for the rest, instead of a scroll inside the page's own.
 * The page marks which entries wait (`data-later`) and its styles hide them;
 * this opens them, from the button or when a paper chosen on the plate is one
 * of them. Beside the plate, the index shows every entry and scrolls.
 */
for (const index of document.querySelectorAll<HTMLElement>('.today .index')) {
  const more = index.querySelector<HTMLButtonElement>('[data-index-more]');
  if (!more) continue;
  const open = () => index.toggleAttribute('data-open', true);
  more.addEventListener('click', () => {
    open();
    index.querySelector<HTMLElement>('.entry[data-later] .badge, .entry[data-later] a')?.focus();
  });
  const watch = new MutationObserver(() => {
    if (!index.querySelector('.entry[data-later][data-chosen]')) return;
    open();
    watch.disconnect();
  });
  watch.observe(index, { subtree: true, attributes: true, attributeFilter: ['data-chosen'] });
}
