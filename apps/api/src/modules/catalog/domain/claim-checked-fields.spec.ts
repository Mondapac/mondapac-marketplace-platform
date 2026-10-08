import {
  CLAIM_CHECKED_FIELD_IDS,
  FIELD_TABLES,
  isClaimCheckedFieldId,
  type FieldDisposition,
} from './claim-checked-fields';

// The schema test of catalog design 6.2 (AC 21): the tables are `Record`s over the content
// types, so the compiler refuses an unclassified key; these tests hold the rest of the rule.

function entries(): [string, string, FieldDisposition][] {
  return Object.entries(FIELD_TABLES).flatMap(([table, fields]) =>
    Object.entries(fields).map(([key, value]): [string, string, FieldDisposition] => [
      table,
      key,
      value,
    ]),
  );
}

describe('ClaimCheckedFields', () => {
  it('registers every checked field id once, in sorted order', () => {
    expect([...CLAIM_CHECKED_FIELD_IDS]).toEqual([...CLAIM_CHECKED_FIELD_IDS].sort());
    expect(new Set(CLAIM_CHECKED_FIELD_IDS).size).toBe(CLAIM_CHECKED_FIELD_IDS.length);
  });

  it('classifies every key, and a checked key names a registered field', () => {
    for (const [table, key, value] of entries()) {
      const shape = Object.keys(value);
      expect([table, key, shape.length]).toEqual([table, key, 1]);
      if ('checked' in value) expect(isClaimCheckedFieldId(value.checked)).toBe(true);
    }
  });

  it('uses every registered field id at least once', () => {
    const used = new Set(
      entries().flatMap(([, , value]) => ('checked' in value ? [value.checked] : [])),
    );
    expect([...used].sort()).toEqual([...CLAIM_CHECKED_FIELD_IDS]);
  });

  it('points every nested key at a table that exists', () => {
    for (const [, , value] of entries()) {
      if ('nested' in value) expect(Object.keys(FIELD_TABLES)).toContain(value.nested);
    }
  });

  it('keeps the texts a customer reads checked', () => {
    const text = (table: string, key: string): FieldDisposition | undefined =>
      FIELD_TABLES[table]?.[key];
    expect(text('REVISION_TEXT_FIELDS', 'name')).toEqual({ checked: 'product.name' });
    expect(text('REVISION_TEXT_FIELDS', 'description')).toEqual({
      checked: 'product.description',
    });
    expect(text('REVISION_VARIANT_FIELDS', 'labels')).toEqual({
      checked: 'product.variant-label',
    });
    expect(text('ATTRIBUTE_OPTION_FIELDS', 'labels')).toEqual({
      checked: 'attribute-definition.option-label',
    });
    expect(text('PLATFORM_CATEGORY_FIELDS', 'slug')).toEqual({
      checked: 'platform-category.slug',
    });
  });

  it('refuses an unregistered field id', () => {
    expect(isClaimCheckedFieldId('product.sku')).toBe(false);
    expect(isClaimCheckedFieldId(7)).toBe(false);
  });
});
