import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryOutbox } from '../../../../../test/support/certification-fakes';
import {
  FakeRegistryCipher,
  MemoryRegistry,
} from '../../../../../test/support/certification-registry-fakes';
import { RecordingAudit } from '../../../../../test/support/certification-review-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CERTIFICATION_ISSUER_EDIT, CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import type { TypeRevisionContent } from '../../domain/type-revision';
import { ConfigCertificationMailPolicy } from '../../infrastructure/config-certification-mail-policy';
import type { RegistryDependencies } from '../registry/registry.shared';
import { IssuerActivate } from './issuer-activate.use-case';
import { IssuerApproveReactivation } from './issuer-approve-reactivation.use-case';
import { IssuerCloseToNew } from './issuer-close-to-new.use-case';
import { IssuerCreate } from './issuer-create.use-case';
import { IssuerDerecognise } from './issuer-derecognise.use-case';
import { IssuerExpertReferenceRead } from './issuer-expert-reference-read.use-case';
import { IssuerProposalReject } from './issuer-proposal-reject.use-case';
import { IssuerProposalWithdraw } from './issuer-proposal-withdraw.use-case';
import { IssuerRead } from './issuer-read.use-case';
import { IssuerRequestReactivation } from './issuer-request-reactivation.use-case';
import { IssuersList } from './issuers-list.use-case';
import { SendDerecognitionMail } from './send-derecognition-mail.use-case';
import { TypeApproveReactivation } from './type-approve-reactivation.use-case';
import { TypeApproveRelaxation } from './type-approve-relaxation.use-case';
import { TypeDeactivate } from './type-deactivate.use-case';
import { TypeProposalReject } from './type-proposal-reject.use-case';
import { TypeProposalWithdraw } from './type-proposal-withdraw.use-case';
import { TypeRead } from './type-read.use-case';
import { TypeRequestReactivation } from './type-request-reactivation.use-case';
import { TypeSaveRevision } from './type-save-revision.use-case';
import { TypesList } from './types-list.use-case';

// The type and issuer registry in memory (certification design 3.5, 3.6, 7.1, 7.2, 7.6, 12;
// slice 12; AC 19; Hassan H1), on both Market fixtures, with the real gate and a registry fake
// that rolls back like a transaction. The SQL is in test/db/certification-registry.db-spec.ts, the
// routes in test/certification-registry.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');
const EXPERT = { confirmedBy: 'Expert One', reference: 'MEMO-2026-001' };
const NEW_EXPERT = { confirmedBy: 'Expert Two', reference: 'MEMO-2026-077' };

