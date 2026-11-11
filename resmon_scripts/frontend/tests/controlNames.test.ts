/** Static control names and navigation tables use the same title capitalization. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { barStatus, linkBarHtml } from '../electron/webLinks';

const ROOT = join(__dirname, '..');
const SMALL = new Set('a an the and but or nor as at by for from in into of off on onto out over per to up via with'.split(' '));
const PROPER = new Set(['resmon', 'arXiv', 'macOS', 'xAI', 'claude', 'codex']);
// Status sentences, unit values, and option explanations are not names.
const SENTENCES: Record<string, readonly string[]> = {
  'atlas/src/screens/settings/Ai.tsx': ['Claude Code, the claude command', 'Codex, the codex command', 'An API key',
    'The command’s default'],
  'atlas/src/screens/Today.tsx': ['Nothing new'],
  'atlas/src/screens/library/Library.tsx': ['Nothing saved to read yet'],
  'atlas/src/screens/Settings.tsx': ['No such group'],
  'atlas/src/screens/today/TodayIndex.tsx': ['Nothing new from'],
  'atlas/src/screens/library/VaultPanels.tsx': ['The Library folder is not where it was'],
  'atlas/src/screens/watches/people/Person.tsx': ['This person could not be read'],
  'atlas/src/shell/PageFailed.tsx': ['This page could not be shown'],
  'atlas/src/screens/sky/MapControls.tsx': ['when resmon found it', 'when it was published'],
  'atlas/src/screens/watches/Destinations.tsx': ['Sent when a run finishes', 'Waits for you to release it'],
  'atlas/src/screens/settings/Embeddings.tsx': ['(saved)'],
  'atlas/src/screens/settings/SummaryChoiceField.tsx': ['(saved)'],
  'atlas/src/screens/settings/SummaryForm.tsx': ['(saved)', 'The command’s default'],
  'atlas/src/screens/settings/ModelField.tsx': ['(not in the list)'],
  'atlas/src/screens/library/Answers.tsx': ['(unavailable)'],
};
// A control's name followed by a clause that explains it: the name is in Title Case, the clause is a sentence.
const EXPLAINED: Record<string, readonly string[]> = {
  'atlas/src/screens/today/TodayIndex.tsx': ['Show ⟦value⟧ More of ⟦value⟧, ⟦value⟧ not listed yet'],
  'atlas/src/screens/ask/Ask.tsx': ['Saved Tool Calls (not in a form this version reads)'],
};
const TABLES: Record<string, readonly string[]> = {
  'atlas/src/routes.tsx': ['label'],
  'atlas/src/screenPaths.ts': ['name'],
  'atlas/src/shell/shortcuts.ts': ['name'],
  'atlas/src/shell/CommandPalette.tsx': ['label', 'group'],
  'atlas/src/shell/ShortcutsSheet.tsx': ['title'],
  'atlas/src/windowTitle.ts': ['title'],
  'atlas/src/screens/runs/sourceMap.ts': ['label'],
  'atlas/src/screens/Settings.tsx': ['label'],
  'atlas/src/screens/settings/model.ts': ['label'],
  'atlas/src/screens/settings/summaryLanes.ts': ['label'],
  'atlas/src/theme/accent.ts': ['name'],
  'atlas/src/screens/settings/DangerZone.tsx': ['label'],
  'atlas/src/screens/library/galleryModel.ts': ['label'],
  'atlas/src/screens/runs/history.ts': ['label'],
  'atlas/src/screens/runs/references.ts': ['label'],
  'atlas/src/screens/searchStart.ts': ['name'],
  'atlas/src/screens/today/TodayIndex.tsx': ['title'],
  'atlas/src/screens/watches/editor.ts': ['label'],
  'atlas/src/screens/watches/window.ts': ['label'],
  'electron/contextMenu.ts': ['label'],
  'electron/webLinks.ts': ['name'],
  'electron/main.ts': ['label', 'title'],
  '../extension/background.js': ['title'],
};

function titleCase(name: string): string {
  // A breadcrumb's parts are separate names. Look Up a Paper is the screen's proper name.
  return name.split(/( › |: )/).map((part) => {
    if (part === ' › ' || part === ': ') return part;
    if (/^look up a paper$/i.test(part)) return 'Look Up a Paper';
    const words = [...part.matchAll(/⟦value⟧|[A-Za-z][A-Za-z0-9]*(?:[’'][A-Za-z]+)?/g)];
    let index = 0;
    return part.replace(/⟦value⟧|[A-Za-z][A-Za-z0-9]*(?:[’'][A-Za-z]+)?/g, (word, offset: number) => {
      const at = index++;
      if (word === '⟦value⟧' || PROPER.has(word.replace(/[’']s$/, ''))) return word;
      if (word.toLowerCase() === 'up' && /(?:Look|Back) $/.test(part.slice(0, offset))) return 'Up';
      if (at > 0 && at < words.length - 1 && SMALL.has(word.toLowerCase())) return word.toLowerCase();
      return word[0].toUpperCase() + word.slice(1);
    });
  }).join('');
}

/** Alternatives made entirely of literal text; data and user-chosen names are opaque. */
function literalNames(node: ts.Node | undefined, inHeading = false): string[] {
  if (!node) return [];
  if (ts.isJsxText(node)) {
    const text = document.createElement('textarea');
    text.innerHTML = node.text;
    return [text.value.replace(/\s+/g, ' ').trim()];
  }
  if (ts.isStringLiteralLike(node)) return [node.text.replace(/\s+/g, ' ').trim()];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literalNames(node.expression);
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return literalNames(node.body);
  if (ts.isConditionalExpression(node)) return [...literalNames(node.whenTrue), ...literalNames(node.whenFalse)];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((span) => '⟦value⟧' + span.literal.text).join('')];
  if (ts.isJsxElement(node)) {
    const opening = node.openingElement;
    if (inHeading && opening.tagName.getText() === 'span') return [''];
    const heading = inHeading || /^h[1-4]$/.test(opening.tagName.getText());
    const hidden = opening.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'aria-hidden' && literalNames(a.initializer)[0] === 'true');
    if (hidden || opening.tagName.getText() === 'kbd') return [''];
    const children = node.children.filter((child) => !(ts.isJsxText(child) && !child.text.trim()));
    let names = [''];
    for (const child of children) {
      const values = literalNames(child, heading);
      if (!values.length) return [];
      names = names.flatMap((name) => values.map((value) => `${name} ${value}`.trim()));
    }
    return names;
  }
  if (ts.isJsxSelfClosingElement(node) && ['Icon', 'input'].includes(node.tagName.getText())) return [''];
  return [];
}

