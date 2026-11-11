/**
 * `resmon://` links (`electron/resmonLinks.ts`) and the Save to resmon
 * extension that makes them (`resmon_scripts/extension/found.js`): what the
 * extension asks for from what was right-clicked, and the one page a link can
 * open in resmon, Look Up a Paper filled in. Every other link is refused.
 */
import fs from 'fs';
import path from 'path';
import { ownsResmonLinks, resmonLinkIn, routeOfResmonLink } from '../electron/resmonLinks';

/** The extension's module, loaded as Chrome loads it: plain JavaScript with its exports. */
function extension(): {
  doiIn: (text: string) => string;
  identifierIn: (address: string) => string;
  findQuery: (facts: Record<string, string>) => string;
  resmonLink: (facts: Record<string, string>) => string | null;
} {
  const source = fs.readFileSync(path.join(__dirname, '../../extension/found.js'), 'utf8');
  const body = source.replace(/^export function /gm, 'function ');
  return new Function(`${body}; return { doiIn, identifierIn, findQuery, resmonLink };`)();
}

describe('a resmon:// link', () => {
  test('opens Look Up a Paper with what to look up, and the web page it came from', () => {
    expect(routeOfResmonLink('resmon://find?q=10.1038%2Fnphys1170&from=https%3A%2F%2Fwww.nature.com%2Farticles%2Fnphys1170'))
      .toBe('/search/find?q=10.1038%2Fnphys1170&from=https%3A%2F%2Fwww.nature.com%2Farticles%2Fnphys1170');
    expect(routeOfResmonLink('resmon:find?q=Attention+Is+All+You+Need')).toBe('/search/find?q=Attention+Is+All+You+Need');
    expect(routeOfResmonLink('RESMON://FIND?q=%20%20spaced%20%20%20out%20')).toBe('/search/find?q=spaced+out');
  });

  test('names its page only when it is a web page', () => {
    for (const from of ['file:///etc/hosts', 'javascript:alert(1)', 'resmon://find?q=x', 'not an address', `https://a.org/${'x'.repeat(2100)}`]) {
      expect(routeOfResmonLink(`resmon://find?q=x&from=${encodeURIComponent(from)}`)).toBe('/search/find?q=x');
    }
  });

  test('anything else is refused: another action, nothing to look up, too much, or another scheme', () => {
    for (const link of [
      'resmon://save?q=x', 'resmon://settings', 'resmon://find', 'resmon://find?q=%20', `resmon://find?q=${'a'.repeat(501)}`,
      'https://find?q=x', 'mailto:find?q=x', 'resmon://find/../settings?q=x', '', 'resmon:',
    ]) {
      expect(routeOfResmonLink(link)).toBeNull();
    }
  });

  test('is claimed by the installed app, and the Windows uninstaller lets it go, except during an update', () => {
    const build = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).build;
    expect(build.protocols).toEqual([{ name: 'resmon link', schemes: ['resmon'] }]);
    const steps = fs.readFileSync(path.join(__dirname, '..', build.nsis.include), 'utf8');
    expect(steps).toMatch(/!macro customUnInstall[\s\S]*\$\{ifNot\} \$\{isUpdated\}[\s\S]*DeleteRegKey HKCU "Software\\Classes\\resmon"/);
  });

  test('is found among a launch’s arguments on Windows and Linux', () => {
    expect(resmonLinkIn(['/opt/resmon/resmon', '--no-sandbox', 'resmon://find?q=x'])).toBe('resmon://find?q=x');
    expect(resmonLinkIn(['resmon.exe', '--service'])).toBeNull();
  });
});

