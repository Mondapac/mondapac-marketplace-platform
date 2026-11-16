import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerListRow } from '../domain/customer-list';
import { LateBoundSectionPeers } from '../infrastructure/late-bound-section-peers';
import type { CustomerSectionDependencies } from './customer-section-lists';
import type { CustomerSectionPeers } from './ports/customer-section-peers';
import type { SheetWriter } from './ports/sheet-writer';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from './testing/in-memory-customer-management';
import { AdminCustomerPasswordReset } from './use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSessions } from './use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignInReveal } from './use-cases/admin-customer-sign-in-reveal.use-case';
import { AdminCustomerSignInsExport } from './use-cases/admin-customer-sign-ins-export.use-case';
import { AdminCustomerSignIns } from './use-cases/admin-customer-sign-ins.use-case';
import { AdminCustomerSignOut } from './use-cases/admin-customer-sign-out.use-case';

// The customer page's sections other modules own (phase 2b, part 2), with the owners faked at
// their facade, for both Market fixtures: only an admin not acting as anyone; only a customer of
// the directory; the owner's refusal stays a refusal; the super list's paging and its export
// (step-up spent, audit row with the section); a reveal shows nothing when its timeline entry
// cannot be written; an account action keeps its answer and notes the timeline.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T12:00:00Z');
const VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
const SIGN_IN_VIEW = 'identity.customer-sign-in.view';
const SIGN_IN_REVEAL = 'identity.customer-sign-in.reveal';
const SESSION_END = 'identity.customer-session.end';
const RESET_SEND = 'identity.customer-password-reset.send';
const ALL = [VIEW, EXPORT, SIGN_IN_VIEW, SIGN_IN_REVEAL, SESSION_END, RESET_SEND];

