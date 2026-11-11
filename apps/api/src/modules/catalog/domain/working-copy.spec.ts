import type { Id } from '@mondapac/shared-kernel';
import type { RevisionContent } from './revision-content';
import {
  MAX_WORKING_COPY_CONTENT_BYTES,
  isStorableContent,
  withSizes,
  workingContentOfRevision,
} from './working-copy';

describe('isStorableContent', () => {
  it('accepts a plain object', () => {
    expect(isStorableContent({ texts: { en: { name: 'Dates' } } })).toBe(true);
    expect(isStorableContent({})).toBe(true);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 1],
  ])('refuses %s', (_name, value) => {
    expect(isStorableContent(value)).toBe(false);
  });

  it('refuses what does not serialise: a BigInt and a cycle', () => {
    expect(isStorableContent({ a: 1n })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(isStorableContent(cyclic)).toBe(false);
  });

  it('refuses U+0000 anywhere, which jsonb cannot store', () => {
    expect(isStorableContent({ a: 'x\u0000y' })).toBe(false);
    expect(isStorableContent({ 'k\u0000': 1 })).toBe(false);
    expect(isStorableContent({ a: { b: ['\u0000'] } })).toBe(false);
  });

  it('refuses an unpaired surrogate in a string or a key, and accepts a pair', () => {
    expect(isStorableContent({ a: '\ud800' })).toBe(false);
    expect(isStorableContent({ a: 'x\udc00' })).toBe(false);
    expect(isStorableContent({ '\ud800': 1 })).toBe(false);
    expect(isStorableContent({ a: '😀' })).toBe(true);
  });

  it('accepts the text of an escaped NUL (backslash, u, 0000), which is not a NUL', () => {
    expect(isStorableContent({ a: String.raw`\u0000` })).toBe(true);
  });

  it('measures the cap in UTF-8 bytes, inclusive', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ t: '' }), 'utf8');
    const exact = { t: 'a'.repeat(MAX_WORKING_COPY_CONTENT_BYTES - overhead) };
    expect(isStorableContent(exact)).toBe(true);
    expect(isStorableContent({ t: `${exact.t}a` })).toBe(false);
    // 2 bytes per character: fewer characters than the cap, more bytes than it.
    const persian = { t: 'ب'.repeat(MAX_WORKING_COPY_CONTENT_BYTES / 2) };
    expect(isStorableContent(persian)).toBe(false);
  });
});

describe('Add sizes and the working copy (catalog design 4.2a)', () => {
  const variantId = 'v1' as Id<'Variant'>;
  const revision: RevisionContent = {
    texts: { en: { name: 'Dates', shortDescription: null, description: 'Sweet' } },
    categoryIds: ['c1', 'c2'],
    topicIds: [],
    taxCategoryCode: 'gst',
    attributeValues: { origin: 'AU', tags: ['a', 'b'] },
    variants: [
      {
        variantId,
        position: 1,
        optionKey: '',
        optionValues: {},
        labels: {},
        gtin: '09506000134352',
        shippingWeightGrams: 500,
        shippingLengthMm: null,
        shippingWidthMm: null,
        shippingHeightMm: null,
        imageIds: ['i1'],
      },
    ],
    imageIds: ['i1', 'i2'],
    schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: ['d1'] },
    contentSchemaVersion: 1,
  };

  it('starts a working copy from a revision in the closed shape of the draft, without labels', () => {
    const content = workingContentOfRevision(revision);

    expect(content).toEqual({
      texts: { en: { name: 'Dates', shortDescription: null, description: 'Sweet' } },
      categoryIds: ['c1', 'c2'],
      taxCategoryCode: 'gst',
      attributeValues: { origin: 'AU', tags: ['a', 'b'] },
      variants: [
        {
          variantId,
          optionValues: {},
          gtin: '09506000134352',
          shippingWeightGrams: 500,
          shippingLengthMm: null,
          shippingWidthMm: null,
          shippingHeightMm: null,
          imageIds: ['i1'],
        },
      ],
      imageIds: ['i1', 'i2'],
    });
    // Nothing is shared with the stored revision.
    (content['categoryIds'] as string[]).push('c3');
    expect(revision.categoryIds).toEqual(['c1', 'c2']);
    expect(isStorableContent(content)).toBe(true);
  });

  it('sets the axes and the option values of the variant and keeps its other fields', () => {
    const base = workingContentOfRevision(revision);
    const content = withSizes(base, {
      variantId,
      axes: ['size'],
      optionValues: { size: 'l' },
    });

    expect(content['variantAxes']).toEqual(['size']);
    expect(content['variants']).toEqual([
      expect.objectContaining({
        variantId,
        optionValues: { size: 'l' },
        gtin: '09506000134352',
        shippingWeightGrams: 500,
        imageIds: ['i1'],
      }),
    ]);
    expect(content['texts']).toEqual(base['texts']);
    // The input is not modified.
    expect(base['variantAxes']).toBeUndefined();
  });

  it('replaces earlier axes and adds the variant entry a draft did not have', () => {
    const content = withSizes(
      { texts: {}, variantAxes: ['colour'], variants: [] },
      { variantId, axes: ['size', 'colour'], optionValues: { size: 'l', colour: 'red' } },
    );
    expect(content).toEqual({
      texts: {},
      variantAxes: ['size', 'colour'],
      variants: [{ variantId, optionValues: { size: 'l', colour: 'red' } }],
    });
    expect(withSizes({}, { variantId, axes: ['size'], optionValues: { size: 'm' } })).toEqual({
      variantAxes: ['size'],
      variants: [{ variantId, optionValues: { size: 'm' } }],
    });
  });
});
