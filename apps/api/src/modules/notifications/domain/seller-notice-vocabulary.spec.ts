import {
  IMAGE_TAKEDOWN_REASONS as CATALOG_IMAGE_REASONS,
  OFFER_CHANGE_REASONS,
} from '../../catalog';
import { ISSUER_REQUEST_OUTCOME_VALUES } from '../../certification';
import { TEAM_MEMBER_INVITE } from '../../identity';
import { HOLD_OUTCOMES as PRICING_HOLD_OUTCOMES, PRICE_RECORD_KINDS } from '../../pricing';
import {
  CHANGE_REASONS,
  HOLD_OUTCOMES,
  IMAGE_TAKEDOWN_REASONS,
  ISSUER_REQUEST_OUTCOMES,
  PRICE_KINDS,
} from './in-app-notice';

// The seller notices (package 4) copy the enum vocabulary of the events they consume. A value
// the publisher adds and this module misses would make the notice's params fail their own check
// and dead-letter the event (Hassan, package 4 review, M1), so every copy is held to its source.

describe('seller notice vocabulary', () => {
  it('matches the vocabulary of each consumed event', () => {
    expect([...CHANGE_REASONS]).toEqual([...OFFER_CHANGE_REASONS]);
    expect([...IMAGE_TAKEDOWN_REASONS]).toEqual([...CATALOG_IMAGE_REASONS]);
    expect([...ISSUER_REQUEST_OUTCOMES]).toEqual([...ISSUER_REQUEST_OUTCOME_VALUES]);
    expect([...PRICE_KINDS]).toEqual([...PRICE_RECORD_KINDS]);
    // `superseded` makes no notice (the subscription drops it); every other outcome is kept.
    expect([...HOLD_OUTCOMES]).toEqual(
      PRICING_HOLD_OUTCOMES.filter((outcome) => outcome !== 'superseded'),
    );
  });

  it('keeps the store access notice to the Seller Owner while its stand-in key is protected', () => {
    // The access notices are seen through identity.team-member.invite, which only the Seller
    // Owner holds while protected seller keys cannot be granted (Hassan, package 4 review, L2).
    // If this key stops being protected, check the Seller Owner role instead.
    expect(TEAM_MEMBER_INVITE.protected).toBe(true);
    expect(TEAM_MEMBER_INVITE.scope).toBe('seller');
  });
});
