import 'server-only';
import type {
  CertificationBadge,
  Money,
  ProductCard,
  SlideSet,
  StorefrontContent,
} from './types.ts';

// Sample content of the approved home page design (v29). It stands in at the API boundary until
// the pages-and-content API (PR #401) and storefront package 2 are on main; the shapes follow
// ./types.ts so only this file is replaced when the screens are wired. Placeholder photos are in
// public/placeholders/ (licence unchecked; replaced by seller media before launch).

const CURRENCY = 'AUD';
const money = (amount: number): Money => ({ amount, currency: CURRENCY });
const certified: CertificationBadge = { type: 'halal', label: 'Halal certified' };

/** The sample home hero: the old top banner as the first slide, and two more to show a slider. */
export const SAMPLE_HERO: SlideSet = {
  position: 'home.hero',
  autoplay: true,
  slides: [
    {
      id: 'sample-fresh',
      title: 'Fresh from Brisbane sellers you can trust',
      body: 'Halal butchers, bakers and pantry makers, all in one cart. Every price includes GST.',
      ctaLabel: 'Shop special prices',
      href: '/offers',
      image: { src: '/placeholders/fruits.jpg', alt: '', decorative: true },
      placement: 'start',
      tone: 'dark',
      sponsored: false,
    },
    {
      id: 'sample-bread',
      title: 'Baked this morning, at your door today',
      body: 'Order from local bakers before noon for same-day delivery.',
      ctaLabel: 'See express delivery',
      href: '/express',
      image: { src: '/placeholders/bread.jpg', alt: '', decorative: true },
      placement: 'start',
      tone: 'dark',
      sponsored: false,
    },
    {
      id: 'sample-certified',
      title: 'Halal certification, clearly shown',
      body: 'Every seal on a product comes from a certificate we have checked.',
      ctaLabel: 'See certified products',
      href: '/certified',
      image: { src: '/placeholders/salmon.jpg', alt: '', decorative: true },
      placement: 'start',
      tone: 'light',
      sponsored: false,
    },
  ],
};

type Row = [
  id: string,
  name: string,
  seller: string,
  category: string,
  price: number,
  extra?: { was?: number; certified?: boolean; low?: number; img?: string },
];

const ROWS: Row[] = [
  [
    'lamb-shoulder',
    'Halal lamb shoulder, 1 kg',
    'Kedron Halal Butchers',
    'meat',
    2490,
    { certified: true, img: 'meat' },
  ],
  ['sourdough', 'Sourdough loaf, 800 g', 'Paddington Bakehouse', 'bakery', 850, { img: 'bread' }],
  ['basmati', 'Basmati rice, 5 kg', 'Sunnybank Pantry Co', 'pantry', 1890, { was: 2200 }],
  [
    'whole-chicken',
    'Free-range chicken, whole',
    'Kedron Halal Butchers',
    'poultry',
    2290,
    { certified: true, low: 3, img: 'chicken' },
  ],
  ['medjool', 'Medjool dates, 500 g', 'Inala Spice House', 'pantry', 1450],
  [
    'flatbread',
    'Lebanese flatbread, 6 pack',
    'Paddington Bakehouse',
    'bakery',
    550,
    { img: 'bread' },
  ],
  [
    'brisket',
    'Beef brisket, 1 kg',
    'Kedron Halal Butchers',
    'meat',
    4690,
    { was: 5400, certified: true, img: 'meat' },
  ],
  ['honey', 'Raw leatherwood honey, 380 g', 'Sunnybank Pantry Co', 'pantry', 1395, { was: 1595 }],
  ['saffron', 'Saffron threads, 1 g', 'Inala Spice House', 'spices', 990, { low: 5 }],
  [
    'croissants',
    'Butter croissants, 4 pack',
    'Paddington Bakehouse',
    'bakery',
    1450,
    { img: 'bread' },
  ],
  ['hummus', 'Hummus, 400 g', 'Moorooka Dairy', 'dairy', 750, { was: 890 }],
  ['olive-oil', 'Cold-pressed olive oil, 500 ml', 'Sunnybank Pantry Co', 'pantry', 1890],
  ['bananas', 'Bananas, 1 kg', 'Mt Gravatt Fresh Produce', 'produce', 490, { img: 'banana' }],
  [
    'apples',
    'Red apples, 1 kg',
    'Mt Gravatt Fresh Produce',
    'produce',
    650,
    { was: 790, img: 'apple' },
  ],
  ['oranges', 'Oranges, 2 kg bag', 'Mt Gravatt Fresh Produce', 'produce', 720, { img: 'orange' }],
  [
    'watermelon',
    'Watermelon, half',
    'Mt Gravatt Fresh Produce',
    'produce',
    690,
    { was: 850, img: 'watermelon' },
  ],
  [
    'fruit-box',
    'Mixed fruit box, 3 kg',
    'Mt Gravatt Fresh Produce',
    'produce',
    2490,
    { img: 'fruits' },
  ],
  [
    'salmon',
    'Salmon fillets, 500 g',
    'Mt Gravatt Fresh Produce',
    'produce',
    1890,
    { low: 4, img: 'salmon' },
  ],
  ['eggs', 'Free-range eggs, 12 pack', 'Moorooka Dairy', 'dairy', 790, { img: 'egg' }],
  ['cheese', 'Tasty cheese block, 500 g', 'Moorooka Dairy', 'dairy', 1090, { img: 'cheese' }],
  ['coconut-milk', 'Coconut milk, 1 L', 'Sunnybank Pantry Co', 'pantry', 590, { img: 'coconut' }],
];

