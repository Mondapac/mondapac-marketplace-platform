import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeDefinition } from './attribute-definition';
import { AttributeFamily } from './attribute-family';
import { buildAttributeSchema } from './attribute-schema-builder';
import {
  ZZ_ATTRIBUTE_DEFINITIONS,
  ZZ_ATTRIBUTE_FAMILIES,
} from '../infrastructure/seed/zz.attributes.seed';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');

const definitions = ZZ_ATTRIBUTE_DEFINITIONS.map((seeded) => {
  const result = AttributeDefinition.create({
    id: `d-${seeded.code}` as Id<'AttributeDefinition'>,
    revisionId: `dr-${seeded.code}` as Id<'AttributeDefinitionRevision'>,
    marketId: 'ZZ' as MarketId,
    ...seeded,
    createdByKind: 'seed',
    now: NOW,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.state;
});
const seededFamily = ZZ_ATTRIBUTE_FAMILIES[0]!;
const family = (() => {
  const result = AttributeFamily.create({
    id: 'f1' as Id<'AttributeFamily'>,
    revisionId: 'fr1' as Id<'AttributeFamilyRevision'>,
    marketId: 'ZZ' as MarketId,
    code: seededFamily.code,
    groups: seededFamily.groups,
    createdByKind: 'seed',
    now: NOW,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.state;
})();

describe('buildAttributeSchema', () => {
  it('builds the fields in group order and records what the schema was built from', () => {
    const built = buildAttributeSchema(family, definitions);
    if (!built.ok) throw new Error(built.missingCodes.join());
    expect(built.schema.fields.map((field) => field.code)).toEqual([
      'brand',
      'description',
      'colour',
      'grade',
      'weight-grams',
    ]);
    expect(built.schema.schemaRef).toEqual({
      familyCode: 'default',
      familyRevisionId: 'fr1',
      definitionRevisionIds: [
        'dr-brand',
        'dr-description',
        'dr-colour',
        'dr-grade',
        'dr-weight-grams',
      ],
    });
  });

  it('takes required from the family and material, type and options from the definition', () => {
    const built = buildAttributeSchema(family, definitions);
    if (!built.ok) throw new Error('missing');
    const field = (code: string) => built.schema.fields.find((f) => f.code === code)!;
    expect(field('brand').required).toBe(true);
    expect(field('grade').material).toBe(true);
    expect(field('colour').isVariantOption).toBe(true);
    expect(field('colour').bounds.options).toEqual([{ code: 'red' }, { code: 'green' }]);
    expect(field('weight-grams').bounds).toMatchObject({ min: 1, max: 100000 });
  });

  it('does not make a variant option of an attribute the definition does not allow', () => {
    const odd = {
      ...family,
      groups: [
        { groupCode: 'g', attributes: [{ code: 'brand', required: false, isVariantOption: true }] },
      ],
    };
    const built = buildAttributeSchema(odd, definitions);
    if (!built.ok) throw new Error('missing');
    expect(built.schema.fields[0]!.isVariantOption).toBe(false);
  });

  it('returns the codes no definition supplies instead of a partial schema', () => {
    const built = buildAttributeSchema(
      family,
      definitions.filter((d) => d.code !== 'grade'),
    );
    expect(built).toEqual({ ok: false, missingCodes: ['grade'] });
  });

  it('treats an archived definition as missing', () => {
    const archived = definitions.map((d) =>
      d.code === 'brand' ? { ...d, status: 'archived' as const } : d,
    );
    expect(buildAttributeSchema(family, archived)).toEqual({ ok: false, missingCodes: ['brand'] });
  });
});
