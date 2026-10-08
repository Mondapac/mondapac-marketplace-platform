import { CONTENT_HASH_PATTERN } from '@mondapac/shared-kernel';
import type { RevisionContent } from '../../domain/revision-content';
import { revisionContentHash } from './revision-content-hash';

const content: RevisionContent = {
  texts: { en: { name: 'Olive oil', shortDescription: null, description: 'Cold pressed.' } },
  categoryIds: ['c1', 'c2'],
  taxCategoryCode: 'standard',
  attributeValues: { brand: 'Acme', weight: 500 },
  variants: [
    {
      variantId: 'v1',
      position: 0,
      optionKey: 'size=l',
      optionValues: { size: 'l' },
      labels: { en: 'L' },
    },
  ],
  imageIds: [],
  schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: ['d1', 'd2'] },
  contentSchemaVersion: 1,
};

describe('revisionContentHash', () => {
  it('has the form the revision table checks', () => {
    expect(revisionContentHash(content)).toMatch(CONTENT_HASH_PATTERN);
    expect(revisionContentHash(content)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is the same for the same content, whatever the key order', () => {
    const reordered: RevisionContent = {
      contentSchemaVersion: 1,
      schemaRef: { definitionRevisionIds: ['d1', 'd2'], familyRevisionId: 'f1' },
      imageIds: [],
      variants: content.variants,
      attributeValues: { weight: 500, brand: 'Acme' },
      taxCategoryCode: 'standard',
      categoryIds: ['c1', 'c2'],
      texts: content.texts,
    };
    expect(revisionContentHash(reordered)).toBe(revisionContentHash(content));
  });

  it.each([
    ['a text', { texts: { en: { ...content.texts.en!, name: 'Olive oil 1L' } } }],
    ['a locale', { texts: { ...content.texts, fr: content.texts.en! } }],
    ['the category order', { categoryIds: ['c2', 'c1'] }],
    ['the tax category', { taxCategoryCode: 'exempt' }],
    ['an attribute value', { attributeValues: { brand: 'Acme', weight: 501 } }],
    ['a variant', { variants: [] }],
    ['an image', { imageIds: ['i1'] }],
    ['the schema', { schemaRef: { familyRevisionId: 'f2', definitionRevisionIds: ['d1', 'd2'] } }],
    [
      'the schema order',
      { schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: ['d2', 'd1'] } },
    ],
  ] as const)('changes with %s', (_name, patch) => {
    expect(revisionContentHash({ ...content, ...patch })).not.toBe(revisionContentHash(content));
  });

  // The hash is persisted and recomputed by anyone: a change here is a format change.
  it('keeps a pinned value for the sample content', () => {
    expect(revisionContentHash(content)).toBe(
      'sha256:ac402a3e46bb628a077afc6155f0e7573e09f685fa6fecee71a415ac5690e82f',
    );
  });

  it('refuses content that has no canonical form', () => {
    expect(() =>
      revisionContentHash({ ...content, attributeValues: { weight: Number.NaN } }),
    ).toThrow();
  });

  it('changes with a variant label and a nested locale value', () => {
    const variant = content.variants[0]!;
    expect(
      revisionContentHash({ ...content, variants: [{ ...variant, labels: { en: 'XL' } }] }),
    ).not.toBe(revisionContentHash(content));
    expect(
      revisionContentHash({ ...content, attributeValues: { brand: { en: 'Acme', fr: 'Acme' } } }),
    ).not.toBe(revisionContentHash(content));
  });
});
