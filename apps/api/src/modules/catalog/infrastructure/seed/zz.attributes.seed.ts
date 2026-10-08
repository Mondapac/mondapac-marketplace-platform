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
    names: { xx: 'Brand', yy: 'Marque' },
    options: [],
  },
  {
    code: 'colour',
    dataType: 'select',
    localizable: false,
    material: false,
    isVariantOption: true,
    bounds: {},
    names: { xx: 'Colour', yy: 'Couleur' },
    options: [
      { code: 'red', labels: { xx: 'Red', yy: 'Rouge' }, active: true, position: 0 },
      { code: 'green', labels: { xx: 'Green', yy: 'Vert' }, active: true, position: 1 },
    ],
  },
  {
    code: 'grade',
    dataType: 'select',
    localizable: false,
    material: true,
    isVariantOption: false,
    bounds: {},
    names: { xx: 'Grade', yy: 'Qualité' },
    options: [
      { code: 'standard', labels: { xx: 'Standard', yy: 'Standard' }, active: true, position: 0 },
      { code: 'premium', labels: { xx: 'Premium', yy: 'Premium' }, active: true, position: 1 },
    ],
  },
  {
    code: 'weight-grams',
    dataType: 'integer',
    localizable: false,
    material: false,
    isVariantOption: false,
    bounds: { min: 1, max: 100000 },
    names: { xx: 'Weight in grams', yy: 'Poids en grammes' },
    options: [],
  },
  {
    code: 'description',
    dataType: 'long-text',
    localizable: true,
    material: false,
    isVariantOption: false,
    bounds: { maxLength: 2000 },
    names: { xx: 'Description', yy: 'Description' },
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
