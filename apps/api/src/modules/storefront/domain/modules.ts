import {
  at,
  closedObject,
  code,
  href,
  image,
  list,
  oneOf,
  problem,
  text,
  uuid,
  wholeNumber,
  type Problems,
} from './fields';

// The closed catalogue of storefront modules (content-management analysis 4). A module is a
// ready-made, designed block of the buyer app with a few settings; admins only choose, order,
// switch on or off and configure modules inside the slots a template allows. Each module checks
// its settings and answers them normalised; an invalid setting is never stored. Texts are plain
// text: the buyer app renders them as text, and a missing optional title is replaced by the
// app's own wording in the buyer's language. No module carries a heading level: the page's only
// h1 comes from its template.

export const MODULE_KEYS = [
  'banner',
  'category-circles',
  'sellers-near-you',
  'product-shelf',
  'info-strip',
  'text-block',
  'image-text',
  'faq',
  'brand-header',
  'product-spotlight',
  'nav-link',
  'nav-category',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export type ModuleConfig = Readonly<Record<string, unknown>>;

/**
 * Where a product shelf takes its products from; `linked` is the page's linked entity.
 * `recently-viewed`, `for-you` and `bought-together` are personal or product-relative: the buyer
 * app reads them per request with no-store, so the page config itself stays shareable.
 * `bought-together` pairs with a product, so it needs a product page (see placements).
 */
export const SHELF_SOURCES = [
  'bestsellers',
  'specials',
  'category',
  'seller',
  'tag',
  'manual',
  'linked',
  'recently-viewed',
  'for-you',
  'bought-together',
] as const;
export const INFO_ICONS = ['delivery', 'tax', 'certified', 'support', 'returns', 'local'] as const;

/** The most products a shelf may ask for, so one page cannot become slow (analysis 8). */
export const MAX_SHELF_PRODUCTS = 24;

const compact = (value: Record<string, unknown>): ModuleConfig =>
  Object.freeze(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)));

/** Text spans of a paragraph: plain text, each optionally a link. */
function spans(problems: Problems, path: string, value: unknown) {
  return list(problems, path, value, 1, 20, (spanPath, entry) => {
    if (!closedObject(problems, spanPath, entry, ['text', 'href'])) return null;
    const content = text(problems, at(spanPath, 'text'), entry.text, 1000);
    const link = href(problems, at(spanPath, 'href'), entry.href, true);
    return content === null ? null : compact({ text: content, href: link });
  });
}

/** Rich text as data: headings (level 2 or 3), paragraphs and lists, never HTML. */
function blocks(problems: Problems, path: string, value: unknown) {
  return list(problems, path, value, 1, 40, (blockPath, entry) => {
    if (!closedObject(problems, blockPath, entry, ['type', 'level', 'text', 'spans', 'items'])) {
      return null;
    }
    const type = oneOf(problems, at(blockPath, 'type'), entry.type, [
      'heading',
      'paragraph',
      'list',
    ] as const);
    const unexpected = (keys: readonly string[]) =>
      keys
        .filter((key) => entry[key] !== undefined)
        .forEach((key) => problem(problems, at(blockPath, key), 'unknown-field'));
    if (type === 'heading') {
      unexpected(['spans', 'items']);
      const level = entry.level === undefined ? 2 : entry.level;
      if (level !== 2 && level !== 3) problem(problems, at(blockPath, 'level'), 'enum');
      const content = text(problems, at(blockPath, 'text'), entry.text, 160);
      return content === null || (level !== 2 && level !== 3)
        ? null
        : { type, level, text: content };
    }
    if (type === 'paragraph') {
      unexpected(['level', 'text', 'items']);
      const content = spans(problems, at(blockPath, 'spans'), entry.spans);
      return content === null ? null : { type, spans: content };
    }
    if (type === 'list') {
      unexpected(['level', 'text', 'spans']);
      const items = list(problems, at(blockPath, 'items'), entry.items, 1, 30, (itemPath, item) =>
        spans(problems, itemPath, item),
      );
      return items === null ? null : { type, items };
    }
    return null;
  });
}

type Parser = (problems: Problems, path: string, value: Record<string, unknown>) => ModuleConfig;

const PARSERS: Readonly<
  Record<ModuleKey, { readonly fields: readonly string[]; readonly parse: Parser }>
