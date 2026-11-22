// The buyer site content of the AU scenario, made through the admin's storefront editor: the
// slides, the home page, the navigation and a few information pages. The words follow the
// storefront's sample content (apps/web/src/storefront/sample-home.ts and sample-catalog.ts).
// Slide and page texts never use a claim word: a claim is shown only as a certificate's badge.

/**
 * Slides by position. kind: announcement, promotion or link (a link slide needs `link`). image: a storefront placeholder photo (decorative; the text carries the
 * message). link: a category of ./catalog.mjs. scope: a category slug for a listing's top.
 * A slide runs for at most 90 days, so a rerun after that makes it again.
 */
const SLIDES = [
  {
    key: 'hero-fresh',
    kind: 'link',
    position: 'home.hero',
    autoplay: true,
    title: 'Fresh from Brisbane sellers you can trust',
    body: 'Butchers, bakers and pantry makers, all in one cart. Every price includes GST.',
    ctaLabel: 'Shop fresh produce',
    image: 'fruits',
    link: 'produce',
    textTone: 'dark',
  },
  {
    key: 'hero-bread',
    kind: 'link',
    position: 'home.hero',
    autoplay: true,
    title: 'Baked this morning, at your door today',
    body: 'Order from local bakers before noon for same-day delivery.',
    ctaLabel: 'Shop the bakery',
    image: 'bread',
    link: 'bakery',
    textTone: 'dark',
  },
  {
    key: 'hero-certificates',
    kind: 'announcement',
    position: 'home.hero',
    autoplay: true,
    title: 'Certification, clearly shown',
    body: 'Every seal on a product comes from a certificate we have checked.',
    ctaLabel: 'Shop meat',
    image: 'meat',
    link: 'meat',
    textTone: 'light',
  },
  {
    key: 'mid-sell',
    kind: 'announcement',
    position: 'home.mid',
    title: 'Sell with Mondapac',
    body: 'Reach Brisbane shoppers with your own shop.',
    image: 'cheese',
    textTone: 'dark',
  },
  {
    key: 'meat-specials',
    kind: 'promotion',
    position: 'category.top',
    scope: 'meat',
    title: 'Meat specials this week',
    body: 'Lamb, beef and chicken from Kedron Family Butchers on special.',
    ctaLabel: 'Shop lamb',
    link: 'lamb',
    textTone: 'dark',
  },
  {
    key: 'pantry-specials',
    kind: 'promotion',
    position: 'category.top',
    scope: 'pantry',
    title: 'Pantry staples for less',
    body: 'Rice, lentils and honey from Sunnybank Pantry Co, this week only.',
    ctaLabel: 'Shop rice and grains',
    link: 'rice-and-grains',
    textTone: 'dark',
  },
];

/** The home page modules by slot, in order (template system.home). */
const HOME = {
  categories: [{ module: 'category-circles', config: { title: 'Shop by category' } }],
  main: [
    { module: 'sellers-near-you', config: { title: 'Sellers near you', limit: 8 } },
    {
      module: 'product-shelf',
      config: { title: 'Best sellers', source: { kind: 'bestsellers' }, limit: 12 },
    },
    {
      module: 'product-shelf',
      config: { title: 'Special prices this week', source: { kind: 'specials' }, limit: 12 },
    },
  ],
  end: [
    {
      module: 'info-strip',
      config: {
        items: [
          { icon: 'delivery', text: 'Delivery across Greater Brisbane' },
          { icon: 'tax', text: 'Every price includes GST' },
          { icon: 'certified', text: 'Certificates checked by Mondapac' },
          { icon: 'local', text: 'From local sellers' },
        ],
      },
    },
  ],
};

/** The navigation: the left rail (system pages), popular departments and every department. */
const NAVIGATION = {
  rail: [
    { label: 'Special prices', target: { kind: 'system-page', key: 'offers' } },
    { label: 'Express delivery', target: { kind: 'system-page', key: 'express' } },
    { label: 'Sellers', target: { kind: 'system-page', key: 'sellers' } },
  ],
  popular: ['meat', 'poultry', 'bakery', 'pantry'],
  // The Browse drawer lists every department of ./catalog.mjs, in the tree's order.
  departments: [
    'meat',
    'poultry',
    'seafood',
    'bakery',
    'pantry',
    'dairy',
    'produce',
    'spices',
    'meals',
    'sweets-and-snacks',
    'drinks',
    'household',
  ],
};

const paragraph = (text) => ({ type: 'paragraph', spans: [{ text }] });

