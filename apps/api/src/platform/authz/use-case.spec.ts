import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS, TEST_MARKETS } from '../../../test/support/test-config';
import type { MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { AccessDeclaration } from './access-rule';
import { UseCase, UseCaseDefinitionError } from './use-case';
import { UseCaseGate } from './use-case-gate';

// identity design 5.2: `execute` is the only public entry; it asks the gate, then `handle`.

const gate = () =>
  new UseCaseGate(
    new MarketRegistry(new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig]))),
    null,
  );

class PurgeThings extends UseCase<{ readonly limit: number }, string> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.purge-things',
    rule: { kind: 'system' },
  };
  readonly seen: CallContext[] = [];

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly limit: number }) {
    this.seen.push(context);
    return Promise.resolve(ok(`purged ${input.limit} in ${context.market.marketId}`));
  }
}

class Lookup extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.lookup',
    rule: { kind: 'anonymous' },
  };
  constructor(gate: UseCaseGate) {
    super(gate);
  }
  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.actor.kind));
  }
}

describe.each(TEST_MARKETS)('UseCase in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  it('runs handle with the admitted context when the gate admits', async () => {
    const useCase = new PurgeThings(gate());
    const context = testCallContext(market, 'system');

    await expect(useCase.execute(context, { limit: 5 })).resolves.toEqual({
      ok: true,
      value: `purged 5 in ${code}`,
    });
    expect(useCase.seen).toEqual([context]);
  });

  it('never runs handle when the gate refuses, and answers the refusal', async () => {
    const useCase = new PurgeThings(gate());

    await expect(
      useCase.execute(testCallContext(market, 'anonymous'), { limit: 5 }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(useCase.seen).toEqual([]);
  });

  it('hands handle the context the gate answered (the anonymous actor, HF9)', async () => {
    await expect(new Lookup(gate()).execute(testCallContext(market, 'anonymous'))).resolves.toEqual(
      { ok: true, value: 'anonymous' },
    );
  });
});

describe('UseCase construction refuses what the CI check also refuses (HF4)', () => {
  it('refuses a use case that extends another use case', () => {
    class Sneaky extends PurgeThings {
      static override readonly access: AccessDeclaration = {
        name: 'identity.sneaky',
        rule: { kind: 'system' },
      };
    }

    expect(() => new Sneaky(gate())).toThrow(UseCaseDefinitionError);
  });

  it('refuses a use case that overrides execute', () => {
    class Bypass extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.bypass',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      override execute(): Promise<Result<string, never>> {
        return Promise.resolve(ok('skipped the gate'));
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }

    expect(() => new Bypass(gate())).toThrow(/execute/);
  });

  it('refuses a use case without its own valid declaration', () => {
    class Undeclared extends UseCase<void, string> {
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }
    class Malformed extends Undeclared {}
    Object.defineProperty(Undeclared, 'access', {
      value: { name: 'identity.undeclared', rule: { kind: 'own-resources' } },
    });

    expect(() => new Undeclared(gate())).toThrow(/declaration/);
    expect(() => new Malformed(gate())).toThrow(UseCaseDefinitionError);
  });

  it('refuses a gate that is not the platform UseCaseGate', () => {
    const lenient = { admit: (_: unknown, context: CallContext) => Promise.resolve(ok(context)) };

    expect(() => new PurgeThings(lenient as unknown as UseCaseGate)).toThrow(/UseCaseGate/);
  });
});
