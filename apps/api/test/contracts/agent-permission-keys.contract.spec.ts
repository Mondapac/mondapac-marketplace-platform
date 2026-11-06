import { PERMISSION_KEY_PATTERN } from '../../src/platform/authz/access-rule';
import { AGENTS_MANAGE_KEY, AGENTS_READ_KEY } from '../../src/modules/identity/contracts';

// The keys identity re-checks for the `agents` module (ADR-0045) are plain strings, so they must
// be the exact, well-formed names the `agents` module will declare. Registry membership is
// asserted once the `agents` module merges and declares them.
describe('agent permission keys held by identity', () => {
  it('are the exact names the agents module declares', () => {
    expect(AGENTS_MANAGE_KEY).toBe('agents.agent.manage');
    expect(AGENTS_READ_KEY).toBe('agents.agent.read');
  });

  it.each([AGENTS_MANAGE_KEY, AGENTS_READ_KEY])('%s matches the permission key pattern', (key) => {
    expect(PERMISSION_KEY_PATTERN.test(key)).toBe(true);
  });
});
