import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { overviewView } from './customer-page-flow';
import type { EmailChangePeer } from './ports/email-change-peer';
import { MemoryAccountDeletionRequests } from './testing/in-memory-account-deletion';
import { AdminCustomerEmailChangeCancel } from './use-cases/admin-customer-email-change-cancel.use-case';
import { AdminCustomerEmailChangeRequest } from './use-cases/admin-customer-email-change-request.use-case';

// The customers side of the admin email change in memory, on both Market fixtures: the access
// rule (view + the protected change key), acting-as refused, the body checks, the pending
// deletion request refused before identity is asked (Hassan R6), and identity's answers mapped to
// the route codes without the address.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T10:00:00.123Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const CUSTOMER = id<'Account'>(0xc1);
const VIEW = 'customers.customers.view';
const CHANGE = 'customers.customer-email.change';
const ORIGIN = '203.0.113.7';
const NEW_EMAIL = 'Maryam.New@Mailbox.test';

type Answer = Result<unknown, { readonly code: string } & Record<string, unknown>>;

/** identity's side, every call recorded, the answer set by the test. */
class Peer implements EmailChangePeer {
  readonly calls: string[] = [];
  requestAnswer: Answer = ok({ changed: true, requestedAt: NOW });
  cancelAnswer: Answer = ok({ code: 'email-change.cancelled' });
  requestCustomerEmailChangeForAdmin(
    _context: CallContext,
    request: { accountId: Id<'Account'>; email: string; origin: string },
  ) {
    this.calls.push(`request:${request.accountId}:${request.email}:${request.origin}`);
    return Promise.resolve(this.requestAnswer as never);
  }
  cancelCustomerEmailChangeForAdmin(_context: CallContext, accountId: Id<'Account'>) {
    this.calls.push(`cancel:${accountId}`);
    return Promise.resolve(this.cancelAnswer as never);
  }
  customerPendingEmailOf() {
    return Promise.resolve(ok(null));
  }
}