async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function refusal<T, E>(promise: Promise<Result<T, E>>): Promise<E> {
  const result = await promise;
  if (result.ok) throw new Error(`unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe('registry access declarations (H1)', () => {
  it('needs the protected edit keys for every write and approval', () => {
    for (const type of [
      TypeSaveRevision,
      TypeDeactivate,
      TypeRequestReactivation,
      TypeApproveRelaxation,
      TypeApproveReactivation,
      TypeProposalReject,
      TypeProposalWithdraw,
    ]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_TYPE_EDIT.key],
      });
    }
    for (const type of [
      IssuerCreate,
      IssuerActivate,
      IssuerCloseToNew,
      IssuerDerecognise,
      IssuerRequestReactivation,
      IssuerApproveReactivation,
      IssuerProposalReject,
      IssuerProposalWithdraw,
      IssuerExpertReferenceRead,
    ]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_ISSUER_EDIT.key],
      });
    }
    expect(CERTIFICATION_TYPE_EDIT.protected).toBe(true);
    expect(CERTIFICATION_ISSUER_EDIT.protected).toBe(true);
    expect(SendDerecognitionMail.access.rule).toEqual({ kind: 'system' });
  });
});

describe.each(['AU', 'ZZ'] as const)('certification registry in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = markets.get(market.marketId).supportedLocales;

  const contentOf = (overrides: Partial<TypeRevisionContent> = {}): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: true,
    defaultBasis: 'SELLER_REQUIRED',
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'seal',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        { name: 'Qorvane', customerDescription: 'Holds a certificate.', claimTerms: ['qorvane'] },
      ]),
    ),
    ...overrides,
  });

  let logs: unknown[];
  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(args[0]);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  function rig() {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const registry = new MemoryRegistry();
    const cipher = new FakeRegistryCipher();
    const audit = new RecordingAudit();
    const outbox = new MemoryOutbox();
    const deps: RegistryDependencies = {
      unitOfWork: registry.unitOfWork,
      registry,
      cipher,
      audit,
      outbox,
      clock,
      ids,
      supportedLocales: (m) => markets.get(m.marketId).supportedLocales,
    };
    const typeId = ids.next<'CertificationType'>();
    registry.addType(
      market,
      { id: typeId, code: 'qorvane', status: 'active' },
      { id: ids.next<'CertificationTypeRevision'>(), content: contentOf() },
      T0,
      'seed',
    );
    const admin = (actingAs = false): CallContext => {
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      return actingAs
        ? ({
            ...context,
            actor: { ...context.actor, actingAs: { accountId: 'x', sellerId: 'y' } },
          } as unknown as CallContext)
        : context;
    };
    const sent: MailMessage[] = [];
    const contacts = new Map<string, string | null>();
    const mail = new SendDerecognitionMail(gate, {
      unitOfWork: registry.unitOfWork,
      registry,
      contacts: { emailOf: (_c, sellerId) => Promise.resolve(contacts.get(sellerId) ?? null) },
      transport: {
        send: (message: MailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      mailPolicy: new ConfigCertificationMailPolicy(markets),
    });
    const delivery = (): EventDelivery => ({
      eventId: ids.next<'event'>(),
      subscriber: 'certification.derecognition-mail',
      attempt: 1,
    });
    return {
      clock,
      ids,
      registry,
      cipher,
      audit,
      outbox,
      typeId,
      admin,
      sent,
      contacts,
      mail,
      delivery,
      types: {
        list: new TypesList(gate, deps),
        read: new TypeRead(gate, deps),
        save: new TypeSaveRevision(gate, deps),
        deactivate: new TypeDeactivate(gate, deps),
        requestReactivation: new TypeRequestReactivation(gate, deps),
        approveRelaxation: new TypeApproveRelaxation(gate, deps),
        approveReactivation: new TypeApproveReactivation(gate, deps),
        reject: new TypeProposalReject(gate, deps),
        withdraw: new TypeProposalWithdraw(gate, deps),
      },
      issuers: {
        list: new IssuersList(gate, deps),
        read: new IssuerRead(gate, deps),
        reference: new IssuerExpertReferenceRead(gate, deps),
        create: new IssuerCreate(gate, deps),
        activate: new IssuerActivate(gate, deps),
        closeToNew: new IssuerCloseToNew(gate, deps),
        derecognise: new IssuerDerecognise(gate, deps),
        requestReactivation: new IssuerRequestReactivation(gate, deps),
        approveReactivation: new IssuerApproveReactivation(gate, deps),
        reject: new IssuerProposalReject(gate, deps),
        withdraw: new IssuerProposalWithdraw(gate, deps),
      },
    };
  }

  type Rig = ReturnType<typeof rig>;

  async function activeIssuer(r: Rig, by: CallContext): Promise<Id<'Issuer'>> {
    const created = await unwrap(
      r.issuers.create.execute(by, {
        typeId: r.typeId,
        displayName: 'Example Certifiers',
        accreditationNumber: 'ACC-1',
      }),
    );
    const issuerId = created.issuerId as Id<'Issuer'>;
    await unwrap(
      r.issuers.activate.execute(by, {
        issuerId,
        version: created.version,
        expertApproval: EXPERT,
      }),
    );
    return issuerId;
  }

  const eventTypes = (r: Rig): string[] => r.outbox.events.map((e) => e.type);
  const auditActions = (r: Rig): string[] => r.audit.entries.map((e) => e.action);

  describe('types', () => {
    it('lists and reads the types for any admin, and refuses other populations', async () => {
      const r = rig();
      const list = await unwrap(r.types.list.execute(r.admin(), {}));
      expect(list.items).toEqual([
        expect.objectContaining({ typeId: r.typeId, code: 'qorvane', status: 'active' }),
      ]);
      const read = await unwrap(r.types.read.execute(r.admin(), { typeId: r.typeId }));
      expect(read).toMatchObject({ typeId: r.typeId, pendingRevision: null });
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: r.ids.next<'Account'>(),
          sessionId: r.ids.next<'Session'>(),
          sellerId: r.ids.next<'Seller'>(),
        }),
      );
      expect(await refusal(r.types.list.execute(seller, {}))).toEqual({ code: 'access.denied' });
    });

    it('publishes a tightening revision at once, with its event and audit row', async () => {
      const r = rig();
      const saved = await unwrap(
        r.types.save.execute(r.admin(), {
          typeId: r.typeId,
          version: 1,
          content: contentOf({ requiresIssuerRegistry: true, badgeIconKey: 'shield' }),
          reason: 'New icon',
        }),
      );
      expect(saved).toMatchObject({ outcome: 'published', revisionNo: 2, version: 2 });
      expect(eventTypes(r)).toEqual(['certification.certification-type-revised.v1']);
      expect(auditActions(r)).toEqual(['certification.type.revised']);
      expect(JSON.stringify(r.audit.entries)).not.toContain('New icon');
      const read = await unwrap(r.types.read.execute(r.admin(), { typeId: r.typeId }));
      expect(read.published.reason).toEqual({ state: 'given', text: 'New icon' });
    });

    it('holds a relaxing revision for a second admin, never the requester (H1)', async () => {
      const r = rig();
      const author = r.admin();
      const saved = await unwrap(
        r.types.save.execute(author, {
          typeId: r.typeId,
          version: 1,
          content: contentOf({ requiresExpiry: false }),
        }),
      );
      expect(saved).toMatchObject({
        outcome: 'pending-second-admin',
        relaxations: ['expiry-no-longer-required'],
        version: 1,
      });
      expect(eventTypes(r)).toEqual(['certification.relaxation-proposed.v1']);
      const proposalId = saved.outcome === 'pending-second-admin' ? saved.proposalId : '';

      // Another save waits until this one is closed.
      expect(
        await refusal(
          r.types.save.execute(r.admin(), {
            typeId: r.typeId,
            version: 1,
            content: contentOf({ badgeIconKey: 'shield' }),
          }),
        ),
      ).toEqual({ code: 'review.proposal-pending' });

      // The author can neither approve nor reject; the panel sees why.
      const read = await unwrap(r.types.read.execute(author, { typeId: r.typeId }));
      expect(read.pendingRevision?.actions.approve).toEqual({
        allowed: false,
        code: 'review.second-admin-required',
      });
      expect(read.pendingRevision?.diff).toEqual([
        { path: 'requiresExpiry', before: true, after: false, relaxes: true },
      ]);
      expect(
        await refusal(
          r.types.approveRelaxation.execute(author, {
            typeId: r.typeId,
            proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.second-admin-required' });
      expect(
        await refusal(
          r.types.reject.execute(author, { subjectId: r.typeId, proposalId, version: 1 }),
        ),
      ).toEqual({ code: 'review.proposer-cannot-reject' });
      expect(r.registry.state.types.get(r.typeId)!.version).toBe(1);

      // A second admin approves: the revision is published.
      const approved = await unwrap(
        r.types.approveRelaxation.execute(r.admin(), {
          typeId: r.typeId,
          proposalId,
          version: 1,
        }),
      );
      expect(approved).toMatchObject({ state: 'approved', typeVersion: 2 });
      expect(r.registry.state.types.get(r.typeId)!.publishedRevisionId).toBe(saved.revisionId);
      expect(eventTypes(r)).toContain('certification.certification-type-revised.v1');
      expect(auditActions(r)).toEqual([
        'certification.type.relaxation-requested',
        'certification.type.relaxation-approved',
      ]);
    });

    it('lets only the requester withdraw a pending revision', async () => {
      const r = rig();
      const author = r.admin();
      const saved = await unwrap(
        r.types.save.execute(author, {
          typeId: r.typeId,
          version: 1,
          content: contentOf({ requiresDocument: false }),
        }),
      );
      const proposalId = saved.outcome === 'pending-second-admin' ? saved.proposalId : '';
      expect(
        await refusal(
          r.types.withdraw.execute(r.admin(), { subjectId: r.typeId, proposalId, version: 1 }),
        ),
      ).toEqual({ code: 'review.not-proposer' });
      expect(
        await unwrap(
          r.types.withdraw.execute(author, { subjectId: r.typeId, proposalId, version: 1 }),
        ),
      ).toMatchObject({ state: 'withdrawn' });
    });

    it('deactivates a type and reactivates it only with a second admin (H1)', async () => {
      const r = rig();
      const deactivated = await unwrap(
        r.types.deactivate.execute(r.admin(), { typeId: r.typeId, version: 1 }),
      );
      expect(deactivated).toEqual({ typeId: r.typeId, status: 'inactive', version: 2 });
      expect(eventTypes(r)).toEqual(['certification.certification-type-deactivated.v1']);
      expect(r.outbox.events[0]!.payload).toEqual({ typeId: r.typeId });
      expect(
        await refusal(r.types.deactivate.execute(r.admin(), { typeId: r.typeId, version: 2 })),
      ).toEqual({ code: 'type.already-inactive' });

      const requester = r.admin();
      const asked = await unwrap(
        r.types.requestReactivation.execute(requester, {
          typeId: r.typeId,
          version: 2,
          reason: 'Issuer list restored',
        }),
      );
      expect(r.registry.state.types.get(r.typeId)!.status).toBe('inactive');
      expect(
        await refusal(
          r.types.approveReactivation.execute(requester, {
            typeId: r.typeId,
            proposalId: asked.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.second-admin-required' });
      expect(r.registry.state.types.get(r.typeId)!.status).toBe('inactive');

      const approved = await unwrap(
        r.types.approveReactivation.execute(r.admin(), {
          typeId: r.typeId,
          proposalId: asked.proposalId,
          version: 1,
        }),
      );
      expect(approved).toMatchObject({ status: 'active', typeVersion: 3 });
      expect(eventTypes(r)).toEqual([
        'certification.certification-type-deactivated.v1',
        'certification.relaxation-proposed.v1',
        'certification.certification-type-activated.v1',
      ]);
      expect(auditActions(r)).toEqual([
        'certification.type.deactivated',
        'certification.type.reactivation-requested',
        'certification.type.reactivation-approved',
      ]);
      expect(JSON.stringify([r.audit.entries, r.outbox.events, logs])).not.toContain(
        'Issuer list restored',
      );
    });

    it('refuses writes in a Login as Seller session', async () => {
      const r = rig();
      expect(
        await refusal(r.types.deactivate.execute(r.admin(true), { typeId: r.typeId, version: 1 })),
      ).toEqual({ code: 'access.denied' });
    });
  });

  describe('issuers', () => {
    it('creates proposed, activates only with an expert reference (AC 19)', async () => {
      const r = rig();
      const by = r.admin();
      const created = await unwrap(
        r.issuers.create.execute(by, { typeId: r.typeId, displayName: 'Example Certifiers' }),
      );
      expect(created).toMatchObject({ state: 'proposed', version: 1 });
      expect(
        await refusal(
          r.issuers.create.execute(by, { typeId: r.typeId, displayName: ' example  CERTIFIERS ' }),
        ),
      ).toEqual({ code: 'issuer.name-taken' });
      const issuerId = created.issuerId;
      expect(
        await refusal(r.issuers.activate.execute(by, { issuerId, version: 1, expertApproval: {} })),
      ).toMatchObject({ code: 'validation.failed' });
      const active = await unwrap(
        r.issuers.activate.execute(by, { issuerId, version: 1, expertApproval: EXPERT }),
      );
      expect(active).toMatchObject({ state: 'active', version: 2 });
      const stored = r.registry.state.issuers.get(issuerId)!;
      expect(stored.expertReferenceCiphertext).toBe(`x:${code}:issuer:${JSON.stringify(EXPERT)}`);
      const reference = await unwrap(r.issuers.reference.execute(by, { issuerId }));
      expect(reference).toEqual({ issuerId, current: EXPERT, pendingReactivation: null });
      expect(auditActions(r)).toEqual([
        'certification.issuer.created',
        'certification.issuer.activated',
        'certification.issuer.expert-reference-viewed',
      ]);
      expect(JSON.stringify([r.audit.entries, r.outbox.events, logs])).not.toContain('MEMO-2026');
    });

    it('form 1 closes an issuer to new certificates and publishes the event', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      const closed = await unwrap(
        r.issuers.closeToNew.execute(r.admin(), { issuerId, version: 2 }),
      );
      expect(closed).toMatchObject({ state: 'closed-to-new', version: 3 });
      expect(r.outbox.events.at(-1)).toMatchObject({
        type: 'certification.issuer-deactivated.v1',
        payload: { issuerId, form: 'closed-to-new' },
      });
      expect(auditActions(r)).toContain('certification.issuer.closed-to-new');
    });

    it('reactivates a closed issuer only with a new reference and a second admin (H1)', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      await unwrap(r.issuers.closeToNew.execute(r.admin(), { issuerId, version: 2 }));
      const requester = r.admin();
      expect(
        await refusal(
          r.issuers.requestReactivation.execute(requester, {
            issuerId,
            version: 3,
            expertApproval: { confirmedBy: 'Someone', reference: 'memo 2026 001' },
          }),
        ),
      ).toEqual({ code: 'issuer.expert-approval-not-new' });
      const asked = await unwrap(
        r.issuers.requestReactivation.execute(requester, {
          issuerId,
          version: 3,
          expertApproval: NEW_EXPERT,
        }),
      );
      expect(asked).toMatchObject({ state: 'closed-to-new' });
      expect(
        await refusal(
          r.issuers.requestReactivation.execute(r.admin(), {
            issuerId,
            version: 3,
            expertApproval: { confirmedBy: 'Third', reference: 'MEMO-9' },
          }),
        ),
      ).toEqual({ code: 'review.proposal-pending' });

      // The requester may not approve; nothing changes.
      expect(
        await refusal(
          r.issuers.approveReactivation.execute(requester, {
            issuerId,
            proposalId: asked.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.second-admin-required' });
      expect(r.registry.state.issuers.get(issuerId)!.state).toBe('closed-to-new');

      // The second admin sees the new reference, then approves.
      const second = r.admin();
      const reference = await unwrap(r.issuers.reference.execute(second, { issuerId }));
      expect(reference.pendingReactivation).toEqual({
        proposalId: asked.proposalId,
        expertApproval: NEW_EXPERT,
      });
      const approved = await unwrap(
        r.issuers.approveReactivation.execute(second, {
          issuerId,
          proposalId: asked.proposalId,
          version: 1,
        }),
      );
      expect(approved).toMatchObject({ state: 'active', issuerVersion: 4 });
      const stored = r.registry.state.issuers.get(issuerId)!;
      expect(stored.state).toBe('active');
      expect(stored.expertReferenceCiphertext).toBe(
        `x:${code}:issuer:${JSON.stringify(NEW_EXPERT)}`,
      );
      expect(r.registry.state.proposals.get(asked.proposalId)!.decidedByAccountId).toBe(
        (second.actor as { accountId: string }).accountId,
      );
      expect(auditActions(r)).toEqual(
        expect.arrayContaining([
          'certification.issuer.reactivation-requested',
          'certification.issuer.reactivation-approved',
        ]),
      );
    });

    it('form 2 refuses a confirmation count that is not the current one', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      r.registry.approve(issuerId, r.ids.next<'Seller'>());
      const read = await unwrap(r.issuers.read.execute(r.admin(), { issuerId }));
      expect(read.affectedCertificates).toBe(1);
      expect(
        await refusal(
          r.issuers.derecognise.execute(r.admin(), {
            issuerId,
            version: 2,
            affectedCertificates: 0,
          }),
        ),
      ).toEqual({ code: 'issuer.confirmation-count-mismatch' });
      expect(r.registry.state.issuers.get(issuerId)!.state).toBe('active');
      expect(r.outbox.events.map((e) => e.type)).not.toContain(
        'certification.issuer-deactivated.v1',
      );
    });

    it('form 2 rolls back when an approval lands between the count and the lock', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      r.registry.approve(issuerId, r.ids.next<'Seller'>());
      r.registry.onCount = () => r.registry.approve(issuerId, r.ids.next<'Seller'>());
      expect(
        await refusal(
          r.issuers.derecognise.execute(r.admin(), {
            issuerId,
            version: 2,
            affectedCertificates: 1,
          }),
        ),
      ).toEqual({ code: 'issuer.confirmation-count-mismatch' });
      expect(r.registry.state.issuers.get(issuerId)!.state).toBe('active');
      expect(r.audit.entries.map((e) => e.action)).not.toContain(
        'certification.issuer.derecognised',
      );
    });

    it('form 2 derecognises for good, supersedes a pending reactivation and mails each seller once', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      await unwrap(r.issuers.closeToNew.execute(r.admin(), { issuerId, version: 2 }));
      const asked = await unwrap(
        r.issuers.requestReactivation.execute(r.admin(), {
          issuerId,
          version: 3,
          expertApproval: NEW_EXPERT,
        }),
      );
      const sellerA = r.ids.next<'Seller'>();
      const sellerB = r.ids.next<'Seller'>();
      r.registry.approve(issuerId, sellerA);
      r.registry.approve(issuerId, sellerB);
      r.contacts.set(sellerA, 'owner-a@example.test');
      r.contacts.set(sellerB, null);

      const done = await unwrap(
        r.issuers.derecognise.execute(r.admin(), {
          issuerId,
          version: 3,
          affectedCertificates: 2,
        }),
      );
      expect(done).toEqual({
        issuerId,
        state: 'derecognised',
        version: 4,
        affectedCertificates: 2,
      });
      expect(r.registry.state.proposals.get(asked.proposalId)!.state).toBe('superseded');
      const event = r.outbox.events.at(-1)!;
      expect(event).toMatchObject({
        type: 'certification.issuer-deactivated.v1',
        payload: { issuerId, form: 'derecognised' },
      });
      expect(r.audit.entries.at(-1)).toMatchObject({
        action: 'certification.issuer.derecognised',
        after: { affectedCertificates: 2, supersededProposalId: asked.proposalId },
      });

      // Terminal: no way back.
      expect(
        await refusal(
          r.issuers.requestReactivation.execute(r.admin(), {
            issuerId,
            version: 4,
            expertApproval: { confirmedBy: 'Late', reference: 'MEMO-LATE' },
          }),
        ),
      ).toMatchObject({ code: 'issuer.transition-forbidden' });
      expect(
        await refusal(r.issuers.closeToNew.execute(r.admin(), { issuerId, version: 4 })),
      ).toMatchObject({ code: 'issuer.transition-forbidden' });

      // The mail: one per seller with an address; a repeated delivery mails nobody again.
      const system = testCallContext(market, 'system');
      const delivery = r.delivery();
      const mailed = await unwrap(
        r.mail.execute(system, { delivery, issuerId, form: 'derecognised' }),
      );
      expect(mailed).toEqual({ code: 'derecognition-mail.sent', sent: 1, skipped: 1 });
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]).toMatchObject({ to: 'owner-a@example.test' });
      expect(r.sent[0]!.text).toContain('Example Certifiers');
      expect(r.sent[0]!.text).not.toContain('MEMO');
      const again = await unwrap(
        r.mail.execute(system, { delivery, issuerId, form: 'derecognised' }),
      );
      expect(again).toEqual({ code: 'derecognition-mail.already-handled' });
    });

    it('sends no mail for form 1 and refuses a non-system caller', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      r.registry.approve(issuerId, r.ids.next<'Seller'>());
      const system = testCallContext(market, 'system');
      const answer = await unwrap(
        r.mail.execute(system, { delivery: r.delivery(), issuerId, form: 'closed-to-new' }),
      );
      expect(answer).toEqual({ code: 'derecognition-mail.not-applicable' });
      expect(r.sent).toHaveLength(0);
      expect(
        await refusal(
          r.mail.execute(r.admin(), { delivery: r.delivery(), issuerId, form: 'derecognised' }),
        ),
      ).toEqual({ code: 'access.denied' });
    });

    it('does not see an issuer of another Market', async () => {
      const r = rig();
      const issuerId = await activeIssuer(r, r.admin());
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      const foreign = testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: r.ids.next<'Account'>(),
          sessionId: r.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      expect(await refusal(r.issuers.read.execute(foreign, { issuerId }))).toEqual({
        code: 'issuer.not-found',
      });
    });
  });
});
