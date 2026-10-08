import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { PlatformCategory } from './platform-category';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const input = (overrides: Partial<Parameters<typeof PlatformCategory.create>[0]> = {}) => ({
  id: 'c1' as Id<'Category'>,
  revisionId: 'r1' as Id<'CategoryRevision'>,
  marketId: 'ZZ' as MarketId,
  parentId: null,
  verticalRootCode: null,
  slug: 'garden-tools',
  names: [{ locale: 'xx', name: 'Garden tools' }],
  createdByKind: 'seed' as const,
  now: NOW,
  ...overrides,
});

describe('PlatformCategory.create', () => {
  it('builds an active category at version 1 with revision 1 and one created event', () => {
    const result = PlatformCategory.create(input());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      status: 'active',
      version: 1,
      revisionNo: 1,
      createdByKind: 'seed',
    });
    expect(result.value.pendingEvents.map((event) => [event.type, event.aggregateVersion])).toEqual(
      [['catalog.platform-category-created.v1', 1]],
    );
    expect(result.value.pendingEvents[0]?.payload).toEqual({ categoryId: 'c1' });
  });

  it.each([
    ['an upper-case slug', { slug: 'Garden' }, 'category.slug-invalid'],
    ['a one-letter slug', { slug: 'g' }, 'category.slug-invalid'],
    ['a double hyphen', { slug: 'a--b' }, 'category.slug-invalid'],
    ['a slug over 80 characters', { slug: 'a'.repeat(81) }, 'category.slug-invalid'],
    ['no name', { names: [] }, 'category.name-required'],
    [
      'a repeated locale',
      {
        names: [
          { locale: 'xx', name: 'A' },
          { locale: 'xx', name: 'B' },
        ],
      },
      'category.locale-repeated',
    ],
    ['a malformed locale', { names: [{ locale: 'XX', name: 'A' }] }, 'category.locale-invalid'],
    ['outer spaces', { names: [{ locale: 'xx', name: ' A' }] }, 'category.name-invalid'],
    ['an empty name', { names: [{ locale: 'xx', name: '' }] }, 'category.name-invalid'],
    ['a bidi control', { names: [{ locale: 'xx', name: 'A‮B' }] }, 'category.name-invalid'],
    [
      'a name over 120 characters',
      { names: [{ locale: 'xx', name: 'x'.repeat(121) }] },
      'category.name-invalid',
    ],
    [
      'a vertical marker below a root',
      { parentId: 'p' as Id<'Category'>, verticalRootCode: 'outdoor' },
      'category.vertical-root-needs-root',
    ],
    [
      'a malformed vertical marker',
      { verticalRootCode: 'Outdoor' },
      'category.vertical-root-code-invalid',
    ],
  ])('refuses %s', (_case, overrides, code) => {
    const result = PlatformCategory.create(input(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });

  it('accepts a zero-width non-joiner between Arabic-script letters', () => {
    const result = PlatformCategory.create(input({ names: [{ locale: 'fa', name: 'نیم‌فاصله' }] }));
    expect(result.ok).toBe(true);
  });
});
