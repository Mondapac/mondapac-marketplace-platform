import {
  hasContactText,
  OFFER_REVIEW_POLICY_VERSION,
  offerEditReviewReasons,
  offerReviewReasons,
  type OfferEditReviewInput,
  type OfferReviewFacts,
  type OfferReviewInput,
} from './offer-review-policy';

const CLEAR: OfferReviewFacts = {
  emergencyStop: false,
  probation: false,
  fullReview: false,
  sensitiveCategory: false,
};

function input(overrides: Partial<OfferReviewInput> = {}): OfferReviewInput {
  return {
    mode: 'risk-based',
    certificateBadges: 'review',
    facts: CLEAR,
    handling: 'SEALED_ORIGINAL',
    badgeTypes: [],
    description: { en: 'Fresh lamb shoulder, 1 kg, vacuum packed.' },
    ...overrides,
  };
}

describe('offerReviewReasons (the Offer review policy)', () => {
  it('publishes a clean Offer of a trusted seller at once in risk-based mode', () => {
    expect(offerReviewReasons(input())).toEqual([]);
  });

  it('names every reason that applies, in the queue order', () => {
    expect(
      offerReviewReasons(
        input({
          facts: {
            emergencyStop: true,
            probation: true,
            fullReview: true,
            sensitiveCategory: true,
          },
          handling: 'REPACKED',
          badgeTypes: ['halal'],
          description: { en: 'Call 0412 345 678' },
        }),
      ),
    ).toEqual([
      'emergency-stop',
      'probation',
      'certificate-badge',
      'handling',
      'contact-text',
      'full-review',
      'sensitive-category',
    ]);
  });

  it('sends a badge to review only while the setting says review (R2)', () => {
    expect(offerReviewReasons(input({ badgeTypes: ['halal'] }))).toEqual(['certificate-badge']);
    expect(
      offerReviewReasons(input({ badgeTypes: ['halal'], certificateBadges: 'automatic' })),
    ).toEqual([]);
  });

  it.each(['REPACKED', 'PREPARED', 'FRESH'] as const)('sends %s handling to review (R3)', (h) => {
    expect(offerReviewReasons(input({ handling: h }))).toEqual(['handling']);
  });

  it('reads every locale of the description for contact text (R5)', () => {
    expect(
      offerReviewReasons(input({ description: { en: 'Fine', ar: 'visit kedron.com.au' } })),
    ).toEqual(['contact-text']);
  });

  it('queues everything in mode all, with review-all when nothing else applies', () => {
    expect(offerReviewReasons(input({ mode: 'all' }))).toEqual(['review-all']);
    expect(offerReviewReasons(input({ mode: 'all', handling: 'FRESH' }))).toEqual(['handling']);
  });

  it('publishes everything in mode off except during an emergency stop (R0 first)', () => {
    expect(
      offerReviewReasons(
        input({ mode: 'off', handling: 'FRESH', facts: { ...CLEAR, probation: true } }),
      ),
    ).toEqual([]);
    expect(
      offerReviewReasons(
        input({ mode: 'off', handling: 'FRESH', facts: { ...CLEAR, emergencyStop: true } }),
      ),
    ).toEqual(['emergency-stop']);
  });
});