describe.each(['AU', 'ZZ'] as const)(
  'admin customer email change (customers) in market %s',
  (code) => {
    const market: MarketContext = testMarketContext(code, 'default');
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
    );

    beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    function setup(keys: readonly string[] = [VIEW, CHANGE]) {
      const check: AuthorisationCheck = {
        check: (_context, declaration) => {
          const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
          return Promise.resolve(
            needs.every((key) => keys.includes(key))
              ? { allowed: true }
              : { allowed: false, denial: { code: 'access.denied' } },
          );
        },
      };
      const gate = createUseCaseGate(markets, check);
      const unitOfWork = {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork;
      const requests = new MemoryAccountDeletionRequests();
      const identity = new Peer();
      const deps = { unitOfWork, requests, identity };
      return {
        identity,
        requests,
        request: new AdminCustomerEmailChangeRequest(gate, deps),
        cancel: new AdminCustomerEmailChangeCancel(gate, deps),
      };
    }
    const body = (overrides: Record<string, unknown> = {}) => ({
      accountId: CUSTOMER,
      email: NEW_EMAIL,
      origin: ORIGIN,
      ...overrides,
    });

    it('declares both keys, the change key protected (Hassan R4)', () => {
      for (const useCase of [AdminCustomerEmailChangeRequest, AdminCustomerEmailChangeCancel]) {
        expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW, CHANGE] });
      }
    });

    it.each([[[VIEW]], [[CHANGE]], [[]]])(
      'is denied with keys %j only, asking identity nothing',
      async (keys) => {
        const t = setup(keys);
        expect(await t.request.execute(admin, body())).toEqual(err({ code: 'access.denied' }));
        expect(await t.cancel.execute(admin, { accountId: CUSTOMER })).toEqual(
          err({ code: 'access.denied' }),
        );
        expect(t.identity.calls).toEqual([]);
      },
    );

    it('passes the request to identity and answers whether it changed anything, and when', async () => {
      const t = setup();
      expect(await t.request.execute(admin, body())).toEqual(
        ok({ changed: true, requestedAt: '2026-11-16T10:00:00.123Z' }),
      );
      expect(t.identity.calls).toEqual([`request:${CUSTOMER}:${NEW_EMAIL}:${ORIGIN}`]);
      t.identity.requestAnswer = ok({ changed: false, requestedAt: null });
      expect(await t.request.execute(admin, body())).toEqual(
        ok({ changed: false, requestedAt: null }),
      );
    });

    it('checks the body before identity: unknown keys, a non-string or overlong address', async () => {
      const t = setup();
      expect(await t.request.execute(admin, body({ extra: 1 }))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await t.request.execute(admin, body({ email: 7 }))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'type' }] },
      });
      expect(
        await t.request.execute(admin, body({ email: `${'a'.repeat(320)}@x.test` })),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'length' }] },
      });
      expect(await t.request.execute(admin, body({ accountId: 'nope' }))).toEqual(
        err({ code: 'customers.customer-not-found' }),
      );
      expect(t.identity.calls).toEqual([]);
    });

    it('refuses while the customer has a pending deletion request, before identity (Hassan R6)', async () => {
      const t = setup();
      jest
        .spyOn(t.requests, 'findActiveOf')
        .mockImplementation((_m, accountId) =>
          Promise.resolve(accountId === CUSTOMER ? ({ accountId } as never) : null),
        );
      expect(await t.request.execute(admin, body())).toEqual(
        err({ code: 'customers.account-deletion-pending' }),
      );
      expect(t.identity.calls).toEqual([]);
    });

    it('answers customers.unavailable when the deletion read fails', async () => {
      const t = setup();
      jest.spyOn(t.requests, 'findActiveOf').mockRejectedValue(new Error('db down'));
      expect(await t.request.execute(admin, body())).toEqual(
        err({ code: 'customers.unavailable' }),
      );
      expect(t.identity.calls).toEqual([]);
    });

    it.each<[string, Answer, unknown]>([
      [
        'account.unknown',
        err({ code: 'account.unknown' }),
        { code: 'customers.customer-not-found' },
      ],
      [
        'account.not-eligible',
        err({ code: 'account.not-eligible' }),
        { code: 'customers.customer-not-eligible' },
      ],
      [
        'account.email-taken',
        err({ code: 'account.email-taken' }),
        { code: 'customers.email-taken' },
      ],
      [
        'validation.failed',
        err({ code: 'validation.failed', fields: [{ path: 'email', code: 'invalid' }] }),
        { code: 'validation.failed', fields: [{ path: 'email', code: 'invalid' }] },
      ],
      [
        'request.throttled',
        err({ code: 'request.throttled', retryAfterSeconds: 120 }),
        { code: 'request.throttled', retryAfterSeconds: 120 },
      ],
      [
        'second-factor.required',
        err({ code: 'second-factor.required', actionKey: CHANGE }),
        { code: 'second-factor.required', actionKey: CHANGE },
      ],
      [
        'second-factor.enrolment-required',
        err({ code: 'second-factor.enrolment-required', actionKey: CHANGE }),
        { code: 'second-factor.enrolment-required', actionKey: CHANGE },
      ],
      ['access.denied', err({ code: 'access.denied' }), { code: 'access.denied' }],
      [
        'access.unavailable',
        err({ code: 'access.unavailable' }),
        { code: 'customers.unavailable' },
      ],
    ])('maps identity %s to its route code', async (_name, answer, expected) => {
      const t = setup();
      t.identity.requestAnswer = answer;
      expect(await t.request.execute(admin, body())).toEqual(err(expected));
    });

    it('cancels through identity and maps a missing change to customers.email-change-not-found', async () => {
      const t = setup();
      expect(await t.cancel.execute(admin, { accountId: CUSTOMER })).toEqual(
        ok({ cancelled: true }),
      );
      t.identity.cancelAnswer = err({ code: 'email-change.none' });
      expect(await t.cancel.execute(admin, { accountId: CUSTOMER })).toEqual(
        err({ code: 'customers.email-change-not-found' }),
      );
      t.identity.cancelAnswer = err({ code: 'account.unknown' });
      expect(await t.cancel.execute(admin, { accountId: CUSTOMER })).toEqual(
        err({ code: 'customers.customer-not-found' }),
      );
      t.identity.cancelAnswer = err({ code: 'second-factor.required', actionKey: CHANGE });
      expect(await t.cancel.execute(admin, { accountId: CUSTOMER })).toEqual(
        err({ code: 'second-factor.required', actionKey: CHANGE }),
      );
      expect(await t.cancel.execute(admin, { accountId: CUSTOMER, extra: 1 })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(t.identity.calls).toEqual(Array(4).fill(`cancel:${CUSTOMER}`));
    });

    it('never logs the address', async () => {
      const logged: unknown[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((entry: unknown) => {
        logged.push(entry);
      });
      const t = setup();
      await t.request.execute(admin, body());
      t.identity.requestAnswer = err({ code: 'account.email-taken' });
      await t.request.execute(admin, body());
      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged).toLowerCase()).not.toContain('mailbox');
    });

    it('shows a pending change on the overview as an ISO instant, or null', () => {
      const row = {
        accountId: CUSTOMER,
        email: 'maryam.old@example.com',
        displayName: null,
        status: 'active' as const,
        emailVerified: true,
        signedUpAt: NOW,
        firstOrderAt: null,
        lastOrderAt: null,
        orderCount: 0,
        spentMinor: 0n,
        currency: null,
        refundCount: 0,
        refundedMinor: 0n,
      };
      expect(overviewView(row).pendingEmailChange).toBeNull();
      expect(overviewView(row, { email: NEW_EMAIL, requestedAt: NOW }).pendingEmailChange).toEqual({
        email: NEW_EMAIL,
        requestedAt: '2026-11-16T10:00:00.123Z',
      });
    });
  },
);
