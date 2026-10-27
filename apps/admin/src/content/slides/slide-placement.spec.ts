import { describe, expect, it } from 'vitest';
import {
  clearErrors,
  hasErrors,
  liveCounts,
  mapPlacementProblems,
  placementFormOf,
  placementRequestOf,
  placementsOf,
  samePlacementForm,
  validatePlacement,
  windowError,
  type PlacementFormState,
} from './slide-placement.ts';
import { CATEGORY, ID, detail, summary, version } from './test-data.ts';

const ZONE = 'Australia/Brisbane';
const edited = (patch: Partial<PlacementFormState>): PlacementFormState => ({
  ...placementFormOf(detail(), ZONE),
  ...patch,
});
const withRow = (
  form: PlacementFormState,
  key: string,
  patch: Partial<PlacementFormState['rows'][string]>,
): PlacementFormState => ({
  ...form,
  rows: { ...form.rows, [key]: { ...form.rows[key]!, ...patch } },
});

describe('placementFormOf', () => {
  it('has one row per position of the catalogue, chosen where the draft is placed', () => {
    const form = placementFormOf(detail(), ZONE);
    expect(Object.keys(form.rows)).toEqual([
      'home.hero',
      'home.mid',
      'category.top',
      'product.below-details',
      'cart.below-lines',
      'landing.top',
    ]);
    expect(form.rows['home.hero']).toMatchObject({ on: true, scope: 'all', autoplay: false });
    expect(form.rows['home.mid']).toMatchObject({ on: false, autoplay: false });
    // A new row at an autoplay position asks to move on its own.
    expect(form.rows['landing.top']).toMatchObject({ on: false, autoplay: true });
  });

  it('reads the window on the clock of the zone', () => {
    const form = placementFormOf(detail(), ZONE);
    expect(form.startsAt).toBe('2026-10-27T00:00');
    expect(form.endsAt).toBe('2026-11-03T23:59');
    expect(form.pinned).toBe(false);
  });

  it('keeps a second placement at one position and a position it does not know', () => {
    const base = version().placements[0]!;
    const form = placementFormOf(
      detail({
        draft: version({
          placements: [
            base,
            { ...base, position: 'category.top', scope: 'category', scopeId: CATEGORY },
            { ...base, position: 'category.top', scope: 'category', scopeId: ID },
            { ...base, position: 'checkout.top' },
          ],
        }),
      }),
      ZONE,
    );
    expect(form.rows['category.top']!.extra).toHaveLength(1);
    expect(form.others).toHaveLength(1);
    const { placements } = placementsOf(form);
    expect(placements.map((p) => `${p.position}:${p.scopeId ?? ''}`)).toEqual([
      'home.hero:',
      `category.top:${CATEGORY}`,
      `category.top:${ID}`,
      'checkout.top:',
    ]);
  });
});

describe('placementsOf', () => {
  it('lists the chosen positions in catalogue order, with the scope the row has', () => {
    let form = withRow(edited({}), 'category.top', {
      on: true,
      scope: 'category',
      scopeId: ` ${CATEGORY} `,
      includeSubcategories: true,
    });
    form = withRow(form, 'home.hero', { on: false });
    const { placements, keys } = placementsOf(form);
    expect(keys).toEqual(['category.top']);
    expect(placements).toEqual([
      {
        position: 'category.top',
        scope: 'category',
        scopeId: CATEGORY,
        includeSubcategories: true,
        sortOrder: 0,
        autoplay: false,
      },
    ]);
  });

  it('drops the id and the subcategories when the scope is all', () => {
    const form = withRow(edited({}), 'home.hero', {
      scope: 'all',
      scopeId: 'left over',
      includeSubcategories: true,
    });
    expect(placementsOf(form).placements[0]).toMatchObject({
      scopeId: null,
      includeSubcategories: false,
    });
  });
});

describe('window checks', () => {
  const start = '2026-10-27T00:00';
  it('accepts a window of 90 days exactly and refuses one minute more', () => {
    expect(
      validatePlacement(edited({ startsAt: start, endsAt: '2027-01-25T00:00' }), ZONE),
    ).toEqual({
      rows: {},
    });
    expect(
      validatePlacement(edited({ startsAt: start, endsAt: '2027-01-25T00:01' }), ZONE).endsAt,
    ).toBe('too-long');
  });

  it('counts 90 days in absolute time across a daylight-saving change', () => {
    // Sydney moves to daylight time on 4 Oct 2026: 90 days then span 2159 hours of wall clock.
    const sydney = 'Australia/Sydney';
    const form = edited({ startsAt: '2026-10-01T00:00', endsAt: '2026-12-30T00:00' });
    expect(validatePlacement(form, sydney).endsAt).toBeUndefined();
    expect(validatePlacement({ ...form, endsAt: '2026-12-30T01:01' }, sydney).endsAt).toBe(
      'too-long',
    );
  });

  it('refuses an end that is not after the start, a missing end and a missing start', () => {
    expect(validatePlacement(edited({ endsAt: start, startsAt: start }), ZONE).endsAt).toBe(
      'before-start',
    );
    expect(validatePlacement(edited({ endsAt: '' }), ZONE).endsAt).toBe('required');
    expect(validatePlacement(edited({ startsAt: '' }), ZONE).startsAt).toBe('required');
    expect(windowError(null, null, 'x', 'y')).toEqual({ startsAt: 'format', endsAt: 'format' });
  });

  it('needs a position and a valid id for a scoped row', () => {
    let form = withRow(edited({}), 'home.hero', { on: false });
    expect(validatePlacement(form, ZONE).none).toBe(true);
    form = withRow(form, 'category.top', { on: true, scope: 'category', scopeId: '' });
    expect(validatePlacement(form, ZONE).rows).toEqual({ 'category.top': { scopeId: 'required' } });
    form = withRow(form, 'category.top', { scopeId: 'nope' });
    expect(validatePlacement(form, ZONE).rows).toEqual({ 'category.top': { scopeId: 'format' } });
    form = withRow(form, 'category.top', { scopeId: CATEGORY });
    expect(hasErrors(validatePlacement(form, ZONE))).toBe(false);
  });
});

