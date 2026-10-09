import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type { AttributeFamily } from '../../domain/attribute-family';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeSeed, SeededDefinition, SeededFamily } from '../ports/attribute-seed';
import type { CheckClaimText, CheckedText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { SeedAttributes } from './seed-attributes.use-case';

/** A claim-text check whose verdict for a text is `found` when it contains "halal". */
function fakeCheck(options: { unavailable?: boolean } = {}) {
  const seen: CheckedText[][] = [];
  const check = {
    executeAsSystem: (_c: unknown, texts: readonly CheckedText[]) => {
      seen.push([...texts]);
      return Promise.resolve({
        ok: true as const,
        value: texts.map((item) => ({
          field: item.field,
          ref: item.ref,
          locale: item.locale,
          code: options.unavailable
            ? ('claim-text.check-unavailable' as const)
            : item.text.toLowerCase().includes('halal')
              ? ('claim-text.found' as const)
              : ('clean' as const),
        })),
      });
    },
  } as unknown as CheckClaimText;
  return { check, seen };
}
const policy = {
  locales: () => ({ default: 'xx', supported: ['xx'] }),
} as unknown as CatalogMarketPolicy;

// The seed use case (catalog design 7.2) in memory for both Market fixtures: system only,
// definitions before families, create-only, an existing code skipped whatever its state, a seed
// that breaks a rule refused with the code named. The SQL is covered by
// test/db/catalog-attributes.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class MemoryAttributes implements AttributeRepository {
  readonly definitions = new Map<string, Id<'AttributeDefinition'>>();
  readonly archived = new Set<string>();
  readonly families = new Map<string, Id<'AttributeFamily'>>();
  readonly order: string[] = [];

  loadSchema() {
    return Promise.resolve(null);
  }

  definitionIdByCode(_m: MarketContext, code: string) {
    return Promise.resolve(this.definitions.get(code) ?? null);
  }
  activeDefinitionCodes(_m: MarketContext, codes: readonly string[]) {
    return Promise.resolve(
      new Set(codes.filter((code) => this.definitions.has(code) && !this.archived.has(code))),
    );
  }
  familyIdByCode(_m: MarketContext, code: string) {
    return Promise.resolve(this.families.get(code) ?? null);
  }
  addDefinition(_m: MarketContext, definition: AttributeDefinition) {
    this.definitions.set(definition.state.code, definition.state.id);
    this.order.push(`definition:${definition.state.code}`);
    return Promise.resolve();
  }
  addFamily(_m: MarketContext, family: AttributeFamily) {
    this.families.set(family.state.code, family.state.id);
    this.order.push(`family:${family.state.code}`);
    return Promise.resolve();
  }
}

const definition = (code: string, overrides: Partial<SeededDefinition> = {}): SeededDefinition => ({
  code,
  dataType: 'text',
  localizable: false,
  material: false,
  isVariantOption: false,
  bounds: { maxLength: 80 },
  names: { xx: 'A name' },
  options: [],
  ...overrides,
});

const family = (code: string, attributeCodes: readonly string[]): SeededFamily => ({
  code,
  groups: [
    {
      groupCode: 'main',
      attributes: attributeCodes.map((attribute) => ({
        code: attribute,
        required: false,
        isVariantOption: false,
      })),
    },
  ],
});

