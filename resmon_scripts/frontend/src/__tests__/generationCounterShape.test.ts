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
 * `LIMITS` below, because a guard whose reach is overstated is worse than no
 * guard.
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
const FIXTURES = path.join(__dirname, 'fixtures', 'generation-counters');

/** Not analyzed: tests, mocks, and the helper that exists to replace all this. */
const SKIP = [path.join('__tests__'), path.join('__mocks__'), path.join('hooks', 'useRuns.ts')];

export const LIMITS = [
  'Nothing here models what a ticket *gates*. A release -- a busy flag cleared in a `finally` -- guarded by a ticket another operation can invalidate is invisible to every rule below, and that is what let rule three be written in the first place: the harm was a stranded flag, not a dropped answer.',
  'A counter bumped by something that is not an operation at all -- an effect that resets an editor when its subject changes -- is not caught. That is a further shape, and it cost a saved evidence note.',
  'Several operations that each claim a ticket from one shared counter are not caught, and neither is one control paged under two keys that should have been one. Sharing is sometimes exactly right, syntax cannot tell which, and the pressure there is a named key and a test, not this file.',
  'Rule three only sees a claim whose key is a plain string. A key built from a template with a substitution is skipped, both as the late claim and as the ticket a function already holds.',
  'A counter reached through a computed key -- runs.current[kind] -- is not attributed to any one operation, so nothing about it is asserted.',
  'Rule one sees a ticket captured into a binding: a declaration, an assignment to a local, a destructure, or a property of an object literal. A capture reached any other way -- through a function call, an array element, a class field -- is not seen.',
  'suspends() recognizes await, .then, .catch and .finally. An operation that resumes in a plain callback -- an event handler, a subscription, a timer -- is not recognized as suspending, so no rule applies to it.',
  'A cleanup hoisted into a variable before being returned is not matched by rule two, which looks for the function in the return statement itself.',
  'This is syntax. A generation counter built out of state, a module-level variable or a closure is invisible to it, as is anything written through a custom hook other than useRuns.',
];

type Rule = 'ticket-without-a-claim' | 'cleanup-that-cancels-nothing' | 'late-claim-on-another-key';
interface Finding { file: string; rule: Rule; symbol: string; line: number }
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

/** `useRef(0)`, `useRef({a:0,b:0})`, or `useRef(START)` for a file-local numeric const. */
function isCounterInit(init: ts.Expression, numericConsts: Set<string>): boolean {
  if (!ts.isCallExpression(init)) return false;
  const callee = init.expression;
  const name = ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  if (name !== 'useRef') return false;
  const arg = init.arguments[0];
  if (!arg) return false;
  if (ts.isNumericLiteral(arg)) return true;
  if (ts.isIdentifier(arg) && numericConsts.has(arg.text)) return true;
  return ts.isObjectLiteralExpression(arg) && arg.properties.length > 0
    && arg.properties.every((p) => ts.isPropertyAssignment(p) && ts.isNumericLiteral(p.initializer));
}

