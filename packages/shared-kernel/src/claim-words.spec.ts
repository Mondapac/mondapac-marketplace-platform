import * as claimWords from './claim-words';
import { foldForClaims, hasClaimWord, hasLookAlikeScripts } from './claim-words';

const claims = [
  'ḥalāl',
  'hálal',
  'haIaI',
  'ha1al',
  'h.a.l.a.l',
  'h. a. l. a. l.',
  'h a l a l',
  'h/a/l/a/l',
  'h,a,l,a,l',
  'ha-lal',
  'hal al chicken',
  'ha lal chicken',
  'hal‌al',
  'hɑlɑl',
  'hałal',
  'haʟal',
  'ʜᴀʟᴀʟ',
  'h⃝alal',
  'ح ل ا ل',
  'حـلال',
  'zabeeha',
  'dhabiha',
  'Islamic slaughter',
  'شرعی',
  'شرعي',
  'ذبيحة',
  'كوشر',
  'گیاه‌خوار',
  'بی‌گلوتن',
  'وگان',
  'عضوي',
  'Это халяль',
  'кошер',
  'веган',
  'харам',
  'органический',
  'טבעוני',
  'אורגני',
  'gluten free',
  'gluten‐free',
  'gluten‑free',
  'gluten–free',
  'It contains no gluten.',
  'Free from gluten.',
  'Safe for coeliacs.',
  'It is plant-based.',
  'GF bread',
  'vegetarian',
  'Suitable for vegans.',
  'Organically grown.',
  'The beef is koshered.',
  'halals',
  'Kashruth supervised.',
  'It is pareve.',
  'It is Shari’ah compliant.',
  'glatt',
  'non-GMO',
  'h͏alal',
  'kasher',
  'koscher',
  'helal',
  'Bio',
  'Chicken h4l4l',
  'It is k0sher.',
  'It is 0rganic.',
  'It is ve9an.',
  'Lactose-free milk',
  'Это халал.',
  'Это био продукт.',
  'Это органик.',
  'وگن',
  'اسلامی',
  'غلوتین',
  'ökologisch',
  'bersertifikat',
  'végétalien',
  'h al a l',
  'h a la l',
  'k os h er',
  'organi c',
  've6an',
  'cert!fied',
  '100halal',
  'peanut-free',
  'meat-free',
  'non-alcoholic',
  'safe for people with a nut allergy',
  'hypoallergenic',
  'Endorsed by AFIC',
  'ha\u200Clal',
];

describe('claim words', () => {
  it.each(claims)('sees a claim in "%s"', (text) => {
    expect(hasClaimWord(text)).toBe(true);
  });

  it.each([
    'rice',
    'hall',
    'heal',
    'healthy snacks',
    'the Isle of Man',
    'tea bags 100',
    'Halloumi',
  ])('sees none in "%s"', (text) => {
    expect(hasClaimWord(text)).toBe(false);
  });

  it('folds accents and invisible marks', () => {
    expect(foldForClaims('ḥalāl')).toBe('halal');
    expect(foldForClaims('ha​lal')).toBe('halal');
  });

  it('exports no pattern that an importer could alter', () => {
    expect(Object.keys(claimWords).sort()).toEqual([
      'foldForClaims',
      'hasClaimWord',
      'hasLookAlikeScripts',
    ]);
  });
});

describe('look-alike scripts', () => {
  it.each(['Ηalal', 'Нalal', 'ΗΑLΑL', 'ᎻᎪᏞᎪᏞ', 'հalal', 'кosher', 'ѵegan', 'Lamb حلالlamb'])(
    'refuses "%s"',
    (text) => {
      expect(hasLookAlikeScripts(text)).toBe(true);
    },
  );

  it.each([
    'rice',
    'برنج ایرانی',
    'Рис',
    'ρύζι',
    'Basmati 5kg',
    'ארז',
    'Vitamin D 10µg',
    'محصولات Nestlé\u200Cی',
    'Straße',
    'ویتامین C',
    'Рис басмати',
  ])('lets "%s" through', (text) => {
    expect(hasLookAlikeScripts(text)).toBe(false);
  });
});
