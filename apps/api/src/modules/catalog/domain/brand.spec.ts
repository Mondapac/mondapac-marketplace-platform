import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  aliasForMergedName,
  azLetterOf,
  Brand,
  brandNameKey,
  brandValueOf,
  groupBrandsAZ,
  isBrandSlug,
  parseBrandContent,
  sameBrandSpelling,
  suggestBrandSlug,
  tidyBrandName,
  type BrandContent,
} from './brand';

// The brand domain is Market-agnostic by design: a brand is shared by every Market and carries no
// Market, currency, tax or locale, so there is no per-Market behaviour to fix. The two Market
// fixtures are exercised where a Market matters (the HTTP and database specs of the brand package).

const T0 = Temporal.Instant.from('2026-10-28T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-28T01:00:00Z');
const brandId = (n: number) => `brand-${n}` as Id<'Brand'>;
const admin = 'admin-1' as Id<'Account'>;
const seller = 'seller-1' as Id<'Seller'>;

const content = (overrides: Partial<BrandContent> = {}): BrandContent => ({
  name: 'Fuji & Co.',
  summary: null,
  originCountry: null,
  logoImageId: null,
  logoAlt: null,
  headerImageId: null,
  ...overrides,
});

function active(n = 1, name = 'Fuji & Co.'): Brand {
  const created = Brand.create({
    id: brandId(n),
    content: content({ name }),
    slug: suggestBrandSlug(name),
    origin: { kind: 'admin', accountId: admin },
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return Brand.restore(created.value.state);
}

function draft(n = 1, name = 'Fuji & Co.'): Brand {
  const created = Brand.create({
    id: brandId(n),
    content: content({ name }),
    slug: suggestBrandSlug(name),
    origin: { kind: 'seller', sellerId: seller },
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return Brand.restore(created.value.state);
}

describe('brand names and keys', () => {
  it('tidies a name: trims the ends and folds inner whitespace', () => {
    expect(tidyBrandName('  Fuji \t  Foods \n')).toBe('Fuji Foods');
  });

  it.each([
    ['Fuji & Co.', 'Fuji and Co', 'FUJI AND CO', 'fuji-and-co', ' Fuji&Co '],
    ['A.B.C', 'abc', 'ABC', 'A B C', 'a-b-c'],
  ])('gives near-duplicates one key: %s', (...names) => {
    const keys = new Set(names.map(brandNameKey));
    expect(keys.size).toBe(1);
  });

  it('keeps different brands apart and keeps non-Latin letters', () => {
    expect(brandNameKey('Acme')).not.toBe(brandNameKey('Acne'));
    expect(brandNameKey('Johnson & Johnson')).toBe('johnsonandjohnson');
    expect(brandNameKey('مندا')).toBe('مندا');
    expect(brandNameKey('!!! -')).toBe('');
  });

  it('suggests an ASCII slug within the limit, without accents or edge hyphens', () => {
    expect(suggestBrandSlug('Fuji & Co.')).toBe('fuji-co');
    expect(suggestBrandSlug('Café Crème')).toBe('cafe-creme');
    expect(suggestBrandSlug('---')).toBe('brand');
    expect(suggestBrandSlug('مندا')).toBe('brand');
    const long = suggestBrandSlug(`${'abcde '.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(70);
    expect(isBrandSlug(long)).toBe(true);
    expect(long.endsWith('-')).toBe(false);
  });

  it.each([
    ['acme', true],
    ['acme-2', true],
    ['a1-b2-c3', true],
    ['Acme', false],
    ['acme-', false],
    ['-acme', false],
    ['ac--me', false],
    ['ac me', false],
    ['', false],
    ['a'.repeat(81), false],
  ])('judges the slug %j valid: %s', (slug, valid) => {
    expect(isBrandSlug(slug)).toBe(valid);
  });

  it('compares spellings apart from case and edge spaces', () => {
    expect(sameBrandSpelling(' Acme ', 'ACME')).toBe(true);
    expect(sameBrandSpelling('Acme', 'Acme Foods')).toBe(false);
  });

  it('reads the brand attribute text of a revision, only when it is plain text', () => {
    expect(brandValueOf({ brand: '  Acme  Foods ' })).toBe('Acme Foods');
    expect(brandValueOf({ brand: '   ' })).toBeNull();
    expect(brandValueOf({ brand: { 'en-AU': 'Acme' } })).toBeNull();
    expect(brandValueOf({ colour: 'red' })).toBeNull();
  });
});

describe('parseBrandContent', () => {
  it('accepts a minimal brand and a full one', () => {
    expect(parseBrandContent({ name: ' Acme ' })).toEqual({
      ok: true,
      value: {
        name: 'Acme',
        summary: null,
        originCountry: null,
        logoImageId: null,
        logoAlt: null,
        headerImageId: null,
      },
    });
    const logo = '01990000-0000-7000-8000-00000000a001';
    const header = '01990000-0000-7000-8000-00000000a002';
    expect(
      parseBrandContent({
        name: 'Acme',
        summary: 'Makers of anvils.',
        originCountry: 'JP',
        logoImageId: logo,
        logoAlt: 'The Acme anvil',
        headerImageId: header,
      }),
    ).toMatchObject({ ok: true, value: { originCountry: 'JP', logoImageId: logo } });
  });

  it('reports every problem at once, with stable codes', () => {
    const result = parseBrandContent({
      name: '   ',
      summary: 'x'.repeat(1001),
      originCountry: 'jp',
      logoImageId: 'nope',
      headerImageId: 5,
    });
    expect(result).toEqual({
      ok: false,
      error: [
        { path: 'name', code: 'required' },
        { path: 'summary', code: 'too-long' },
        { path: 'originCountry', code: 'format' },
        { path: 'logoImageId', code: 'format' },
        { path: 'headerImageId', code: 'format' },
      ],
    });
  });

  it.each([
    [{ name: 'x'.repeat(121) }, 'too-long'],
    [{ name: 'Ac​me' }, 'chars'],
    [{ name: '!!!' }, 'no-letters'],
    [{ name: 5 }, 'required'],
  ])('refuses the name %j', (input, code) => {
    expect(parseBrandContent(input)).toEqual({ ok: false, error: [{ path: 'name', code }] });
  });

  it('ties a logo to its alt text, both ways', () => {
    const logo = '01990000-0000-7000-8000-00000000a001';
    expect(parseBrandContent({ name: 'Acme', logoImageId: logo })).toEqual({
      ok: false,
      error: [{ path: 'logoAlt', code: 'required' }],
    });
    expect(parseBrandContent({ name: 'Acme', logoAlt: 'A logo' })).toEqual({
      ok: false,
      error: [{ path: 'logoAlt', code: 'no-logo' }],
    });
  });
});

describe('Brand creation and status transitions', () => {
  it('creates an admin brand active and records the admin as approver', () => {
    const brand = active();
    expect(brand.state).toMatchObject({
      status: 'active',
      approvedBy: admin,
      proposedBySellerId: null,
      nameKey: 'fujiandco',
      version: 1,
      mergedIntoId: null,
    });
    expect(brand.hasChanges).toBe(false);
  });

  it("creates a seller's proposal as an unapproved draft", () => {
    expect(draft().state).toMatchObject({
      status: 'draft',
      approvedBy: null,
      proposedBySellerId: seller,
    });
  });

  it('refuses a slug that is not a slug', () => {
    expect(
      Brand.create({
        id: brandId(1),
        content: content(),
        slug: 'Not A Slug',
        origin: { kind: 'admin', accountId: admin },
        now: T0,
      }),
    ).toEqual({ ok: false, error: { code: 'brand.slug-invalid' } });
  });

  it('approves a draft once: draft to active, by an admin', () => {
    const approved = draft().approve({ accountId: admin, now: T1 });
    if (!approved.ok) throw new Error(approved.error.code);
    expect(approved.value.state).toMatchObject({
      status: 'active',
      approvedBy: admin,
      version: 2,
      updatedAt: T1,
    });
    expect(approved.value.hasChanges).toBe(true);
    expect(approved.value.persistedVersion).toBe(1);
    expect(approved.value.approve({ accountId: admin, now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.not-draft' },
    });
    expect(active().approve({ accountId: admin, now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.not-draft' },
    });
  });

  it('archives a draft or an active brand, and an archived brand is final', () => {
    for (const brand of [draft(), active()]) {
      const archived = brand.archive({ now: T1 });
      if (!archived.ok) throw new Error(archived.error.code);
      expect(archived.value.state.status).toBe('archived');
      expect(archived.value.archive({ now: T1 })).toEqual({
        ok: false,
        error: { code: 'brand.already-archived' },
      });
      expect(archived.value.approve({ accountId: admin, now: T1 })).toEqual({
        ok: false,
        error: { code: 'brand.not-draft' },
      });
      expect(archived.value.edit({ content: content(), now: T1 })).toEqual({
        ok: false,
        error: { code: 'brand.archived' },
      });
    }
  });

  it('does not change the original when a command returns the next state', () => {
    const brand = active();
    brand.archive({ now: T1 });
    expect(brand.state.status).toBe('active');
    expect(brand.state.version).toBe(1);
  });
});

describe('Brand edit', () => {
  it('replaces the content, recomputes the name key and raises the version', () => {
    const edited = active().edit({
      content: content({ name: 'Fuji Foods', summary: 'Rice.', originCountry: 'JP' }),
      now: T1,
    });
    if (!edited.ok) throw new Error(edited.error.code);
    expect(edited.value.state).toMatchObject({
      name: 'Fuji Foods',
      nameKey: 'fujifoods',
      summary: 'Rice.',
      originCountry: 'JP',
      slug: 'fuji-co',
      version: 2,
    });
  });

  it('changes the slug of a draft only: a public URL stays', () => {
    const asDraft = draft().edit({ content: content(), slug: 'fuji-foods', now: T1 });
    expect(asDraft.ok && asDraft.value.state.slug).toBe('fuji-foods');
    expect(active().edit({ content: content(), slug: 'fuji-foods', now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.slug-locked' },
    });
    // The same slug again is not a change.
    expect(active().edit({ content: content(), slug: 'fuji-co', now: T1 }).ok).toBe(true);
    expect(draft().edit({ content: content(), slug: 'Bad Slug', now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.slug-invalid' },
    });
  });
});

describe('Brand merge rules', () => {
  const target = (n = 2) => active(n, 'Fuji Foods');

  it('archives the source into an active target and records where it went', () => {
    const merged = active(1).mergeInto({ target: target().state, now: T1 });
    if (!merged.ok) throw new Error(merged.error.code);
    expect(merged.value.state).toMatchObject({
      status: 'archived',
      mergedIntoId: brandId(2),
      version: 2,
    });
  });

  it('merges a draft proposal into an active brand too', () => {
    const merged = draft(1).mergeInto({ target: target().state, now: T1 });
    expect(merged.ok && merged.value.state.status).toBe('archived');
  });

  it('refuses a brand merged into itself', () => {
    const brand = active(1);
    expect(brand.mergeInto({ target: brand.state, now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.merge-into-itself' },
    });
  });

  it('refuses a target that is a draft or archived', () => {
    const archivedTarget = target().archive({ now: T1 });
    if (!archivedTarget.ok) throw new Error('archive');
    for (const refused of [draft(2).state, archivedTarget.value.state]) {
      expect(active(1).mergeInto({ target: refused, now: T1 })).toEqual({
        ok: false,
        error: { code: 'brand.merge-target-not-active' },
      });
    }
  });

  it('refuses an archived source, unless it was already merged into this same target', () => {
    const archived = active(1).archive({ now: T1 });
    if (!archived.ok) throw new Error('archive');
    expect(archived.value.mergeInto({ target: target().state, now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.merge-source-archived' },
    });

    const merged = active(1).mergeInto({ target: target(2).state, now: T1 });
    if (!merged.ok) throw new Error('merge');
    const stored = Brand.restore(merged.value.state);
    // A repeat for another Market's products: allowed, and it changes nothing about the source.
    const again = stored.mergeInto({ target: target(2).state, now: T1 });
    expect(again.ok && again.value.hasChanges).toBe(false);
    // Another target is a different merge.
    expect(stored.mergeInto({ target: target(3).state, now: T1 })).toEqual({
      ok: false,
      error: { code: 'brand.merge-source-archived' },
    });
  });

  it('keeps the source name as an alias unless the target already has that spelling', () => {
    expect(aliasForMergedName('ACME', 'Acme Foods')).toBe('ACME');
    expect(aliasForMergedName('ACME', 'Acme')).toBeNull();
    expect(aliasForMergedName(' acme ', 'ACME')).toBeNull();
  });
});

describe('the A to Z grouping', () => {
  it.each([
    ['Acme', 'A'],
    ['  zeta', 'Z'],
    ['Éclair', 'E'],
    ['"Quoted" brand', 'Q'],
    ['7-Eleven', '#'],
    ['مندا', '#'],
    ['', '#'],
  ])('puts %j in section %s', (name, letter) => {
    expect(azLetterOf(name)).toBe(letter);
  });

  it('sorts sections A to Z then #, and brands by name without regard to case', () => {
    const brands = [
      { name: 'zeta', slug: 'zeta' },
      { name: '7-Eleven', slug: '7-eleven' },
      { name: 'acme', slug: 'acme-2' },
      { name: 'Acme', slug: 'acme' },
      { name: 'Bravo', slug: 'bravo' },
      { name: 'Ábaco', slug: 'abaco' },
    ];
    const grouped = groupBrandsAZ(brands);
    expect(grouped.map((section) => section.letter)).toEqual(['A', 'B', 'Z', '#']);
    expect(grouped[0]!.brands.map((brand) => brand.slug)).toEqual(['abaco', 'acme', 'acme-2']);
  });

  it('is empty for no brand', () => {
    expect(groupBrandsAZ([])).toEqual([]);
  });
});
