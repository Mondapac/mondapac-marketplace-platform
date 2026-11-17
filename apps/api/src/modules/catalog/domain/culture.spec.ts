import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  editCulture,
  isCultureNamePublished,
  newCulture,
  parseBadgeColour,
  parseCultureContent,
  parseDisplayOrder,
  parseRequiredCertificationType,
  type CultureState,
} from './culture';

const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-11T01:00:00Z');
const locales = { required: 'en', supported: ['en', 'ar', 'fa'] };

const base = (overrides: Partial<CultureState> = {}): CultureState => ({
  ...newCulture({
    id: 'c1' as Id<'Culture'>,
    code: 'some-culture',
    content: { names: [{ locale: 'en', name: 'Some', description: 'About' }] },
    displayOrder: 0,
    requiredCertificationType: null,
    badgeColour: null,
    createdBy: 'a1' as Id<'Account'>,
    now: T0,
  }),
  ...overrides,
});

describe('parseCultureContent', () => {
  it('accepts English with both fields and a partial other locale', () => {
    const parsed = parseCultureContent(
      { names: { en: { name: ' Some  culture ', description: 'About' }, ar: { name: 'س' } } },
      locales,
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        names: [
          { locale: 'ar', name: 'س', description: null },
          { locale: 'en', name: 'Some culture', description: 'About' },
        ],
      },
    });
    if (parsed.ok) {
      expect(parsed.value.names.map(isCultureNamePublished)).toEqual([false, true]);
    }
  });

  it('requires the name and the description in the required locale', () => {
    expect(parseCultureContent({ names: { ar: { name: 'س' } } }, locales)).toEqual({
      ok: false,
      error: [{ path: 'names.en.name', code: 'required' }],
    });
    expect(parseCultureContent({ names: { en: { name: 'Some' } } }, locales)).toEqual({
      ok: false,
      error: [{ path: 'names.en.description', code: 'required' }],
    });
  });

  it('judges every field and reports the problems together', () => {
    const parsed = parseCultureContent(
      {
        names: {
          en: { name: 'x'.repeat(81), description: 'ok', extra: 1 },
          xx: { name: 'N' },
          fa: { description: 'only a description' },
          ar: 'text',
        },
      },
      locales,
    );
    expect(parsed).toEqual({
      ok: false,
      error: [
        { path: 'names.ar', code: 'type' },
        { path: 'names.en.extra', code: 'unknown' },
        { path: 'names.en.name', code: 'too-long' },
        { path: 'names.fa.name', code: 'required' },
        { path: 'names.xx', code: 'locale-unsupported' },
      ],
    });
  });

  it('refuses control characters and a non-object', () => {
    expect(
      parseCultureContent({ names: { en: { name: 'a\u0000b', description: 'd' } } }, locales),
    ).toEqual({ ok: false, error: [{ path: 'names.en.name', code: 'chars' }] });
    expect(parseCultureContent({ names: [] }, locales)).toEqual({
      ok: false,
      error: [{ path: 'names', code: 'type' }],
    });
  });
});

describe('scalar parsers', () => {
  it('validates order, badge colour token and certification type shape', () => {
    expect(parseDisplayOrder(3).ok).toBe(true);
    expect(parseDisplayOrder(-1).ok).toBe(false);
    expect(parseDisplayOrder(1.5).ok).toBe(false);
    expect(parseBadgeColour(null)).toEqual({ ok: true, value: null });
    expect(parseBadgeColour('brand-green').ok).toBe(true);
    expect(parseBadgeColour('#fff').ok).toBe(false);
    expect(parseRequiredCertificationType('halal').ok).toBe(true);
    expect(parseRequiredCertificationType('Halal!').ok).toBe(false);
  });
});

describe('newCulture', () => {
  it('starts as a draft at version 1 and not the default', () => {
    expect(base()).toMatchObject({ status: 'draft', isDefault: false, version: 1 });
  });
});

describe('editCulture', () => {
  it('keeps the code and changes only what is given', () => {
    const result = editCulture(base(), { displayOrder: 4, badgeColour: 'accent' }, T1);
    expect(result).toMatchObject({
      ok: true,
      value: {
        code: 'some-culture',
        displayOrder: 4,
        badgeColour: 'accent',
        version: 2,
        updatedAt: T1,
      },
    });
  });

  it('clears the badge and the required type with null, keeps them when left out', () => {
    const state = base({ badgeColour: 'accent', requiredCertificationType: 'halal' });
    const kept = editCulture(state, { displayOrder: 1 }, T1);
    const cleared = editCulture(state, { badgeColour: null, requiredCertificationType: null }, T1);
    expect(kept).toMatchObject({
      value: { badgeColour: 'accent', requiredCertificationType: 'halal' },
    });
    expect(cleared).toMatchObject({
      value: { badgeColour: null, requiredCertificationType: null },
    });
  });

  it('moves draft to active, active to inactive and back, never back to draft', () => {
    expect(editCulture(base(), { status: 'active' }, T1)).toMatchObject({ ok: true });
    expect(editCulture(base({ status: 'active' }), { status: 'inactive' }, T1)).toMatchObject({
      ok: true,
    });
    expect(editCulture(base({ status: 'inactive' }), { status: 'active' }, T1)).toMatchObject({
      ok: true,
    });
    expect(editCulture(base({ status: 'active' }), { status: 'draft' }, T1)).toEqual({
      ok: false,
      error: 'culture.status-transition',
    });
    expect(editCulture(base(), { status: 'inactive' }, T1)).toEqual({
      ok: false,
      error: 'culture.status-transition',
    });
  });

  it('cannot make the default culture inactive or unmark it', () => {
    const def = base({ status: 'active', isDefault: true });
    expect(editCulture(def, { status: 'inactive' }, T1)).toEqual({
      ok: false,
      error: 'culture.default-must-stay-active',
    });
    expect(editCulture(def, { isDefault: false }, T1)).toEqual({
      ok: false,
      error: 'culture.default-required',
    });
    expect(editCulture(def, { isDefault: true, displayOrder: 2 }, T1)).toMatchObject({ ok: true });
  });

  it('makes only an active culture the default (also in the same edit)', () => {
    expect(editCulture(base(), { isDefault: true }, T1)).toEqual({
      ok: false,
      error: 'culture.default-must-be-active',
    });
    expect(editCulture(base(), { isDefault: true, status: 'active' }, T1)).toMatchObject({
      ok: true,
      value: { isDefault: true, status: 'active' },
    });
    expect(editCulture(base({ status: 'inactive' }), { isDefault: true }, T1)).toMatchObject({
      ok: false,
    });
  });
});
