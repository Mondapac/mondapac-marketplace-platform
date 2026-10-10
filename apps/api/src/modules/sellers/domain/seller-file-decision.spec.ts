import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import type { DecisionIntent } from './decision-intent';
import { isStale } from './decision-intent';
import { SellerFile } from './seller-file';
import type { ShopSlug } from './shop-slug';

// The decision intent on a file (sellers design 3.2, 7.3; slice 7a-decide): one decision at a
// time, the draft frozen while it is in flight, the intent ended only by the revision it names.

const T0 = Temporal.Instant.from('2026-10-10T00:00:00Z');
const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;
const REVISION = '01928a3c-0000-7000-8000-0000000000b1' as Id<'BusinessFileRevision'>;
const OTHER = '01928a3c-0000-7000-8000-0000000000b2' as Id<'BusinessFileRevision'>;
const intent: DecisionIntent = {
  kind: 'approve-requested',
  attemptId: '01928a3c-0000-7000-8000-0000000000c1' as Id<'DecisionAttempt'>,
  revisionId: REVISION,
  since: T0,
};
const REQUIREMENTS = { identifierRequired: false, contactEmailRequired: false } as never;

describe.each(['AU', 'ZZ'] as const)('the decision intent of a file in %s', (code) => {
  const fresh = () =>
    SellerFile.create({
      sellerId: SELLER,
      marketId: code as MarketId,
      origin: 'self',
      approvalRequiredAtRegistration: true,
      now: T0,
    });

  it('sets the intent with one version step and refuses a second one', () => {
    const file = fresh();
    const version = file.state.version;
    expect(file.beginDecision(intent)).toEqual({ ok: true, value: undefined });
    expect(file.state).toMatchObject({ version: version + 1, decisionIntent: intent });
    expect(file.beginDecision({ ...intent, kind: 'reject-requested' })).toEqual({
      ok: false,
      error: { code: 'file.decision-in-progress' },
    });
  });

  it('freezes the draft while the intent is set', () => {
    const file = fresh();
    file.beginDecision(intent);
    expect(file.saveSlug('al-noor' as ShopSlug, T0, REQUIREMENTS)).toEqual({
      ok: false,
      error: { code: 'file.decision-in-progress' },
    });
  });

  it('ends the intent only for the revision it names, and records an approval once', () => {
    const file = fresh();
    file.beginDecision(intent);
    expect(file.closeDecision(OTHER, T0)).toBe(false);
    expect(file.state.decisionIntent).toEqual(intent);
    expect(file.recordApproval(REVISION, T0)).toEqual({ ok: true, value: undefined });
    expect(file.state).toMatchObject({ decisionIntent: null, hasApprovedRevision: true });
    expect(file.recordApproval(REVISION, T0)).toMatchObject({ ok: false });
    expect(file.beginDecision(intent)).toEqual({
      ok: false,
      error: { code: 'file.change-request-required' },
    });
  });

  it('is stale for the job five minutes after it was set', () => {
    expect(isStale(intent, T0.add({ minutes: 4, seconds: 59 }))).toBe(false);
    expect(isStale(intent, T0.add({ minutes: 5 }))).toBe(true);
  });
});
