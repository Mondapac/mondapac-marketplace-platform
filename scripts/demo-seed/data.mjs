// The sample marketplace of the local demo: a small Brisbane grocery market. Names avoid the
// claim words of the Market (halal, kosher, vegan, organic, certified, authentic, official,
// verified): a claim is made through a certificate, never in free text (catalog design 6.1).

export const PASSWORD = process.env.DEMO_PASSWORD ?? 'Mondapac-Demo-2026-Passw0rd!';
export const ADMIN = { email: 'admin@demo.example', displayName: 'Demo Admin' };
export const BUYER = { email: 'buyer@demo.example', password: PASSWORD };

/** An 11-digit ABN with a valid checksum, built from a 9-digit core. */
export function abn(core) {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  for (let prefix = 10; prefix <= 99; prefix += 1) {
    const digits = `${prefix}${core}`.split('').map(Number);
    digits[0] -= 1;
    if (digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 89 === 0) {
      return `${prefix}${core}`;
    }
  }
  throw new Error(`no ABN for ${core}`);
}

export const SELLERS = [
  {
    key: 'alnoor',
    owner: 'Amina Rahman',
    email: 'amina@alnoor.demo.example',
    storeName: 'Al Noor Grocers',
    businessName: 'Al Noor Grocers Pty Ltd',
    slug: 'al-noor-grocers',
    phone: '0732001234',
    abn: abn('824753556'),
    address: { line1: '12 Logan Road', suburb: 'Woolloongabba', state: 'QLD', postcode: '4102' },
    stockName: 'Woolloongabba shop',
  },
  {
    key: 'sunnybank',
    owner: 'Yusuf Demir',
    email: 'yusuf@sunnybank.demo.example',
    storeName: 'Sunnybank Butchery',
    businessName: 'Sunnybank Butchery Pty Ltd',
    slug: 'sunnybank-butchery',
    phone: '0733451122',
    abn: abn('004085616'),
    address: { line1: '3 Mains Road', suburb: 'Sunnybank', state: 'QLD', postcode: '4109' },
    stockName: 'Sunnybank cold room',
  },
  {
    key: 'valley',
    owner: 'Layla Haddad',
    email: 'layla@valley.demo.example',
    storeName: 'Valley Sweets and Bakery',
    businessName: 'Valley Sweets Pty Ltd',
    slug: 'valley-sweets-bakery',
    phone: '0732547788',
    abn: abn('612345678'),
    address: {
      line1: '88 Brunswick Street',
      suburb: 'Fortitude Valley',
      state: 'QLD',
      postcode: '4006',
    },
    stockName: 'Fortitude Valley bakery',
  },
  {
    key: 'spice',
    owner: 'Omar Siddiqui',
    email: 'omar@spicehouse.demo.example',
    storeName: 'Mount Gravatt Spice House',
    businessName: 'Spice House Trading Pty Ltd',
    slug: 'mount-gravatt-spice-house',
    phone: '0734229900',
    abn: abn('735918264'),
    address: { line1: '25 Logan Road', suburb: 'Mount Gravatt', state: 'QLD', postcode: '4122' },
    stockName: 'Mount Gravatt warehouse',
  },
  {
    // Submitted and left waiting, so the admin's review queue has something to show.
    key: 'taringa',
    owner: 'Fatima Noor',
    email: 'fatima@taringa.demo.example',
    storeName: 'Taringa Fresh Produce',
    businessName: 'Taringa Fresh Pty Ltd',
    slug: 'taringa-fresh-produce',
    phone: '0733712200',
    abn: abn('491876234'),
    address: { line1: '149 Moggill Road', suburb: 'Taringa', state: 'QLD', postcode: '4068' },
    stockName: 'Taringa shop',
    leaveInReview: true,
  },
];

