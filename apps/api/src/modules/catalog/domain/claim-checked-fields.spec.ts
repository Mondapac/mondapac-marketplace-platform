import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAIM_CHECKED_FIELD_IDS,
  CONTENT_TYPE_CLASSIFICATION,
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

  describe('default-deny over the content types (AC 21, design 6.2)', () => {
    const root = join(__dirname, '..');
    const exported = (dir: string): string[] =>
      readdirSync(join(root, dir))
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
        .flatMap((file) =>
          [
            ...readFileSync(join(root, dir, file), 'utf8').matchAll(/^export interface (\w+)/gm),
          ].map((match) => match[1]!),
        );
    const found = [...exported('domain'), ...exported('contracts')];

    it('finds the exported content types', () => {
      expect(found.length).toBeGreaterThan(20);
    });

    it('classifies every exported interface; an unlisted new one fails here', () => {
      const missing = found.filter((name) => !(name in CONTENT_TYPE_CLASSIFICATION));
      expect(missing).toEqual([]);
    });

    it('keeps no entry for a type that is gone, and points every table at a real one', () => {
      expect(
        Object.keys(CONTENT_TYPE_CLASSIFICATION).filter((name) => !found.includes(name)),
      ).toEqual([]);
      for (const value of Object.values(CONTENT_TYPE_CLASSIFICATION)) {
        if ('table' in value) expect(Object.keys(FIELD_TABLES)).toContain(value.table);
        else expect(value.noCustomerText.length).toBeGreaterThan(0);
      }
    });
  });
});
