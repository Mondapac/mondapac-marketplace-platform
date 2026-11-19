import {
  applySellUnitChanges,
  isValidVariantSku,
  sellUnitDisplaySku,
  type SellUnitState,
} from './offer-sell-unit';

const unit = (variantId: string, over: Partial<SellUnitState> = {}): SellUnitState => ({
  variantId,
  variantSku: null,
  selling: true,
  ...over,
});
const current = [unit('v1'), unit('v2'), unit('v3')];

describe('isValidVariantSku', () => {
  it.each(['A', 'SKU-1/x', 'a'.repeat(64)])('accepts %s', (sku) => {
    expect(isValidVariantSku(sku)).toBe(true);
  });
  it.each(['', 'has space', 'a'.repeat(65), 'tab\t', 'é', 12 as unknown as string])(
    'refuses %s',
    (sku) => {
      expect(isValidVariantSku(sku)).toBe(false);
    },
  );
});

describe('applySellUnitChanges', () => {
  it('sets a SKU and a switch and returns only the changed units', () => {
    const r = applySellUnitChanges(current, [
      { variantId: 'v1', variantSku: 'S-1' },
      { variantId: 'v2', selling: false },
      { variantId: 'v3', selling: true },
    ]);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.value.changed).toEqual([
      { variantId: 'v1', variantSku: 'S-1', selling: true },
      { variantId: 'v2', variantSku: null, selling: false },
    ]);
    expect(r.value.after).toHaveLength(3);
  });

  it('clears a SKU with null and keeps the switch when left out', () => {
    const r = applySellUnitChanges(
      [unit('v1', { variantSku: 'S-1', selling: false }), unit('v2')],
      [{ variantId: 'v1', variantSku: null }],
    );
    expect(r.ok && r.value.changed).toEqual([
      { variantId: 'v1', variantSku: null, selling: false },
    ]);
  });

  it('is reversible: a unit off sale can be put back', () => {
    const off = applySellUnitChanges(current, [{ variantId: 'v2', selling: false }]);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const back = applySellUnitChanges(off.value.after, [{ variantId: 'v2', selling: true }]);
    expect(back.ok && back.value.after.every((u) => u.selling)).toBe(true);
  });

  it('answers no change for a request that matches the stored state', () => {
    const r = applySellUnitChanges(current, [{ variantId: 'v1', selling: true }]);
    expect(r.ok && r.value.changed).toEqual([]);
  });

  it('refuses a variant that is not a non-retired variant of the product', () => {
    expect(applySellUnitChanges(current, [{ variantId: 'other', selling: false }])).toEqual({
      ok: false,
      error: { code: 'sell-unit.variant-unknown', variantId: 'other' },
    });
  });

  it('refuses the same variant twice in one request', () => {
    expect(
      applySellUnitChanges(current, [
        { variantId: 'v1', selling: false },
        { variantId: 'v1', selling: true },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'sell-unit.variant-unknown' } });
  });

  it('refuses a malformed SKU', () => {
    expect(applySellUnitChanges(current, [{ variantId: 'v1', variantSku: 'a b' }])).toEqual({
      ok: false,
      error: { code: 'sell-unit.sku-invalid', variantId: 'v1' },
    });
  });

  it('refuses one SKU on two units, also against a stored SKU', () => {
    expect(
      applySellUnitChanges(current, [
        { variantId: 'v1', variantSku: 'X' },
        { variantId: 'v2', variantSku: 'X' },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'sell-unit.sku-duplicate' } });
    expect(
      applySellUnitChanges(
        [unit('v1', { variantSku: 'X' }), unit('v2')],
        [{ variantId: 'v2', variantSku: 'X' }],
      ),
    ).toMatchObject({ ok: false, error: { code: 'sell-unit.sku-duplicate' } });
  });

  it('keeps at least one unit selling', () => {
    expect(
      applySellUnitChanges(current, [
        { variantId: 'v1', selling: false },
        { variantId: 'v2', selling: false },
        { variantId: 'v3', selling: false },
      ]),
    ).toEqual({ ok: false, error: { code: 'sell-unit.none-selling' } });
  });
});

describe('sellUnitDisplaySku', () => {
  it('uses the variant SKU when present', () => {
    expect(sellUnitDisplaySku({ sellerSku: 'TEE', variantSku: 'TEE-RED-M', variantNo: 3 })).toBe(
      'TEE-RED-M',
    );
  });
  it('falls back to {sellerSku}-{variantNo}', () => {
    expect(sellUnitDisplaySku({ sellerSku: 'TEE', variantSku: null, variantNo: 3 })).toBe('TEE-3');
  });
});
