import { describe, expect, it } from 'vitest';
import { requestAxesOf, requestProblemOf } from './size-request-logic.ts';
import type { ProductView } from './types.ts';

const field = (code: string, names: Record<string, string>, options: string[]) => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  bounds: {},
  names,
  options: options.map((option) => ({ code: option, labels: { 'en-AU': option.toUpperCase() } })),
});

const product = (over: Partial<ProductView> = {}): ProductView =>
  ({
    variants: [{ variantId: 'v1', state: 'published', variantCode: 'P-01' }],
    form: {
      fields: [
        field('size', { 'en-AU': 'Size' }, ['s', 'm', 'xl']),
        field('colour', { 'en-AU': 'Colour' }, []),
        { ...field('flavour', { 'en-AU': 'Flavour' }, ['a']), isVariantOption: false },
      ],
    },
    published: {
      content: { variantAxes: ['size', 'colour'], variants: [] },
    },
    workingCopy: null,
    ...over,
  }) as unknown as ProductView;

describe('requestAxesOf', () => {
  it('lists the axes of the published version with every option, named in the locale', () => {
    expect(requestAxesOf(product(), 'en-AU')).toEqual([
      {
        code: 'size',
        name: 'Size',
        options: [
          { code: 's', label: 'S' },
          { code: 'm', label: 'M' },
          { code: 'xl', label: 'XL' },
        ],
      },
    ]);
  });

  it('falls back to another language, then the code, when the locale has no name', () => {
    const [axis] = requestAxesOf(product(), 'ja-JP');
    expect(axis?.name).toBe('Size');
    expect(axis?.options[0]?.label).toBe('S');
  });

  it('has no axis for a product without variant options', () => {
    expect(requestAxesOf(product({ published: null }), 'en-AU')).toEqual([]);
  });
});

describe('requestProblemOf', () => {
  it.each([
    ['variant-request.variant-exists', 409, 'variant-exists'],
    ['variant-request.already-open', 409, 'already-open'],
    ['variant-request.limit-reached', 422, 'limit-reached'],
    ['variant-request.daily-limit', 422, 'daily-limit'],
    ['offer.not-found', 404, 'not-found'],
    ['validation.failed', 400, 'invalid'],
    ['whatever', 503, 'unavailable'],
    ['whatever', 400, 'unknown'],
  ])('maps %s (%i) to %s', (code, status, key) => {
    expect(requestProblemOf({ status, code })).toBe(key);
  });
});
