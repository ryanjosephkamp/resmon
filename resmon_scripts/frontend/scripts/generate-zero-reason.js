#!/usr/bin/env node
/**
 * Generate `src/api/zeroReasonVocabulary.ts` from `zero_reason.py`.
 *
 * The renderer used to keep a hand-written copy of the backend's
 * `DID_NOT_ANSWER` set, with a comment claiming there was no second copy of
 * the vocabulary to drift. There were three copies and they had drifted: the
 * set in `ExecutionContext` was missing `entity_unsupported`, so on an author
 * or entity sweep the seven sources that have no author query rendered a
 * green tick — "answered and found nothing" — beside the backend's own
 * sentence saying they could not be asked.
 *
 * Adding the missing string by hand would have rebuilt the same defect with a
 * longer fuse, so the vocabulary is now derived. `zero_reason.py` is the one
 * source of truth; this script copies it into TypeScript, and
 * `ZeroReasonSurfaces.test.tsx` regenerates the module and fails the renderer
 * suite if the committed file is not byte-identical to what the live Python
 * produces. A reason added to the backend turns the frontend red until this
 * is re-run, and every renderer surface reads the generated module, so a
 * fourth consumer cannot drift either.
 *
 * Usage: `npm run gen:zero-reason` (or `node scripts/generate-zero-reason.js`).
 */
const fs = require('fs');
const path = require('path');

const FRONTEND_ROOT = path.resolve(__dirname, '..');

/** The backend module this vocabulary belongs to. */
const PYTHON_SOURCE = path.resolve(
  FRONTEND_ROOT, '..', 'implementation_scripts', 'zero_reason.py',
);

/** The generated module, relative to the frontend root. */
const GENERATED_PATH = path.join('src', 'api', 'zeroReasonVocabulary.ts');

/**
 * Pull one `NAME = <delimiter> ... <delimiter>` literal out of the Python.
 *
 * Comments are stripped first: both blocks carry prose explaining why a value
 * is in them, and `DID_NOT_ANSWER`'s comment for `entity_unsupported` is four
 * lines long. No reason slug contains a `#`, so a line-wise strip is safe and
 * a lot more legible than a Python parser would be here.
 *
 * **Every entry must be understood, or this throws.** The first version of
 * this function scanned the block with `/"([a-z_]+)"/g` and kept whatever
 * matched, which meant a reason written with single quotes, or holding a
 * digit, was skipped in silence. That is worse than a parse error, because
 * the byte-compare guard regenerates through this same function: the
 * committed module and the regeneration agreed on the same wrong answer, and
 * a reason the renderer had never heard of would have reached the grid as a
 * green tick — the exact defect this module exists to prevent. So the block
 * is split into entries first and each one is required to be a quoted slug;
 * anything else names itself in the error and stops the run.
 *
 * **What this still does not see.** The per-entry check catches an entry
 * whose *text* is unexpected. It does not catch a change to the *structure*
 * around the block: `ZERO_REASONS = (...) + EXTRA` or
 * `frozenset({...}) | EXTRA_SET` parses the inline part alone and reports no
 * error, because the composition happens outside the delimiters this reads
 * between. Nothing here would notice, and the byte-compare guard would agree
 * with it. If the backend ever composes either set, this function has to
 * learn that shape — a reviewer reading only the code above will not be
 * warned by it.
 *
 * The quote count below is belt-and-braces and, as written, unreachable:
 * every entry that passes the per-entry regex contributes exactly two
 * quotes, so the regex rejects the odd cases first. It is kept as a cheap
 * invariant on the arithmetic rather than as a guard that earns its place.
 */
function literals(source, name, open, close) {
  const uncommented = source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  const escaped = open.replace(/[(){}]/g, '\\$&');
  const closeEscaped = close.replace(/[(){}]/g, '\\$&');
  const block = uncommented.match(
    new RegExp(`${name}\\s*=\\s*(?:frozenset\\()?${escaped}([\\s\\S]*?)${closeEscaped}`),
  );
  if (!block) {
    throw new Error(`${name} was not found in ${PYTHON_SOURCE}`);
  }

  const body = block[1];
  const entries = body.split(',').map((entry) => entry.trim()).filter(Boolean);
  const values = entries.map((entry) => {
    const matched = entry.match(/^(['"])([a-z0-9_]+)\1$/);
    if (!matched) {
      throw new Error(
        `${name} in ${PYTHON_SOURCE} holds an entry this parser does not `
        + `understand: ${entry}. Teach it the new shape rather than letting `
        + 'the value drop.',
      );
    }
    return matched[2];
  });
  if (values.length === 0) {
    throw new Error(`${name} in ${PYTHON_SOURCE} parsed as empty`);
  }

  const quotes = (body.match(/['"]/g) || []).length;
  if (quotes !== values.length * 2) {
    throw new Error(
      `${name} in ${PYTHON_SOURCE} has ${quotes} quote characters for `
      + `${values.length} values. One of them is not a plain slug.`,
    );
  }
  return values;
}

/** `{ zeroReasons, didNotAnswer }`, read from the Python that defines them. */
function pythonVocabulary(source = fs.readFileSync(PYTHON_SOURCE, 'utf8')) {
  const zeroReasons = literals(source, 'ZERO_REASONS', '(', ')');
  const didNotAnswer = literals(source, 'DID_NOT_ANSWER', '{', '}');
  const stray = didNotAnswer.filter((reason) => !zeroReasons.includes(reason));
  if (stray.length) {
    // DID_NOT_ANSWER is a subset of ZERO_REASONS by construction in the
    // backend. If that stops being true the parse is wrong, and a wrong parse
    // must not be written out as though it were the taxonomy.
    throw new Error(`DID_NOT_ANSWER holds values absent from ZERO_REASONS: ${stray.join(', ')}`);
  }
  return { zeroReasons, didNotAnswer };
}

/** The exact text of the generated module. */
function renderModule(vocabulary = pythonVocabulary()) {
  const list = (values) => values.map((v) => `  '${v}',`).join('\n');
  return `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: implementation_scripts/zero_reason.py
 * Regenerate with: npm run gen:zero-reason
 *
 * \`ZeroReasonSurfaces.test.tsx\` regenerates this from the Python and fails if
 * the committed text differs, so a reason added to the backend turns the
 * renderer suite red rather than reaching a user as an unhandled slug.
 */

/** Every reason the backend can record for a zero — \`zero_reason.ZERO_REASONS\`. */
export const ZERO_REASONS = [
${list(vocabulary.zeroReasons)}
] as const;

export type ZeroReason = typeof ZERO_REASONS[number];

/**
 * The reasons that mean *the source did not answer*, as opposed to *it
 * answered and had nothing* — \`zero_reason.DID_NOT_ANSWER\`.
 */
export const DID_NOT_ANSWER: ReadonlySet<string> = new Set<string>([
${list(vocabulary.didNotAnswer)}
]);
`;
}

function main() {
  const target = path.join(FRONTEND_ROOT, GENERATED_PATH);
  const text = renderModule();
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (existing === text) {
    process.stdout.write(`${GENERATED_PATH} is already up to date.\n`);
    return;
  }
  fs.writeFileSync(target, text);
  process.stdout.write(`Wrote ${GENERATED_PATH}.\n`);
}

module.exports = { PYTHON_SOURCE, GENERATED_PATH, pythonVocabulary, renderModule };

if (require.main === module) {
  main();
}