describe('placementRequestOf', () => {
  it('sends the whole draft again with the content as saved and the new placements and window', () => {
    const slide = detail({ draft: version({ sponsored: true }) });
    const form = withRow(
      { ...placementFormOf(slide, ZONE), pinned: true, endsAt: '2026-11-10T23:59' },
      'home.mid',
      { on: true },
    );
    const body = placementRequestOf(slide, form, ZONE)!;
    expect(body).toMatchObject({
      internalName: 'Diwali sweets week',
      sponsored: true,
      pinned: true,
      content: { title: 'Diwali sweets, delivered', link: { type: 'category', id: CATEGORY } },
      placements: [{ position: 'home.hero' }, { position: 'home.mid', scope: 'all' }],
    });
    expect(body).not.toHaveProperty('kind');
    // An unchanged time is sent as saved; a changed one is read in the zone.
    expect(body.startsAt).toBe('2026-10-26T14:00:00Z');
    expect(body.endsAt).toBe('2026-11-10T13:59:00.000Z');
  });

  it('is null for a slide with no version to build on', () => {
    const slide = detail({ draft: null, live: null });
    expect(placementRequestOf(slide, placementFormOf(slide, ZONE), ZONE)).toBeNull();
  });
});

describe('mapPlacementProblems', () => {
  const keys = ['home.hero', 'category.top', ''];
  it('puts the window and row problems on their fields', () => {
    const { errors, other } = mapPlacementProblems(
      [
        { path: 'endsAt', code: 'too-long' },
        { path: 'startsAt', code: 'format' },
        { path: 'placements[1].scopeId', code: 'required' },
        { path: 'placements[1].scope', code: 'not-allowed-here' },
        { path: 'placements[2]', code: 'duplicate' },
        { path: 'placements[9].scope', code: 'enum' },
        { path: 'content.title', code: 'required' },
      ],
      keys,
    );
    expect(errors.endsAt).toBe('too-long');
    expect(errors.startsAt).toBe('format');
    expect(errors.rows).toEqual({ 'category.top': { scopeId: 'required', scope: 'invalid' } });
    expect(other).toBe(3);
  });

  it('reads a list problem as nothing chosen', () => {
    expect(mapPlacementProblems([{ path: 'placements', code: 'required' }], keys).errors.none).toBe(
      true,
    );
  });
});

describe('clearErrors', () => {
  it('clears only what was edited', () => {
    const errors = {
      startsAt: 'required' as const,
      endsAt: 'too-long' as const,
      none: true as const,
      rows: {
        'home.hero': { scopeId: 'required' as const },
        'home.mid': { scopeId: 'format' as const },
      },
    };
    expect(clearErrors(errors, { field: 'endsAt' })).toMatchObject({
      startsAt: 'required',
      none: true,
    });
    expect(clearErrors(errors, { field: 'endsAt' }).endsAt).toBeUndefined();
    const row = clearErrors(errors, { row: 'home.hero' });
    expect(row.none).toBeUndefined();
    expect(row.rows).toEqual({ 'home.mid': { scopeId: 'format' } });
  });
});

describe('liveCounts', () => {
  it('counts the other live slides at each position, once each', () => {
    const counts = liveCounts(
      [
        summary({ id: 'a', positions: ['home.hero', 'home.mid'] }),
        summary({ id: 'b', positions: ['home.hero', 'home.hero'] }),
        summary({ id: ID, positions: ['home.hero'] }),
        summary({ id: 'c', status: 'scheduled', positions: ['home.hero'] }),
        summary({ id: 'd', positions: ['elsewhere'] }),
      ],
      ID,
    );
    expect(counts).toMatchObject({ 'home.hero': 2, 'home.mid': 1, 'category.top': 0 });
    expect(Object.keys(counts)).not.toContain('elsewhere');
  });
});

describe('samePlacementForm', () => {
  it('sees a change in a row or in the window', () => {
    const base = placementFormOf(detail(), ZONE);
    expect(samePlacementForm(base, placementFormOf(detail(), ZONE))).toBe(true);
    expect(samePlacementForm(base, withRow(base, 'home.mid', { on: true }))).toBe(false);
    expect(samePlacementForm(base, { ...base, pinned: true })).toBe(false);
  });
});
