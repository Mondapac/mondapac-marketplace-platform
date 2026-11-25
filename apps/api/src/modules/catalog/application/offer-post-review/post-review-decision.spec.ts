import type { ActorContext, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { decidesOwnPostReview, parsePostReviewDecision } from './post-review-decision';

const ID = '01990000-0000-7000-8000-0000000f0001';
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const ADMIN = '01990000-0000-7000-8000-0000000a0001' as Id<'Account'>;

describe.each(TEST_MARKET_IDS)('post-review decisions in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const admin = testAuthenticatedActor(market, {
    population: 'admin',
    accountId: ADMIN,
    sessionId: '01990000-0000-7000-8000-0000000b0001' as Id<'Session'>,
    sellerId: null,
  });
  const acting = (marker: Record<string, unknown>): ActorContext =>
    ({ ...admin, actingAs: marker }) as unknown as ActorContext;

  it('refuses the admin behind a submit and a session acting for the seller (fail closed)', () => {
    expect(decidesOwnPostReview(admin, SELLER, new Set())).toBe(false);
    expect(decidesOwnPostReview(admin, SELLER, new Set([ADMIN]))).toBe(true);
    expect(decidesOwnPostReview(acting({ sellerId: SELLER }), SELLER, new Set())).toBe(true);
    // A marker that names no seller counts as this seller.
    expect(decidesOwnPostReview(acting({ adminAccountId: ADMIN }), SELLER, new Set())).toBe(true);
    expect(
      decidesOwnPostReview(
        acting({ sellerId: '01990000-0000-7000-8000-00000000c002' }),
        SELLER,
        new Set(),
      ),
    ).toBe(false);
    expect(decidesOwnPostReview({ kind: 'system' } as ActorContext, SELLER, new Set())).toBe(true);
  });

  it('reads a closed body and never echoes the note in a refusal', () => {
    expect(parsePostReviewDecision({ id: ID, version: 1 }, 'optional')).toEqual({
      ok: true,
      value: { id: ID, version: 1, note: null, raw: { id: ID, version: 1 } },
    });
    for (const [body, field] of [
      [
        { id: 'x', version: 1 },
        { path: 'id', code: 'format' },
      ],
      [
        { id: ID, version: 0 },
        { path: 'version', code: 'type' },
      ],
      [
        { id: ID, version: 1.5 },
        { path: 'version', code: 'type' },
      ],
      [
        { id: ID, version: 1, other: 1 },
        { path: 'other', code: 'unknown' },
      ],
      [
        { id: ID, version: 1, note: '  ' },
        { path: 'note', code: 'required' },
      ],
      [
        { id: ID, version: 1, note: 7 },
        { path: 'note', code: 'type' },
      ],
    ] as const) {
      expect(parsePostReviewDecision(body, 'optional')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [field] },
      });
    }
    const secret = 'secret note '.repeat(200);
    expect(
      JSON.stringify(parsePostReviewDecision({ id: ID, version: 1, note: secret }, 'optional')),
    ).not.toContain('secret note secret note secret note secret note secret note secret note');
    expect(parsePostReviewDecision({ id: ID, version: 1 }, 'required')).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
    });
  });
});
