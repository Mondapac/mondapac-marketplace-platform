import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeFamily } from './attribute-family';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const entry = (code: string) => ({ code, required: false, isVariantOption: false });
const input = (overrides: Partial<Parameters<typeof AttributeFamily.create>[0]> = {}) => ({
  id: 'f1' as Id<'AttributeFamily'>,
  revisionId: 'fr1' as Id<'AttributeFamilyRevision'>,
  marketId: 'ZZ' as MarketId,
  code: 'default',
  groups: [{ groupCode: 'general', attributes: [entry('brand'), entry('colour')] }],
  createdByKind: 'seed' as const,
  now: NOW,
  ...overrides,
});

describe('AttributeFamily.create', () => {
  it('builds an active family at version 1', () => {
    const result = AttributeFamily.create(input());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({ status: 'active', version: 1, revisionNo: 1 });
  });

  it.each([
    ['a bad family code', { code: 'Default' }, 'attribute-family.code-invalid'],
    [
      'a bad group code',
      { groups: [{ groupCode: '1x', attributes: [] }] },
      'attribute-family.group-invalid',
    ],
    [
      'a repeated group',
      {
        groups: [
          { groupCode: 'g1', attributes: [] },
          { groupCode: 'g1', attributes: [] },
        ],
      },
      'attribute-family.group-repeated',
    ],
    [
      'a bad attribute code',
      { groups: [{ groupCode: 'g1', attributes: [entry('Bad')] }] },
      'attribute-family.attribute-invalid',
    ],
    [
      'an attribute in two groups',
      {
        groups: [
          { groupCode: 'g1', attributes: [entry('brand')] },
          { groupCode: 'g2', attributes: [entry('brand')] },
        ],
      },
      'attribute-family.attribute-repeated',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    const result = AttributeFamily.create(input(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});

describe('AttributeFamily written by an admin (attributes A4)', () => {
  const group = (
    groupCode: string,
    attributes: readonly { code: string; level: 'required' | 'recommended' | 'optional' }[],
  ) => ({
    groupCode,
    names: { 'en-AU': groupCode },
    attributes: attributes.map(({ code, level }) => ({
      code,
      level,
      required: level === 'required',
      isVariantOption: false,
    })),
  });
  const core = () =>
    group('core', [
      { code: 'brand', level: 'required' },
      { code: 'country-of-origin', level: 'optional' },
    ]);
  const content = (
    overrides: Partial<Parameters<typeof AttributeFamily.createByAdmin>[0]['content']> = {},
  ) => ({
    names: { 'en-AU': 'Pantry' },
    groups: [core(), group('details', [{ code: 'pack-size', level: 'recommended' }])],
    ...overrides,
  });
  const make = (c = content()) =>
    AttributeFamily.createByAdmin({
      id: 'f1' as Id<'AttributeFamily'>,
      revisionId: 'fr1' as Id<'AttributeFamilyRevision'>,
      marketId: 'AU' as MarketId,
      code: 'pantry',
      content: c,
      defaultLocale: 'en-AU',
      now: NOW,
    });

  it('builds an active admin family at version 1 with its names', () => {
    const result = make();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      status: 'active',
      createdByKind: 'admin',
      version: 1,
      revisionNo: 1,
      names: { 'en-AU': 'Pantry' },
    });
  });

  it.each([
    [
      'no default-locale name',
      { names: { 'fa-IR': 'x' } },
      'attribute-family.default-name-required',
    ],
    [
      'an invisible character in a name',
      { names: { 'en-AU': 'Pan​try' } },
      'attribute-family.text-invalid',
    ],
    ['a bad locale', { names: { 'en-AU': 'P', EN: 'x' } }, 'attribute-family.locale-invalid'],
    ['no groups', { groups: [] }, 'attribute-family.too-many'],
    [
      'a group without a default-locale name',
      { groups: [core(), { ...group('d', []), names: {} }] },
      'attribute-family.default-name-required',
    ],
    [
      'the Core group not first',
      { groups: [group('details', []), core()] },
      'attribute-family.core-invalid',
    ],
    [
      'a Core group missing the country',
      { groups: [group('core', [{ code: 'brand', level: 'required' }])] },
      'attribute-family.core-invalid',
    ],
    [
      'a brand that is not required',
      {
        groups: [
          group('core', [
            { code: 'brand', level: 'recommended' },
            { code: 'country-of-origin', level: 'optional' },
          ]),
        ],
      },
      'attribute-family.core-invalid',
    ],
    [
      'a code in two groups',
      { groups: [core(), group('d', [{ code: 'brand', level: 'optional' }])] },
      'attribute-family.attribute-repeated',
    ],
    [
      'a level that disagrees with the required flag',
      {
        groups: [
          core(),
          {
            ...group('d', []),
            attributes: [
              { code: 'x', level: 'optional' as const, required: true, isVariantOption: false },
            ],
          },
        ],
      },
      'attribute-family.level-invalid',
    ],
  ])('refuses %s', (_name, overrides, code) => {
    const result = make(content(overrides));
    expect(result.ok ? 'ok' : result.error.code).toBe(code);
  });

  it('revises into the next revision and refuses an archived family', () => {
    const created = make();
    if (!created.ok) throw new Error(created.error.code);
    const revised = created.value.revise({
      revisionId: 'fr2' as Id<'AttributeFamilyRevision'>,
      content: content({ names: { 'en-AU': 'Pantry goods' } }),
      defaultLocale: 'en-AU',
    });
    if (!revised.ok) throw new Error(revised.error.code);
    expect(revised.value.state).toMatchObject({ version: 2, revisionNo: 2, code: 'pantry' });
    expect(created.value.state.version).toBe(1);

    const archived = AttributeFamily.rehydrate({ ...created.value.state, status: 'archived' });
    const refused = archived.revise({
      revisionId: 'fr3' as Id<'AttributeFamilyRevision'>,
      content: content(),
      defaultLocale: 'en-AU',
    });
    expect(refused.ok ? 'ok' : refused.error.code).toBe('attribute-family.archived');
  });
});
