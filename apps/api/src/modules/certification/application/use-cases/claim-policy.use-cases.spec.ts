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
  FakeCatalogReferences,
  MemoryClaimPolicies,
} from '../../../../../test/support/certification-claim-policy-fakes';
import {
  FakeRegistryCipher,
  MemoryRegistry,
} from '../../../../../test/support/certification-registry-fakes';
import { RecordingAudit } from '../../../../../test/support/certification-review-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  CERTIFICATION_CLAIM_POLICY_EDIT,
  CERTIFICATION_CLAIM_POLICY_VIEW,
} from '../../contracts/permissions';
import type { TypeDefaultBasis, TypeRevisionContent } from '../../domain/type-revision';
import type { ClaimPolicyDependencies } from '../registry/claim-policy.shared';
import { ClaimPolicyApproveRelaxation } from './claim-policy-approve-relaxation.use-case';
import { ClaimPolicyProposalReject } from './claim-policy-proposal-reject.use-case';
import { ClaimPolicyProposalWithdraw } from './claim-policy-proposal-withdraw.use-case';
import { ClaimPolicyRead } from './claim-policy-read.use-case';
import { ClaimPolicySaveRevision } from './claim-policy-save-revision.use-case';

// The claim basis policy use cases in memory (certification design 3.7, 7.2, 7.6; CERT-42;
// ADR-0012 d2; H1; slice 13), on both Market fixtures, with the real gate, a store that rolls back
// like a transaction and catalog's references as a fake. The SQL is in
// test/db/certification-claim-policy.db-spec.ts, the routes in test/certification-claim-policy.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-18T00:00:00Z');

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

describe('claim policy access declarations (H1)', () => {
  it('needs the protected edit key for every write and approval, the view key to read', () => {
    for (const type of [
      ClaimPolicySaveRevision,
      ClaimPolicyApproveRelaxation,
      ClaimPolicyProposalReject,
      ClaimPolicyProposalWithdraw,
    ]) {
      expect(type.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_CLAIM_POLICY_EDIT.key],
      });
    }
    expect(ClaimPolicyRead.access.rule).toEqual({
      kind: 'permissions',
      allOf: [CERTIFICATION_CLAIM_POLICY_VIEW.key],
    });
    expect(CERTIFICATION_CLAIM_POLICY_EDIT.protected).toBe(true);
    expect(CERTIFICATION_CLAIM_POLICY_VIEW.protected).toBe(false);
  });
});

