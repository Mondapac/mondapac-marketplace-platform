import {
  hasContactText,
  offerReviewReasons,
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
  ])('finds contact text in %p', (text) => {
    expect(hasContactText(text)).toBe(true);
  });

  it.each([
    'Lamb shoulder 1 kg, vacuum packed. Keep below 4°C.',
    'Pack of 12 x 375 ml',
    'Best before 2027-03-01',
    'Packed on 01.03.2027',
    'Made in Brisbane since 1998',
    '100% Australian beef, grass fed',
  ])('leaves ordinary text alone: %p', (text) => {
    expect(hasContactText(text)).toBe(false);
  });
});
