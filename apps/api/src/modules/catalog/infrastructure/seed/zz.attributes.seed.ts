import type { SeededDefinition, SeededFamily } from '../../application/ports/attribute-seed';

/**
 * The attributes of the fixture Market `ZZ` (catalog design 7.2): a different material attribute,
 * locale set and option list from any real Market, so the tests prove the model generic.
 */
export const ZZ_ATTRIBUTE_DEFINITIONS: readonly SeededDefinition[] = [
  {
    code: 'brand',
    dataType: 'text',
    localizable: false,
    material: false,
    isVariantOption: false,
    bounds: { maxLength: 80 },
    names: { 'ja-JP': 'Brand', 'en-US': 'Marque' },
    options: [],
  },
  {
    code: 'colour',
    dataType: 'select',
    localizable: false,
    material: false,
    isVariantOption: true,
    bounds: {},
    names: { 'ja-JP': 'Colour', 'en-US': 'Couleur' },
    options: [
      { code: 'red', labels: { 'ja-JP': 'Red', 'en-US': 'Rouge' }, active: true, position: 0 },
      { code: 'green', labels: { 'ja-JP': 'Green', 'en-US': 'Vert' }, active: true, position: 1 },
    ],
  },
  {
    code: 'grade',
    dataType: 'select',
    localizable: false,
    material: true,
    isVariantOption: false,
    bounds: {},
    names: { 'ja-JP': 'Grade', 'en-US': 'Qualité' },
    options: [
      {
        code: 'standard',
        labels: { 'ja-JP': 'Standard', 'en-US': 'Standard' },
        active: true,
        position: 0,
      },
      {
        code: 'premium',
        labels: { 'ja-JP': 'Premium', 'en-US': 'Premium' },
        active: true,
        position: 1,
      },
    ],
  },
  {
    code: 'weight-grams',
    dataType: 'integer',
    localizable: false,
    material: false,
    isVariantOption: false,
    bounds: { min: 1, max: 100000 },
    names: { 'ja-JP': 'Weight in grams', 'en-US': 'Poids en grammes' },
    options: [],
  },
  {
    code: 'description',
    dataType: 'long-text',
    localizable: true,
    material: false,
    isVariantOption: false,
    bounds: { maxLength: 2000 },
    names: { 'ja-JP': 'Description', 'en-US': 'Description' },
    options: [],
  },
];

export const ZZ_ATTRIBUTE_FAMILIES: readonly SeededFamily[] = [
  {
    code: 'default',
    groups: [
      {
        groupCode: 'general',
        attributes: [
          { code: 'brand', required: true, isVariantOption: false },
          { code: 'description', required: true, isVariantOption: false },
        ],
      },
      {
        groupCode: 'details',
        attributes: [
          { code: 'colour', required: false, isVariantOption: true },
          { code: 'grade', required: false, isVariantOption: false },
          { code: 'weight-grams', required: false, isVariantOption: false },
        ],
      },
    ],
  },
];
