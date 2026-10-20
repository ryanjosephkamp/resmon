/**
 * Two shapes of cancellation that do not cancel what they look like they do.
 *
 * Both were written more than once in this renderer, by different people, in
 * the same week. They share a property that makes review a poor defense: the
 * code reads as a correct stale-response guard, and when it is wrong nothing
 * is written anywhere — no result, no refusal, no sentence saying a request
 * was abandoned. Nothing turns red either, because the suite asserts what the
 * surviving operation does.
 *
 * This guard reads the renderer's own syntax tree, not its prose. It is
 * deliberately narrow: it names two shapes that are nearly always wrong rather
 * than every shape that could be. What it does **not** catch is written out in
 * `LIMITS` below and repeated in `AGENTS.md`, because a guard whose reach is
 * overstated is worse than no guard.
 *
 * A file that genuinely needs one of these shapes goes in
 * `generationCounters.allow.json` with the reason, and the reason is the
 * thing a reviewer reads. An entry that no longer matches anything fails too,
 * so the list can only shrink without someone deciding it should not.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..');
const ALLOW = path.join(__dirname, 'generationCounters.allow.json');

/** Not analyzed: tests, mocks, and the helper that exists to replace all this. */
const SKIP = [path.join('__tests__'), path.join('__mocks__'), path.join('hooks', 'useRuns.ts')];

export const LIMITS = [
  'A counter bumped by something that is not an operation at all — an effect that resets an editor when its subject changes — is not caught. That is a third shape, and it cost a saved evidence note.',
  'Several operations that each do claim a ticket from one shared counter are not caught. Sharing is sometimes exactly right, syntax cannot tell which, and the right pressure there is a named key rather than a failing test.',
  'A counter reached through a computed key — runs.current[kind] — is not attributed to any one operation, so nothing about it is asserted.',
  'This is syntax. A generation counter built out of state, a module-level variable or a closure is invisible to it.',
];

interface Finding { file: string; rule: 'ticket-without-a-claim' | 'cleanup-that-cancels-nothing'; symbol: string; line: number }
interface Allowed { file: string; rule: string; symbol: string; count: number; reason: string }

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.some((s) => full.endsWith(s))) continue;
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `useRef(0)` or `useRef({a:0,b:0})` — a number this component counts upward. */
function isCounterInit(init: ts.Expression): boolean {
  if (!ts.isCallExpression(init)) return false;
  const callee = init.expression;
  const name = ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  if (name !== 'useRef') return false;
  const arg = init.arguments[0];
  if (!arg) return false;
  if (ts.isNumericLiteral(arg)) return true;
  return ts.isObjectLiteralExpression(arg) && arg.properties.length > 0
    && arg.properties.every((p) => ts.isPropertyAssignment(p) && ts.isNumericLiteral(p.initializer));
}

/** `x.current` or `x.current.k` → `x`; anything else → null. */
function counterBase(node: ts.Node): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (node.name.text === 'current' && ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'current'
      && ts.isIdentifier(node.expression.expression)) return node.expression.expression.text;
  return null;
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) return p;
  }
  return null;
}

/** Does this function hand control back before it finishes? */
function suspends(fn: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isAwaitExpression(n)) { found = true; return; }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then') { found = true; return; }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn, walk);
  return found;
}

/** Does this cleanup claim a new generation, so a re-run really does cancel? */
function claimsGeneration(scope: ts.Node, counters: Set<string>): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && n.operator === ts.SyntaxKind.PlusPlusToken) {
      const base = counterBase(n.operand);
      if (base && counters.has(base)) { found = true; return; }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(scope, walk);
  return found;
}

function assignsBoolean(scope: ts.Node, value: boolean): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const base = counterBase(n.left);
      const literal = value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword;
      if (base && n.right.kind === literal) names.add(base);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(scope, walk);
  return names;
}

