import type { RevisionContent, RevisionRead } from './types.ts';

// Test data of one product version under review: a change to a published product.

export const PRODUCT = '0190a000-0000-7000-8000-0000000000d1';
export const REVISION = '0190a000-0000-7000-8000-0000000000e2';
export const PUBLISHED = '0190a000-0000-7000-8000-0000000000e1';
export const IMG = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
export const VARIANT = (n: number) =>
  `0190a000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
export const CATEGORY = (n: number) =>
  `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;

export const TOPIC = (n: number) =>
  `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;

const variant = (n: number, gtin: string | null) => ({
  variantId: VARIANT(n),
  position: n,
  optionValues: { size: `${n} L` },
  labels: { 'en-AU': `${n} litre` },
  gtin,
  shippingWeightGrams: 1000 * n,
  shippingLengthMm: null,
  shippingWidthMm: null,
  shippingHeightMm: null,
  imageIds: [],
});

export const published: RevisionContent = {
  revisionId: PUBLISHED,
  revisionNo: 1,
  kind: 'submission',
  authorKind: 'seller',
  submittedAt: '2026-10-01T01:00:00.000Z',
  texts: {
    'en-AU': { name: 'Olive oil', shortDescription: 'Cold pressed', description: null },
    ar: { name: 'زيت زيتون', shortDescription: null, description: null },
  },
  categoryIds: [CATEGORY(1)],
  topicIds: [TOPIC(1), TOPIC(2)],
  taxCategoryCode: 'food-basic',
  attributeValues: { origin: 'Spain', volume: 1 },
  variants: [variant(1, '09300000000011'), variant(2, null)],
  imageIds: [IMG(1), IMG(2)],
};

export const revision: RevisionContent = {
  ...published,
  revisionId: REVISION,
  revisionNo: 2,
  submittedAt: '2026-11-01T01:00:00.000Z',
  texts: {
    'en-AU': {
      name: 'Extra virgin olive oil',
      shortDescription: 'Cold pressed',
      description: 'From one grove.',
    },
    ar: published.texts['ar']!,
  },
  categoryIds: [CATEGORY(2)],
  topicIds: [TOPIC(2), TOPIC(3)],
  taxCategoryCode: 'food-standard',
  attributeValues: { origin: 'Spain', volume: 1, organic: true },
  variants: [variant(1, '09300000000028'), variant(3, null)],
  imageIds: [IMG(1), IMG(3)],
};

export const read: RevisionRead = {
  productId: PRODUCT,
  productCode: 'P-100',
  typeCode: 'grocery',
  status: 'published',
  version: 7,
  sellerId: '0190a000-0000-7000-8000-0000000000f1',
  storeName: 'Cedar Lane',
  state: 'pending',
  firstPublication: false,
  reasons: ['name', 'tax-category', 'image-added-or-replaced', 'topics-changed'],
  requiredChecks: ['photos-no-certification-mark', 'tax-category-fits'],
  warnings: ['gtin.duplicate'],
  revision,
  topicRefs: [
    { id: TOPIC(1), slug: 'eid', status: 'active', name: 'Eid', names: { 'en-AU': 'Eid' } },
    {
      id: TOPIC(2),
      slug: 'ramadan',
      status: 'archived',
      name: 'Ramadan',
      names: { 'en-AU': 'Ramadan', ar: 'رمضان' },
    },
    {
      id: TOPIC(3),
      slug: 'picnic',
      status: 'active',
      name: 'Picnic',
      names: { 'en-AU': 'Picnic' },
    },
  ],
  published,
  history: [
    {
      revisionId: REVISION,
      revisionNo: 2,
      kind: 'submission',
      authorKind: 'seller',
      submittedAt: '2026-11-01T01:00:00.000Z',
      decision: null,
    },
    {
      revisionId: PUBLISHED,
      revisionNo: 1,
      kind: 'submission',
      authorKind: 'seller',
      submittedAt: '2026-10-01T01:00:00.000Z',
      decision: {
        outcome: 'published',
        publishKind: 'reviewed',
        supersededCause: null,
        reasonCode: null,
        decidedByKind: 'admin',
        decidedAt: '2026-10-02T01:00:00.000Z',
      },
    },
  ],
};
