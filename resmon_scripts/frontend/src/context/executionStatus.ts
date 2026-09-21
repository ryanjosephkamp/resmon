/**
 * One vocabulary for an execution's status.
 *
 * The renderer used to spell the words twice — once in `ActiveExecution`'s
 * union type and once in a hand-written `TERMINAL_STATUSES` array — and both
 * copies were a transcription of the `executions.status` CHECK in
 * `implementation_scripts/database.py`. Three lists that must agree and no
 * check that they do is how `interrupted` could have been added to the schema
 * and silently left out of the list that decides when a run is over: the
 * monitor would have gone on showing a finished run as running.
 *
 * `EXECUTION_DB_STATUSES` is now the single source. `ExecutionStatusVocabulary.test.ts`
 * parses the CHECK values out of the DDL string in `database.py` and fails if
 * the two sets differ, so adding a status to the schema without adding it here
 * is a red renderer test rather than a quiet behaviour change.
 */

/**
 * Every value `executions.status` may hold, in the order the DDL lists them.
 * The set — not the order — is what the vocabulary test compares.
 */
export const EXECUTION_DB_STATUSES = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type ExecutionDbStatus = (typeof EXECUTION_DB_STATUSES)[number];

/**
 * `cancelling` is this renderer's own intermediate word: it is set locally
 * between the cancel request and the backend's answer, and never comes back
 * from the database. It is deliberately *not* in `EXECUTION_DB_STATUSES`,
 * which is what lets the vocabulary test compare that list to the CHECK
 * exactly rather than approximately.
 */
export const CLIENT_ONLY_EXECUTION_STATUSES = ['cancelling'] as const;

export type ClientOnlyExecutionStatus = (typeof CLIENT_ONLY_EXECUTION_STATUSES)[number];

/** What `ActiveExecution.status` may be: a stored status, or the local one. */
export type ExecutionStatus = ExecutionDbStatus | ClientOnlyExecutionStatus;

/** The one stored status that does not mean the run is over. */
export const RUNNING_STATUS: ExecutionDbStatus = 'running';

/**
 * The statuses that mean the run is over: the CHECK values minus `running`.
 * Derived, never retyped — a new stored status is terminal by default, which
 * is the safe direction: a run the renderer wrongly believes is still going
 * is the overclaim, not one it stops polling too early.
 */
export const TERMINAL_STATUSES: readonly ExecutionDbStatus[] =
  EXECUTION_DB_STATUSES.filter((status) => status !== RUNNING_STATUS);

/**
 * The statuses a stopped run can be started again from.
 *
 * Mirrors ``resmon._RESTARTABLE_STATES``, and like `TERMINAL_STATUSES` it is
 * derived rather than retyped: terminal, minus the one terminal status that
 * means the run did what it was asked. The backend is still the decider — it
 * answers 409 with a sentence for anything else — so this only decides whether
 * offering the button is worth the user's attention.
 */
export const RESTARTABLE_STATUSES: readonly ExecutionDbStatus[] =
  TERMINAL_STATUSES.filter((status) => status !== 'completed');

/**
 * The label the Results status filter shows for a stored status.
 *
 * Derived from the word itself rather than held in a map, so a status added to
 * the vocabulary gets an option — and a readable one — without a second list
 * to keep in step. The badge in the table deliberately shows the raw stored
 * word instead; that column is reporting what the database holds.
 */
export const executionStatusLabel = (status: string): string =>
  status.charAt(0).toUpperCase() + status.slice(1);

/**
 * The options of the Results status filter, in the order the DDL lists the
 * statuses. A status added to `EXECUTION_DB_STATUSES` appears here; one that
 * is renderer-only (`cancelling`) never does, because no row is ever stored
 * with it and the filter compares against stored values.
 */
export const EXECUTION_STATUS_FILTER_OPTIONS: readonly { value: ExecutionDbStatus; label: string }[] =
  EXECUTION_DB_STATUSES.map((status) => ({ value: status, label: executionStatusLabel(status) }));