/** The key of a `.begin(...)` call when it is a plain string, else null. */
function staticKey(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  return (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
}

/** `<anything>.begin(...)` — the helper's claim, whatever the receiver is called. */
function isClaim(n: ts.Node): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'begin';
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
function suspensionPoints(fn: ts.Node): number[] {
  const at: number[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isAwaitExpression(n)) at.push(n.getStart());
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
             && ['then', 'catch', 'finally'].includes(n.expression.name.text)) at.push(n.getStart());
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn, walk);
  return at;
}
const suspends = (fn: ts.Node) => suspensionPoints(fn).length > 0;

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

  const numericConsts = new Set<string>();
  const constants = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isNumericLiteral(n.initializer)) numericConsts.add(n.name.text);
    ts.forEachChild(n, constants);
  };
  constants(src);

  const counters = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && isCounterInit(n.initializer, numericConsts)) counters.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(src);

  const walk = (n: ts.Node) => {
    // Rule A. A ticket read out of a counter that this operation never
    // claimed. It can never be the newest run of anything, so every other
    // control on the page erases its outcome, including its refusal.
    // A capture is the value being put somewhere to compare against later: a
    // declaration, an assignment to a local, a destructure, or a property of an
    // object literal. A comparison is not a capture, which is what keeps every
    // correct guard in the renderer out of this.
    let captured: string | null = null;
    if (ts.isVariableDeclaration(n) && n.initializer) {
      captured = counterBase(n.initializer);
      if (!captured && ts.isObjectBindingPattern(n.name) && ts.isIdentifier(n.initializer)
          && counters.has(n.initializer.text)
          && n.name.elements.some((e) => ts.isIdentifier(e.propertyName ?? e.name) && (e.propertyName ?? e.name).getText() === 'current')) {
        captured = n.initializer.text;
      }
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      captured = counterBase(n.right);
    } else if (ts.isPropertyAssignment(n)) {
      captured = counterBase(n.initializer);
    }
    if (captured && counters.has(captured)) {
      const fn = enclosingFunction(n);
      if (fn && suspends(fn)) findings.push({ file: rel, rule: 'ticket-without-a-claim', symbol: captured, line: at(n) });
    }
    // Rule three. A claim on a key this operation does not hold, reached after
    // it has already suspended. By then another run may own that key, and
    // claiming it invalidates that run -- including, as this branch's own
    // review found, the guard on the `finally` that releases its busy flag.
    // Claiming before the first await is a different thing and is how every
    // operation starts; this is about reaching over, late, for someone else's.
    if (isClaim(n)) {
      const key = staticKey(n.arguments[0]);
      const fn = key === null ? null : enclosingFunction(n);
      if (fn && key !== null) {
        const late = suspensionPoints(fn).some((position) => position < n.getStart());
        let holds = false;
        const held = (x: ts.Node) => {
          if (ts.isVariableDeclaration(x) && x.initializer && isClaim(x.initializer) && staticKey(x.initializer.arguments[0]) === key) holds = true;
          ts.forEachChild(x, held);
        };
        ts.forEachChild(fn, held);
        if (late && !holds) findings.push({ file: rel, rule: 'late-claim-on-another-key', symbol: key, line: at(n) });
      }
    }
    // Rule B. A cleanup that clears a flag the effect body sets straight back.
    // On a re-run it cancels nothing; it cancels only on a true unmount, and
    // whether that is safe depends on a `key` in some other file that nobody
    // editing that other file would know to preserve.
    // `useEffect`, `React.useEffect`, `useLayoutEffect` and `React.useLayoutEffect`
    // are all effect sites; matching only the bare identifier left 15 of the
    // renderer's 115 call sites invisible to this rule.
    const effectName = ts.isCallExpression(n)
      ? (ts.isIdentifier(n.expression) ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '')
      : '';
    if (ts.isCallExpression(n) && (effectName === 'useEffect' || effectName === 'useLayoutEffect')) {
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
  it('looked at the whole renderer, and not at its own fixtures', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.endsWith(path.join('pages', 'EvidencePage.tsx')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('hooks', 'useRuns.ts')))).toBe(false);
    expect(files.some((f) => f.includes(path.join('fixtures', 'generation-counters')))).toBe(false);
  });
});

/**
 * Every case above asserts the renderer is clean, which is exactly what a
 * guard that has stopped working also reports. Two of the three rules could
 * be blinded with the whole suite staying green — including rule two, whose
 * demonstration against a file it did not write is this guard's entire
 * argument. So each rule is pinned separately against a file written to be
 * wrong in that one way.
 *
 * Breaking one of these on purpose has two ways of lying to you, and both
 * happened here: a mutation that fails to compile scores as a catch, and a
 * mutation that fails to apply scores as a pass. The fixture directory's
 * README has the detail; the short version is to assert the edit landed
 * before reading what the suite says about it.
 */
describe('each rule still fires', () => {
  const found = scanRenderer(FIXTURES).map((f) => `${f.file}|${f.rule}|${f.symbol}`).sort();
  const at = (file: string) => `__tests__/fixtures/generation-counters/${file}`;
  const expected = [
    `${at('cleanup-that-cancels-nothing.tsx')}|cleanup-that-cancels-nothing|alive`,
    `${at('late-claim-on-another-key.tsx')}|late-claim-on-another-key|selection`,
    `${at('ticket-without-a-claim.tsx')}|ticket-without-a-claim|epoch`,
  ];

  it.each(expected)('reports %s', (one) => {
    expect(found).toContain(one);
  });

  // And nothing else: a rule that fired on another rule's fixture, or twice
  // on its own, would be over-reaching rather than working.
  it('reports those three and nothing besides', () => {
    expect(found).toEqual(expected);
  });
});
