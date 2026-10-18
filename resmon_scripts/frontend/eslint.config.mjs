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
const TYPESCRIPT = ['src/**/*.{ts,tsx}', 'electron/**/*.ts', 'e2e/**/*.ts', 'journeys/**/*.ts'];

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
 *    7  no-control-regex  (4 files)
 *    6  no-empty-pattern  (3 files)
 *    4  no-redeclare      (1 file)
 *    1  no-regex-spaces   (1 file)
 */
const CORE_BACKLOG = {
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
    files: ['src/**/*.{ts,tsx}'],
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
    files: ['electron/**/*.ts', 'e2e/**/*.ts', 'journeys/**/*.ts'],
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
      // 331 reports across 60 files, every one of them wrong: `no-undef`
      // reads an ambient type as an undefined identifier (`RequestInit`,
      // `NodeJS`, `Electron`) and cannot see a global a `.d.ts` declares
      // (`e2eFetch`, injected into the page by the Playwright fixture).
      // typescript-eslint's own guidance is to switch it off on TypeScript
      // and let the compiler answer the question, which `npm run typecheck`
      // does in this same job. It stays on for the `.js` build scripts.
      'no-undef': 'off',
    },
  },

  // ---- the backlog, applied last so it wins ------------------------------
  { files: TYPESCRIPT, rules: TS_BACKLOG },
  { files: ['**/*.{js,mjs,ts,tsx}'], rules: CORE_BACKLOG },
);
