// @ts-check
/**
 * ESLint for the renderer — the first one this repository has had.
 *
 * The codebase carried five `eslint-disable` comments naming
 * `react-hooks/exhaustive-deps`, `@typescript-eslint/no-namespace` and
 * `@typescript-eslint/no-var-requires`, and no ESLint at all: no dependency,
 * no config file, no script. The suppressions suppressed nothing, and the
 * rule that catches the stale-closure and missing-dependency class — the
 * class behind the 114 of 176 request-then-`setState` paths that carry no
 * cancellation guard — had never been run against this code.
 *
 * **This is a backlog, not a gate.** Every rule the code already satisfies is
 * an `error` and will fail CI the moment it stops being satisfied. Every rule
 * it does not satisfy yet is a `warn`, named below with its count, so the job
 * is green today and the debt is written down by rule instead of hidden
 * behind a blanket disable. Promoting one of those to `error` is the unit of
 * work; fixing them is deliberately not this change.
 *
 * Deliberately not type-aware: `recommendedTypeChecked` would build a program
 * from four separate tsconfigs (src, electron, e2e, journeys) on every run.
 * `npm run typecheck` already compiles the renderer and the Electron main
 * process, in the same CI job, and it is the authority on types.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** Every TypeScript file this config walks, named once. */
const TYPESCRIPT = ['src/**/*.{ts,tsx}', 'atlas/**/*.{ts,tsx}', 'electron/**/*.ts', 'e2e/**/*.ts', 'journeys/**/*.ts', 'perf/**/*.ts', 'demos/**/*.ts'];

/**
 * The react-hooks half of the backlog.
 *
 * Kept separate from the rest so the Electron main process, the Playwright
 * suites and the build scripts are not walked by React rules that cannot
 * apply to them.
 *
 *   57  react-hooks/set-state-in-effect   (44 files)
 *   30  react-hooks/exhaustive-deps       (17 files)
 *   18  react-hooks/refs                  (2 files)
 *    3  react-hooks/static-components     (1 file)
 *    1  react-hooks/globals               (1 file)
 */
const HOOKS_BACKLOG = {
  'react-hooks/set-state-in-effect': 'warn',
  'react-hooks/exhaustive-deps': 'warn',
  'react-hooks/refs': 'warn',
  'react-hooks/static-components': 'warn',
  'react-hooks/globals': 'warn',
};

/**
 * The typescript-eslint half, applied only where that plugin is loaded.
 *
 *  247  @typescript-eslint/no-explicit-any        (73 files)
 *   31  @typescript-eslint/no-unused-vars         (22 files)
 *    2  @typescript-eslint/no-require-imports     (2 files)
 *    1  @typescript-eslint/no-unsafe-function-type (1 file)
 */
const TS_BACKLOG = {
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': 'warn',
  '@typescript-eslint/no-require-imports': 'warn',
  '@typescript-eslint/no-unsafe-function-type': 'warn',
};

/**
 * The core ESLint half, which applies to every file this config walks.
 *
 *    8  no-useless-assignment  (7 files)
 *    7  no-control-regex       (4 files)
 *    6  no-empty-pattern       (3 files)
 *    4  no-redeclare           (1 file)
 *    1  no-regex-spaces        (1 file)
 *
 * `no-useless-assignment` is ESLint 10's; it does not exist in 9. All eight
 * are dead stores in `e2e/` and `journeys/`, none in `src/`, and deleting
 * them would be no risk at all -- which is exactly why they are here. This
 * change fixes nothing and lands every pre-existing violation as a warning
 * with a number beside it; making an exception for the easy eight would
 * leave the next reader unable to trust the count.
 */
const CORE_BACKLOG = {
  'no-useless-assignment': 'warn',
  'no-control-regex': 'warn',
  'no-empty-pattern': 'warn',
  'no-redeclare': 'warn',
  'no-regex-spaces': 'warn',
};

export default tseslint.config(
  {
    // Everything generated, vendored or installed. `vendor/` is third-party
    // code shipped as-is; linting it would report on someone else's file.
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      'build-resources/**',
      'vendor/**',
      'e2e/screenshots/**',
      'perf/test-results/**',
      'demos/test-results/**',
    ],
  },

  {
    // An `eslint-disable` for a rule that reports nothing is how this
    // codebase ended up with five of them for a linter that was never
    // installed. A stale one now fails rather than accumulating.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  // ---- the renderer ------------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx}', 'atlas/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs['recommended-latest'].rules, ...HOOKS_BACKLOG },
  },
  {
    // The renderer suite runs in jsdom — jest's globals and the browser's
    // both in scope — and its mocks and setup file are CommonJS under Node.
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/__mocks__/**/*.js', 'jest.setup.js'],
    languageOptions: {
      globals: { ...globals.jest, ...globals.node, ...globals.browser },
    },
  },

  // ---- the Electron main process, the suites and the build scripts -------
  {
    files: ['electron/**/*.ts', 'e2e/**/*.ts', 'journeys/**/*.ts', 'perf/**/*.ts', 'demos/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['scripts/**/*.js', '*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
  },
  {
    files: ['*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
  },

  // ---- rules that do not apply to TypeScript -----------------------------
  {
    files: TYPESCRIPT,
    rules: {
      // 105 reports across 47 files with the rest of this config in place,
      // and all 105 are identifiers `no-undef` is structurally unable to
      // see. 55 are ambient TypeScript types -- `RequestInit` (20),
      // `RequestInfo` (14), `NodeJS` (9), `Electron` (6),
      // `EventListener`/`EventListenerOptions` (4), `BodyInit` (1),
      // `NotificationPermission` (1) -- which exist only in the type space
      // this rule does not read. The other 50 are `e2eFetch`, declared in a
      // `declare global` block at `e2e/fixtures/resmon-app.ts:94`.
      //
      // An earlier draft of this comment said 331 across 60. That figure was
      // measured before the jest-globals block for `src/**/__tests__` and
      // the browser globals on the electron block existed, so roughly 226 of
      // it was ordinary missing-globals (`expect`, `jest`, `window`,
      // `process`) that configuration fixed rather than false positives. The
      // judgment is the same either way; the number was not.
      //
      // typescript-eslint's own guidance is to switch it off on TypeScript
      // and let the compiler answer the question. That is a real
      // compensating control here, not a hand-wave: `tsconfig.json`,
      // `e2e/tsconfig.json`, `journeys/tsconfig.json` and
      // `tsconfig.electron.json` are each clean, and the first of them runs
      // as `npm run typecheck` in this same job. It stays on for the `.js`
      // build scripts, which no tsconfig covers.
      'no-undef': 'off',
    },
  },

  // ---- the backlog, applied last so it wins ------------------------------
  { files: TYPESCRIPT, rules: TS_BACKLOG },
  { files: ['**/*.{js,mjs,ts,tsx}'], rules: CORE_BACKLOG },
);