describe.each(TEST_MARKETS)('SeedAttributes in market %s', (code) => {
  const market = testMarketContext(code, 'default');

  function build(
    seedDefinitions: readonly SeededDefinition[],
    seedFamilies: readonly SeededFamily[],
    checkOptions: { unavailable?: boolean } = {},
  ) {
    const { check, seen } = fakeCheck(checkOptions);
    let sequence = 0;
    const attributes = new MemoryAttributes();
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const attributeSeed: AttributeSeed = {
      definitions: () => seedDefinitions,
      families: () => seedFamilies,
    };
    const useCase = new SeedAttributes(createUseCaseGate(markets, null), {
      unitOfWork,
      attributes,
      attributeSeed,
      check,
      policy,
      clock: new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z')),
      ids: {
        next: <T extends string>() =>
          `01990000-0000-7000-8000-${String(++sequence).padStart(12, '0')}` as Id<T>,
      },
    });
    return { useCase, attributes, seen };
  }

  const system = () => testCallContext(market, 'system', 'seed-attributes-0001');

  it('declares rule system under its own name', () => {
    expect(SeedAttributes.access).toEqual({
      name: 'catalog.seed-attributes',
      rule: { kind: 'system' },
    });
  });

  it('creates definitions before families, once, and nothing on a rerun', async () => {
    const s = build([definition('brand'), definition('model')], [family('default', ['brand'])]);

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { definitions: 2, families: 1 },
    });
    expect(s.attributes.order).toEqual(['definition:brand', 'definition:model', 'family:default']);

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { definitions: 0, families: 0 },
    });
    expect(s.attributes.order).toHaveLength(3);
  });

  it('skips an existing code whatever its state: there is no update path', async () => {
    const s = build([definition('brand', { material: true })], []);
    s.attributes.definitions.set(
      'brand',
      '01990000-0000-7000-8000-0000000000ff' as Id<'AttributeDefinition'>,
    );
    s.attributes.archived.add('brand');

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { definitions: 0, families: 0 },
    });
    expect(s.attributes.order).toEqual([]);
  });

  it('answers an empty seed with zeros', async () => {
    const s = build([], []);
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { definitions: 0, families: 0 },
    });
  });

  it('refuses a definition that breaks a rule, naming the code, and keeps the earlier ones', async () => {
    const s = build([definition('brand'), definition('Bad Code')], []);
    const result = await s.useCase.execute(system(), {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'attribute.seed-invalid', name: 'Bad Code' },
    });
    expect(s.attributes.definitions.has('brand')).toBe(true);
  });

  it('refuses a family that names an unknown definition', async () => {
    const s = build([definition('brand')], [family('default', ['brand', 'missing'])]);
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: false,
      error: {
        code: 'attribute.seed-invalid',
        name: 'default',
        reason: 'attribute-family.unknown-attribute',
      },
    });
    expect(s.attributes.families.size).toBe(0);
  });

  it('refuses a family that names an archived definition', async () => {
    const s = build([], [family('default', ['brand'])]);
    s.attributes.definitions.set(
      'brand',
      '01990000-0000-7000-8000-0000000000fe' as Id<'AttributeDefinition'>,
    );
    s.attributes.archived.add('brand');
    await expect(s.useCase.execute(system(), {})).resolves.toMatchObject({
      ok: false,
      error: { reason: 'attribute-family.unknown-attribute' },
    });
  });

  it('refuses every caller but the system', async () => {
    const s = build([definition('brand')], []);
    const anonymous = testCallContext(market, 'anonymous', 'seed-attributes-0002');
    const result = await s.useCase.execute(anonymous, {});
    expect(result.ok).toBe(false);
    expect(s.attributes.order).toEqual([]);
  });

  it('checks every name and option label as the system actor before writing anything', async () => {
    const withOption: SeededDefinition = {
      ...definition('brand'),
      options: [{ code: 'acme', labels: { xx: 'Acme' }, active: true, position: 1 }],
    };
    const s = build([withOption], []);
    await s.useCase.execute(system(), {});
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toEqual([
      { field: 'attribute-definition.name', ref: 'brand', locale: 'xx', text: 'A name' },
      { field: 'attribute-definition.option-label', ref: 'brand-acme', locale: 'xx', text: 'Acme' },
    ]);
  });

  it('refuses the whole run, creating nothing, when an option label holds a claim word', async () => {
    const bad: SeededDefinition = {
      ...definition('brand'),
      options: [{ code: 'x', labels: { xx: 'Halal' }, active: true, position: 1 }],
    };
    const s = build([definition('model'), bad], []);
    const result = await s.useCase.execute(system(), {});
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'seed.claim-text-refused',
        places: [{ field: 'attribute-definition.option-label', ref: 'brand-x' }],
      },
    });
    expect(s.attributes.definitions.size).toBe(0);
  });

  it('refuses the whole run when the check is unavailable', async () => {
    const s = build([definition('brand')], [], { unavailable: true });
    const result = await s.useCase.execute(system(), {});
    expect(!result.ok && result.error.code).toBe('seed.claim-text-unavailable');
    expect(s.attributes.definitions.size).toBe(0);
  });
});
