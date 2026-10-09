import type { SeededCategory } from '../../application/ports/category-seed';

/**
 * The tree of the fixture Market `ZZ` (catalog design 7.2): a different tree, locale set and
 * Vertical marker from any real Market, so the tests prove the model generic. Names pass the
 * claim-text check when slice 5 re-runs the seed check.
 */
export const ZZ_CATEGORY_TREE: readonly SeededCategory[] = [
  {
    slug: 'garden',
    parentSlug: null,
    verticalRootCode: 'outdoor',
    names: [
      { locale: 'ja-JP', name: 'Garden' },
      { locale: 'en-US', name: 'Jardin' },
    ],
  },
  {
    slug: 'garden-tools',
    parentSlug: 'garden',
    verticalRootCode: null,
    names: [
      { locale: 'ja-JP', name: 'Garden tools' },
      { locale: 'en-US', name: 'Outils de jardin' },
    ],
  },
  {
    slug: 'garden-furniture',
    parentSlug: 'garden',
    verticalRootCode: null,
    names: [
      { locale: 'ja-JP', name: 'Garden furniture' },
      { locale: 'en-US', name: 'Mobilier de jardin' },
    ],
  },
  {
    slug: 'kitchen',
    parentSlug: null,
    verticalRootCode: null,
    names: [
      { locale: 'ja-JP', name: 'Kitchen' },
      { locale: 'en-US', name: 'Cuisine' },
    ],
  },
];