describe.each(['AU', 'ZZ'] as const)('customer page sections in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);

  const row = (): CustomerListRow => ({
    accountId: ids.next<'Account'>(),
    email: 'buyer@example.test',
    groups: [],
    displayName: null,
    status: 'active',
    emailVerified: true,
    signedUpAt: NOW.subtract({ hours: 24 * 30 }),
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
  });

  function setup(peers: Partial<Record<keyof CustomerSectionPeers, object>> = {}) {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const listReader = new InMemoryCustomerList();
    const timeline = new InMemoryCustomerTimeline(listReader);
    const stepUp = { refuse: null as null | 'second-factor.required', spent: [] as string[] };
    const consumer: StepUpProofConsumer = {
      consume: (_context: CallContext, actionKey: string) => {
        if (stepUp.refuse !== null) return Promise.resolve(err({ code: stepUp.refuse, actionKey }));
        stepUp.spent.push(actionKey);
        return Promise.resolve(ok({ sessionId: ids.next<'Session'>(), verifiedAt: NOW }));
      },
    };
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const deps: CustomerSectionDependencies = {
      unitOfWork,
      listReader,
      timeline,
      audit,
      stepUp: consumer,
      sheetWriter,
      clock,
      ids,
      peers: peers as unknown as CustomerSectionPeers,
    };
    const admin = (keys: readonly string[] = ALL): CallContext => {
      const accountId = ids.next<'Account'>();
      held.set(accountId, keys);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    };
    const customer = row();
    listReader.add(market, customer);
    return { deps, gate, audits, timeline, stepUp, admin, customer, listReader };
  }

  const actingAs = (context: CallContext): CallContext => ({
    ...context,
    actor: { ...context.actor, actingAs: { sellerId: 'x' } } as never,
  });

  const signInRow = (n: number) => ({
    signInId: `01990000-0000-7000-8000-0000000050${n.toString().padStart(2, '0')}`,
    occurredAt: NOW.subtract({ hours: n }).toString(),
    outcome: 'signed-in',
    result: 'success',
    device: 'chrome.windows',
    city: null,
  });

  describe('the sign-ins super list', () => {
    function identityPeer() {
      const requests: unknown[] = [];
      return {
        requests,
        peer: {
          adminCustomerSignIns: (_context: CallContext, request: { window: { limit: number } }) => {
            requests.push(request);
            const rows = Array.from({ length: Math.min(request.window.limit, 30) }, (_, n) =>
              signInRow(n + 1),
            );
            return Promise.resolve(ok({ rows, total: 30, since: NOW.toString() }));
          },
        },
      };
    }

    it('pages through identity with the filters, both paging modes and the 90-day note', async () => {
      const identity = identityPeer();
      const { deps, gate, admin, customer } = setup({ identity: identity.peer });
      const useCase = new AdminCustomerSignIns(gate, deps);

      const pages = await useCase.execute(admin(), {
        accountId: customer.accountId,
        filters: { result: ['success'], from: NOW.subtract({ hours: 48 }).toString() },
        pageSize: 10,
      });
      expect(pages).toMatchObject({
        ok: true,
        value: { total: 30, page: 1, pageSize: 10, hasNext: true, since: NOW.toString() },
      });
      expect(identity.requests[0]).toMatchObject({
        accountId: customer.accountId,
        results: ['success'],
        direction: 'desc',
        window: { offset: 0, limit: 10 },
        withTotal: true,
      });

      const prevNext = await useCase.execute(admin(), {
        accountId: customer.accountId,
        paging: 'prev-next',
        pageSize: 10,
      });
      expect(prevNext).toMatchObject({ ok: true, value: { total: null, hasNext: true } });
      expect(identity.requests[1]).toMatchObject({ window: { limit: 11 }, withTotal: false });
    });

    it('refuses bad filters, an unknown customer and an acting-as session before asking identity', async () => {
      const identity = identityPeer();
      const { deps, gate, admin, customer } = setup({ identity: identity.peer });
      const useCase = new AdminCustomerSignIns(gate, deps);
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, filters: { result: ['x'] } }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, filters: { city: 'x' } }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        useCase.execute(admin(), { accountId: ids.next<'Account'>() }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'customers.customer-not-found' } });
      await expect(
        useCase.execute(actingAs(admin()), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      await expect(
        useCase.execute(admin([VIEW]), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(identity.requests).toEqual([]);
    });

    it('fails closed while identity is not bound', async () => {
      const { deps, gate, admin, customer } = setup();
      const useCase = new AdminCustomerSignIns(gate, {
        ...deps,
        peers: new LateBoundSectionPeers(),
      });
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('exports after spending the step-up, with an audit row naming the section', async () => {
      const identity = identityPeer();
      const { deps, gate, admin, customer, audits, stepUp } = setup({ identity: identity.peer });
      const exported = await new AdminCustomerSignInsExport(gate, deps).execute(admin(), {
        accountId: customer.accountId,
        format: 'csv',
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.value.filename).toBe(`customer-sign-ins-${NOW.toString().slice(0, 10)}.csv`);
      let text = '';
      for await (const chunk of exported.value.chunks) text += String(chunk);
      expect(text.split('\n').filter(Boolean)).toHaveLength(31);
      expect(stepUp.spent).toEqual([EXPORT]);
      expect(audits).toMatchObject([
        {
          action: 'customers.customer-section.exported',
          targetId: customer.accountId,
          after: { section: 'sign-ins', format: 'csv', rowCount: 30 },
        },
      ]);
    });

    it('releases no file when the step-up is refused, and refuses an admin without the export key', async () => {
      const identity = identityPeer();
      const { deps, gate, admin, customer, audits, stepUp } = setup({ identity: identity.peer });
      stepUp.refuse = 'second-factor.required';
      await expect(
        new AdminCustomerSignInsExport(gate, deps).execute(admin(), {
          accountId: customer.accountId,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
      await expect(
        new AdminCustomerSignInsExport(gate, deps).execute(admin([VIEW, SIGN_IN_VIEW]), {
          accountId: customer.accountId,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(audits).toEqual([]);
    });
  });

  describe('the reveal', () => {
    it('answers the address after the timeline entry, and nothing when that entry fails', async () => {
      const reveal = {
        adminRevealCustomerSignIn: () =>
          Promise.resolve(ok({ address: '203.0.113.7', occurredAt: NOW.toString() })),
      };
      const { deps, gate, admin, customer, timeline } = setup({ identity: reveal });
      const useCase = new AdminCustomerSignInReveal(gate, deps);
      const signInId = signInRow(1).signInId;

      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, signInId }),
      ).resolves.toEqual({
        ok: true,
        value: { signInId, address: '203.0.113.7', occurredAt: NOW.toString() },
      });
      const entries = await timeline.page(
        market,
        { accountId: customer.accountId, kinds: null, from: null, to: null },
        'desc',
        { offset: 0, limit: 5 },
      );
      expect(entries.map((entry) => [entry.kind, entry.detail])).toEqual([
        ['sign-in-address-revealed', 'sign-in'],
      ]);

      const broken = {
        ...deps,
        timeline: { record: () => Promise.reject(new Error('down')) },
      };
      await expect(
        new AdminCustomerSignInReveal(gate, broken).execute(admin(), {
          accountId: customer.accountId,
          signInId,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('keeps identity’s refusals and needs the protected key', async () => {
      const refusing = {
        adminRevealCustomerSignIn: () => Promise.resolve(err({ code: 'account.unknown' })),
      };
      const { deps, gate, admin, customer } = setup({ identity: refusing });
      const useCase = new AdminCustomerSignInReveal(gate, deps);
      const signInId = signInRow(1).signInId;
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, signInId }),
      ).resolves.toEqual({ ok: false, error: { code: 'customers.sign-in-not-found' } });
      await expect(
        useCase.execute(admin(), { accountId: customer.accountId, signInId: 'nope' }),
      ).resolves.toEqual({ ok: false, error: { code: 'customers.sign-in-not-found' } });
      await expect(
        useCase.execute(admin([VIEW, SIGN_IN_VIEW]), { accountId: customer.accountId, signInId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('the sessions and the account actions', () => {
    it('reads the sessions, signs out everywhere and sends a reset, each noted on the timeline', async () => {
      const identity = {
        adminCustomerSessions: () => Promise.resolve(ok({ items: [], more: false })),
        adminSignOutCustomer: () => Promise.resolve(ok({ revokedSessions: 3 })),
        adminSendCustomerPasswordReset: () => Promise.resolve(ok({ sent: true as const })),
      };
      const { deps, gate, admin, customer, timeline } = setup({ identity });
      const accountId = customer.accountId;
      await expect(
        new AdminCustomerSessions(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: true, value: { items: [], more: false } });
      await expect(
        new AdminCustomerSignOut(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: true, value: { revokedSessions: 3 } });
      await expect(
        new AdminCustomerPasswordReset(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: true, value: { sent: true } });
      const entries = await timeline.page(
        market,
        { accountId, kinds: null, from: null, to: null },
        'asc',
        { offset: 0, limit: 5 },
      );
      expect(entries.map((entry) => entry.kind).sort()).toEqual([
        'password-reset-sent',
        'signed-out-by-admin',
      ]);
    });

    it('maps identity’s refusals of an action', async () => {
      const identity = {
        adminSignOutCustomer: () => Promise.resolve(err({ code: 'account.unknown' })),
        adminSendCustomerPasswordReset: () =>
          Promise.resolve(err({ code: 'password-reset.recently-requested' })),
      };
      const { deps, gate, admin, customer } = setup({ identity });
      const accountId = customer.accountId;
      await expect(
        new AdminCustomerSignOut(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({ ok: false, error: { code: 'customers.customer-not-found' } });
      await expect(
        new AdminCustomerPasswordReset(gate, deps).execute(admin(), { accountId }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'customers.password-reset-recently-requested' },
      });
      await expect(
        new AdminCustomerSignOut(gate, deps).execute(admin([VIEW]), { accountId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });
});
