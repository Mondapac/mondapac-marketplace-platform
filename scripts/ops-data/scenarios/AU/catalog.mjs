// The catalog structure of the AU scenario, built through the admin API (the catalog seed jobs are
// switched off in this environment with CATALOG_SEED_JOBS_OFF): departments and categories,
// attributes, feature sets, the feature set and buyer filters of each department, and cultures.
// Codes and slugs are fixed, so a rerun finds what an earlier run made.

/** Departments (parent null) and categories, parents before children, in menu order. */
const CATEGORIES = [
  ['pantry', null, 'Pantry'],
  ['rice-and-grains', 'pantry', 'Rice and grains'],
  ['flour-and-baking', 'pantry', 'Flour and baking'],
  ['spices-and-seasonings', 'pantry', 'Spices and seasonings'],
  ['oils-and-sauces', 'pantry', 'Oils and sauces'],
  ['tinned-food', 'pantry', 'Tinned food'],
  ['pasta-and-noodles', 'pantry', 'Pasta and noodles'],
  ['meat-and-poultry', null, 'Meat and poultry'],
  ['beef-and-lamb', 'meat-and-poultry', 'Beef and lamb'],
  ['chicken', 'meat-and-poultry', 'Chicken'],
  ['smallgoods', 'meat-and-poultry', 'Smallgoods'],
  ['dairy-and-eggs', null, 'Dairy and eggs'],
  ['milk-and-cream', 'dairy-and-eggs', 'Milk and cream'],
  ['cheese', 'dairy-and-eggs', 'Cheese'],
  ['yoghurt', 'dairy-and-eggs', 'Yoghurt'],
  ['eggs', 'dairy-and-eggs', 'Eggs'],
  ['fruit-and-vegetables', null, 'Fruit and vegetables'],
  ['fresh-fruit', 'fruit-and-vegetables', 'Fresh fruit'],
  ['fresh-vegetables', 'fruit-and-vegetables', 'Fresh vegetables'],
  ['dried-fruit-and-nuts', 'fruit-and-vegetables', 'Dried fruit and nuts'],
  ['bakery', null, 'Bakery'],
  ['bread', 'bakery', 'Bread'],
  ['flatbread', 'bakery', 'Flatbread'],
  ['cakes-and-pastries', 'bakery', 'Cakes and pastries'],
  ['frozen', null, 'Frozen'],
  ['frozen-meals', 'frozen', 'Frozen meals'],
  ['frozen-vegetables', 'frozen', 'Frozen vegetables'],
  ['sweets-and-snacks', null, 'Sweets and snacks'],
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
  ['pantry', 'grocery', ['pack-size', 'storage']],
  ['meat-and-poultry', 'grocery', ['pack-size', 'storage']],
  ['dairy-and-eggs', 'grocery', ['storage']],
  ['fruit-and-vegetables', 'grocery', ['pack-size']],
  ['bakery', 'grocery', ['storage']],
  ['frozen', 'grocery', ['pack-size']],
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
