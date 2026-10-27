import { mismatchOf, type FleetCapabilities, type FleetNeed } from './fleet';

// The capability filter of the fleet router: what a fleet declares against what a seller order
// needs. Pure; run on both Market fixtures (AU: AUD, greater-brisbane; ZZ: JPY, zz-central).

describe.each([
  ['AU', 'AUD', 'greater-brisbane', 'zz-coast'],
  ['ZZ', 'JPY', 'zz-central', 'zz-coast'],
] as const)('mismatchOf in market %s', (_code, currency, area, otherArea) => {
  const caps = (overrides: Partial<FleetCapabilities> = {}): FleetCapabilities => ({
    fleet: 'fake_test',
    methods: ['instant', 'same_day', 'scheduled'],
    serviceAreas: [area],
    outsideCityAreasOnly: false,
    temperatures: ['ambient', 'chilled'],
    maxItemWeightGrams: 20_000,
    maxItems: 10,
    maxOrderValue: { amount: 50_000n, currency },
    prohibitedClasses: ['alcohol'],
    idempotentBooking: true,
    supportsWindow: true,
    ...overrides,
  });
  const need = (overrides: Partial<FleetNeed> = {}): FleetNeed => ({
    method: 'instant',
    hasWindow: false,
    temperature: 'ambient',
    heaviestItemGrams: 5000,
    itemCount: 3,
    declaredValue: { amount: 4500n, currency },
    classes: [],
    pickupArea: area,
    dropoffArea: area,
    ...overrides,
  });

  it('accepts an order within every limit', () => {
    expect(mismatchOf(caps(), need())).toBeNull();
    expect(
      mismatchOf(caps({ maxItemWeightGrams: null, maxItems: null, maxOrderValue: null }), need()),
    ).toBeNull();
  });

  it('refuses a method the fleet does not carry', () => {
    expect(mismatchOf(caps({ methods: ['scheduled'] }), need())).toBe('method');
    expect(mismatchOf(caps({ methods: ['scheduled'] }), need({ method: 'scheduled' }))).toBeNull();
  });

  it('refuses a buyer window when the fleet cannot be booked for one', () => {
    const windowed = need({ method: 'scheduled', hasWindow: true });
    expect(mismatchOf(caps({ supportsWindow: false }), windowed)).toBe('window');
    expect(mismatchOf(caps({ supportsWindow: false }), need({ method: 'scheduled' }))).toBeNull();
    expect(mismatchOf(caps(), windowed)).toBeNull();
  });

  it('wants both ends in a served city area', () => {
    expect(mismatchOf(caps(), need({ dropoffArea: otherArea }))).toBe('area');
    expect(mismatchOf(caps(), need({ pickupArea: otherArea }))).toBe('area');
    expect(mismatchOf(caps(), need({ dropoffArea: null }))).toBe('area');
    expect(mismatchOf(caps(), need({ pickupArea: null }))).toBe('area');
  });

  it('serves only drop-offs outside every city area when outsideCityAreasOnly', () => {
    const post = caps({ outsideCityAreasOnly: true, serviceAreas: [] });
    expect(mismatchOf(post, need({ dropoffArea: null, pickupArea: area }))).toBeNull();
    expect(mismatchOf(post, need({ dropoffArea: null, pickupArea: null }))).toBeNull();
    expect(mismatchOf(post, need({ dropoffArea: area }))).toBe('area');
  });

  it('refuses a temperature, a heavy item, too many items and a dear order', () => {
    expect(mismatchOf(caps(), need({ temperature: 'frozen' }))).toBe('temperature');
    expect(mismatchOf(caps(), need({ heaviestItemGrams: 20_001 }))).toBe('weight');
    expect(mismatchOf(caps(), need({ heaviestItemGrams: 20_000 }))).toBeNull();
    expect(mismatchOf(caps(), need({ itemCount: 11 }))).toBe('items');
    expect(mismatchOf(caps(), need({ itemCount: 10 }))).toBeNull();
    expect(mismatchOf(caps(), need({ declaredValue: { amount: 50_001n, currency } }))).toBe(
      'value',
    );
    expect(mismatchOf(caps(), need({ declaredValue: { amount: 50_000n, currency } }))).toBeNull();
  });

  it('refuses a value it cannot compare (another currency) rather than guess', () => {
    expect(mismatchOf(caps(), need({ declaredValue: { amount: 1n, currency: 'USD' } }))).toBe(
      'value',
    );
  });

  it('refuses a prohibited class of goods', () => {
    expect(mismatchOf(caps(), need({ classes: ['grocery', 'alcohol'] }))).toBe('class');
    expect(mismatchOf(caps(), need({ classes: ['grocery'] }))).toBeNull();
  });
});
