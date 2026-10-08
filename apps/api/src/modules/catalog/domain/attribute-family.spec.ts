import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeFamily } from './attribute-family';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const entry = (code: string) => ({ code, required: false, isVariantOption: false });
const input = (overrides: Partial<Parameters<typeof AttributeFamily.create>[0]> = {}) => ({
  id: 'f1' as Id<'AttributeFamily'>,
  revisionId: 'fr1' as Id<'AttributeFamilyRevision'>,
  marketId: 'ZZ' as MarketId,
  code: 'default',
  groups: [{ groupCode: 'general', attributes: [entry('brand'), entry('colour')] }],
  createdByKind: 'seed' as const,
  now: NOW,
  ...overrides,
});

describe('AttributeFamily.create', () => {
  it('builds an active family at version 1', () => {
    const result = AttributeFamily.create(input());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({ status: 'active', version: 1, revisionNo: 1 });
  });

  it.each([
    ['a bad family code', { code: 'Default' }, 'attribute-family.code-invalid'],
    [
      'a bad group code',
      { groups: [{ groupCode: '1x', attributes: [] }] },
      'attribute-family.group-invalid',
    ],
    [
      'a repeated group',
      {
        groups: [
          { groupCode: 'g1', attributes: [] },
          { groupCode: 'g1', attributes: [] },
        ],
      },
      'attribute-family.group-repeated',
    ],
    [
      'a bad attribute code',
      { groups: [{ groupCode: 'g1', attributes: [entry('Bad')] }] },
      'attribute-family.attribute-invalid',
    ],
    [
      'an attribute in two groups',
      {
        groups: [
          { groupCode: 'g1', attributes: [entry('brand')] },
          { groupCode: 'g2', attributes: [entry('brand')] },
        ],
      },
      'attribute-family.attribute-repeated',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    const result = AttributeFamily.create(input(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});
