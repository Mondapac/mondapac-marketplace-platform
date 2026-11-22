// The catalog structure of the AU scenario, built through the admin API (the catalog seed jobs are
// switched off in this environment with CATALOG_SEED_JOBS_OFF): departments and categories,
// attributes, feature sets, the feature set and buyer filters of each department, and cultures.
// Codes and slugs are fixed, so a rerun finds what an earlier run made.

/**
 * Departments (parent null) and categories, parents before children, in menu order. The tree and
 * its codes follow the storefront's sample tree (apps/web/src/storefront/sample-home.ts), so the
 * live site shows the same menu, with fish, sweets, drinks and household added.
 */
const CATEGORIES = [
  ['meat', null, 'Meat'],
  ['lamb', 'meat', 'Lamb'],
  ['beef', 'meat', 'Beef'],
  ['goat', 'meat', 'Goat'],
  ['mince', 'meat', 'Mince'],
  ['sausages-and-burgers', 'meat', 'Sausages and burgers'],
  ['bbq', 'meat', 'BBQ'],
  ['poultry', null, 'Poultry'],
  ['whole-chicken', 'poultry', 'Whole chicken'],
  ['chicken-pieces', 'poultry', 'Chicken pieces'],
  ['duck-and-turkey', 'poultry', 'Duck and turkey'],
  ['seafood', null, 'Fish and seafood'],
  ['fish', 'seafood', 'Fish'],
  ['prawns-and-shellfish', 'seafood', 'Prawns and shellfish'],
  ['bakery', null, 'Bakery'],
  ['bread', 'bakery', 'Bread'],
  ['wraps-and-flatbread', 'bakery', 'Wraps and flatbread'],
  ['pastries', 'bakery', 'Pastries'],
  ['cakes-and-slices', 'bakery', 'Cakes and slices'],
  ['pantry', null, 'Pantry'],
  ['rice-and-grains', 'pantry', 'Rice and grains'],
  ['oils-and-vinegars', 'pantry', 'Oils and vinegars'],
  ['honey-and-spreads', 'pantry', 'Honey and spreads'],
  ['pasta-and-noodles', 'pantry', 'Pasta and noodles'],
  ['canned-goods', 'pantry', 'Canned goods'],
  ['nuts-and-dried-fruit', 'pantry', 'Nuts and dried fruit'],
  ['flour-and-baking', 'pantry', 'Flour and baking'],
  ['dairy', null, 'Dairy and eggs'],
  ['milk', 'dairy', 'Milk'],
  ['yoghurt', 'dairy', 'Yoghurt'],
  ['cheese', 'dairy', 'Cheese'],
  ['eggs', 'dairy', 'Eggs'],
  ['dips-and-hummus', 'dairy', 'Dips and hummus'],
  ['produce', null, 'Fresh produce'],
  ['fruit', 'produce', 'Fruit'],
  ['vegetables', 'produce', 'Vegetables'],
  ['herbs', 'produce', 'Herbs'],
  ['salads', 'produce', 'Salads'],
  ['spices', null, 'Spices'],
  ['whole-spices', 'spices', 'Whole spices'],
  ['ground-spices', 'spices', 'Ground spices'],
  ['spice-blends', 'spices', 'Spice blends'],
  ['saffron', 'spices', 'Saffron'],
  ['meals', null, 'Ready meals'],
  ['heat-and-eat', 'meals', 'Heat and eat'],
  ['frozen-meals', 'meals', 'Frozen meals'],
  ['soups', 'meals', 'Soups'],
  ['sides', 'meals', 'Sides'],
  ['sweets-and-snacks', null, 'Sweets and snacks'],
  ['middle-eastern-sweets', 'sweets-and-snacks', 'Middle Eastern sweets'],
  ['chocolate', 'sweets-and-snacks', 'Chocolate'],
  ['biscuits', 'sweets-and-snacks', 'Biscuits'],
  ['chips-and-crackers', 'sweets-and-snacks', 'Chips and crackers'],
  ['drinks', null, 'Drinks'],
  ['tea-and-coffee', 'drinks', 'Tea and coffee'],
  ['juice', 'drinks', 'Juice'],
  ['soft-drinks', 'drinks', 'Soft drinks'],
  ['water', 'drinks', 'Water'],
  ['household', null, 'Household'],
  ['cleaning', 'household', 'Cleaning'],
  ['kitchenware', 'household', 'Kitchenware'],
].map(([slug, parent, name]) => ({ slug, parent, name }));

