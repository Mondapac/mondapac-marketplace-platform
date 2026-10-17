import type { ModuleConfig, ModuleKey } from './modules';

// Page templates, their slots and the system pages of the buyer site (content-management analysis
// 2, 3-a and 4; john 17 Oct). All of it is code, never rows: an admin can only fill the `modules`
// slots of a template with the modules it allows, between its minimum and maximum. A `fixed`
// slot is a section the buyer app draws itself (product details, the product list of a category,
// the cart) and takes no module. The header, the left rail's "Browse products" button, the
// mobile bottom bar and the footer are no slot of any template: they are locked in the app. The
// navigation (the left-rail items and the Browse drawer's category lists) is the system page
// `navigation`, edited as a draft and live only after a platform admin approves it.

export type SlotKind = 'modules' | 'fixed';
export type SlotWidth = 'full' | 'column';
export type LinkedType = 'category' | 'product' | 'seller';
export const LINKED_TYPES: readonly LinkedType[] = ['category', 'product', 'seller'];

export interface SlotDefinition {
  readonly key: string;
  readonly kind: SlotKind;
  readonly modules: readonly ModuleKey[];
  readonly min: number;
  readonly max: number;
  readonly width: SlotWidth;
}

export interface DefaultPlacement {
  readonly module: ModuleKey;
  readonly config: ModuleConfig;
}

export interface TemplateDefinition {
  readonly key: string;
  /** `dynamic`: offered when an admin creates a page; `system`: the template of one system page. */
  readonly scope: 'dynamic' | 'system';
  readonly slots: readonly SlotDefinition[];
  /** The entity types a page of this template may be linked to. */
  readonly linkable: readonly LinkedType[];
  /**
   * The modules a new draft starts with, per slot. Defaults hold no invented copy: only modules
   * whose texts are optional, or texts taken from the page's own title.
   */
  readonly defaults: (page: {
    readonly title: string;
  }) => Readonly<Record<string, readonly DefaultPlacement[]>>;
}

/** Most modules any slot may hold, whatever its own maximum, so a page stays fast (analysis 8). */
export const MAX_MODULES_PER_SLOT = 30;

const slot = (
  key: string,
  modules: readonly ModuleKey[],
  min: number,
  max: number,
  width: SlotWidth = 'full',
): SlotDefinition => ({ key, kind: 'modules', modules, min, max, width });
const fixed = (key: string): SlotDefinition => ({
  key,
  kind: 'fixed',
  modules: [],
  min: 0,
  max: 0,
  width: 'full',
});

const shelf = (kind: 'bestsellers' | 'specials' | 'linked'): DefaultPlacement => ({
  module: 'product-shelf',
  config: { source: { kind }, limit: 12 },
});

const TEMPLATE_LIST: readonly TemplateDefinition[] = [
  // Dynamic templates, offered at page creation (analysis 3-a).
  {
    key: 'campaign-landing',
    scope: 'dynamic',
    linkable: ['category', 'seller', 'product'],
    slots: [
      slot('hero', ['banner'], 1, 1),
      slot('benefits', ['info-strip'], 0, 1),
      slot('main', ['product-shelf', 'banner', 'image-text', 'text-block'], 1, 8),
      slot('bottom', ['faq', 'text-block'], 0, 2, 'column'),
    ],
    defaults: ({ title }) => ({
      hero: [
        { module: 'banner', config: { title, image: { ref: 'campaign-default', alt: title } } },
      ],
      benefits: [
        { module: 'info-strip', config: { items: [{ icon: 'delivery' }, { icon: 'tax' }] } },
      ],
      main: [shelf('specials'), shelf('bestsellers')],
    }),
  },
  {
    key: 'brand-page',
    scope: 'dynamic',
    linkable: ['seller', 'category'],
    slots: [
      slot('header', ['brand-header'], 1, 1),
      slot('main', ['product-shelf', 'banner', 'image-text'], 1, 8),
      slot('about', ['image-text', 'text-block'], 0, 3, 'column'),
    ],
    defaults: ({ title }) => ({
      header: [{ module: 'brand-header', config: { name: title } }],
      main: [shelf('linked')],
    }),
  },
  {
    key: 'product-spotlight',
    scope: 'dynamic',
    linkable: ['product'],
    slots: [
      slot('hero', ['product-spotlight'], 1, 1),
      slot('details', ['text-block', 'image-text', 'info-strip'], 0, 4, 'column'),
      slot('related', ['product-shelf'], 0, 2),
      slot('faq', ['faq'], 0, 1, 'column'),
    ],
    defaults: () => ({
      hero: [{ module: 'product-spotlight', config: {} }],
      related: [shelf('linked')],
    }),
  },
  {
    key: 'info-page',
    scope: 'dynamic',
    linkable: [],
    slots: [
      slot('body', ['text-block', 'image-text'], 1, 10, 'column'),
      slot('faq', ['faq'], 0, 1, 'column'),
    ],
    defaults: () => ({}),
  },
  // System page templates (analysis 2).
  {
    key: 'system.home',
    scope: 'system',
    linkable: [],
    slots: [
      slot('top', ['banner'], 0, 5),
      slot('categories', ['category-circles'], 0, 1),
      slot('main', ['product-shelf', 'banner', 'sellers-near-you', 'image-text'], 1, 12),
      slot('end', ['info-strip', 'text-block', 'image-text'], 0, 3),
    ],
    defaults: () => ({
      categories: [{ module: 'category-circles', config: {} }],
      main: [
        shelf('bestsellers'),
        shelf('specials'),
        { module: 'sellers-near-you', config: { limit: 8 } },
      ],
      end: [{ module: 'info-strip', config: { items: [{ icon: 'delivery' }, { icon: 'tax' }] } }],
    }),
  },
  {
    key: 'system.offers',
    scope: 'system',
    linkable: [],
    slots: [slot('top', ['banner'], 0, 3), slot('main', ['product-shelf', 'banner'], 1, 12)],
    defaults: () => ({ main: [shelf('specials')] }),
  },
  {
    key: 'system.express',
    scope: 'system',
    linkable: [],
    slots: [slot('top', ['banner'], 0, 3), slot('main', ['product-shelf', 'banner'], 1, 12)],
    defaults: () => ({ main: [shelf('bestsellers')] }),
  },
  {
    key: 'system.category',
    scope: 'system',
    linkable: [],
    slots: [
      slot('top', ['banner', 'text-block'], 0, 2),
      fixed('listing'),
      slot('bottom', ['product-shelf', 'text-block', 'faq'], 0, 3),
    ],
    defaults: () => ({}),
  },
  {
    key: 'system.search',
    scope: 'system',
    linkable: [],
    slots: [
      slot('top', ['banner'], 0, 1),
      fixed('results'),
      slot('no-results', ['product-shelf', 'text-block'], 0, 2),
    ],
    defaults: () => ({ 'no-results': [shelf('bestsellers')] }),
  },
  {
    key: 'system.product',
    scope: 'system',
    linkable: [],
    slots: [fixed('details'), slot('below', ['product-shelf', 'banner'], 0, 3)],
    defaults: () => ({}),
  },
  {
    key: 'system.sellers',
    scope: 'system',
    linkable: [],
    slots: [slot('top', ['banner', 'text-block'], 0, 2), fixed('list')],
    defaults: () => ({}),
  },
  {
    key: 'system.seller',
    scope: 'system',
    linkable: [],
    slots: [
      fixed('header'),
      slot('below-header', ['banner', 'text-block'], 0, 2),
      fixed('products'),
    ],
    defaults: () => ({}),
  },
  {
    key: 'system.cart',
    scope: 'system',
    linkable: [],
    // Only one promotion slot under the cart; the minimum-order message and GST stay locked.
    slots: [fixed('cart'), slot('below-cart', ['product-shelf', 'banner'], 0, 1)],
    defaults: () => ({}),
  },
  {
    key: 'system.locked',
    scope: 'system',
    linkable: [],
    slots: [fixed('content')],
    defaults: () => ({}),
  },
  {
    key: 'system.navigation',
    scope: 'system',
    linkable: [],
    slots: [
      slot('rail', ['nav-link'], 0, 12, 'column'),
      slot('drawer-popular', ['nav-category'], 0, 12, 'column'),
      slot('drawer-categories', ['nav-category'], 0, 30, 'column'),
    ],
    defaults: () => ({}),
  },
];

