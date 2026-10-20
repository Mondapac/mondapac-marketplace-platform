import 'server-only';
import { apiGet, type ApiRead } from './api.ts';
import { PRODUCTS, SAMPLE_CONTENT } from './sample-home.ts';
import type {
  Category,
  HomeSection,
  Money,
  ProductCard,
  ShelfCard,
  PromoBanner,
  SellerSummary,
} from './types.ts';

// The home page's read of the published layout (`GET storefront/pages/home`, PR #401), the live
// category tree (`GET catalog/categories`) and the product shelves (`GET search/bestsellers`,
// `GET search/specials`, `GET search/products`, PR #408). Every answer is checked here before it
// becomes a card or a banner: text stays text, links are site paths or https only, prices need a
// currency. Where the API answers nothing or fails, sample data stands in while the sample
// fallback is on (STOREFRONT_SAMPLE_DATA, below); with it off the section is left out.
//
// Not in the API yet, so left off the cards: seller names, prices of best sellers and category
// shelves (no add button either), photos, certification seals. The sellers near you section is
// left out until the seller public read merges.
// The info strip, text block and image-text modules have no design on the buyer site yet and are
// skipped.

export interface HomeContent {
  readonly sections: readonly HomeSection[];
  readonly categories: readonly Category[];
  readonly sellers: readonly SellerSummary[];
}

/** The ready-made banner images the buyer app holds, by their layout key. */
const BANNER_IMAGES: ReadonlySet<string> = new Set([
  'apple',
  'banana',
  'bread',
  'cheese',
  'chicken',
  'coconut',
  'egg',
  'fruits',
  'meat',
  'orange',
  'salmon',
  'watermelon',
]);

const SHELF_LIMIT_MAX = 24;

const SAMPLE_HOME: HomeContent = {
  sections: SAMPLE_CONTENT.home,
  categories: SAMPLE_CONTENT.categories,
  sellers: SAMPLE_CONTENT.sellers,
};

const EMPTY_HOME: HomeContent = { sections: [], categories: [], sellers: [] };

const SAMPLE_SHELVES: Readonly<Record<'bestsellers' | 'specials', readonly ProductCard[]>> = {
  bestsellers: PRODUCTS,
  specials: PRODUCTS.filter((p) => p.wasPrice !== undefined),
};

const DEFAULT_TITLE = {
  bestsellers: 'Best sellers',
  specials: 'Special prices this week',
} as const;

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== ''
    ? Array.from(value).slice(0, max).join('')
    : undefined;

const limitOf = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : fallback;

/** A site path (`/offers`, never `//host`) or an https link; anything else is dropped. */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  if (/^\/(?![/\\])/u.test(value)) return value;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Money as the API sends it (minor units as a decimal string, ISO 4217 code). */
export function moneyOf(value: unknown): Money | undefined {
  if (!isObject(value) || typeof value.currency !== 'string') return undefined;
  if (!/^[A-Z]{3}$/u.test(value.currency)) return undefined;
  const text = typeof value.amount === 'number' ? String(value.amount) : value.amount;
  if (typeof text !== 'string' || !/^[0-9]{1,15}$/u.test(text)) return undefined;
  const amount = Number(text);
  return Number.isSafeInteger(amount) ? { amount, currency: value.currency } : undefined;
}

interface LiveCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
}

/** The live tree as the home page's categories: the top level with its direct children. */
export function categoriesOf(body: unknown): {
  readonly top: readonly (Category & { readonly id: string })[];
  readonly slugs: ReadonlyMap<string, string>;
} {
  const rows: LiveCategory[] = [];
  if (isObject(body) && Array.isArray(body.categories)) {
    for (const row of body.categories as unknown[]) {
      if (!isObject(row) || typeof row.id !== 'string') continue;
      const slug = textOf(row.slug, 120);
      const name = textOf(row.name, 120);
      if (slug === undefined || name === undefined || !/^[a-z0-9-]+$/u.test(slug)) continue;
      const parentId = typeof row.parentId === 'string' ? row.parentId : null;
      rows.push({ id: row.id, parentId, slug, name });
    }
  }
  const top = rows
    .filter((c) => c.parentId === null)
    .map((c) => ({
      id: c.id,
      code: c.slug,
      name: c.name,
      shortName: c.name,
      children: rows
        .filter((k) => k.parentId === c.id)
        .map((k) => ({ code: k.slug, name: k.name })),
    }));
  return { top, slugs: new Map(rows.map((c) => [c.id, c.slug])) };
}

