import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeRelaxationRequest } from './attribute-relaxation-request';

// The two-admin request's own rules (catalog design 8.2), for both Market fixtures: 72 hours, a
// different confirmer in time, only the requester cancels, a change of the attribute cancels, and
// every move leaves `open` once with the version one above.

const T0 = Temporal.Instant.from('2026-11-02T10:00:00Z');
const A = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const B = '01990000-0000-7000-8000-0000000000b1' as Id<'Account'>;

describe.each(['AU', 'ZZ'])('AttributeRelaxationRequest in market %s', (market) => {
  const open = () =>
    AttributeRelaxationRequest.open({
      id: '01990000-0000-7000-8000-0000000000c1' as Id<'AttributeRelaxationRequest'>,
      marketId: market as MarketId,
      definitionId: '01990000-0000-7000-8000-0000000000d1' as Id<'AttributeDefinition'>,
      definitionVersion: 4,
      kind: 'clear-material',
      requestedByAccountId: A,
      now: T0,
    });

  it('opens for 72 hours at version 1', () => {
    expect(open().state).toMatchObject({
      status: 'open',
      version: 1,
      expiresAt: Temporal.Instant.from('2026-11-05T10:00:00Z'),
      familyId: null,
    });
  });

  it('is confirmed by another admin in time, never by the requester or late', () => {
    const request = open();
    expect(request.confirm(A, T0)).toEqual({ ok: false, error: { code: 'relaxation.same-admin' } });
    const late = T0.add({ hours: 72 });
    expect(request.confirm(B, late)).toEqual({ ok: false, error: { code: 'relaxation.expired' } });
    const done = request.confirm(B, T0.add({ hours: 71 }));
    expect(done.ok && done.value.state).toMatchObject({
      status: 'confirmed',
      confirmedByAccountId: B,
      version: 2,
    });
    if (!done.ok) return;
    expect(done.value.confirm(B, T0)).toEqual({ ok: false, error: { code: 'relaxation.closed' } });
    expect(done.value.cancel(A, T0)).toEqual({ ok: false, error: { code: 'relaxation.closed' } });
  });

  it('is cancelled by the requester only, or by a change of the attribute', () => {
    const request = open();
    expect(request.cancel(B, T0)).toEqual({
      ok: false,
      error: { code: 'relaxation.not-requester' },
    });
    const own = request.cancel(A, T0);
    expect(own.ok && own.value.state).toMatchObject({
      status: 'cancelled',
      cancelReason: 'requester',
    });
    const changed = request.cancelForChange(T0);
    expect(changed.ok && changed.value.state).toMatchObject({
      status: 'cancelled',
      cancelReason: 'definition-changed',
      version: 2,
    });
  });

  it('expires only once its time ran out', () => {
    const request = open();
    expect(request.expire(T0.add({ hours: 71 })).ok).toBe(false);
    const expired = request.expire(T0.add({ hours: 72 }));
    expect(expired.ok && expired.value.state).toMatchObject({ status: 'expired', version: 2 });
  });

  it('names a family exactly for remove-from-family', () => {
    expect(() =>
      AttributeRelaxationRequest.open({
        id: '01990000-0000-7000-8000-0000000000c2' as Id<'AttributeRelaxationRequest'>,
        marketId: market as MarketId,
        definitionId: '01990000-0000-7000-8000-0000000000d1' as Id<'AttributeDefinition'>,
        definitionVersion: 1,
        kind: 'remove-from-family',
        requestedByAccountId: A,
        now: T0,
      }),
    ).toThrow();
  });
});
