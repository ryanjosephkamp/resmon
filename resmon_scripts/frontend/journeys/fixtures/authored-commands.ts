/**
 * Authored commands on this machine, for the rows whose AI lane is a command a
 * person installed rather than an API: the repository's agent-CLI double that
 * the assistant runs, with or without a record of every argument it was handed,
 * and a summarizer whose sign-in has lapsed.
 *
 * Each is a file in the session's own state directory, so it is removed with
 * everything else the run made, and each is a file a person could point
 * Settings › AI at. Pointing the app at it is the driver's step, because that
 * is the step a person takes on a screen. Reading what a command received is
 * not, so it is read here, off the file the command wrote, whichever driver
 * set it up.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { expect } from '@playwright/test';
import type { Session } from '../drivers/session';

type Host = Pick<Session, 'stateDir' | 'root' | 'python'>;

/** The record separator the recording shim writes after each invocation's arguments. */
const END_OF_INVOCATION = '--journey-end-of-invocation--';

/** Where the recording shim writes what it was handed. */
function argumentLog(session: Pick<Session, 'stateDir'>): string {
  return path.join(session.stateDir, 'authored-agent-arguments');
}

/**
 * Write the agent command: a one-line shim around the repository's own
 * agent-CLI double, run under the same interpreter the backend uses. Returns
 * its path, which is what a person types as the command.
 *
 * With `recordArguments`, the shim first appends every argument it was given
 * to a log and then execs the double unchanged. **NUL-separated**, because
 * the last argument is the person's own prompt and a prompt with a newline in
 * it would otherwise be read back as several arguments — which is precisely
 * the kind of silent corruption the composer row is about.
 */
export function writeTheAuthoredAgentCommand(session: Host, options: { recordArguments: boolean }): string {
  const command = path.join(session.stateDir, 'authored-agent-command');
  const double = path.join(
    session.root.repo, 'resmon_scripts', 'verification_scripts', 'fixtures', 'fake_claude.py',
  );
  expect(
    fs.existsSync(double),
    'the build under test carries no agent-CLI double to drive the assistant with',
  ).toBe(true);
  // The interpreter has to be absolute: a bare name in a shebang is not
  // looked up on PATH the way a command is.
  const python = execFileSync(session.python, ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' }).trim();
  const record = options.recordArguments
    ? `{ for argument in "$@"; do printf '%s\\0' "$argument"; done; `
      + `printf '%s\\0' '${END_OF_INVOCATION}'; } >> "${argumentLog(session)}"\n`
    : '';
  fs.writeFileSync(command, `#!/bin/sh\n${record}exec "${python}" "${double}" "$@"\n`, { mode: 0o755 });
  return command;
}

/** Every argument list the recording shim was run with, in order; empty where it never ran. */
export function readTheAgentCommandArguments(session: Pick<Session, 'stateDir'>): string[][] {
  const log = argumentLog(session);
  if (!fs.existsSync(log)) return [];
  const invocations: string[][] = [];
  let current: string[] = [];
  // The trailing separator leaves one empty field, which is not an argument.
  const fields = fs.readFileSync(log, 'utf8').split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  for (const field of fields) {
    if (field === END_OF_INVOCATION) { invocations.push(current); current = []; } else current.push(field);
  }
  expect(current, 'the agent command was recorded mid-invocation').toEqual([]);
  return invocations;
}

/**
 * Write a summarizer whose sign-in has lapsed, and return its path.
 *
 * The summarization lane runs `claude -p --output-format json …` and reads one
 * JSON envelope off stdout. A CLI whose OAuth session has lapsed answers with
 * `is_error` set and says so in `result`, and exits zero doing it — which is
 * why the lane keys on the field rather than on the status. This is that
 * envelope, byte for byte as `test_llm_subscription.py` recorded it from the
 * real CLI.
 */
export function writeTheLapsedSummarizer(session: Pick<Session, 'stateDir'>): string {
  const command = path.join(session.stateDir, 'authored-summarizer');
  fs.writeFileSync(command, '#!/bin/sh\ncat <<\'JSON\'\n'
    + JSON.stringify({
      is_error: true,
      subtype: 'success',
      terminal_reason: 'api_error',
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      type: 'result',
    })
    + '\nJSON\n', { mode: 0o755 });
  return command;
}