// Products are PLATFORM products made by the admin; every seller lists them through Offers.
// `variants` is for a Configurable product (pack-size option codes of the AU attribute seed);
// a Simple product has one variant of its own. Prices are minor units (AUD cents).
export const PRODUCTS = [
  {
    key: 'basmati',
    name: 'Aged Basmati Rice',
    short: 'Long grain aged basmati',
    text: 'Fragrant aged long grain basmati rice. Cooks light and separate.',
    category: 'rice-and-grains',
    tax: 'gst_free',
    brand: 'Golden Harvest',
    origin: 'India',
    variants: [
      { option: 'kg1', label: '1 kg' },
      { option: 'kg5', label: '5 kg' },
    ],
  },
  {
    key: 'lentils',
    name: 'Red Split Lentils',
    short: 'Quick cooking red lentils',
    text: 'Skinned and split red lentils for soups, dal and stews.',
    category: 'rice-and-grains',
    tax: 'gst_free',
    brand: 'Golden Harvest',
    origin: 'Australia',
    variants: [
      { option: 'g500', label: '500 g' },
      { option: 'kg1', label: '1 kg' },
    ],
  },
  {
    key: 'turmeric',
    name: 'Ground Turmeric',
    short: 'Bright golden ground turmeric',
    text: 'Finely ground turmeric root with a warm, earthy flavour.',
    category: 'spices-and-seasonings',
    tax: 'gst_free',
    brand: 'Spice Route',
    origin: 'India',
    variants: [
      { option: 'g250', label: '250 g' },
      { option: 'g500', label: '500 g' },
    ],
  },
  {
    key: 'cumin',
    name: 'Cumin Seeds',
    short: 'Whole cumin seeds',
    text: 'Whole cumin seeds, ideal for tempering and spice blends.',
    category: 'spices-and-seasonings',
    tax: 'gst_free',
    brand: 'Spice Route',
    origin: 'Turkey',
  },
  {
    key: 'oil',
    name: 'Cold Pressed Olive Oil 1L',
    short: 'Extra virgin olive oil',
    text: 'Cold pressed extra virgin olive oil in a one litre bottle.',
    category: 'oils-and-sauces',
    tax: 'gst_free',
    brand: 'Olive Grove',
    origin: 'Greece',
  },
  {
    key: 'chicken',
    name: 'Chicken Breast Fillets',
    short: 'Fresh chicken breast, about 1 kg',
    text: 'Fresh trimmed chicken breast fillets, packed to order.',
    category: 'meat-and-poultry',
    tax: 'gst_free',
    brand: 'Sunnybank Butchery',
    origin: 'Australia',
  },
  {
    key: 'lamb',
    name: 'Diced Lamb Shoulder',
    short: 'Diced lamb, about 1 kg',
    text: 'Diced lamb shoulder for slow cooking, curries and stews.',
    category: 'meat-and-poultry',
    tax: 'gst_free',
    brand: 'Sunnybank Butchery',
    origin: 'Australia',
  },
  {
    key: 'mince',
    name: 'Beef Mince 500g',
    short: 'Lean beef mince',
    text: 'Lean beef mince, ground fresh each morning.',
    category: 'meat-and-poultry',
    tax: 'gst_free',
    brand: 'Sunnybank Butchery',
    origin: 'Australia',
  },
  {
    key: 'eggs',
    name: 'Free Range Eggs 12 Pack',
    short: 'A dozen free range eggs',
    text: 'A dozen large free range eggs from Queensland farms.',
    category: 'dairy-and-eggs',
    tax: 'gst_free',
    brand: 'Farm Fresh',
    origin: 'Australia',
  },
  {
    key: 'delight',
    name: 'Turkish Delight Assorted',
    short: 'Rose, lemon and pistachio',
    text: 'Soft Turkish delight in rose, lemon and pistachio flavours.',
    category: 'sweets-and-snacks',
    tax: 'taxable',
    brand: 'Valley Sweets',
    origin: 'Turkey',
    variants: [
      { option: 'g250', label: '250 g' },
      { option: 'g500', label: '500 g' },
    ],
  },
  {
    key: 'baklava',
    name: 'Baklava Selection Box',
    short: 'Twelve pieces',
    text: 'Twelve pieces of baklava with pistachio and walnut, baked this week.',
    category: 'sweets-and-snacks',
    tax: 'taxable',
    brand: 'Valley Sweets',
    origin: 'Australia',
  },
  {
    key: 'sourdough',
    name: 'Sourdough Loaf',
    short: 'Baked this morning',
    text: 'A crusty sourdough loaf baked fresh each morning.',
    category: 'bakery',
    tax: 'gst_free',
    brand: 'Valley Bakery',
    origin: 'Australia',
  },
  {
    key: 'dates',
    name: 'Medjool Dates 500g',
    short: 'Large soft Medjool dates',
    text: 'Large, soft and sweet Medjool dates in a 500 g tub.',
    category: 'sweets-and-snacks',
    tax: 'gst_free',
    brand: 'Desert Gold',
    origin: 'Jordan',
  },
  {
    key: 'syrup',
    name: 'Date Syrup 350ml',
    short: 'Thick date syrup',
    text: 'Thick, naturally sweet date syrup for baking and breakfast.',
    category: 'oils-and-sauces',
    tax: 'gst_free',
    brand: 'Desert Gold',
    origin: 'Jordan',
  },
];