function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.name === '__tests__') return [];
    return entry.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
  });
}

interface Name { file: string; line: number; name: string }
function declaredNames(path: string, source: string): Name[] {
  const file = relative(ROOT, path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names: Name[] = [];
  const add = (node: ts.Node, values = literalNames(node)) => values.filter((name) => /[A-Za-z]/.test(name)).forEach((name) => {
    let element: ts.Node | undefined = node;
    while (element && !ts.isJsxElement(element)) element = element.parent;
    const tag = element && ts.isJsxElement(element) ? element.openingElement.tagName.getText(ast) : null;
    if (tag && ['h1', 'h2', 'h3', 'h4', 'option'].includes(tag) && SENTENCES[file]?.includes(name)) return;
    if (tag && ['button', 'summary'].includes(tag) && EXPLAINED[file]?.includes(name)) return;
    if (file.endsWith('/watches/WatchEditor.tsx') && tag === 'option' && /^(?:⟦value⟧ )?hours?$/.test(name)) return;
    // Provider, length, and tone choices put an explanation after their name.
    const controlName = file.endsWith('/summaryLanes.ts') ? name.split(/[,:]/)[0] : name;
    names.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, name: controlName });
  });
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node) && node.name.getText(ast) === 'resetLabel' && node.initializer) add(node.initializer);
    if (ts.isVariableDeclaration(node) && file.endsWith('/settings/Links.tsx') && node.name.getText(ast) === 'yours' && node.initializer) add(node.initializer);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'heading' && node.initializer) add(node.initializer);
    if (ts.isPropertyAssignment(node) && TABLES[file]?.includes(node.name.getText(ast))) add(node.initializer);
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'buttons' && ts.isArrayLiteralExpression(node.initializer)) {
      node.initializer.elements.forEach((entry) => add(entry));
    }
    if (ts.isReturnStatement(node) && ts.isBlock(node.parent) && ts.isFunctionDeclaration(node.parent.parent) && node.parent.parent.name?.text === 'saveLabel' && node.expression) add(node.expression);
    if (ts.isVariableDeclaration(node) && ['SAYS', 'MODE_WORDS', 'SECTION_WORDS'].includes(node.name.getText(ast)) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      node.initializer.properties.filter(ts.isPropertyAssignment).forEach((entry) => add(entry.initializer));
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'TABS') {
      let value = node.initializer;
      while (value && ts.isAsExpression(value)) value = value.expression;
      if (value && ts.isArrayLiteralExpression(value)) value.elements.forEach((entry) => add(entry));
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(ast);
      const attributes = opening.attributes.properties.filter(ts.isJsxAttribute);
      const attribute = (key: string) => attributes.find((a) => a.name.getText(ast) === key)?.initializer;
      const role = literalNames(attribute('role'))[0];
      if (file.endsWith('/sources/SourceCatalog.tsx') && tag === 'div' && literalNames(attribute('className'))[0] === 'catalog-head' && ts.isJsxElement(node)) {
        node.children.filter(ts.isJsxElement).forEach((child) => add(child));
      }
      // Switches label sentence-like settings. Counts, paper titles, and keyboard hints are data.
      const namedTerm = tag === 'dt' && ['atlas/src/shell/ShortcutsSheet.tsx', 'atlas/src/screens/collection/SharedWording.tsx'].includes(file);
      const buttonLabel = tag === 'label' && /\bbtn\b/.test(literalNames(attribute('className'))[0] ?? '');
      const linkChoice = file.endsWith('/settings/Links.tsx') && tag === 'label' && literalNames(attribute('className'))[0] === 'choice';
      const findLabel = file.endsWith('/library/Reader.tsx') && tag === 'label' && attribute('htmlFor')?.getText(ast).includes('-find');
      const control = !['switch', 'checkbox', 'radio'].includes(role ?? '') &&
        (namedTerm || buttonLabel || linkChoice || findLabel || ['button', 'NavLink', 'summary', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || (['a', 'Link'].includes(tag) && /\b(btn|back)\b/.test(literalNames(attribute('className'))[0] ?? '')) || ['tab', 'menuitem'].includes(role ?? ''));
      if (control || tag === 'dialog' || role === 'dialog' || (file.endsWith('/SharedWording.tsx') && ['section', 'dl'].includes(tag))) {
        const label = attribute('aria-label');
        if (label && !(file === 'atlas/src/collections/CollectionSwitcher.tsx' && literalNames(label)[0] === 'Collection: ⟦value⟧. Choose another collection')) add(label);
        if (control && ts.isJsxElement(node)) {
          add(node);
        }
      }
      if (tag === 'Plate' && attribute('resetLabel')) add(attribute('resetLabel')!);
      if (['Sheet', 'Confirm', 'TargetMenu', 'More', 'SelectBar', 'PlaceHelp', 'PairView'].includes(tag)) {
        attributes.filter((a) => (tag === 'SelectBar' ? ['allLabel', 'doneLabel'] : ['label', 'title', 'confirmLabel', 'act', 'summary', 'backLabel']).includes(a.name.getText(ast)))
          .forEach((a) => { if (a.initializer) add(a.initializer); });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return names;
}

test('declared button, tab, menu, shortcut, and settings names use title case', () => {
  const names = [...files(join(ROOT, 'atlas/src')), ...files(join(ROOT, 'electron')), join(ROOT, '../extension/background.js')]
    .flatMap((path) => declaredNames(path, readFileSync(path, 'utf8')));
  for (const loading of [false, true]) {
    const url = 'https://paper.example';
    const html = linkBarHtml({ url, status: barStatus({ url, loading, failed: false }), platform: 'darwin' });
    const document = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll('button').forEach((button) => names.push({
      file: 'electron/webLinks.ts (browser bar)', line: 1,
      name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
    }));
  }
  expect(names.length).toBeGreaterThan(500);
  expect(names.map(({ name }) => name)).toEqual(expect.arrayContaining([
    'Collection', 'Look Up a Paper', 'Open Link in Your Browser', 'Save to Read',
    'New Conversation', 'Settings › Top Bar',
  ]));
  const shared = readFileSync(join(ROOT, '../implementation_scripts/shared_wording.py'), 'utf8');
  const labels = /CATEGORY_LABELS = \{([\s\S]*?)\n\}/.exec(shared)![1];
  for (const match of labels.matchAll(/:\s*"([^"]+)"/g)) names.push({ file: '../implementation_scripts/shared_wording.py', line: 1, name: match[1] });
  expect(['Import Files', 'New Tab', 'Next Tab, Previous Tab', 'Save or Send What You Wrote',
    'About Sources and Their Keys', 'Longest Passage', 'Authors in Common', 'All Pairs'].filter((name) => !names.some((entry) => entry.name === name))).toEqual([]);
  const wrong = names.filter(({ name }) => name !== titleCase(name));
  expect(wrong.map(({ file, line, name }) => `${file}:${line}: ${name} → ${titleCase(name)}`)).toEqual([]);
});

test('a new sentence-case button fails and short words follow the specified rule', () => {
  const names = declaredNames(join(ROOT, 'atlas/src/Example.tsx'), '<button><span>Save this search</span></button>');
  expect(names[0].name).not.toBe(titleCase(names[0].name));
  const statusAsButton = declaredNames(join(ROOT, 'atlas/src/screens/Today.tsx'), '<button>Nothing new</button>');
  expect(statusAsButton[0].name).not.toBe(titleCase(statusAsButton[0].name));
  expect(titleCase('save to read')).toBe('Save to Read');
  expect(titleCase('Add to a Project')).toBe('Add to a Project');
  expect(titleCase('Open Link in Your Browser')).toBe('Open Link in Your Browser');
  expect(titleCase('Mark as Read')).toBe('Mark as Read');
  expect(titleCase('Remove From Read')).toBe('Remove from Read');
  expect(titleCase('Move to')).toBe('Move To');
  expect(titleCase('Look Up a Paper')).toBe('Look Up a Paper');
});


test('button labels, shortcut entries, summary headings, and window titles are checked as names', () => {
  const fixtures = [
    ['atlas/src/Example.tsx', '<label className="btn">Import files<input type="file" /></label><summary>The scan</summary>'],
    ['atlas/src/shell/ShortcutsSheet.tsx', '<dt>New tab</dt>'],
    ['atlas/src/screens/collection/SharedWording.tsx', '<dt>Longest passage</dt><dl aria-label="What each number means" />'],
    ['atlas/src/Example.tsx', '<PlaceHelp summary="About sources and their keys" />'],
    ['atlas/src/windowTitle.ts', "const entry = { title: () => 'Edit watch' };"],
  ];
  for (const [file, source] of fixtures) {
    const names = declaredNames(join(ROOT, file), source);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(({ name }) => name !== titleCase(name))).toBe(true);
  }
  expect(titleCase('Back up Now')).toBe('Back Up Now');
});
