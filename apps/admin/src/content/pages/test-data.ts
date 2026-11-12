import type { PageDetail, Placement } from './page-types.ts';

export const ID = '0190a000-0000-7000-8000-0000000000a1';
export const BANNER = '0190a000-0000-7000-8000-0000000000b1';
export const SHELF_A = '0190a000-0000-7000-8000-0000000000b2';
export const SHELF_B = '0190a000-0000-7000-8000-0000000000b3';

export const placement = (
  over: Partial<Placement> & Pick<Placement, 'id' | 'module'>,
): Placement => ({
  enabled: true,
  config: {},
  ...over,
});

/** A published campaign landing page with one banner, two shelves and an empty FAQ part. */
export function page(over: Partial<PageDetail> = {}): PageDetail {
  return {
    id: ID,
    kind: 'dynamic',
    systemKey: null,
    slug: 'ramadan',
    path: '/l/ramadan',
    templateKey: 'campaign-landing',
    title: 'Ramadan specials',
    editLevel: 'full',
    status: 'published',
    hasDraft: true,
    publishedVersionNo: 2,
    publishedAt: '2026-11-01T02:00:00Z',
    updatedAt: '2026-11-02T02:00:00Z',
    seo: { title: 'Ramadan', description: 'Offers for Ramadan' },
    linked: null,
    startsAt: null,
    endsAt: null,
    archivedRedirect: null,
    slots: [
      { key: 'hero', kind: 'modules', modules: ['banner'], min: 1, max: 1, width: 'full' },
      {
        key: 'main',
        kind: 'modules',
        modules: ['product-shelf', 'banner', 'image-text', 'text-block'],
        min: 1,
        max: 8,
        width: 'full',
      },
      {
        key: 'bottom',
        kind: 'modules',
        modules: ['faq', 'text-block'],
        min: 0,
        max: 2,
        width: 'column',
      },
    ],
    draft: {
      versionNo: 3,
      updatedAt: '2026-11-02T02:00:00Z',
      settings: null,
      placements: {
        hero: [
          placement({
            id: BANNER,
            module: 'banner',
            config: { title: 'Ramadan', image: { ref: 'fruits', alt: 'Fruit' } },
          }),
        ],
        main: [
          placement({
            id: SHELF_A,
            module: 'product-shelf',
            config: { title: 'Dates', source: { kind: 'bestsellers' }, limit: 12 },
          }),
          placement({
            id: SHELF_B,
            module: 'product-shelf',
            config: { source: { kind: 'manual', productIds: [ID] }, limit: 6 },
          }),
        ],
        bottom: [],
      },
    },
    published: null,
    versions: [],
    ...over,
  };
}
