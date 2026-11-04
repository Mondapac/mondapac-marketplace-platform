import 'server-only';
import { BRAND_MAX_PAGE, brandPageOf } from './brands.ts';
import { SAMPLE_PRODUCTS } from './sample-catalog.ts';
import type { Brand, BrandEntry, BrandIndex, BrandPage, ProductCard } from './types.ts';

// Sample brands, for the buyer site while API_BASE_URL is empty (the demo): the A to Z index and the
// brand pages of design B5, over the sample products of the listing pages. Only this file goes when
// the pages read the API (./brands.ts). The header picture is a placeholder photo (licence
// unchecked, like the other sample photos); a brand without one shows the neutral header.

interface SampleBrand {
  readonly brand: Brand;
  /** Ids of `SAMPLE_PRODUCTS`, in the order the brand page lists them. */
  readonly products: readonly string[];
}

const header = { src: '/placeholders/fruits.jpg', width: 420, height: 420 } as const;

const SAMPLE_BRANDS: readonly SampleBrand[] = [
  {
    brand: {
      slug: 'saffron-co',
      name: 'Saffron & Co',
      summary:
        'Family spice mill in Western Sydney since 1998. Roasted and stone-ground in small batches.',
      originCountry: 'AU',
      header,
      productCount: 10,
    },
    products: [
      'saffron',
      'medjool',
      'tahini',
      'rose-water',
      'date-syrup',
      'pistachios',
      'honey',
      'olive-oil',
      'lentils',
      'couscous',
    ],
  },
  {
    brand: {
      slug: 'atlas-pantry',
      name: 'Atlas Pantry',
      summary: 'Everyday pantry staples from the Mediterranean, packed in Brisbane.',
      originCountry: 'MA',
      productCount: 4,
    },
    products: ['chickpeas', 'basmati', 'jasmine-rice', 'vermicelli'],
  },
  {
    brand: {
      slug: 'kedron-farms',
      name: 'Kedron Farms',
      summary: 'Pasture-raised lamb, beef and chicken from Queensland farms.',
      originCountry: 'AU',
      productCount: 5,
    },
    products: ['lamb-shoulder', 'brisket', 'whole-chicken', 'lamb-mince', 'beef-sausages'],
  },
  {
    brand: {
      slug: 'moorooka-dairy',
      name: 'Moorooka Dairy',
      originCountry: 'AU',
      productCount: 3,
    },
    products: ['hummus', 'eggs', 'cheese'],
  },
  {
    brand: {
      slug: 'paddington-bakehouse',
      name: 'Paddington Bakehouse',
      summary: 'Sourdough and flatbreads baked every morning.',
      originCountry: 'AU',
      productCount: 3,
    },
    products: ['sourdough', 'flatbread', 'croissants'],
  },
  {
    brand: {
      slug: 'zahra-kitchen',
      name: 'Zahra Kitchen',
      originCountry: 'LB',
      productCount: 0,
    },
    products: [],
  },
];

const byId = new Map<string, ProductCard>(SAMPLE_PRODUCTS.map((p) => [p.id, p]));

/** The sample A to Z index: every sample brand, by first letter. */
export function sampleBrandIndex(): BrandIndex {
  const sections = new Map<string, BrandEntry[]>();
  for (const { brand } of [...SAMPLE_BRANDS].sort((a, b) =>
    a.brand.name.localeCompare(b.brand.name, 'en'),
  )) {
    const letter = /^[A-Za-z]/u.test(brand.name) ? brand.name[0]!.toUpperCase() : '#';
    sections.set(letter, [...(sections.get(letter) ?? []), { slug: brand.slug, name: brand.name }]);
  }
  return {
    sections: [...sections].map(([letter, brands]) => ({ letter, brands })),
    truncated: false,
  };
}

/** A sample brand page, or undefined for a slug that is no sample brand. */
export function sampleBrandPage(
  slug: string,
  page: number,
  pageSize: number,
  all: boolean,
): BrandPage | undefined {
  const found = SAMPLE_BRANDS.find((b) => b.brand.slug === slug);
  if (found === undefined) return undefined;
  const ids = found.products.slice((page - 1) * pageSize, page * pageSize + 1);
  const items = ids.slice(0, pageSize).flatMap((id) => byId.get(id) ?? []);
  return brandPageOf(
    found.brand,
    {
      kind: 'ok',
      items,
      page: Math.min(page, BRAND_MAX_PAGE),
      hasMore: ids.length > pageSize,
    },
    all,
  );
}

/** The sample brand a sample product belongs to (for the product page's brand link), if any. */
export function sampleBrandOf(productId: string): { slug: string; name: string } | undefined {
  const found = SAMPLE_BRANDS.find((b) => b.products.includes(productId));
  return found === undefined ? undefined : { slug: found.brand.slug, name: found.brand.name };
}