> = {
  banner: {
    fields: ['title', 'subtitle', 'image', 'href', 'ctaLabel'],
    parse: (p, path, v) =>
      compact({
        title: text(p, at(path, 'title'), v.title, 80),
        subtitle: text(p, at(path, 'subtitle'), v.subtitle, 160, true),
        image: image(p, at(path, 'image'), v.image),
        href: href(p, at(path, 'href'), v.href, true),
        ctaLabel: text(p, at(path, 'ctaLabel'), v.ctaLabel, 40, true),
      }),
  },
  'category-circles': {
    // No ids: the Market's top-level categories, in their own order.
    fields: ['title', 'categoryIds'],
    parse: (p, path, v) =>
      compact({
        title: text(p, at(path, 'title'), v.title, 80, true),
        categoryIds:
          v.categoryIds === undefined
            ? null
            : unique(
                p,
                at(path, 'categoryIds'),
                list(p, at(path, 'categoryIds'), v.categoryIds, 1, 16, (ip, e) => uuid(p, ip, e)),
              ),
      }),
  },
  'sellers-near-you': {
    fields: ['title', 'limit'],
    parse: (p, path, v) =>
      compact({
        title: text(p, at(path, 'title'), v.title, 80, true),
        limit: v.limit === undefined ? 8 : wholeNumber(p, at(path, 'limit'), v.limit, 1, 12),
      }),
  },
  'product-shelf': {
    fields: ['title', 'source', 'limit'],
    parse: (p, path, v) =>
      compact({
        title: text(p, at(path, 'title'), v.title, 80, true),
        source: shelfSource(p, at(path, 'source'), v.source),
        limit:
          v.limit === undefined
            ? 12
            : wholeNumber(p, at(path, 'limit'), v.limit, 1, MAX_SHELF_PRODUCTS),
      }),
  },
  'info-strip': {
    fields: ['items'],
    parse: (p, path, v) =>
      compact({
        items: list(p, at(path, 'items'), v.items, 1, 4, (ip, entry) => {
          if (!closedObject(p, ip, entry, ['icon', 'text', 'href'])) return null;
          const icon = oneOf(p, at(ip, 'icon'), entry.icon, INFO_ICONS);
          const label = text(p, at(ip, 'text'), entry.text, 80, true);
          const link = href(p, at(ip, 'href'), entry.href, true);
          return icon === null ? null : compact({ icon, text: label, href: link });
        }),
      }),
  },
  'text-block': {
    fields: ['blocks'],
    parse: (p, path, v) => compact({ blocks: blocks(p, at(path, 'blocks'), v.blocks) }),
  },
  'image-text': {
    fields: ['image', 'heading', 'body', 'imageSide', 'href', 'ctaLabel'],
    parse: (p, path, v) =>
      compact({
        image: image(p, at(path, 'image'), v.image),
        heading: text(p, at(path, 'heading'), v.heading, 120),
        body: spans(p, at(path, 'body'), v.body),
        imageSide:
          v.imageSide === undefined
            ? 'start'
            : oneOf(p, at(path, 'imageSide'), v.imageSide, ['start', 'end'] as const),
        href: href(p, at(path, 'href'), v.href, true),
        ctaLabel: text(p, at(path, 'ctaLabel'), v.ctaLabel, 40, true),
      }),
  },
  faq: {
    fields: ['title', 'items'],
    parse: (p, path, v) =>
      compact({
        title: text(p, at(path, 'title'), v.title, 80, true),
        items: list(p, at(path, 'items'), v.items, 1, 20, (ip, entry) => {
          if (!closedObject(p, ip, entry, ['question', 'answer'])) return null;
          const question = text(p, at(ip, 'question'), entry.question, 200);
          const answer = spans(p, at(ip, 'answer'), entry.answer);
          return question === null || answer === null ? null : { question, answer };
        }),
      }),
  },
  'brand-header': {
    fields: ['name', 'description', 'logo'],
    parse: (p, path, v) =>
      compact({
        name: text(p, at(path, 'name'), v.name, 80),
        description: text(p, at(path, 'description'), v.description, 300, true),
        logo: image(p, at(path, 'logo'), v.logo, true),
      }),
  },
  'product-spotlight': {
    // No product id: the page's linked product.
    fields: ['productId', 'heading', 'body'],
    parse: (p, path, v) =>
      compact({
        productId: v.productId === undefined ? null : uuid(p, at(path, 'productId'), v.productId),
        heading: text(p, at(path, 'heading'), v.heading, 120, true),
        body: v.body === undefined ? null : spans(p, at(path, 'body'), v.body),
      }),
  },
  'nav-link': {
    // A left-rail entry: a label and where it goes (a category, a storefront page or a site path).
    fields: ['label', 'icon', 'target'],
    parse: (p, path, v) =>
      compact({
        label: text(p, at(path, 'label'), v.label, 40),
        icon: v.icon === undefined ? null : code(p, at(path, 'icon'), v.icon),
        target: navTarget(p, at(path, 'target'), v.target),
      }),
  },
  'nav-category': {
    // A Browse-drawer entry: one category, with an optional label that replaces its name.
    fields: ['categoryId', 'label'],
    parse: (p, path, v) =>
      compact({
        categoryId: uuid(p, at(path, 'categoryId'), v.categoryId),
        label: text(p, at(path, 'label'), v.label, 40, true),
      }),
  },
};