export const PRODUCTS: ProductCard[] = ROWS.map(
  ([id, name, sellerName, category, price, extra = {}]) => ({
    id,
    name,
    sellerName,
    category,
    price: money(price),
    ...(extra.was === undefined ? {} : { wasPrice: money(extra.was) }),
    certifications: extra.certified ? [certified] : [],
    ...(extra.low === undefined ? {} : { lowStock: extra.low }),
    ...(extra.img === undefined ? {} : { imageUrl: `/placeholders/${extra.img}.jpg` }),
  }),
);

export const SAMPLE_CONTENT: StorefrontContent = {
  delivery: { label: 'Brisbane 4000' },
  popularSearches: [
    'Halal chicken',
    'Basmati rice',
    'Lebanese flatbread',
    'Saffron',
    'Ready meals',
  ],
  categories: [
    {
      code: 'meat',
      name: 'Meat',
      shortName: 'Meat',
      children: kids('Lamb', 'Beef', 'Pork', 'Mince', 'Sausages and burgers', 'BBQ'),
    },
    {
      code: 'poultry',
      name: 'Poultry',
      shortName: 'Poultry',
      children: kids('Whole chicken', 'Chicken pieces', 'Duck and turkey'),
    },
    {
      code: 'bakery',
      name: 'Bakery',
      shortName: 'Bakery',
      children: kids('Bread', 'Wraps and flatbread', 'Pastries', 'Cakes and slices'),
    },
    {
      code: 'pantry',
      name: 'Pantry',
      shortName: 'Pantry',
      children: kids(
        'Rice and grains',
        'Oils and vinegars',
        'Honey and spreads',
        'Pasta and noodles',
        'Canned goods',
        'Nuts and dried fruit',
      ),
    },
    {
      code: 'dairy',
      name: 'Dairy and eggs',
      shortName: 'Dairy',
      children: kids('Milk', 'Yoghurt', 'Cheese', 'Eggs', 'Dips and hummus'),
    },
    {
      code: 'produce',
      name: 'Fresh produce',
      shortName: 'Fresh produce',
      children: kids('Fruit', 'Vegetables', 'Herbs', 'Salads'),
    },
    {
      code: 'spices',
      name: 'Spices',
      shortName: 'Spices',
      children: kids('Whole spices', 'Ground spices', 'Spice blends', 'Saffron'),
    },
    {
      code: 'meals',
      name: 'Ready meals',
      shortName: 'Ready meals',
      children: kids('Heat and eat', 'Frozen meals', 'Soups', 'Sides'),
    },
  ],
  sellers: [
    {
      id: 'kedron',
      name: 'Kedron Halal Butchers',
      initials: 'KH',
      deliveryWindow: 'Tomorrow 8am-12pm',
      minimumOrder: 'A$40 minimum order',
      logo: 'KH',
    },
    {
      id: 'paddington',
      name: 'Paddington Bakehouse',
      initials: 'PB',
      deliveryWindow: 'Today by 5pm',
      minimumOrder: 'No minimum order',
      logo: 'PB',
    },
    {
      id: 'sunnybank',
      name: 'Sunnybank Pantry Co',
      initials: 'SP',
      deliveryWindow: 'Tomorrow 8am-12pm',
      minimumOrder: 'A$30 minimum order',
      logo: 'SP',
    },
    {
      id: 'inala',
      name: 'Inala Spice House',
      initials: 'IS',
      deliveryWindow: 'Tomorrow 12pm-4pm',
      minimumOrder: 'No minimum order',
      logo: 'IS',
    },
    {
      id: 'moorooka',
      name: 'Moorooka Dairy',
      initials: 'MD',
      deliveryWindow: 'Today by 6pm',
      minimumOrder: 'A$25 minimum order',
      logo: 'MD',
    },
    {
      id: 'mt-gravatt',
      name: 'Mt Gravatt Fresh Produce',
      initials: 'MG',
      deliveryWindow: 'Tomorrow 8am-12pm',
      minimumOrder: 'A$30 minimum order',
      logo: 'MG',
    },
  ],
  home: [
    {
      kind: 'hero',
      set: SAMPLE_HERO,
    },
    {
      kind: 'promos',
      banners: [
        {
          id: 'sell',
          variant: 'secondary',
          title: 'Sell with Mondapac',
          body: 'Reach Brisbane shoppers with your own shop.',
          action: { label: 'Become a seller', href: '/sell' },
          images: ['/placeholders/cheese.jpg', '/placeholders/egg.jpg'],
        },
      ],
    },
    { kind: 'categories' },
    { kind: 'sellers', title: 'Sellers near you', href: '/sellers' },
    { kind: 'products', title: 'Best sellers', href: '/best-sellers', products: PRODUCTS },
    {
      kind: 'products',
      title: 'Special prices this week',
      href: '/offers',
      products: PRODUCTS.filter((p) => p.wasPrice !== undefined),
    },
  ],
};

function kids(...names: string[]) {
  return names.map((name) => ({ code: name.toLowerCase().replace(/[^a-z]+/g, '-'), name }));
}
