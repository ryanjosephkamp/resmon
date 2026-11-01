/**
 * The zero-reason vocabulary Atlas reads is still the backend's.
 *
 * `atlas/src/api/zeroReasonVocabulary.ts` is generated from `zero_reason.py`
 * by `scripts/generate-zero-reason.js`. The committed module is regenerated
 * from the live Python and compared byte for byte, so a reason added to the
 * backend turns this suite red until the module is regenerated with it. And
 * because that comparison regenerates through the same parser it checks, the
 * parser has to throw on anything it does not understand: a reason it skipped
 * in silence would drop out of both sides and agree.
 */
import * as fs from 'fs';
import * as path from 'path';

// `require`, not `import`: the generator is the CommonJS script `npm run
// gen:zero-reason` runs, and the test calls the same code rather than a
// second transcription of the parse.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const generator = require('../scripts/generate-zero-reason.js');

test('Atlas\'s vocabulary is still the backend vocabulary', () => {
  const committed = fs.readFileSync(path.resolve(__dirname, '..', generator.ATLAS_GENERATED_PATH), 'utf8');
  expect(committed).toBe(generator.renderModule());
  const { zeroReasons, didNotAnswer } = generator.pythonVocabulary();
  expect(committed).toContain(`'${zeroReasons[0]}'`);
  // The one that was once missing, named so a regression reads as itself.
  expect(didNotAnswer).toContain('entity_unsupported');
});

test('a reason the generator cannot parse throws rather than vanishing', () => {
  const parse = (zero: string, did: string): { zeroReasons: string[] } => (
    generator.pythonVocabulary(
      `ZERO_REASONS = (\n${zero}\n)\n\nDID_NOT_ANSWER = frozenset({\n${did}\n})\n`,
    )
  );
  // Both spellings, and a digit, survive.
  expect(parse("  'quota_exhausted',\n  \"http_503\",", "  'quota_exhausted',").zeroReasons)
    .toEqual(['quota_exhausted', 'http_503']);
  // Anything else names itself and stops the run. A comma inside a literal
  // splits it into two fragments, neither a quoted slug, so it is refused too.
  for (const bad of ['  Upstream_Failure,', '  "upstream-failure",', '  *OTHER,', '  "missing_key,retired",']) {
    expect(() => parse(`  "missing_key",\n${bad}`, '  "missing_key",')).toThrow(/does not understand/);
  }
});