/**
 * A shelf item as a card, or null when it cannot be shown: no id or name, or a price that excludes
 * tax (the card says "including GST"). Without a price (best sellers and category shelves carry
 * none yet, nor does a price without a currency) the card shows no price and no add button; no
 * shelf route carries the seller's name, so that line is left out. The certification seal is
 * never built here (AI rule R1: it comes only from evaluateClaim, and the shelf routes do not
 * carry it).
 */
export function cardOf(item: unknown, slugs: ReadonlyMap<string, string>): ShelfCard | null {
  if (!isObject(item) || typeof item.productId !== 'string') return null;
  const name = textOf(item.name, 200);
  const price = moneyOf(item.price);
  if (name === undefined || (price !== undefined && item.taxInclusive === false)) return null;
  const regular = moneyOf(item.regularPrice);
  const wasPrice =
    price !== undefined &&
    regular !== undefined &&
    regular.currency === price.currency &&
    regular.amount > price.amount
      ? regular
      : undefined;
  const firstCategory: unknown = Array.isArray(item.categoryIds)
    ? (item.categoryIds as unknown[])[0]
    : undefined;
  return {
    id: item.productId,
    name,
    sellerName: '',
    category: (typeof firstCategory === 'string' ? slugs.get(firstCategory) : undefined) ?? '',
    ...(price === undefined ? {} : { price }),
    ...(wasPrice === undefined ? {} : { wasPrice }),
    certifications: [],
  };
}