// What each seller lists. `prices` and `stock` follow the product's variants in order (a Simple
// product has one). `handling` is recorded through the seller handling endpoint.
const o = (product, sku, handling, prices, stock) => ({ product, sku, handling, prices, stock });
export const OFFERS = {
  alnoor: [
    o('basmati', 'AN-BAS', 'SEALED_ORIGINAL', [899, 3450], [60, 25]),
    o('lentils', 'AN-LEN', 'SEALED_ORIGINAL', [320, 550], [80, 40]),
    o('oil', 'AN-OIL', 'SEALED_ORIGINAL', [1490], [30]),
    o('dates', 'AN-DAT', 'SEALED_ORIGINAL', [1290], [45]),
    o('syrup', 'AN-SYR', 'SEALED_ORIGINAL', [850], [8]),
    o('eggs', 'AN-EGG', 'FRESH', [680], [36]),
  ],
  sunnybank: [
    o('chicken', 'SB-CHK', 'FRESH', [1200], [24]),
    o('lamb', 'SB-LMB', 'FRESH', [1850], [14]),
    o('mince', 'SB-MNC', 'FRESH', [1390], [30]),
    o('eggs', 'SB-EGG', 'FRESH', [720], [40]),
  ],
  valley: [
    o('delight', 'VS-TUR', 'PREPARED', [750, 1300], [50, 30]),
    o('baklava', 'VS-BAK', 'PREPARED', [1600], [18]),
    o('sourdough', 'VS-SOU', 'FRESH', [720], [20]),
    o('dates', 'VS-DAT', 'SEALED_ORIGINAL', [1350], [22]),
  ],
  spice: [
    o('turmeric', 'SH-TUR', 'REPACKED', [450, 800], [70, 40]),
    o('cumin', 'SH-CUM', 'REPACKED', [390], [90]),
    o('basmati', 'SH-BAS', 'SEALED_ORIGINAL', [950, 3600], [30, 12]),
    o('lentils', 'SH-LEN', 'SEALED_ORIGINAL', [340, 580], [60, 25]),
    o('syrup', 'SH-SYR', 'SEALED_ORIGINAL', [890], [20]),
  ],
};

// The showcase prices: one active special price (admin sees none waiting) and one price jump
// that the platform holds until the admin approves it (a rise of more than 50 per cent).
export const SPECIAL = {
  seller: 'alnoor',
  product: 'basmati',
  sku: 'AN-BAS',
  variant: 0,
  amount: 749,
  days: 7,
};
export const HELD = { seller: 'spice', product: 'cumin', sku: 'SH-CUM', variant: 0, amount: 890 };
