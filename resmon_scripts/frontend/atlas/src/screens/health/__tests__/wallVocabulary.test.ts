/**
 * Every state the backend's Source wall can hold has a mark of its own here.
 *
 * `source_wall.WALL_STATES` is the one list of the wall's states, and the
 * words for each come with the grid (`state_legend`), so Atlas holds no label
 * of its own. What it does hold is how each state is drawn (`MARK`): a state
 * the backend adds without a mark here would be drawn as the square kept for
 * a state this build does not know. The list is read from the backend's
 * source rather than written here, so a state added there fails this until
 * Atlas draws it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MARK, markOf } from '../model';

const SOURCE_WALL = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'implementation_scripts', 'source_wall.py');

function wallStates(): string[] {
  const source = fs.readFileSync(SOURCE_WALL, 'utf8');
  const block = /^WALL_STATES: tuple\[str, \.\.\.\] = \(([\s\S]*?)^\)/m.exec(source);
  if (!block) throw new Error('source_wall.py no longer declares WALL_STATES as this test reads it');
  const states = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (states.length === 0) throw new Error('WALL_STATES parsed to nothing');
  return states;
}

test('each of the backend\'s wall states is drawn with its own mark', () => {
  const states = wallStates();
  const unknown = markOf('a state no build has heard of');
  expect(states.filter((state) => markOf(state) === unknown)).toEqual([]);
  expect(new Set(states.map((state) => markOf(state))).size).toBe(states.length);
});

test('Atlas draws no state the backend does not have', () => {
  const states = wallStates();
  expect(Object.keys(MARK).filter((state) => !states.includes(state))).toEqual([]);
});
