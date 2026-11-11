/**
 * Web links (`electron/webLinks.ts`): where a followed link opens, what the
 * link window's address field makes of what is typed, and the bar's page.
 */
import { createHash } from 'crypto';
import {
  DEFAULT_WEB_LINKS, SEARCHES, addressTarget, barStatus, isWebAddress, linkBarHtml, linkOpening, readWebLinks,
} from '../electron/webLinks';
import { SEARCH_NAMES } from '../atlas/src/shell/webLinks';

describe('where a followed link opens', () => {
  test("by default in resmon's browser, as a window", () => {
    expect(linkOpening(DEFAULT_WEB_LINKS, 'darwin')).toBe('window');
    expect(DEFAULT_WEB_LINKS).toEqual({ open_in: 'resmon', new: 'window', search: 'duckduckgo' });
  });

  test('a tab only where macOS draws one; elsewhere it is a window', () => {
    const tabs = { ...DEFAULT_WEB_LINKS, new: 'tab' as const };
    expect(linkOpening(tabs, 'darwin')).toBe('tab');
    expect(linkOpening(tabs, 'win32')).toBe('window');
    expect(linkOpening(tabs, 'linux')).toBe('window');
  });

  test('your own browser, whatever resmon would have done', () => {
    expect(linkOpening({ ...DEFAULT_WEB_LINKS, open_in: 'browser', new: 'tab' }, 'darwin')).toBe('browser');
    expect(linkOpening({ ...DEFAULT_WEB_LINKS, open_in: 'browser' }, 'linux')).toBe('browser');
  });

  test('a renderer is believed only for the choices the engine stores', () => {
    expect(readWebLinks({ open_in: 'browser', new: 'tab', search: 'google_scholar' }))
      .toEqual({ open_in: 'browser', new: 'tab', search: 'google_scholar' });
    for (const bad of [null, 'resmon', {}, { open_in: 'chrome', new: 'tab', search: 'google' },
      { open_in: 'resmon', new: 'pane', search: 'google' }, { open_in: 'resmon', new: 'tab', search: 'toString' },
      { open_in: 'resmon', new: 'tab', search: 'askjeeves' }]) {
      expect(readWebLinks(bad)).toBeNull();
    }
  });
});

describe('the address field', () => {
  test('a web address goes as typed', () => {
    expect(addressTarget('https://arxiv.org/abs/2401.00001', 'google')).toBe('https://arxiv.org/abs/2401.00001');
    expect(addressTarget('  http://example.org/a?b=c#d  ', 'google')).toBe('http://example.org/a?b=c#d');
  });

  test('an address without its scheme gets https, or http for this computer and a numeric address', () => {
    expect(addressTarget('arxiv.org/abs/2401.00001', 'google')).toBe('https://arxiv.org/abs/2401.00001');
    expect(addressTarget('www.nature.com', 'google')).toBe('https://www.nature.com/');
    expect(addressTarget('localhost:8000/docs', 'google')).toBe('http://localhost:8000/docs');
    expect(addressTarget('127.0.0.1:5173', 'google')).toBe('http://127.0.0.1:5173/');
    expect(addressTarget('example.org:8443/x', 'google')).toBe('https://example.org:8443/x');
  });

  test('a DOI, bare or with doi:, opens at doi.org', () => {
    expect(addressTarget('10.1038/nphys1170', 'google')).toBe('https://doi.org/10.1038/nphys1170');
    expect(addressTarget('doi:10.1371/journal.pone.0000308', 'google')).toBe('https://doi.org/10.1371/journal.pone.0000308');
  });

  test('words, and an address of another scheme, are searched for with the chosen search', () => {
    expect(addressTarget('graph neural networks', 'duckduckgo')).toBe('https://duckduckgo.com/?q=graph%20neural%20networks');
    expect(addressTarget('protein folding', 'google_scholar')).toBe('https://scholar.google.com/scholar?q=protein%20folding');
    expect(addressTarget('transformers', 'semantic_scholar')).toBe('https://www.semanticscholar.org/search?q=transformers');
    expect(addressTarget('javascript:alert(1)', 'bing')).toBe('https://www.bing.com/search?q=javascript%3Aalert(1)');
    expect(addressTarget('file:///etc/hosts', 'bing')).toBe('https://www.bing.com/search?q=file%3A%2F%2F%2Fetc%2Fhosts');
    expect(addressTarget('e.g', 'brave')).toBe('https://search.brave.com/search?q=e.g');
    expect(addressTarget('C++', 'ecosia')).toBe('https://www.ecosia.org/search?q=C%2B%2B');
    expect(addressTarget('a&b=c', 'startpage')).toBe('https://www.startpage.com/sp/search?query=a%26b%3Dc');
  });

  test('nothing typed goes nowhere', () => {
    expect(addressTarget('', 'google')).toBeNull();
    expect(addressTarget('   ', 'google')).toBeNull();
  });

  test('every search goes to an https address, and Settings names each as the main process does', () => {
    for (const { address } of Object.values(SEARCHES)) expect(address.startsWith('https://')).toBe(true);
    expect(Object.fromEntries(Object.entries(SEARCHES).map(([key, { name }]) => [key, name]))).toEqual(SEARCH_NAMES);
    expect(Object.keys(SEARCHES)[0]).toBe(DEFAULT_WEB_LINKS.search);
  });

  test('only http and https are web addresses', () => {
    expect(isWebAddress('https://example.org')).toBe(true);
    expect(isWebAddress('http://127.0.0.1:1/x')).toBe(true);
    for (const other of ['file:///etc/hosts', 'javascript:alert(1)', 'mailto:a@b.c', 'resmon://save', 'not a url', '']) {
      expect(isWebAddress(other)).toBe(false);
    }
  });
});

describe("the link window's bar", () => {
  test('says what the page is doing, and nothing once it has loaded', () => {
    expect(barStatus({ url: 'https://a.org', loading: true, failed: false })).toBe('Loading the page…');
    expect(barStatus({ url: 'https://a.org', loading: false, failed: true })).toBe('The page could not be loaded.');
    expect(barStatus({ url: 'https://a.org', loading: false, failed: false })).toBe('');
    // An empty tab is not loading anything.
    expect(barStatus({ url: '', loading: false, failed: false })).toBe('');
  });

  test('allows its one script by hash, and no other', () => {
    const html = linkBarHtml({ url: 'https://example.org/', status: 'Loading the page…', platform: 'darwin' });
    const policy = /content="([^"]+)"/.exec(html)![1];
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    expect(policy).toBe(`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'`);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  test("escapes the page's address into the field, and names each key for the platform", () => {
    const html = linkBarHtml({ url: 'https://example.org/?q="><script>x</script>', status: '', platform: 'win32' });
    expect(html).toContain('value="https://example.org/?q=&#34;&#62;&#60;script&#62;x&#60;/script&#62;"');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('title="Reload (Ctrl+R)"');
    expect(linkBarHtml({ url: '', status: '', platform: 'darwin' })).toContain('title="Reload (⌘R)"');
  });
});