function scan(file: string): Finding[] {
  const text = fs.readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const at = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const findings: Finding[] = [];

  const counters = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && isCounterInit(n.initializer)) counters.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(src);

  const walk = (n: ts.Node) => {
    // Rule A. A ticket read out of a counter that this operation never
    // claimed. It can never be the newest run of anything, so every other
    // control on the page erases its outcome, including its refusal.
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const base = counterBase(n.initializer);
      if (base && counters.has(base)) {
        const fn = enclosingFunction(n);
        if (fn && suspends(fn)) findings.push({ file: rel, rule: 'ticket-without-a-claim', symbol: base, line: at(n) });
      }
    }
    // Rule B. A cleanup that clears a flag the effect body sets straight back.
    // On a re-run it cancels nothing; it cancels only on a true unmount, and
    // whether that is safe depends on a `key` in some other file that nobody
    // editing that other file would know to preserve.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useEffect') {
      const [body, deps] = n.arguments;
      if (body && deps && ts.isArrayLiteralExpression(deps) && deps.elements.length > 0
          && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
        const set = assignsBoolean(body, true);
        let cleared = new Set<string>();
        let claims = false;
        const findReturn = (x: ts.Node) => {
          if (ts.isReturnStatement(x) && x.expression && (ts.isArrowFunction(x.expression) || ts.isFunctionExpression(x.expression))) {
            cleared = new Set([...cleared, ...assignsBoolean(x.expression, false)]);
            claims = claims || claimsGeneration(x.expression, counters);
          }
          if (!ts.isArrowFunction(x) || x === body) ts.forEachChild(x, findReturn);
        };
        ts.forEachChild(body, findReturn);
        // A cleanup that also claims a new generation does cancel on a re-run,
        // whatever the flag does, so it is not this shape.
        if (!claims) for (const name of set) if (cleared.has(name)) findings.push({ file: rel, rule: 'cleanup-that-cancels-nothing', symbol: name, line: at(n) });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return findings;
}

export function scanRenderer(root = SRC): Finding[] {
  return sources(root).flatMap(scan);
}

describe('generation counters keep the shapes that lost outcomes out of the renderer', () => {
  const allowed: Allowed[] = JSON.parse(fs.readFileSync(ALLOW, 'utf8'));
  const key = (f: { file: string; rule: string; symbol: string }) => `${f.file}|${f.rule}|${f.symbol}`;
  const findings = scanRenderer();

  const counted = new Map<string, number>();
  for (const f of findings) counted.set(key(f), (counted.get(key(f)) ?? 0) + 1);

  it('flags no shape that is not allowed with a stated reason', () => {
    const permitted = new Set(allowed.map(key));
    const unexplained = findings.filter((f) => !permitted.has(key(f)));
    expect(unexplained.map((f) => `${f.file}:${f.line} ${f.rule} on '${f.symbol}'`)).toEqual([]);
  });

  // An allowance covers the occurrences someone looked at, not the name. A
  // fourth read of a counter that already has three allowed ones is a new
  // decision and gets its own look, rather than inheriting an old reason.
  it('allows exactly the occurrences that were examined', () => {
    const wrong = allowed.filter((a) => (counted.get(key(a)) ?? 0) !== a.count)
      .map((a) => `${key(a)} allows ${a.count}, found ${counted.get(key(a)) ?? 0}`);
    expect(wrong).toEqual([]);
  });

  it('keeps no allowance that has stopped matching anything', () => {
    expect(allowed.filter((a) => !counted.has(key(a))).map(key)).toEqual([]);
  });

  it('every allowance states a reason', () => {
    expect(allowed.filter((a) => !a.reason || a.reason.length < 40).map(key)).toEqual([]);
  });

  // The denominator, so a later reader can tell a guard that found nothing
  // from a guard that looked at nothing.
  it('looked at the whole renderer', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.endsWith(path.join('pages', 'EvidencePage.tsx')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('hooks', 'useRuns.ts')))).toBe(false);
  });
});