describe.each(['AU', 'ZZ'] as const)('claim basis policy in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = markets.get(market.marketId).supportedLocales;

  const contentOf = (defaultBasis: TypeDefaultBasis): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: true,
    defaultBasis,
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'seal',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        { name: 'Qorvane', customerDescription: 'Holds a certificate.', claimTerms: ['qorvane'] },
      ]),
    ),
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

  function rig(defaultBasis: TypeDefaultBasis = 'SELLER_REQUIRED') {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const registry = new MemoryRegistry();
    const policies = new MemoryClaimPolicies(registry);
    const catalog = new FakeCatalogReferences();
    const cipher = new FakeRegistryCipher();
    const audit = new RecordingAudit();
    const outbox = new MemoryOutbox();
    const deps: ClaimPolicyDependencies = {
      unitOfWork: policies.unitOfWork,
      registry,
      policies,
      catalog,
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
      { id: ids.next<'CertificationTypeRevision'>(), content: contentOf(defaultBasis) },
      T0,
      'seed',
    );
    const food = ids.next<'Category'>();
    const drinks = ids.next<'Category'>();
    catalog.add(market, food);
    catalog.add(market, drinks);
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
    return {
      ids,
      registry,
      policies,
      catalog,
      cipher,
      audit,
      outbox,
      typeId,
      food,
      drinks,
      admin,
      save: new ClaimPolicySaveRevision(gate, deps),
      read: new ClaimPolicyRead(gate, deps),
      approve: new ClaimPolicyApproveRelaxation(gate, deps),
      reject: new ClaimPolicyProposalReject(gate, deps),
      withdraw: new ClaimPolicyProposalWithdraw(gate, deps),
    };
  }
  type Rig = ReturnType<typeof rig>;

  const category = (categoryId: string, basis: string) => ({
    selector: 'platform-category',
    categoryId,
    basis,
  });
  const handling = (value: string, basis: string) => ({
    selector: 'handling',
    handling: value,
    basis,
  });
  const eventTypes = (r: Rig): string[] => r.outbox.events.map((e) => e.type);
  const auditActions = (r: Rig): string[] => r.audit.entries.map((e) => e.action);

  /** A first, tightening revision (NOT_APPLICABLE on food), published at once. */
  async function published(r: Rig, by: CallContext) {
    return unwrap(
      r.save.execute(by, {
        typeId: r.typeId,
        version: 0,
        rows: [category(r.food, 'NOT_APPLICABLE')],
      }),
    );
  }

  describe('save', () => {
    it('publishes a first tightening revision at once: creates the policy, audit, claim-policy-changed.v1', async () => {
      const r = rig();
      const by = r.admin();
      const saved = await unwrap(
        r.save.execute(by, {
          typeId: r.typeId,
          version: 0,
          rows: [category(r.food, 'NOT_APPLICABLE'), handling('PREPARED', 'NOT_APPLICABLE')],
          reason: 'Prepared food is out of scope.',
        }),
      );
      expect(saved).toMatchObject({ outcome: 'published', revisionNo: 1, version: 2 });
      expect(saved.changes.every((c) => !c.relaxes)).toBe(true);
      const policy = await r.policies.policyOfType(market, r.typeId);
      expect(policy).toEqual({
        id: saved.policyId,
        typeId: r.typeId,
        publishedRevisionId: saved.revisionId,
        version: 2,
      });
      expect(auditActions(r)).toEqual(['certification.claim-policy.revised']);
      expect(r.audit.entries[0]).toMatchObject({
        targetType: 'certification.claim-policy',
        targetId: saved.policyId,
        after: { typeId: r.typeId, revisionId: saved.revisionId, reasonGiven: true },
      });
      expect(eventTypes(r)).toEqual(['certification.claim-policy-changed.v1']);
      expect(r.outbox.events[0]!.payload).toEqual({
        policyId: saved.policyId,
        revisionId: saved.revisionId,
        typeId: r.typeId,
      });
      // The reason is sealed under the revision id and never logged or audited in clear.
      expect(r.cipher.reasonKeys).toEqual([saved.revisionId]);
      expect(JSON.stringify([r.audit.entries, r.outbox.events, logs])).not.toContain(
        'out of scope',
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: 'certification.claim-policy-revision.saved',
          outcome: 'published',
          marketId: market.marketId,
          correlationId: by.correlationId,
        }),
      );
    });

    it('asks catalog only for the categories a revision adds or changes', async () => {
      const r = rig();
      const by = r.admin();
      const first = await published(r, by);
      r.catalog.calls.length = 0;
      await unwrap(
        r.save.execute(by, {
          typeId: r.typeId,
          version: first.version,
          rows: [category(r.food, 'NOT_APPLICABLE'), category(r.drinks, 'NOT_APPLICABLE')],
        }),
      );
      expect(r.catalog.calls).toEqual([[r.drinks]]);
    });

    it('a relaxing first revision (manufacturer basis on a category) waits for a second admin; nothing is published', async () => {
      const r = rig();
      const by = r.admin();
      const saved = await unwrap(
        r.save.execute(by, {
          typeId: r.typeId,
          version: 0,
          rows: [category(r.food, 'SELLER_OR_MANUFACTURER')],
          reason: 'Sealed imports.',
        }),
      );
      expect(saved).toMatchObject({ outcome: 'pending-second-admin', revisionNo: 1, version: 1 });
      expect(saved.changes).toEqual([
        { path: `row:${r.food}`, before: null, after: 'SELLER_OR_MANUFACTURER', relaxes: true },
      ]);
      expect((await r.policies.policyOfType(market, r.typeId))?.publishedRevisionId).toBeNull();
      expect(auditActions(r)).toEqual(['certification.claim-policy.relaxation-requested']);
      expect(eventTypes(r)).toEqual(['certification.relaxation-proposed.v1']);
      expect(r.outbox.events[0]!.payload).toEqual({
        proposalId: (saved as { proposalId: string }).proposalId,
        subject: 'claim-policy-revision',
      });
      const proposal = await r.registry.pendingProposal(
        market,
        'claim-policy-revision',
        saved.policyId,
      );
      expect(proposal).toMatchObject({
        basedOnRevisionId: null,
        proposedRevisionId: saved.revisionId,
        proposerAccountId: by.actor.kind === 'authenticated' ? by.actor.accountId : null,
        changeReasonCiphertext: null,
      });
    });

    it('classifies against the published rows: removing a non-manufacturer row or loosening a basis relaxes, tightening does not', async () => {
      const r = rig();
      const by = r.admin();
      const first = await published(r, by);
      const removed = await unwrap(
        r.save.execute(by, { typeId: r.typeId, version: first.version, rows: [] }),
      );
      expect(removed).toMatchObject({ outcome: 'pending-second-admin' });
      await unwrap(
        r.withdraw.execute(by, {
          subjectId: r.typeId,
          proposalId: (removed as { proposalId: string }).proposalId,
          version: 1,
        }),
      );
      const loosened = await unwrap(
        r.save.execute(by, {
          typeId: r.typeId,
          version: first.version,
          rows: [category(r.food, 'SELLER_REQUIRED')],
        }),
      );
      expect(loosened).toMatchObject({ outcome: 'pending-second-admin' });
    });

    it('a row equal to or stricter than the default is no relaxation; one looser than a NOT_APPLICABLE default is', async () => {
      const strict = rig('SELLER_REQUIRED');
      expect(
        await unwrap(
          strict.save.execute(strict.admin(), {
            typeId: strict.typeId,
            version: 0,
            rows: [category(strict.food, 'SELLER_REQUIRED')],
          }),
        ),
      ).toMatchObject({ outcome: 'published' });
      const closed = rig('NOT_APPLICABLE');
      expect(
        await unwrap(
          closed.save.execute(closed.admin(), {
            typeId: closed.typeId,
            version: 0,
            rows: [category(closed.food, 'SELLER_REQUIRED')],
          }),
        ),
      ).toMatchObject({ outcome: 'pending-second-admin' });
    });

    it('refuses the manufacturer basis on a handling row (M1), duplicates and unknown fields, before any read', async () => {
      const r = rig();
      const by = r.admin();
      expect(
        await refusal(
          r.save.execute(by, {
            typeId: r.typeId,
            version: 0,
            rows: [handling('SEALED_ORIGINAL', 'SELLER_OR_MANUFACTURER')],
          }),
        ),
      ).toEqual({
        code: 'claim-policy.revision-invalid',
        issues: [{ path: 'rows[0].basis', code: 'manufacturer-basis-on-handling' }],
      });
      expect(
        await refusal(
          r.save.execute(by, {
            typeId: r.typeId,
            version: 0,
            rows: [category(r.food, 'NOT_APPLICABLE'), category(r.food, 'SELLER_REQUIRED')],
          }),
        ),
      ).toMatchObject({ code: 'claim-policy.revision-invalid' });
      expect(
        await refusal(
          r.save.execute(by, {
            typeId: r.typeId,
            version: 0,
            rows: [{ ...category(r.food, 'NOT_APPLICABLE'), sellerId: 'x' }],
          }),
        ),
      ).toEqual({
        code: 'claim-policy.revision-invalid',
        issues: [{ path: 'rows[0].sellerId', code: 'unknown-field' }],
      });
      expect(r.catalog.calls).toEqual([]);
      expect(await r.policies.policyOfType(market, r.typeId)).toBeNull();
    });

    it('refuses a category that is not an active platform category of the Market, at its position', async () => {
      const r = rig();
      const ghost = r.ids.next<'Category'>();
      expect(
        await refusal(
          r.save.execute(r.admin(), {
            typeId: r.typeId,
            version: 0,
            rows: [category(r.food, 'NOT_APPLICABLE'), category(ghost, 'NOT_APPLICABLE')],
          }),
        ),
      ).toEqual({
        code: 'claim-policy.revision-invalid',
        issues: [{ path: 'rows[1].categoryId', code: 'category-unknown' }],
      });
      expect(await r.policies.policyOfType(market, r.typeId)).toBeNull();
    });

    it('fails closed when catalog cannot answer (access.unavailable), nothing written', async () => {
      const r = rig();
      r.catalog.fail = true;
      expect(
        await refusal(
          r.save.execute(r.admin(), {
            typeId: r.typeId,
            version: 0,
            rows: [category(r.food, 'NOT_APPLICABLE')],
          }),
        ),
      ).toEqual({ code: 'access.unavailable' });
      expect(await r.policies.policyOfType(market, r.typeId)).toBeNull();
      expect(r.outbox.events).toEqual([]);
    });

    it('refuses an unchanged revision, a stale version, an unknown type and a save while a relaxation waits', async () => {
      const r = rig();
      const by = r.admin();
      const first = await published(r, by);
      expect(
        await refusal(
          r.save.execute(by, {
            typeId: r.typeId,
            version: first.version,
            rows: [category(r.food, 'NOT_APPLICABLE')],
          }),
        ),
      ).toEqual({ code: 'claim-policy.revision-unchanged' });
      expect(await refusal(r.save.execute(by, { typeId: r.typeId, version: 0, rows: [] }))).toEqual(
        { code: 'conflict.stale' },
      );
      expect(
        await refusal(
          r.save.execute(by, { typeId: r.ids.next<'CertificationType'>(), version: 0, rows: [] }),
        ),
      ).toEqual({ code: 'type.not-found' });
      await unwrap(r.save.execute(by, { typeId: r.typeId, version: first.version, rows: [] }));
      expect(
        await refusal(
          r.save.execute(r.admin(), {
            typeId: r.typeId,
            version: first.version,
            rows: [category(r.food, 'NOT_APPLICABLE'), category(r.drinks, 'NOT_APPLICABLE')],
          }),
        ),
      ).toEqual({ code: 'review.proposal-pending' });
    });

    it('locks first: a change committed between the read and the write is conflict.stale, and the unit rolls back', async () => {
      const r = rig();
      const by = r.admin();
      const first = await published(r, by);
      const eventsBefore = r.outbox.events.length;
      r.policies.beforeLock = () => {
        r.policies.state.policies.get(first.policyId)!.version += 1;
      };
      expect(
        await refusal(
          r.save.execute(by, {
            typeId: r.typeId,
            version: first.version,
            rows: [category(r.food, 'NOT_APPLICABLE'), category(r.drinks, 'NOT_APPLICABLE')],
          }),
        ),
      ).toEqual({ code: 'conflict.stale' });
      expect(r.outbox.events).toHaveLength(eventsBefore);
      expect(
        await r.policies.revisions(market, first.policyId as Id<'ClaimBasisPolicy'>, 50),
      ).toHaveLength(1);
    });

    it('refuses a caller acting as a seller and a seller actor', async () => {
      const r = rig();
      expect(
        await refusal(r.save.execute(r.admin(true), { typeId: r.typeId, version: 0, rows: [] })),
      ).toEqual({ code: 'access.denied' });
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: r.ids.next<'Account'>(),
          sessionId: r.ids.next<'Session'>(),
          sellerId: r.ids.next<'Seller'>(),
        }),
      );
      expect(
        await refusal(r.save.execute(seller, { typeId: r.typeId, version: 0, rows: [] })),
      ).toEqual({ code: 'access.denied' });
    });
  });

  describe('approve, reject, withdraw (H1)', () => {
    async function pending(r: Rig, by: CallContext) {
      const saved = await unwrap(
        r.save.execute(by, {
          typeId: r.typeId,
          version: 0,
          rows: [category(r.food, 'SELLER_OR_MANUFACTURER')],
          reason: 'Sealed imports.',
        }),
      );
      return saved as typeof saved & { proposalId: string };
    }

    it('a second admin publishes the relaxing revision: pointer, proposal approved, audit, claim-policy-changed.v1', async () => {
      const r = rig();
      const proposer = r.admin();
      const saved = await pending(r, proposer);
      const second = r.admin();
      const approved = await unwrap(
        r.approve.execute(second, {
          typeId: r.typeId,
          proposalId: saved.proposalId,
          version: 1,
        }),
      );
      expect(approved).toEqual({
        typeId: r.typeId,
        policyId: saved.policyId,
        proposalId: saved.proposalId,
        revisionId: saved.revisionId,
        state: 'approved',
        policyVersion: 2,
      });
      expect((await r.policies.policyOfType(market, r.typeId))?.publishedRevisionId).toBe(
        saved.revisionId,
      );
      expect(
        await r.registry.proposal(market, saved.proposalId as Id<'RelaxationProposal'>),
      ).toMatchObject({ state: 'approved', version: 2 });
      expect(auditActions(r)).toEqual([
        'certification.claim-policy.relaxation-requested',
        'certification.claim-policy.relaxation-approved',
      ]);
      expect(eventTypes(r)).toEqual([
        'certification.relaxation-proposed.v1',
        'certification.claim-policy-changed.v1',
      ]);
    });

    it('the proposer never approves their own relaxation (review.second-admin-required)', async () => {
      const r = rig();
      const proposer = r.admin();
      const saved = await pending(r, proposer);
      expect(
        await refusal(
          r.approve.execute(proposer, {
            typeId: r.typeId,
            proposalId: saved.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.second-admin-required' });
      expect((await r.policies.policyOfType(market, r.typeId))?.publishedRevisionId).toBeNull();
    });

    it('refuses a stale proposal version, a proposal addressed under another type and a base that moved', async () => {
      const r = rig();
      const proposer = r.admin();
      const saved = await pending(r, proposer);
      expect(
        await refusal(
          r.approve.execute(r.admin(), {
            typeId: r.typeId,
            proposalId: saved.proposalId,
            version: 7,
          }),
        ),
      ).toEqual({ code: 'conflict.stale' });
      expect(
        await refusal(
          r.approve.execute(r.admin(), {
            typeId: r.ids.next<'CertificationType'>(),
            proposalId: saved.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'proposal.not-found' });
      // A pointer that moved since the proposal (only possible by a race): stale.
      r.policies.state.policies.get(saved.policyId)!.publishedRevisionId =
        r.ids.next<'ClaimPolicyRevision'>();
      expect(
        await refusal(
          r.approve.execute(r.admin(), {
            typeId: r.typeId,
            proposalId: saved.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'conflict.stale' });
    });

    it('another admin rejects, the proposer withdraws; neither publishes and a new save is possible after', async () => {
      const r = rig();
      const proposer = r.admin();
      const saved = await pending(r, proposer);
      expect(
        await refusal(
          r.reject.execute(proposer, {
            subjectId: r.typeId,
            proposalId: saved.proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.proposer-cannot-reject' });
      expect(
        await unwrap(
          r.reject.execute(r.admin(), {
            subjectId: r.typeId,
            proposalId: saved.proposalId,
            version: 1,
          }),
        ),
      ).toMatchObject({ state: 'rejected' });
      expect((await r.policies.policyOfType(market, r.typeId))?.publishedRevisionId).toBeNull();

      const again = await unwrap(
        r.save.execute(proposer, {
          typeId: r.typeId,
          version: 1,
          rows: [category(r.food, 'SELLER_OR_MANUFACTURER')],
        }),
      );
      expect(again).toMatchObject({ outcome: 'pending-second-admin', revisionNo: 2 });
      expect(
        await refusal(
          r.withdraw.execute(r.admin(), {
            subjectId: r.typeId,
            proposalId: (again as { proposalId: string }).proposalId,
            version: 1,
          }),
        ),
      ).toEqual({ code: 'review.not-proposer' });
      expect(
        await unwrap(
          r.withdraw.execute(proposer, {
            subjectId: r.typeId,
            proposalId: (again as { proposalId: string }).proposalId,
            version: 1,
          }),
        ),
      ).toMatchObject({ state: 'withdrawn' });
    });

    it('a type without a policy has no proposal to close', async () => {
      const r = rig();
      expect(
        await refusal(
          r.reject.execute(r.admin(), {
            subjectId: r.typeId,
            proposalId: r.ids.next<'RelaxationProposal'>(),
            version: 1,
          }),
        ),
      ).toEqual({ code: 'proposal.not-found' });
    });
  });

  describe('read', () => {
    it('shows the default, the published rows with the reason, a pending revision with its diff and actions, and the history', async () => {
      const r = rig();
      const proposer = r.admin();
      const first = await unwrap(
        r.save.execute(proposer, {
          typeId: r.typeId,
          version: 0,
          rows: [category(r.food, 'NOT_APPLICABLE')],
          reason: 'Food is out of scope.',
        }),
      );
      const relaxing = await unwrap(
        r.save.execute(proposer, {
          typeId: r.typeId,
          version: first.version,
          rows: [category(r.food, 'SELLER_OR_MANUFACTURER')],
          reason: 'Sealed imports.',
        }),
      );
      const reader = r.admin();
      const read = await unwrap(r.read.execute(reader, { typeId: r.typeId }));
      expect(read).toMatchObject({
        typeId: r.typeId,
        typeCode: 'qorvane',
        defaultBasis: 'SELLER_REQUIRED',
        policyId: first.policyId,
        version: first.version,
        published: {
          revisionId: first.revisionId,
          revisionNo: 1,
          rows: [{ selector: 'platform-category', categoryId: r.food, basis: 'NOT_APPLICABLE' }],
          reason: { state: 'given', text: 'Food is out of scope.' },
        },
        pendingRevision: {
          proposal: {
            subject: 'claim-policy-revision',
            subjectId: first.policyId,
            proposedRevisionId: relaxing.revisionId,
            reason: { state: 'given', text: 'Sealed imports.' },
            diff: [
              {
                path: `row:${r.food}`,
                before: 'NOT_APPLICABLE',
                after: 'SELLER_OR_MANUFACTURER',
                relaxes: true,
              },
            ],
            actions: { approve: { allowed: true }, reject: { allowed: true } },
          },
          rows: [
            { selector: 'platform-category', categoryId: r.food, basis: 'SELLER_OR_MANUFACTURER' },
          ],
        },
      });
      expect(read.history.map((h) => [h.revisionNo, h.published, h.reasonGiven])).toEqual([
        [2, false, true],
        [1, true, true],
      ]);
      // The proposer's own view: approval is refused to them.
      const own = await unwrap(r.read.execute(proposer, { typeId: r.typeId }));
      expect(own.pendingRevision?.proposal.actions.approve).toEqual({
        allowed: false,
        code: 'review.second-admin-required',
      });
    });

    it('a type with no policy reads version 0 and nothing published; another Market sees nothing of it', async () => {
      const r = rig();
      expect(await unwrap(r.read.execute(r.admin(), { typeId: r.typeId }))).toEqual({
        typeId: r.typeId,
        typeCode: 'qorvane',
        defaultBasis: 'SELLER_REQUIRED',
        policyId: null,
        version: 0,
        published: null,
        pendingRevision: null,
        history: [],
      });
      await published(r, r.admin());
      const otherCode = code === 'AU' ? 'ZZ' : 'AU';
      const otherMarket = testMarketContext(otherCode, 'default');
      const otherAdmin = testCallContext(
        otherMarket,
        testAuthenticatedActor(otherMarket, {
          population: 'admin',
          accountId: r.ids.next<'Account'>(),
          sessionId: r.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      expect(await refusal(r.read.execute(otherAdmin, { typeId: r.typeId }))).toEqual({
        code: 'type.not-found',
      });
    });
  });
});
