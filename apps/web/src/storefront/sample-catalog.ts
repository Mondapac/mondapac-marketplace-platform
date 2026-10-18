import 'server-only';

// Subcategory of each sample product (codes from the sample category tree in ./sample-home.ts).
// It stands in for the category ids the search route returns per product.
export const SAMPLE_SUBCATEGORY: Readonly<Record<string, string>> = {
  'lamb-shoulder': 'lamb',
  brisket: 'beef',
  'whole-chicken': 'whole-chicken',
  sourdough: 'bread',
  flatbread: 'wraps-and-flatbread',
  croissants: 'pastries',
  basmati: 'rice-and-grains',
  medjool: 'nuts-and-dried-fruit',
  honey: 'honey-and-spreads',
  'olive-oil': 'oils-and-vinegars',
  'coconut-milk': 'canned-goods',
  saffron: 'saffron',
  hummus: 'dips-and-hummus',
  eggs: 'eggs',
  cheese: 'cheese',
  bananas: 'fruit',
  apples: 'fruit',
  oranges: 'fruit',
  watermelon: 'fruit',
  'fruit-box': 'fruit',
};
