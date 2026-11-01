import { engineState, identityOf } from '../engineIdentity';

const health = (runtime_id: unknown, contract_version: unknown = 3) => ({ status: 'ok', identity: { runtime_id, contract_version } });

describe('which engine answers this window', () => {
  it('reads the runtime id and contract version an answer carries', () => {
    expect(identityOf(health('r-1', 3))).toEqual({ runtime: 'r-1', contract: 3 });
  });

  it('reads nothing from an answer with no identity, or one it cannot read', () => {
    expect(identityOf({ status: 'ok' })).toBeNull();
    expect(identityOf(health('', 3))).toBeNull();
    expect(identityOf(health(7, 3))).toBeNull();
    expect(identityOf(health('r-1', '3'))).toBeNull();
    expect(identityOf(null)).toBeNull();
    expect(identityOf(undefined)).toBeNull();
  });

  it('says nothing before the first answer, or while the engine is the one it opened on', () => {
    const first = { runtime: 'r-1', contract: 3 };
    expect(engineState(null, undefined)).toBe('same');
    expect(engineState(null, first)).toBe('same');
    expect(engineState(first, { runtime: 'r-1', contract: 3 })).toBe('same');
  });

  it('says the engine changed when the runtime or the contract differs', () => {
    const first = { runtime: 'r-1', contract: 3 };
    expect(engineState(first, { runtime: 'r-2', contract: 3 })).toBe('changed');
    expect(engineState(first, { runtime: 'r-1', contract: 4 })).toBe('changed');
  });

  it('says the identity cannot be read rather than guessing either way', () => {
    expect(engineState({ runtime: 'r-1', contract: 3 }, null)).toBe('unreadable');
    expect(engineState(null, null)).toBe('unreadable');
  });
});