/** The cards of a shelf answer, one per product, in shelf order. */
export function cardsOf(body: unknown, slugs: ReadonlyMap<string, string>): ShelfCard[] {
  if (!isObject(body) || !Array.isArray(body.items)) return [];
  const seen = new Set<string>();
  const cards: ShelfCard[] = [];
  for (const item of body.items as unknown[]) {
    const card = cardOf(item, slugs);
    if (card === null || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards;
}

/** A layout banner as a promo; the first banner of the page is the primary one. */
export function bannerOf(config: Json, id: string, primary: boolean): PromoBanner | null {
  const title = textOf(config.title, 80);
  if (title === undefined) return null;
  const href = safeHref(config.href);
  const label = textOf(config.ctaLabel, 40);
  const ref = isObject(config.image) ? config.image.ref : undefined;
  return {
    id,
    variant: primary ? 'primary' : 'secondary',
    title,
    body: textOf(config.subtitle, 160) ?? '',
    ...(href !== undefined && label !== undefined ? { action: { label, href } } : {}),
    images: typeof ref === 'string' && BANNER_IMAGES.has(ref) ? [`/placeholders/${ref}.jpg`] : [],
  };
}

interface Placed {
  readonly id: string;
  readonly module: string;
  readonly config: Json;
}

/** The modules of a published page in slot order, or null when the answer is not a page. */
export function placedModules(body: unknown): Placed[] | null {
  if (!isObject(body) || body.kind !== 'page' || !isObject(body.page)) return null;
  if (!Array.isArray(body.page.slots)) return null;
  const placed: Placed[] = [];
  for (const slot of body.page.slots as unknown[]) {
    if (!isObject(slot) || !Array.isArray(slot.modules)) continue;
    for (const entry of slot.modules as unknown[]) {
      if (!isObject(entry) || typeof entry.module !== 'string') continue;
      placed.push({
        id: typeof entry.id === 'string' ? entry.id : `${placed.length}`,
        module: entry.module,
        config: isObject(entry.config) ? entry.config : {},
      });
    }
  }
  return placed;
}

type ShelfPlan = {
  readonly kind: 'bestsellers' | 'specials' | 'category';
  readonly path: string;
  readonly title: string;
  readonly href: string;
} | null;

function shelfPlan(config: Json, categories: ReturnType<typeof categoriesOf>): ShelfPlan {
  const source = isObject(config.source) ? config.source : {};
  const limit = limitOf(config.limit, 12, SHELF_LIMIT_MAX);
  const title = textOf(config.title, 80);
  if (source.kind === 'bestsellers' || source.kind === 'specials') {
    return {
      kind: source.kind,
      path: `search/${source.kind}?limit=${limit}`,
      title: title ?? DEFAULT_TITLE[source.kind],
      href: source.kind === 'specials' ? '/offers' : '/best-sellers',
    };
  }
  if (source.kind === 'category' && typeof source.id === 'string') {
    const slug = categories.slugs.get(source.id);
    const name = categories.top.find((c) => c.id === source.id)?.name;
    if (slug === undefined || (title ?? name) === undefined) return null;
    return {
      kind: 'category',
      path: `search/products?category=${encodeURIComponent(source.id)}&pageSize=${limit}`,
      title: (title ?? name) as string,
      href: `/c/${slug}`,
    };
  }
  // Seller, tag, manual and linked shelves have no public read yet.
  return null;
}

/** The answers the home page is built from; each read may have failed on its own. */
export interface HomeReads {
  readonly page: ApiRead<unknown>;
  readonly tree: ApiRead<unknown>;
  /** By the shelf path, as {@link shelfPaths} lists them. */
  readonly shelves: ReadonlyMap<string, ApiRead<unknown>>;
}

/** The shelf reads a published home page needs. */
export function shelfPaths(page: ApiRead<unknown>, tree: ApiRead<unknown>): string[] {
  const placed = page.kind === 'ok' ? placedModules(page.body) : null;
  const categories = categoriesOf(tree.kind === 'ok' ? tree.body : null);
  const paths = (placed ?? [])
    .filter((m) => m.module === 'product-shelf')
    .map((m) => shelfPlan(m.config, categories)?.path)
    .filter((path) => path !== undefined);
  return [...new Set(paths)];
}

/** The home content from the API's answers, with sample data where they hold nothing. */
export function homeFrom(reads: HomeReads, fallback: boolean): HomeContent {
  const placed = reads.page.kind === 'ok' ? placedModules(reads.page.body) : null;
  if (placed === null) return fallback ? SAMPLE_HOME : EMPTY_HOME;
  const categories = categoriesOf(reads.tree.kind === 'ok' ? reads.tree.body : null);
  const sections: HomeSection[] = [];
  let shownCategories: readonly Category[] = [];
  let bannerCount = 0;
  for (const m of placed) {
    switch (m.module) {
      case 'banner': {
        const banner = bannerOf(m.config, m.id, bannerCount === 0);
        if (banner === null) break;
        bannerCount += 1;
        const last = sections.at(-1);
        if (last?.kind === 'promos')
          sections[sections.length - 1] = { kind: 'promos', banners: [...last.banners, banner] };
        else sections.push({ kind: 'promos', banners: [banner] });
        break;
      }
      case 'category-circles': {
        const ids = Array.isArray(m.config.categoryIds)
          ? (m.config.categoryIds as unknown[])
          : null;
        const chosen =
          ids === null
            ? categories.top
            : ids.flatMap((id) => categories.top.filter((c) => c.id === id));
        shownCategories = chosen.length > 0 ? chosen : fallback ? SAMPLE_HOME.categories : [];
        if (shownCategories.length > 0) sections.push({ kind: 'categories' });
        break;
      }
      case 'product-shelf': {
        const plan = shelfPlan(m.config, categories);
        if (plan === null) break;
        const read = reads.shelves.get(plan.path);
        const cards = read?.kind === 'ok' ? cardsOf(read.body, categories.slugs) : [];
        const limit = limitOf(m.config.limit, 12, SHELF_LIMIT_MAX);
        const products =
          cards.length > 0 || !fallback || plan.kind === 'category'
            ? cards
            : SAMPLE_SHELVES[plan.kind].slice(0, limit);
        if (products.length > 0) {
          sections.push({ kind: 'products', title: plan.title, href: plan.href, products });
        }
        break;
      }
      case 'sellers-near-you':
        // Left out until the seller public read merges: sample stores beside real products would
        // send buyers to shops that do not exist.
        break;
      default:
        break;
    }
  }
  if (sections.length === 0 && fallback) return SAMPLE_HOME;
  return { sections, categories: shownCategories, sellers: [] };
}

/** A read of one public route, as `apiGet` answers it. */
export type HomeReader = (path: string) => Promise<ApiRead<unknown>>;

/**
 * `STOREFRONT_SAMPLE_DATA=off` stops sample data standing in where the API answers nothing or
 * fails; any other value, or none, keeps it (the demo default). With API_BASE_URL empty the
 * whole home is the sample whatever this says.
 */
export const SAMPLE_DATA_ENV = 'STOREFRONT_SAMPLE_DATA';

export function sampleFallback(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SAMPLE_DATA_ENV]?.trim() !== 'off';
}

/** The home page's content: the API's when API_BASE_URL is set, else the sample. */
export async function loadHome(
  read: HomeReader = apiGet,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HomeContent> {
  const [page, tree] = await Promise.all([
    read('storefront/pages/home'),
    read('catalog/categories'),
  ]);
  if (page.kind === 'off') return SAMPLE_HOME;
  const paths = shelfPaths(page, tree);
  const answers = await Promise.all(paths.map((path) => read(path)));
  const shelves = new Map(paths.map((path, i) => [path, answers[i]!]));
  return homeFrom({ page, tree, shelves }, sampleFallback(env));
}
