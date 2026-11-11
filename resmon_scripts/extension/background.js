// Save to resmon: a right-click item on a page and on a link that asks resmon to look the paper
// up. resmon opens its Look Up a Paper with the paper's DOI, arXiv id, PMID, or title filled in;
// nothing is looked up or saved there until the person says so. This extension reads the page
// only when its item is clicked, and sends nothing anywhere else.
import { resmonLink } from './found.js';

const PAGE = 'resmon-save-page';
const LINK = 'resmon-save-link';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: PAGE, title: 'Save to resmon', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: LINK, title: 'Save Link to resmon', contexts: ['link'] });
  });
});

// Read in the page, on the click: the citation tags publishers write for reference managers. A
// page can carry several of one tag (Dublin Core's identifier is often an ISSN first), so the DOI
// is the first value that holds one.
function citationTags() {
  const values = (...names) => names.flatMap((name) => [...document.querySelectorAll(`meta[name="${name}" i], meta[property="${name}" i]`)]
    .map((node) => node.getAttribute('content')?.trim() ?? '').filter(Boolean));
  return {
    metaDoi: values('citation_doi', 'prism.doi', 'bepress_citation_doi', 'dc.identifier').find((value) => /10\.\d{4,9}\//.test(value)) ?? '',
    metaTitle: values('citation_title', 'dc.title', 'og:title')[0] ?? '',
  };
}

// Read in the page, on the click: the words of the link right-clicked. Chrome gives an extension
// the link's address but not its text.
function linkWords(href) {
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.href === href) return anchor.textContent ?? '';
  }
  return '';
}

async function readTags(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: citationTags });
    return result?.result ?? {};
  } catch {
    // A page the browser keeps scripts out of (its own pages, the store): its address and title still serve.
    return {};
  }
}

async function readLinkText(tabId, frameId, href) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] }, func: linkWords, args: [href],
    });
    return result?.result ?? '';
  } catch {
    return '';
  }
}

// Hand the link to the system, which asks the person whether to open resmon. The tab keeps its page.
async function open(tabId, link) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: (to) => { window.location.href = to; }, args: [link] });
  } catch {
    await chrome.tabs.update(tabId, { url: link });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const page = info.menuItemId === PAGE;
  const facts = page
    ? { kind: 'page', pageUrl: info.pageUrl ?? tab.url, pageTitle: tab.title, selection: info.selectionText, ...(await readTags(tab.id)) }
    : { kind: 'link', linkUrl: info.linkUrl, selection: info.selectionText, linkText: await readLinkText(tab.id, info.frameId, info.linkUrl) };
  const link = resmonLink(facts);
  if (link) await open(tab.id, link);
});
