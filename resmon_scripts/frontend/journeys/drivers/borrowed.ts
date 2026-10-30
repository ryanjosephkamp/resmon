/**
 * What the candidate borrows from the classic driver, and why: the only way a
 * candidate journey takes a step without going through an Atlas screen.
 *
 * Two lists, because a step has no Atlas markup to drive for one of two
 * different reasons, and only one of them is permanent.
 *
 * - **Screenless.** Nothing a person does on a screen, in any interface:
 *   reading the engine's own record, a picture, the test's own fixtures going
 *   down and up, a raw socket, the MCP server, a pytest gate, killing the
 *   backend or quitting the app, a file read on disk, and what an authored
 *   command, provider or model was sent.
 * - **API setup.** A step a person takes on a screen, which the classic driver
 *   takes over the app's API instead, borrowed only because Atlas has no
 *   screen for it. Each entry says why, as a fact about Atlas checked against
 *   its code. This list is meant to shrink: the day Atlas has the screen, the
 *   step goes through it, and `register.spec.ts` fails until the entry goes.
 *
 * `register.spec.ts` holds both lists to that: a member borrowed from neither,
 * an API-setup entry with no real reason, an entry `atlas.ts` now implements,
 * and a screenless member whose classic body writes to the app all fail it.
 * Everything else Atlas does not implement is skipped as "Not in Atlas yet".
 *
 * Data only, so the guard can read it without launching or importing a driver.
 */

/** Members that touch no screen in any interface. */
export const SCREENLESS: readonly string[] = [
  // The engine's own record, read over its API; its two writes are seeding
  // (`collectPapers`) and the API half of the erase check (`eraseCorpus`).
  'backend', 'waitForRunToSettle', 'reportExists', 'readAssistantSettings',
  // A picture, and what the offline guard refused.
  'takePicture', 'refusedConnections',
  // The authored source: held, released, taken down and brought back.
  'releaseTheSource', 'theSourceGoesDown', 'theSourceComesBack',
  // The process: the backend killed as a force-quit would, the app quit.
  'killTheBackend', 'closeTheApp',
  // A port bound and closed again on this machine.
  'anAddressThatRefusesConnections',
  // J16: the live suite's gate, run as a subprocess. Its journey is a CI job.
  'runTheGate',
  // What a folder or a feed received, read off the disk.
  'readDeliveredFiles', 'readFeedFile',
  // J37: a saved file opened in a reader that is not resmon.
  'readTheFileOffline',
  // What the authored command, provider and model were sent, and the model
  // told to cite text it was not sent: the fixtures' own records.
  'readWhatTheAgentCommandReceived', 'readWhatTheProviderReceived',
  'theAuthoredModelCitesTextItWasNotSent', 'readWhatTheAuthoredModelReceived',
  // J42 and J44: a raw socket that is not this renderer, and the MCP server an
  // outside harness starts. Neither goes through a window.
  'askOverTheRawSocket', 'askTheMcpServer',
];

/**
 * Setup a person does on a screen that Atlas does not have yet, by member,
 * with the fact that says so. A reason names what Atlas lacks and the route
 * the classic driver takes instead.
 */
export const API_SETUP: Readonly<Record<string, string>> = {
  scanForNearDuplicates:
    'Atlas has no control that starts the near-duplicate scan, and neither does the classic renderer: '
    + 'a run only reads the links a scan stored (sweep_engine._duplicate_links_for), so the corpus-wide '
    + 'scan starts only on POST /api/links/scan.',
};

/** Whether the candidate takes this member from the classic driver. */
export function borrowedFromClassic(member: string): boolean {
  return SCREENLESS.includes(member) || Object.prototype.hasOwnProperty.call(API_SETUP, member);
}