function unique(problems: Problems, path: string, ids: string[] | null): string[] | null {
  if (ids === null) return null;
  if (new Set(ids).size !== ids.length) {
    problem(problems, path, 'duplicate');
    return null;
  }
  return ids;
}

function shelfSource(problems: Problems, path: string, value: unknown) {
  if (!closedObject(problems, path, value, ['kind', 'id', 'code', 'productIds'])) return null;
  const kind = oneOf(problems, at(path, 'kind'), value.kind, SHELF_SOURCES);
  const none = (keys: readonly string[]) =>
    keys
      .filter((key) => value[key] !== undefined)
      .forEach((key) => problem(problems, at(path, key), 'unknown-field'));
  switch (kind) {
    case 'bestsellers':
    case 'specials':
    case 'linked':
    case 'recently-viewed':
    case 'for-you':
    case 'bought-together':
      none(['id', 'code', 'productIds']);
      return { kind };
    case 'category':
    case 'seller': {
      none(['code', 'productIds']);
      const id = uuid(problems, at(path, 'id'), value.id);
      return id === null ? null : { kind, id };
    }
    case 'tag': {
      // A certification type code (for example a halal tag); the products are re-checked by
      // catalog when the shelf is read, never trusted from here.
      none(['id', 'productIds']);
      const tag = code(problems, at(path, 'code'), value.code);
      return tag === null ? null : { kind, code: tag };
    }
    case 'manual': {
      none(['id', 'code']);
      const ids = unique(
        problems,
        at(path, 'productIds'),
        list(problems, at(path, 'productIds'), value.productIds, 1, MAX_SHELF_PRODUCTS, (ip, e) =>
          uuid(problems, ip, e),
        ),
      );
      return ids === null ? null : { kind, productIds: ids };
    }
    default:
      return null;
  }
}

function navTarget(problems: Problems, path: string, value: unknown) {
  if (!closedObject(problems, path, value, ['kind', 'id', 'key', 'path'])) return null;
  const kind = oneOf(problems, at(path, 'kind'), value.kind, [
    'category',
    'page',
    'system-page',
    'path',
  ] as const);
  const extra = (keys: readonly string[]) =>
    keys
      .filter((key) => value[key] !== undefined)
      .forEach((key) => problem(problems, at(path, key), 'unknown-field'));
  switch (kind) {
    case 'category':
    case 'page': {
      extra(['key', 'path']);
      const id = uuid(problems, at(path, 'id'), value.id);
      return id === null ? null : { kind, id };
    }
    case 'system-page': {
      extra(['id', 'path']);
      const key = code(problems, at(path, 'key'), value.key);
      return key === null ? null : { kind, key };
    }
    case 'path': {
      extra(['id', 'key']);
      const target = href(problems, at(path, 'path'), value.path);
      if (target !== null && !target.startsWith('/')) {
        problem(problems, at(path, 'path'), 'format');
        return null;
      }
      return target === null ? null : { kind, path: target };
    }
    default:
      return null;
  }
}

export const isModuleKey = (value: unknown): value is ModuleKey =>
  typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value);

/** The settings fields a module accepts (the admin editor's form). */
export const moduleFields = (module: ModuleKey): readonly string[] => PARSERS[module].fields;

/**
 * Checks and normalises a module's settings. `path` prefixes the problems. A config is valid only
 * when no problem was added while it was checked.
 */
export function parseModuleConfig(
  module: ModuleKey,
  value: unknown,
  path = 'config',
):
  | { readonly ok: true; readonly config: ModuleConfig }
  | { readonly ok: false; readonly problems: Problems } {
  const problems: Problems = [];
  const entry = PARSERS[module];
  if (!closedObject(problems, path, value, entry.fields)) return { ok: false, problems };
  const config = entry.parse(problems, path, value);
  return problems.length === 0 ? { ok: true, config } : { ok: false, problems };
}
