import { CapabilityRegistry } from '../capability-registry';
import { EVAL_SPECS, FakeSuite } from '../../../../test/support/ai-evaluations';
import { EvaluationSuiteRegistry, EvaluationSuiteRegistryError } from './evaluation-suite';

const registryOf = () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register('alpha', EVAL_SPECS);
  capabilities.seal();
  return new EvaluationSuiteRegistry(capabilities);
};

describe('EvaluationSuiteRegistry (G4c)', () => {
  it('registers, seals and answers suites by capability, sorted', () => {
    const registry = registryOf();
    const admin = new FakeSuite('alpha.admin-writer');
    registry.register('alpha', [new FakeSuite('alpha.seller-writer'), admin]);
    registry.onApplicationBootstrap();
    expect(registry.sealed).toBe(true);
    expect(registry.ids()).toEqual(['alpha.admin-writer', 'alpha.seller-writer']);
    expect(registry.get('alpha.admin-writer')).toBe(admin);
    expect(registry.get('alpha.tool-chat')).toBeUndefined();
  });

  it.each([
    ['the reserved owner platform', 'platform', () => new FakeSuite('platform.ai-evaluation')],
    ['an owner that is not a module name', 'Alpha', () => new FakeSuite('Alpha.writer')],
    ["another module's capability", 'beta', () => new FakeSuite('alpha.admin-writer')],
    [
      'a bad set version',
      'alpha',
      () => Object.assign(new FakeSuite('alpha.admin-writer'), { setVersion: 'a b' }),
    ],
    ['no samples', 'alpha', () => new FakeSuite('alpha.admin-writer', [])],
    [
      'a duplicate sample',
      'alpha',
      () =>
        new FakeSuite('alpha.admin-writer', [
          { id: 's-1', text: 'x', mustShow: 'x', mustNotShow: 'y' },
          { id: 's-1', text: 'x', mustShow: 'x', mustNotShow: 'y' },
        ]),
    ],
    [
      'a sample id outside the pattern',
      'alpha',
      () =>
        new FakeSuite('alpha.admin-writer', [
          { id: 'S 1', text: 'x', mustShow: 'x', mustNotShow: 'y' },
        ]),
    ],
    [
      'a request with tools',
      'alpha',
      () => Object.assign(new FakeSuite('alpha.admin-writer'), { withTools: true }),
    ],
  ])('refuses %s', (_name, owner, suite) => {
    expect(() => registryOf().register(owner, [suite()])).toThrow(EvaluationSuiteRegistryError);
  });

  it('refuses a second suite of a capability, and any registration once sealed', () => {
    const registry = registryOf();
    registry.register('alpha', [new FakeSuite('alpha.admin-writer')]);
    expect(() => registry.register('alpha', [new FakeSuite('alpha.admin-writer')])).toThrow(
      EvaluationSuiteRegistryError,
    );
    registry.seal();
    expect(() => registry.register('alpha', [new FakeSuite('alpha.seller-writer')])).toThrow(
      EvaluationSuiteRegistryError,
    );
  });

  it('refuses at seal a capability nobody registered, or one with tool rounds (G4c2)', () => {
    const unknown = registryOf();
    unknown.register('alpha', [new FakeSuite('alpha.nothing')]);
    expect(() => unknown.seal()).toThrow(/not a registered capability/);
    const tools = registryOf();
    tools.register('alpha', [new FakeSuite('alpha.tool-chat')]);
    expect(() => tools.seal()).toThrow(/G4c2/);
  });
});