describe('Save to resmon', () => {
  const { doiIn, identifierIn, findQuery, resmonLink } = extension();

  test('reads a DOI, an arXiv id, or a PMID from an address, as Look Up a Paper reads them', () => {
    expect(identifierIn('https://doi.org/10.1371/journal.pone.0000308')).toBe('10.1371/journal.pone.0000308');
    expect(identifierIn('https://onlinelibrary.wiley.com/doi/10.1002/anie.201915678/abstract')).toBe('10.1002/anie.201915678');
    expect(identifierIn('https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0000308')).toBe('10.1371/journal.pone.0000308');
    expect(identifierIn('https://arxiv.org/abs/1706.03762v7')).toBe('arXiv:1706.03762v7');
    expect(identifierIn('https://arxiv.org/pdf/hep-th/9711200.pdf')).toBe('arXiv:hep-th/9711200');
    expect(identifierIn('https://pubmed.ncbi.nlm.nih.gov/17375194/')).toBe('PMID:17375194');
    expect(identifierIn('https://www.example.org/blog/post')).toBe('');
    expect(identifierIn('file:///Users/me/10.1000/x.pdf')).toBe('');
    // bioRxiv's and medRxiv's addresses add a version and a page to the DOI.
    expect(identifierIn('https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1.full.pdf')).toBe('10.1101/2020.03.22.002386');
    expect(doiIn('doi:10.1000/xyz123.')).toBe('10.1000/xyz123');
  });

  test('a link: its identifier, else the words on it', () => {
    expect(findQuery({ kind: 'link', linkUrl: 'https://doi.org/10.1038/nphys1170', linkText: 'Read It' })).toBe('10.1038/nphys1170');
    expect(findQuery({ kind: 'link', linkUrl: 'https://example.org/p/9', linkText: '  Deep  Residual Learning ' })).toBe('Deep Residual Learning');
    expect(findQuery({ kind: 'link', linkUrl: 'https://example.org/p/9', linkText: '' })).toBe('');
  });

  test('a page: a selection, its citation DOI, its address, its citation title, then its title', () => {
    const page = { kind: 'page', pageUrl: 'https://example.org/p/9', pageTitle: 'Example Journal | Article' };
    expect(findQuery({ ...page, selection: 'Selected Title Words', metaDoi: '10.5555/abc' })).toBe('Selected Title Words');
    expect(findQuery({ ...page, metaDoi: 'doi:10.5555/abc', metaTitle: 'A Title' })).toBe('10.5555/abc');
    expect(findQuery({ ...page, pageUrl: 'https://arxiv.org/abs/2401.00001', metaTitle: 'A Title' })).toBe('arXiv:2401.00001');
    expect(findQuery({ ...page, metaTitle: 'A Title' })).toBe('A Title');
    expect(findQuery(page)).toBe('Example Journal | Article');
    // Too long for Look Up a Paper: the next serves, and with none, nothing is sent.
    expect(findQuery({ ...page, selection: 'x'.repeat(501), metaDoi: '10.5555/abc' })).toBe('10.5555/abc');
    expect(findQuery({ ...page, pageTitle: 'x'.repeat(501) })).toBe('');
  });

  test('asks for no more than it uses, reaches no server, and carries resmon’s version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8'));
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(manifest.version).toBe(app.version);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'contextMenus', 'scripting']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'none'");
    for (const size of ['16', '32', '48', '128']) {
      expect(fs.existsSync(path.join(__dirname, '../../extension', manifest.icons[size]))).toBe(true);
    }
  });

  test('its link opens exactly that in resmon, with the page it came from', () => {
    const link = resmonLink({ kind: 'page', pageUrl: 'https://www.nature.com/articles/nphys1170', pageTitle: 'x', metaDoi: '10.1038/nphys1170' });
    expect(link).toBe('resmon://find?q=10.1038%2Fnphys1170&from=https%3A%2F%2Fwww.nature.com%2Farticles%2Fnphys1170');
    const route = routeOfResmonLink(link!);
    const params = new URLSearchParams(route!.split('?')[1]);
    expect(route!.startsWith('/search/find?')).toBe(true);
    expect(params.get('q')).toBe('10.1038/nphys1170');
    expect(params.get('from')).toBe('https://www.nature.com/articles/nphys1170');
    expect(resmonLink({ kind: 'link', linkUrl: 'https://example.org/', linkText: '' })).toBeNull();
  });
});

test('only the app named resmon claims resmon:// links, never a copy built under another name', () => {
  expect(ownsResmonLinks('/Applications/resmon.app/Contents/MacOS/resmon')).toBe(true);
  expect(ownsResmonLinks('C:\\Program Files\\resmon\\resmon.exe')).toBe(true);
  expect(ownsResmonLinks('/tmp/.mount_resmonAbc/resmon')).toBe(true);
  expect(ownsResmonLinks('/Users/someone/walk9/build/resmon walk.app/Contents/MacOS/resmon walk')).toBe(false);
  expect(ownsResmonLinks('/Applications/Electron.app/Contents/MacOS/Electron')).toBe(false);
  expect(ownsResmonLinks('')).toBe(false);
});
