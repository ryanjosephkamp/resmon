import { stepMark } from '../FirstRun';

describe('Getting started’s marks', () => {
  test('a command that was found is marked found, never with the mark of a key that is stored', () => {
    expect(stepMark({ id: 'agent_cli', done: true })).toEqual({ label: 'found', state: 'found' });
    expect(stepMark({ id: 'ai_key', done: true })).toEqual({ label: 'done', state: 'yes' });
    expect(stepMark({ id: 'repository_key', done: true })).toEqual({ label: 'done', state: 'yes' });
  });

  test('not found, not stored, and not checked are each their own', () => {
    expect(stepMark({ id: 'agent_cli', done: false })).toEqual({ label: 'not done', state: 'no' });
    expect(stepMark({ id: 'ai_key', done: null })).toEqual({ label: 'could not check', state: 'unknown' });
  });
});
