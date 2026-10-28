#!/usr/bin/env node
/**
 * The Atlas renderer's API types, generated from the guarded HTTP description.
 *
 *   node scripts/atlas-api.mjs --write   regenerate atlas/src/api/schema.d.ts
 *   node scripts/atlas-api.mjs --check   fail if the committed file is stale
 *
 * `docs/api-contract/openapi.json` is written from the running FastAPI app and
 * guarded by the backend suite (`test_api_contract.py`), so it is the one
 * description of every route. Generating the renderer's types from it means a
 * route that changes shape breaks `npm run typecheck` here until the types are
 * regenerated, rather than surfacing as a request the screen silently
 * misreads. `--check` runs as part of `npm run typecheck`, which CI runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(here, '..', '..', '..', 'docs', 'api-contract', 'openapi.json');
const OUT = path.resolve(here, '..', 'atlas', 'src', 'api', 'schema.d.ts');
const HEADER = '// Generated from docs/api-contract/openapi.json by scripts/atlas-api.mjs. Do not edit;\n'
  + '// regenerate with `npm run gen:atlas-api` after the API contract changes.\n\n';

const ast = await openapiTS(new URL(`file://${SPEC}`));
const generated = HEADER + astToString(ast);
const mode = process.argv[2];

if (mode === '--write') {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, generated);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
} else if (mode === '--check') {
  const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (committed !== generated) {
    console.error('atlas/src/api/schema.d.ts does not match docs/api-contract/openapi.json.\n'
      + 'The HTTP surface changed; run `npm run gen:atlas-api` and commit the result.');
    process.exit(1);
  }
  console.log('atlas API types match docs/api-contract/openapi.json');
} else {
  console.error('usage: node scripts/atlas-api.mjs --write | --check');
  process.exit(2);
}