describe('offerEditReviewReasons (the edit rules of a live Offer, slice 2c)', () => {
  const edit = (overrides: Partial<OfferEditReviewInput> = {}): OfferEditReviewInput => ({
    mode: 'risk-based',
    certificateBadges: 'review',
    emergencyStop: false,
    sensitiveCategory: false,
    addedBadgeTypes: [],
    ...overrides,
  });

  it('is version 3 of the policy', () => {
    expect(OFFER_REVIEW_POLICY_VERSION).toBe(3);
  });

  it('holds a watched edit of a product in an always-review category (R7), outside mode off', () => {
    for (const mode of ['risk-based', 'all'] as const) {
      expect(
        offerEditReviewReasons(
          edit({ mode, sensitiveCategory: true, newDescription: { en: 'Now 2 kg' } }),
        ),
      ).toEqual(['sensitive-category']);
      expect(
        offerEditReviewReasons(edit({ mode, sensitiveCategory: true, newHandling: 'FRESH' })),
      ).toEqual(['handling', 'sensitive-category']);
      // Nothing watched, or handling back to sealed original: still instant.
      expect(offerEditReviewReasons(edit({ mode, sensitiveCategory: true }))).toEqual([]);
      expect(
        offerEditReviewReasons(
          edit({ mode, sensitiveCategory: true, newHandling: 'SEALED_ORIGINAL' }),
        ),
      ).toEqual([]);
    }
    expect(
      offerEditReviewReasons(
        edit({ mode: 'off', sensitiveCategory: true, newDescription: { en: 'Now 2 kg' } }),
      ),
    ).toEqual([]);
    expect(
      offerEditReviewReasons(
        edit({ emergencyStop: true, sensitiveCategory: true, newDescription: { en: 'x' } }),
      ),
    ).toEqual(['emergency-stop', 'sensitive-category']);
  });

  it('applies a clean edit at once in risk-based mode', () => {
    expect(offerEditReviewReasons(edit({ newDescription: { en: 'Now 2 kg' } }))).toEqual([]);
    expect(offerEditReviewReasons(edit({ newHandling: 'SEALED_ORIGINAL' }))).toEqual([]);
    expect(offerEditReviewReasons(edit())).toEqual([]);
  });

  it('holds a new badge type only while badges are reviewed (R2)', () => {
    expect(offerEditReviewReasons(edit({ addedBadgeTypes: ['halal'] }))).toEqual([
      'certificate-badge',
    ]);
    expect(
      offerEditReviewReasons(edit({ addedBadgeTypes: ['halal'], certificateBadges: 'automatic' })),
    ).toEqual([]);
  });

  it.each(['REPACKED', 'PREPARED', 'FRESH'] as const)('holds handling changed to %s (R3)', (h) => {
    expect(offerEditReviewReasons(edit({ newHandling: h }))).toEqual(['handling']);
  });

  it('holds a changed description with contact text in any locale (R5)', () => {
    expect(
      offerEditReviewReasons(edit({ newDescription: { en: 'Fine', ar: 'Call 0412 345 678' } })),
    ).toEqual(['contact-text']);
  });

  it('names every reason in the queue order', () => {
    expect(
      offerEditReviewReasons(
        edit({
          addedBadgeTypes: ['halal'],
          newHandling: 'FRESH',
          newDescription: { en: 'see kedron.com.au' },
        }),
      ),
    ).toEqual(['certificate-badge', 'handling', 'contact-text']);
  });

  it('holds every watched change in mode all, with review-all when no rule applies', () => {
    // Back to sealed original lowers the risk: instant even in mode all (Hadi).
    expect(offerEditReviewReasons(edit({ mode: 'all', newHandling: 'SEALED_ORIGINAL' }))).toEqual(
      [],
    );
    expect(offerEditReviewReasons(edit({ mode: 'all', newHandling: 'FRESH' }))).toEqual([
      'handling',
    ]);
    expect(
      offerEditReviewReasons(edit({ mode: 'all', newDescription: { en: 'Clean text' } })),
    ).toEqual(['review-all']);
    expect(
      offerEditReviewReasons(
        edit({ mode: 'all', certificateBadges: 'automatic', addedBadgeTypes: ['halal'] }),
      ),
    ).toEqual(['review-all']);
    expect(offerEditReviewReasons(edit({ mode: 'all', newHandling: 'FRESH' }))).toEqual([
      'handling',
    ]);
    // Nothing watched changed: nothing to hold, even in mode all.
    expect(offerEditReviewReasons(edit({ mode: 'all' }))).toEqual([]);
  });

  it('holds every watched change during an emergency stop, in every mode (R0)', () => {
    for (const mode of ['off', 'risk-based', 'all'] as const) {
      const stopped = (more: Partial<OfferEditReviewInput>) =>
        offerEditReviewReasons(edit({ mode, emergencyStop: true, ...more }));
      expect(stopped({ newDescription: { en: 'Now 2 kg' } })).toEqual(['emergency-stop']);
      expect(stopped({ addedBadgeTypes: ['halal'], certificateBadges: 'automatic' })).toEqual([
        'emergency-stop',
      ]);
      // Back to sealed original, or nothing watched: still instant.
      expect(stopped({ newHandling: 'SEALED_ORIGINAL' })).toEqual([]);
      expect(stopped({})).toEqual([]);
    }
    // The stop comes first; the other rules still name themselves outside mode off.
    expect(offerEditReviewReasons(edit({ emergencyStop: true, newHandling: 'FRESH' }))).toEqual([
      'emergency-stop',
      'handling',
    ]);
    expect(
      offerEditReviewReasons(edit({ mode: 'off', emergencyStop: true, newHandling: 'FRESH' })),
    ).toEqual(['emergency-stop']);
  });

  it('holds nothing in mode off without a stop, whatever the edit', () => {
    expect(
      offerEditReviewReasons(
        edit({
          mode: 'off',
          addedBadgeTypes: ['halal'],
          newHandling: 'FRESH',
          newDescription: { en: 'Call 0412 345 678' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('hasContactText (R5)', () => {
  it.each([
    'Order at https://kedron.example',
    'see www.kedronmeats.au for more',
    'kedronmeats.com.au',
    'mail sales@kedron.example',
    'mail sales (at) kedron.example',
    'Call 0412 345 678',
    'Ring +61 7 3123 4567',
    '(07) 3123-4567',
    'follow @kedron_meats',
    'message us on WhatsApp',
    'DM me for a discount',
    'sales [at] kedron.example',
    'Call 0412\n345\n678',
    'Order: 0412345678',
    'Phone no. 0412 345 678',
    'Call ٠٤١٢ ٣٤٥ ٦٧٨',
    'Call 0412\u200B345\u200B678',
    'follow ＠kedron_meats',
  ])('finds contact text in %p', (text) => {
    expect(hasContactText(text)).toBe(true);
  });

  it.each([
    'Lamb shoulder 1 kg, vacuum packed. Keep below 4°C.',
    'Pack of 12 x 375 ml',
    'Best before 2027-03-01',
    'Packed on 01.03.2027',
    'Barcode 9300675024235',
    '9300675024235',
    'SKU 12345678',
    'ABN 51 824 753 556',
    '1.5 kg x 6',
    '3.5mm jack',
    'v2.0',
    'Signal brand dates 12/03/2027',
    'e.g. fresh',
    'Made in Brisbane since 1998',
    '100% Australian beef, grass fed',
  ])('leaves ordinary text alone: %p', (text) => {
    expect(hasContactText(text)).toBe(false);
  });
});

describe('hasContactText on long hostile text (Hassan S1)', () => {
  it.each(['a', '1-.', 'a.'])('answers within 100 ms for 20 x 5000 of %p', (unit) => {
    const text = unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
    const started = performance.now();
    for (let locale = 0; locale < 20; locale += 1) hasContactText(text);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
