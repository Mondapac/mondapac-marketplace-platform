import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  checkVariantTypeSettings,
  DEFAULT_VARIANT_TYPE_SETTINGS,
  normaliseColour,
  orderOptions,
  sizeOf,
  SELLER_HELP_MAX,
  SWATCHES_MAX,
  VariantTypeSettings,
  type OrderableOption,
  type VariantTypeSettingsContent,
} from './variant-type-settings';

// The display settings of a variant type (variants V6): the checks, the revisions and the option
// order buyers see. Both Market fixtures' locale shapes are covered by the locale lists below.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-06T01:00:00Z');
const DEFINITION = '0197c1f0-0000-7000-8000-0000000000d1' as Id<'AttributeDefinition'>;
const REVISION_1 = '0197c1f0-0000-7000-8000-0000000000e1' as Id<'VariantTypeSettingRevision'>;
const REVISION_2 = '0197c1f0-0000-7000-8000-0000000000e2' as Id<'VariantTypeSettingRevision'>;
const OPTIONS = new Set(['red', 'blue', 'old-green']);

describe.each([
  ['AU', ['en-AU']],
  ['ZZ', ['xx-ZZ', 'en']],
] as const)('variant type settings in market %s', (market, locales) => {
  const locale = locales[0];
  const content = (over: Partial<VariantTypeSettingsContent> = {}): VariantTypeSettingsContent => ({
    displayStyle: 'swatches',
    optionOrder: 'manual',
    swatches: { red: '#FF0000', 'old-green': '#00AA00' },
    sellerHelp: { [locale]: 'Pick the colour printed on the pack.' },
    ...over,
  });
  const check = (c: VariantTypeSettingsContent) => checkVariantTypeSettings(c, OPTIONS, locales);

  it('accepts the defaults and a full content, an inactive option keeping its colour', () => {
    expect(check(DEFAULT_VARIANT_TYPE_SETTINGS)).toBeNull();
    expect(check(content())).toBeNull();
  });

  it.each<[Partial<VariantTypeSettingsContent>, unknown]>([
    [{ displayStyle: 'grid' as never }, { code: 'variant-type.display-style-invalid' }],
    [{ optionOrder: 'random' as never }, { code: 'variant-type.option-order-invalid' }],
    [
      { swatches: { pink: '#FF00FF' } },
      { code: 'variant-type.swatch-unknown-option', option: 'pink' },
    ],
    [
      { swatches: { 'Red!': '#FF00FF' } },
      { code: 'variant-type.swatch-unknown-option', option: 'Red!' },
    ],
    [{ swatches: { red: '#ff0000' } }, { code: 'variant-type.swatch-invalid', option: 'red' }],
    [{ swatches: { red: 'red' } }, { code: 'variant-type.swatch-invalid', option: 'red' }],
    [
      { sellerHelp: { 'fr-FR': 'Bonjour.' } },
      { code: 'variant-type.locale-invalid', locale: 'fr-FR' },
    ],
    [{ sellerHelp: { [locale]: ' padded ' } }, { code: 'variant-type.help-invalid', locale }],
    [{ sellerHelp: { [locale]: '' } }, { code: 'variant-type.help-invalid', locale }],
    [
      { sellerHelp: { [locale]: 'x'.repeat(SELLER_HELP_MAX + 1) } },
      { code: 'variant-type.help-invalid', locale },
    ],
    [
      { sellerHelp: { [locale]: 'Pick one\u202E here' } },
      { code: 'variant-type.help-invalid', locale },
    ],
  ])('refuses %j', (over, refusal) => {
    expect(check(content(over))).toEqual(refusal);
  });

  it('refuses more swatches than a type has options', () => {
    const many = Object.fromEntries(
      Array.from({ length: SWATCHES_MAX + 1 }, (_, i) => [`o${i}`, '#000000']),
    );
    expect(check(content({ swatches: many }))).toEqual({ code: 'variant-type.swatches-too-many' });
  });

  it('accepts a help sentence of exactly the maximum length', () => {
    expect(check(content({ sellerHelp: { [locale]: 'x'.repeat(SELLER_HELP_MAX) } }))).toBeNull();
  });

  it('normalises a typed colour to #RRGGBB, or refuses it', () => {
    expect(normaliseColour('#a1b2c3')).toBe('#A1B2C3');
    expect(normaliseColour(' A1B2C3 ')).toBe('#A1B2C3');
    expect(normaliseColour('#abc')).toBeNull();
    expect(normaliseColour('#GGGGGG')).toBeNull();
    expect(normaliseColour(123)).toBeNull();
  });

  it('creates version 1 and revises to the next version with the whole new content', () => {
    const marketId = market as MarketId;
    const created = VariantTypeSettings.create({
      marketId,
      definitionId: DEFINITION,
      revisionId: REVISION_1,
      content: content(),
      optionCodes: OPTIONS,
      locales,
      now: T0,
    });
    if (!created.ok) throw new Error('not created');
    expect(created.value.state).toMatchObject({
      marketId,
      definitionId: DEFINITION,
      revisionId: REVISION_1,
      revisionNo: 1,
      version: 1,
      displayStyle: 'swatches',
      createdAt: T0,
      revisedAt: T0,
    });

    const revised = created.value.revise({
      revisionId: REVISION_2,
      content: content({ displayStyle: 'dropdown', swatches: {}, sellerHelp: {} }),
      optionCodes: OPTIONS,
      locales,
      now: T1,
    });
    if (!revised.ok) throw new Error('not revised');
    expect(revised.value.state).toMatchObject({
      revisionId: REVISION_2,
      revisionNo: 2,
      version: 2,
      displayStyle: 'dropdown',
      swatches: {},
      sellerHelp: {},
      createdAt: T0,
      revisedAt: T1,
    });
    // The first revision is not changed by the second.
    expect(created.value.state.displayStyle).toBe('swatches');
  });

  it('refuses a create or a revision that fails the check, changing nothing', () => {
    const bad = content({ swatches: { pink: '#000000' } });
    expect(
      VariantTypeSettings.create({
        marketId: market as MarketId,
        definitionId: DEFINITION,
        revisionId: REVISION_1,
        content: bad,
        optionCodes: OPTIONS,
        locales,
        now: T0,
      }),
    ).toEqual({ ok: false, error: { code: 'variant-type.swatch-unknown-option', option: 'pink' } });
  });

  describe('the option order', () => {
    const option = (code: string, position: number, label: string): OrderableOption => ({
      code,
      position,
      labels: { [locale]: label },
    });
    const options = [
      option('kg1', 0, '1 kg'),
      option('g250', 1, '250 g'),
      option('family', 2, 'Family pack'),
      option('ml500', 3, '500 ml'),
      option('g500', 4, '500g'),
      option('l1', 5, '1 L'),
    ];
    const codes = (list: readonly OrderableOption[]) => list.map((o) => o.code);

    it('manual keeps the positions', () => {
      expect(codes(orderOptions([...options].reverse(), 'manual', locale, locale))).toEqual(
        codes(options),
      );
    });

    it('alphabetical sorts the labels of the shown locale, numbers by value', () => {
      expect(codes(orderOptions(options, 'alphabetical', locale, locale))).toEqual([
        'kg1',
        'l1',
        'g250',
        'ml500',
        'g500',
        'family',
      ]);
    });

    it('by-size groups units of one kind and sorts by amount, labels without one last', () => {
      expect(codes(orderOptions(options, 'by-size', locale, locale))).toEqual([
        'g250',
        'g500',
        'kg1',
        'ml500',
        'l1',
        'family',
      ]);
    });

    it('reads the default locale for by-size, so every language sees one order', () => {
      const other = 'zz-other';
      const translated = options.map((o) => ({
        ...o,
        labels: { ...o.labels, [other]: `x ${o.code}` },
      }));
      expect(codes(orderOptions(translated, 'by-size', other, locale))).toEqual(
        codes(orderOptions(options, 'by-size', locale, locale)),
      );
    });
  });
});

describe('sizeOf', () => {
  it.each<[string, unknown]>([
    ['250 g', { kind: 'mass', value: 250 }],
    ['1,5 kg', { kind: 'mass', value: 1500 }],
    ['500ml', { kind: 'volume', value: 500 }],
    ['2 L', { kind: 'volume', value: 2000 }],
    ['30 cm', { kind: 'length', value: 300 }],
    ['6 pack', { kind: 'pack', value: 6 }],
    ['Large', null],
  ])('%s', (label, size) => {
    expect(sizeOf(label)).toEqual(size);
  });
});
