import { describe, expect, it } from 'vitest';
import { attributeInputsOf } from './draft-content.ts';
import type { FormField } from './types.ts';

const field = (code: string, dataType: string): FormField => ({
  code,
  dataType,
  localizable: false,
  required: false,
  isVariantOption: false,
  bounds: {},
  names: {},
  options: [],
});

describe('attributeInputsOf after Convert type (attributes A8)', () => {
  it('reads a code saved while the attribute was a select as a list of one', () => {
    const inputs = attributeInputsOf({ attributeValues: { tags: 'a' } }, [
      field('tags', 'multi-select'),
    ]);
    expect(inputs['tags']).toEqual(['a']);
  });

  it('reads a whole number saved while the attribute was an integer as decimal text', () => {
    const inputs = attributeInputsOf({ attributeValues: { weight: 5 } }, [
      field('weight', 'decimal'),
    ]);
    expect(inputs['weight']).toBe('5');
  });
});