/** Information pages (template info-page): title, slug and text blocks. */
const PAGES = [
  {
    slug: 'about',
    title: 'About Mondapac',
    blocks: [
      paragraph(
        'Mondapac brings the butchers, bakers, grocers and makers of Greater Brisbane into one shop, so you can fill one cart from many local sellers.',
      ),
      { type: 'heading', level: 2, text: 'Certificates you can check' },
      paragraph(
        'A product shows a certification badge only when its seller holds a certificate of that type that we have checked and that has not expired.',
      ),
    ],
  },
  {
    slug: 'delivery',
    title: 'Delivery',
    blocks: [
      paragraph('We deliver across Greater Brisbane. Each seller sets its own minimum order.'),
      paragraph(
        'Order from a seller offering express delivery before noon to get it the same day.',
      ),
    ],
  },
  {
    slug: 'returns',
    title: 'Returns and refunds',
    blocks: [
      paragraph(
        'If something arrives damaged or is not what you ordered, tell us within 48 hours from your orders page and we will sort it out with the seller.',
      ),
    ],
  },
];

/**
 * The platform's blog (blog module): its categories and a few posts written by the platform team.
 * cover: a placeholder photo, coverAlt its description. products: product keys of ./products.mjs, shown as product cards
 * (each must be on sale). seller: a seller key of ./sellers.mjs, shown as a store card.
 */
const BLOG = {
  categories: [
    { slug: 'news', name: 'News' },
    { slug: 'recipes-and-tips', name: 'Recipes and tips' },
  ],
  featured: 'welcome-to-mondapac',
  posts: [
    {
      slug: 'welcome-to-mondapac',
      kind: 'news',
      category: 'news',
      cover: 'fruits',
      coverAlt: 'A box of fresh fruit',
      title: 'Welcome to Mondapac',
      excerpt: 'Butchers, bakers and grocers from across Greater Brisbane, in one cart.',
      body: [
        {
          type: 'paragraph',
          text: 'Mondapac brings the local sellers of Greater Brisbane into one shop. Fill one cart from many stores and pay once; each seller packs and delivers its own part of the order.',
        },
        { type: 'heading', level: 2, text: 'How it works' },
        {
          type: 'list',
          ordered: true,
          items: [
            'Browse by department or search for what you need.',
            'Add products from as many sellers as you like.',
            'Check out once; every price already includes GST.',
          ],
        },
        { type: 'seller_card', seller: 'kedron' },
      ],
    },
    {
      slug: 'weeknight-pantry-staples',
      kind: 'product',
      category: 'recipes-and-tips',
      cover: 'coconut',
      coverAlt: 'A halved coconut',
      title: 'Five pantry staples for a quick weeknight dinner',
      excerpt: 'Rice, lentils, chickpeas, coconut milk and tomatoes: dinner in thirty minutes.',
      body: [
        {
          type: 'paragraph',
          text: 'A well-stocked pantry turns a busy evening into a warm, simple dinner. These five staples keep for months and come together in one pot.',
        },
        {
          type: 'tip',
          title: 'Rinse the rice',
          text: 'Rinse basmati until the water runs clear for light, separate grains.',
        },
        {
          type: 'product_cards',
          products: ['basmati', 'lentils', 'chickpeas', 'coconut-milk', 'tomatoes'],
        },
      ],
    },
    {
      slug: 'slow-roast-lamb-shoulder',
      kind: 'product',
      category: 'recipes-and-tips',
      cover: 'meat',
      coverAlt: 'Raw cuts of lamb on a board',
      title: 'How to slow-roast a lamb shoulder',
      excerpt: 'Low heat, a spice rub and a little patience for meat that falls off the bone.',
      body: [
        {
          type: 'paragraph',
          text: 'Rub the shoulder with baharat, olive oil and salt, cover it and roast at 150 degrees for four hours. Brush it with pomegranate molasses for the last twenty minutes.',
        },
        {
          type: 'quote',
          text: 'Ask us to score the fat for you when you order; it crisps beautifully.',
          attribution: 'Kedron Family Butchers',
        },
        { type: 'product_cards', products: ['lamb-shoulder', 'baharat', 'pomegranate-molasses'] },
      ],
    },
    {
      slug: 'same-day-bread',
      kind: 'news',
      category: 'news',
      cover: 'bread',
      coverAlt: 'Fresh loaves of bread',
      title: 'Bread baked this morning, at your door today',
      excerpt: 'Order from Paddington Bakehouse before noon for same-day delivery.',
      body: [
        {
          type: 'paragraph',
          text: 'Sourdough, Turkish bread and pastries are baked every morning in Paddington. Order before noon and they arrive the same afternoon.',
        },
        { type: 'seller_card', seller: 'paddington' },
      ],
    },
  ],
};

export const CONTENT = {
  slides: SLIDES,
  home: HOME,
  navigation: NAVIGATION,
  pages: PAGES,
  blog: BLOG,
};
