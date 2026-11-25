import type { CapabilitySpec } from './capability';
import { CapabilityRegistry, CapabilityRegistryError } from './capability-registry';

const SPEC: CapabilitySpec = {
  id: 'alpha.writer',
  audience: 'seller',
  task: 'write',
  sellerScoped: true,
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 10_000,
  promptVersion: 'alpha-writer-1',
};

describe('CapabilityRegistry (platform-ai.md section 4)', () => {
  it('registers a module capability and returns it by id', () => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', [SPEC]);
    expect(registry.get('alpha.writer')).toEqual(SPEC);
    expect(registry.get('alpha.other')).toBeUndefined();
    expect(registry.ids()).toEqual(['alpha.writer']);
  });

  it('fails on a duplicate, a foreign id or after sealing', () => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', [SPEC]);
    expect(() => registry.register('alpha', [SPEC])).toThrow(CapabilityRegistryError);
    expect(() => registry.register('beta', [SPEC])).toThrow(/starts with its owner/u);
    registry.onApplicationBootstrap();
    expect(registry.sealed).toBe(true);
    expect(() => registry.register('gamma', [{ ...SPEC, id: 'gamma.writer' }])).toThrow(/sealed/u);
  });

  it.each([
    ['a bad id', { id: 'Alpha.Writer' }],
    ['an unknown audience', { audience: 'robot' }],
    ['an unknown task', { task: 'dance' }],
    ['no output cap', { maxOutputTokens: 0 }],
    ['a fractional timeout', { timeoutMs: 1.5 }],
    ['tools under an admin (R9)', { audience: 'admin', sellerScoped: false, maxToolRounds: 1 }],
    ['a seller-scoped buyer capability', { audience: 'buyer' }],
    ['a prompt version with spaces', { promptVersion: 'v 1' }],
  ])('refuses %s', (_name, change) => {
    const registry = new CapabilityRegistry();
    expect(() => registry.register('alpha', [{ ...SPEC, ...change } as CapabilitySpec])).toThrow(
      CapabilityRegistryError,
    );
  });

  it('refuses the owner platform: platform.ai-evaluation is the evaluation budget (G4c)', () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register('platform', [{ ...SPEC, id: 'platform.ai-evaluation' }]),
    ).toThrow(/reserved/u);
    expect(registry.get('platform.ai-evaluation')).toBeUndefined();
  });
});