export const TEMPLATES: ReadonlyMap<string, TemplateDefinition> = new Map(
  TEMPLATE_LIST.map((template) => [template.key, template]),
);

export const DYNAMIC_TEMPLATE_KEYS: readonly string[] = TEMPLATE_LIST.filter(
  (template) => template.scope === 'dynamic',
).map((template) => template.key);

/** How much of a system page an admin may change (analysis 2). */
export type EditLevel = 'full' | 'limited' | 'locked' | 'navigation';

export interface SystemPageDefinition {
  readonly key: string;
  readonly templateKey: string;
  readonly editLevel: EditLevel;
  /** The page's path in the buyer site; a `:name` part is filled by the app. */
  readonly path: string;
}

const system = (
  key: string,
  templateKey: string,
  editLevel: EditLevel,
  path: string,
): SystemPageDefinition => ({ key, templateKey, editLevel, path });

export const SYSTEM_PAGE_LIST: readonly SystemPageDefinition[] = [
  system('home', 'system.home', 'full', '/'),
  system('offers', 'system.offers', 'full', '/offers'),
  system('express', 'system.express', 'full', '/express'),
  system('category', 'system.category', 'limited', '/c/:category'),
  system('search', 'system.search', 'limited', '/search'),
  system('product', 'system.product', 'limited', '/p/:product'),
  system('sellers', 'system.sellers', 'limited', '/sellers'),
  system('seller', 'system.seller', 'limited', '/s/:seller'),
  system('cart', 'system.cart', 'limited', '/cart'),
  system('checkout', 'system.locked', 'locked', '/checkout'),
  system('order-confirmation', 'system.locked', 'locked', '/orders/:order'),
  system('account', 'system.locked', 'locked', '/account'),
  system('navigation', 'system.navigation', 'navigation', '/'),
];

export const SYSTEM_PAGES: ReadonlyMap<string, SystemPageDefinition> = new Map(
  SYSTEM_PAGE_LIST.map((page) => [page.key, page]),
);

/** The system page that holds the navigation; edited and approved through its own use cases. */
export const NAVIGATION_KEY = 'navigation';

/**
 * Slugs a dynamic page may not take, so `/l/<slug>` never reads like a system word, and words
 * the buyer app may want for its own routes later.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...SYSTEM_PAGE_LIST.map((page) => page.key),
  'admin',
  'api',
  'c',
  'p',
  's',
  'l',
  'login',
  'sign-in',
  'sign-up',
  'orders',
  'new',
  'preview',
  'draft',
]);

export const templateOf = (key: string): TemplateDefinition => {
  const template = TEMPLATES.get(key);
  // Only code writes template keys; an unknown one means damage, never guessed.
  if (template === undefined) throw new Error('storefront.template-unknown');
  return template;
};
