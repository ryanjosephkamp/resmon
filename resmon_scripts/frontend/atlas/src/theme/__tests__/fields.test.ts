/**
 * A field's edge, a box to tick, and a control that cannot be used now are
 * seen in both themes: each boundary is 3:1 against what it sits on (WCAG
 * 1.4.11), an unchecked box is an outline rather than a fill, and a disabled
 * button keeps its edge and a readable label. Read from the tokens and the
 * rules the screens draw with, so a rule added later is held to the same line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from '../accent';

const tokensCss = readFileSync(join(__dirname, '../tokens.css'), 'utf8');
const atlasCss = readFileSync(join(__dirname, '../../atlas.css'), 'utf8');

function theme(name: 'dark' | 'light'): Record<string, string> {
  const start = tokensCss.indexOf(`:root[data-theme="${name}"]`);
  const block = tokensCss.slice(start, tokensCss.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[key!] = value!;
  return tokens;
}

/** A selector list split at its top-level commas, so `:is(a, b)` stays one selector. */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim());
}

/** Every rule in `atlas.css`, its selectors and its declarations, comments left out. */
const RULES = [...atlasCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selectors: selectorsOf(selector!), body: body! }));

/** A rule that draws a text field, a select, or the box that holds a field's input. */
const FIELD_CONTAINERS = new Set(['.cmdk', '.picker-hex', '.map-find', '.terms', '.ev-find', '.ev-text', '.conv-filter', '.ev-page-input']);
const isField = (selectors: string[]) => selectors.some((s) => FIELD_CONTAINERS.has(s) || /\b(input|select|textarea)$/.test(s));

describe.each(['dark', 'light'] as const)('the %s theme', (name) => {
  const t = theme(name);

  test('a field\'s edge is 3:1 against the plate, the panels, and a raised sheet', () => {
    for (const ground of ['plate', 'panel', 'panel-2', 'raise']) {
      expect(contrast(t['field-edge']!, t[ground]!)).toBeGreaterThanOrEqual(3);
    }
  });

  test('a disabled button\'s label stays readable against the ground and the panel', () => {
    for (const ground of ['ground', 'panel']) expect(contrast(t['ink-3']!, t[ground]!)).toBeGreaterThanOrEqual(4.5);
  });
});

test('every field that draws an edge draws it in the field edge, never in the rule between sections', () => {
  const faint = RULES.filter((rule) => isField(rule.selectors) && /border:\s*1px solid var\(--rule-2\)/.test(rule.body))
    .map((rule) => rule.selectors.join(', '));
  expect(faint).toEqual([]);
  expect(RULES.filter((rule) => isField(rule.selectors) && /var\(--field-edge\)/.test(rule.body)).length).toBeGreaterThan(20);
});

test('an unchecked box is an outline in the field edge, and a ticked one the accent', () => {
  const box = RULES.find((rule) => rule.selectors.includes('input:is([type="checkbox"], [type="radio"]):not(.sr-only)'));
  expect(box?.body).toMatch(/appearance:\s*none/);
  expect(box?.body).toMatch(/border:\s*1\.5px solid var\(--field-edge\)/);
  expect(box?.body).toMatch(/background:\s*transparent/);
  const ticked = RULES.find((rule) => rule.selectors.includes('input[type="checkbox"]:not(.sr-only):checked'));
  expect(ticked?.body).toMatch(/background:\s*var\(--accent-fill\)/);
});

test('a disabled button is not faded away: it keeps an edge in the field edge and a label in the quietest ink', () => {
  const disabled = RULES.find((rule) => rule.selectors.includes('.btn:disabled'));
  expect(disabled?.body).not.toMatch(/opacity/);
  expect(disabled?.body).toMatch(/border-color:\s*var\(--field-edge\)/);
  expect(disabled?.body).toMatch(/color:\s*var\(--ink-3\)/);
});
