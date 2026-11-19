import type { SeededCulture } from '../../application/ports/culture-seed';

/**
 * The cultures of the fixture Market `ZZ`: a different default locale and a culture with no
 * required certification type, so the tests prove the model generic (no halal, no English).
 */
export const ZZ_CULTURES: readonly SeededCulture[] = [
  {
    code: 'zz-default',
    displayOrder: 0,
    requiredCertificationType: null,
    badgeColour: null,
    isDefault: true,
    names: [
      { locale: 'ja-JP', name: 'Everyday community', description: 'The default community of ZZ' },
    ],
  },
];