/** Attribute definitions: created, then published. Options are in order. */
const ATTRIBUTES = [
  { code: 'brand', dataType: 'text', name: 'Brand', bounds: { maxLength: 80 } },
  {
    code: 'description',
    dataType: 'long-text',
    name: 'Description',
    localizable: true,
    bounds: { maxLength: 2000 },
  },
  {
    code: 'country-of-origin',
    dataType: 'text',
    name: 'Country of origin',
    bounds: { maxLength: 80 },
  },
  {
    code: 'pack-size',
    dataType: 'select',
    name: 'Pack size',
    isVariantOption: true,
    filter: true,
    options: [
      ['g250', '250 g'],
      ['g500', '500 g'],
      ['kg1', '1 kg'],
      ['kg2', '2 kg'],
      ['kg5', '5 kg'],
      ['pack4', '4 pack'],
      ['pack6', '6 pack'],
      ['pack12', '12 pack'],
    ],
  },
  {
    code: 'volume',
    dataType: 'select',
    name: 'Volume',
    isVariantOption: true,
    filter: true,
    options: [
      ['ml375', '375 ml'],
      ['ml600', '600 ml'],
      ['l1', '1 L'],
      ['l2', '2 L'],
    ],
  },
  {
    code: 'storage',
    dataType: 'select',
    name: 'Storage',
    filter: true,
    options: [
      ['pantry', 'Pantry'],
      ['chilled', 'Chilled'],
      ['frozen', 'Frozen'],
    ],
  },
  { code: 'ingredients', dataType: 'long-text', name: 'Ingredients', localizable: true },
  { code: 'flavour', dataType: 'text', name: 'Flavour', bounds: { maxLength: 60 } },
].map((attribute) => ({
  localizable: false,
  isVariantOption: false,
  filter: false,
  bounds: {},
  options: [],
  ...attribute,
}));

/**
 * Feature sets. The first group is Core (brand and country of origin), as the editor requires.
 * Levels: required, recommended or optional.
 */
const CORE = {
  groupCode: 'core',
  name: 'Core',
  attributes: [
    ['brand', 'required'],
    ['country-of-origin', 'recommended'],
  ],
};
const FEATURE_SETS = [
  {
    code: 'grocery',
    name: 'Grocery',
    groups: [
      CORE,
      {
        groupCode: 'details',
        name: 'Details',
        attributes: [
          ['description', 'required'],
          ['pack-size', 'optional'],
          ['storage', 'recommended'],
          ['ingredients', 'optional'],
        ],
      },
    ],
  },
  {
    code: 'drinks',
    name: 'Drinks',
    groups: [
      CORE,
      {
        groupCode: 'details',
        name: 'Details',
        attributes: [
          ['description', 'required'],
          ['volume', 'optional'],
          ['flavour', 'optional'],
          ['ingredients', 'optional'],
        ],
      },
    ],
  },
  {
    code: 'household',
    name: 'Household',
    groups: [
      CORE,
      { groupCode: 'details', name: 'Details', attributes: [['description', 'required']] },
    ],
  },
];

/**
 * Each department's feature set and buyer filters; its categories inherit the set. A buyer filter
 * is a choice attribute (text attributes cannot be filters).
 */
const LINKS = [
  ['meat', 'grocery', ['pack-size', 'storage']],
  ['poultry', 'grocery', ['pack-size', 'storage']],
  ['seafood', 'grocery', ['pack-size', 'storage']],
  ['bakery', 'grocery', ['pack-size', 'storage']],
  ['pantry', 'grocery', ['pack-size', 'storage']],
  ['dairy', 'grocery', ['storage']],
  ['produce', 'grocery', ['pack-size']],
  ['spices', 'grocery', ['pack-size']],
  ['meals', 'grocery', ['storage']],
  ['sweets-and-snacks', 'grocery', ['pack-size']],
  ['drinks', 'drinks', ['volume']],
  ['household', 'household', []],
].map(([category, featureSet, filters]) => ({ category, featureSet, filters }));

/** Cultures (ADR-0047): a required certification type is one the certification seed creates. */
const CULTURES = [
  {
    code: 'muslim',
    displayOrder: 0,
    requiredCertificationType: 'halal',
    isDefault: true,
    name: 'Muslim community',
    description: 'Products and sellers for the Muslim community.',
  },
];

export const CATALOG = {
  categories: CATEGORIES,
  attributes: ATTRIBUTES,
  featureSets: FEATURE_SETS,
  links: LINKS,
  cultures: CULTURES,
};
