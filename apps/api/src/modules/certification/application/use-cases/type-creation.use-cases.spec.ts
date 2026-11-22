import { loadBadgeArtworkKeys } from '../../infrastructure/badge-artwork-keys';
import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
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
import { RecordingReview } from '../../../../../test/support/system-request-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import type { TypeRevisionContent } from '../../domain/type-revision';
import type { RegistryDependencies } from '../registry/registry.shared';
import { TypeApproveCreation } from './type-approve-creation.use-case';
import { TypeCreate } from './type-create.use-case';
import { TypeDeactivate } from './type-deactivate.use-case';
import { TypeNewOptions } from './type-new-options.use-case';
import { TypeProposalReject } from './type-proposal-reject.use-case';
import { TypeProposalWithdraw } from './type-proposal-withdraw.use-case';
import { TypeRead } from './type-read.use-case';
import { TypeSaveRevision } from './type-save-revision.use-case';
import { TypesList } from './types-list.use-case';

// Add a new certificate type from the admin panel (FE-091; new-type design 2, 5): an admin
// proposes, a second admin approves, rejects, or the proposer withdraws or changes the proposal.
// In memory, on both Market fixtures, with the real gate; the SQL is in
// test/db/certification-registry.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-23T00:00:00Z');

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

describe('new type access declarations (H1)', () => {
  it('needs the protected type edit key to propose, approve or read the form options', () => {
    for (const useCase of [TypeCreate, TypeApproveCreation, TypeNewOptions]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CERTIFICATION_TYPE_EDIT.key],
      });
    }
    expect(CERTIFICATION_TYPE_EDIT.protected).toBe(true);
  });
});

describe.each(['AU', 'ZZ'] as const)('a new certification type in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = markets.get(market.marketId).supportedLocales;

  const contentOf = (overrides: Partial<TypeRevisionContent> = {}): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: true,
    defaultBasis: 'SELLER_REQUIRED',
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'text',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        {
          name: 'Wyndrel',
          customerDescription: 'The seller holds a Wyndrel certificate the platform reviewed.',
          claimTerms: ['wyndrel', 'wyndrel seal'],
        },
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
      review: new RecordingReview(),
      supportedLocales: (m) => markets.get(m.marketId).supportedLocales,
      badgeArtworkKeys: loadBadgeArtworkKeys(),
    };
    // A type the Market already has, and a seed code that has no type yet.
    registry.addType(
      market,
      { id: ids.next<'CertificationType'>(), code: 'qorvane', status: 'active' },
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
    return {
      registry,
      audit,
      outbox,
      cipher,
      admin,
      create: new TypeCreate(gate, { ...deps, reservedTypeCodes: () => ['qorvane', 'zedvale'] }),
      approve: new TypeApproveCreation(gate, deps),
      save: new TypeSaveRevision(gate, deps),
      reject: new TypeProposalReject(gate, deps),
      withdraw: new TypeProposalWithdraw(gate, deps),
      read: new TypeRead(gate, deps),
      list: new TypesList(gate, deps),
      deactivate: new TypeDeactivate(gate, deps),
      options: new TypeNewOptions(gate, deps),
    };
  }
  type Rig = ReturnType<typeof rig>;

  const eventTypes = (r: Rig): string[] => r.outbox.events.map((e) => e.type);
  const auditActions = (r: Rig): string[] => r.audit.entries.map((e) => e.action);

  async function proposed(r: Rig, by: CallContext, reason?: string) {
    return unwrap(
      r.create.execute(by, { code: 'wyndrel', content: contentOf(), reason: reason ?? undefined }),
    );
  }

  it('proposes a type that no one outside the registry sees, with its audit row and event', async () => {
    const r = rig();
    const proposer = r.admin();
    const created = await proposed(r, proposer, 'Organic sellers asked');
    expect(created).toMatchObject({ status: 'proposed', proposalVersion: 1 });
    const typeId = created.typeId as Parameters<MemoryRegistry['type']>[1];

    // Invisible to every other path (sellers, issuers, claim policies): not a live type.
    expect(await r.registry.type(market, typeId)).toBeNull();
    expect((await r.registry.typeOfAnyStatus(market, typeId))?.status).toBe('proposed');

    expect(auditActions(r)).toEqual(['certification.type.proposed']);
    expect(r.audit.entries[0]!.after).toEqual({
      proposalId: created.proposalId,
      revisionId: created.revisionId,
      revisionNo: 1,
      reasonGiven: true,
    });
    // No relaxation-proposed.v1: its subject enum does not name a type creation.
    expect(eventTypes(r)).toEqual([]);
    expect(JSON.stringify([r.audit.entries, r.outbox.events, logs])).not.toContain(
      'Organic sellers asked',
    );

    // The admin list shows it; the page carries the pending creation and who may do what.
    const list = await unwrap(r.list.execute(r.admin(), {}));
    expect(list.items.map((i) => [i.code, i.status, i.pending])).toEqual([
      ['qorvane', 'active', []],
      ['wyndrel', 'proposed', ['type-creation']],
    ]);
    const asProposer = await unwrap(r.read.execute(proposer, { typeId }));
    expect(asProposer.status).toBe('proposed');
    expect(asProposer.pendingCreation).toMatchObject({
      id: created.proposalId,
      subject: 'type-creation',
      reason: { state: 'given', text: 'Organic sellers asked' },
      version: 1,
      actions: {
        approve: { allowed: false, code: 'review.second-admin-required' },
        reject: { allowed: false, code: 'review.proposer-cannot-reject' },
        withdraw: { allowed: true },
      },
    });
    const asOther = await unwrap(r.read.execute(r.admin(), { typeId }));
    expect(asOther.pendingCreation?.actions).toEqual({
      approve: { allowed: true },
      reject: { allowed: true },
      withdraw: { allowed: false, code: 'review.not-proposer' },
    });
  });

  it('refuses a seed code, a taken code, a malformed code and invalid content', async () => {
    const r = rig();
    const by = r.admin();
    expect(await refusal(r.create.execute(by, { code: 'zedvale', content: contentOf() }))).toEqual({
      code: 'type.code-reserved',
    });
    // A taken code that is not a seed code: propose, withdraw, and the code stays taken.
    const first = await proposed(r, by);
    await unwrap(
      r.withdraw.execute(by, { subjectId: first.typeId, proposalId: first.proposalId, version: 1 }),
    );
    expect(await refusal(r.create.execute(by, { code: 'wyndrel', content: contentOf() }))).toEqual({
      code: 'type.code-taken',
    });
    for (const bad of ['W', 'Wyndrel', '1abc', 'a b', 42]) {
      expect(
        await refusal(r.create.execute(by, { code: bad, content: contentOf() })),
      ).toMatchObject({ code: 'validation.failed' });
    }
    expect(
      await refusal(
        r.create.execute(by, { code: 'brelith', content: contentOf({ requiresDocument: false }) }),
      ),
    ).toEqual({ code: 'type.revision-invalid', issues: [{ code: 'type.document-required' }] });
    expect(
      await refusal(
        r.create.execute(by, { code: 'brelith', content: contentOf({ badgeIconKey: 'shield' }) }),
      ),
    ).toEqual({ code: 'type.revision-invalid', issues: [{ code: 'type.badge-icon-invalid' }] });
    // Nothing of a refused proposal was kept.
    expect([...r.registry.state.types.values()].map((t) => t.code).sort()).toEqual([
      'qorvane',
      'wyndrel',
    ]);
  });

  it('is approved only by a second admin, and the type is then live', async () => {
    const r = rig();
    const proposer = r.admin();
    const created = await proposed(r, proposer);
    const input = { typeId: created.typeId, proposalId: created.proposalId, version: 1 };
    expect(await refusal(r.approve.execute(proposer, input))).toEqual({
      code: 'review.second-admin-required',
    });
    const approved = await unwrap(r.approve.execute(r.admin(), input));
    expect(approved).toEqual({
      typeId: created.typeId,
      proposalId: created.proposalId,
      status: 'active',
      typeVersion: 2,
    });
    const typeId = created.typeId as Parameters<MemoryRegistry['type']>[1];
    expect((await r.registry.type(market, typeId))?.status).toBe('active');
    expect(r.registry.state.proposals.get(created.proposalId)!.state).toBe('approved');
    expect(auditActions(r)).toEqual(['certification.type.proposed', 'certification.type.created']);
    expect(eventTypes(r)).toEqual(['certification.certification-type-activated.v1']);
    // Approved once: a second approval is refused and changes nothing.
    expect(await refusal(r.approve.execute(r.admin(), input))).toEqual({
      code: 'type.not-proposed',
    });
  });

  it('lets only the proposer change it, and an approval of the earlier content is stale', async () => {
    const r = rig();
    const proposer = r.admin();
    const created = await proposed(r, proposer);
    const changed = contentOf({ requiresExpiry: false });
    expect(
      await refusal(
        r.save.execute(r.admin(), { typeId: created.typeId, version: 1, content: changed }),
      ),
    ).toEqual({ code: 'review.not-proposer' });

    const revised = await unwrap(
      r.save.execute(proposer, {
        typeId: created.typeId,
        version: 1,
        content: changed,
        reason: 'No expiry for this one',
      }),
    );
    expect(revised).toMatchObject({
      outcome: 'proposal-revised',
      revisionNo: 2,
      version: 2,
      proposalVersion: 1,
      request: null,
    });
    const next = revised.outcome === 'proposal-revised' ? revised.proposalId : '';
    expect(r.registry.state.proposals.get(created.proposalId)!.state).toBe('superseded');
    expect(auditActions(r)).toEqual([
      'certification.type.proposed',
      'certification.type.proposal-revised',
    ]);

    // The second admin read the first proposal: stale, and the type stays proposed.
    const second = r.admin();
    expect(
      await refusal(
        r.approve.execute(second, {
          typeId: created.typeId,
          proposalId: created.proposalId,
          version: 1,
        }),
      ),
    ).toEqual({ code: 'conflict.stale' });
    const read = await unwrap(r.read.execute(second, { typeId: created.typeId }));
    expect(read.status).toBe('proposed');
    expect(read.published.content.requiresExpiry).toBe(false);
    expect(read.pendingCreation).toMatchObject({
      id: next,
      reason: { state: 'given', text: 'No expiry for this one' },
    });
    expect(
      await unwrap(
        r.approve.execute(second, { typeId: created.typeId, proposalId: next, version: 1 }),
      ),
    ).toMatchObject({ status: 'active', typeVersion: 3 });
  });

  it('is rejected by another admin or withdrawn by the proposer, for good', async () => {
    const r = rig();
    const proposer = r.admin();
    const first = await proposed(r, proposer);
    expect(
      await refusal(
        r.reject.execute(proposer, {
          subjectId: first.typeId,
          proposalId: first.proposalId,
          version: 1,
        }),
      ),
    ).toEqual({ code: 'review.proposer-cannot-reject' });
    await unwrap(
      r.reject.execute(r.admin(), {
        subjectId: first.typeId,
        proposalId: first.proposalId,
        version: 1,
      }),
    );
    expect(r.registry.state.types.get(first.typeId)!.status).toBe('rejected');

    const second = await unwrap(
      r.create.execute(proposer, { code: 'brelith', content: contentOf() }),
    );
    await unwrap(
      r.withdraw.execute(proposer, {
        subjectId: second.typeId,
        proposalId: second.proposalId,
        version: 1,
      }),
    );
    expect(r.registry.state.types.get(second.typeId)!.status).toBe('withdrawn');
    expect(auditActions(r)).toEqual([
      'certification.type.proposed',
      'certification.relaxation-proposal.rejected',
      'certification.type.proposed',
      'certification.relaxation-proposal.withdrawn',
    ]);

    // Hidden from the list unless asked for; read-only for everyone.
    const visible = await unwrap(r.list.execute(r.admin(), {}));
    expect(visible.items.map((i) => i.code)).toEqual(['qorvane']);
    const all = await unwrap(r.list.execute(r.admin(), { closed: true }));
    expect(all.items.map((i) => [i.code, i.status])).toEqual([
      ['brelith', 'withdrawn'],
      ['qorvane', 'active'],
      ['wyndrel', 'rejected'],
    ]);
    expect(await refusal(r.list.execute(r.admin(), { closed: 'yes' }))).toMatchObject({
      code: 'validation.failed',
    });
    const read = await unwrap(r.read.execute(r.admin(), { typeId: first.typeId }));
    expect(read).toMatchObject({ status: 'rejected', pendingCreation: null });
    expect(
      await refusal(
        r.save.execute(proposer, { typeId: first.typeId, version: 2, content: contentOf() }),
      ),
    ).toEqual({ code: 'type.proposal-closed' });
    expect(
      await refusal(
        r.approve.execute(r.admin(), {
          typeId: first.typeId,
          proposalId: first.proposalId,
          version: 2,
        }),
      ),
    ).toEqual({ code: 'type.proposal-closed' });
    // Only a live type is deactivated.
    expect(
      await refusal(r.deactivate.execute(r.admin(), { typeId: first.typeId, version: 2 })),
    ).toEqual({ code: 'type.not-found' });
  });

  it('refuses every write in a Login as Seller session', async () => {
    const r = rig();
    expect(
      await refusal(r.create.execute(r.admin(true), { code: 'wyndrel', content: contentOf() })),
    ).toEqual({ code: 'access.denied' });
    const created = await proposed(r, r.admin());
    expect(
      await refusal(
        r.approve.execute(r.admin(true), {
          typeId: created.typeId,
          proposalId: created.proposalId,
          version: 1,
        }),
      ),
    ).toEqual({ code: 'access.denied' });
  });

  it('offers the Market locales, the artwork that exists and the limits', async () => {
    const r = rig();
    expect(await unwrap(r.options.execute(r.admin(), {}))).toEqual({
      locales: [...locales],
      verificationModes: ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'],
      defaultBases: ['SELLER_REQUIRED', 'NOT_APPLICABLE'],
      badgeArtworkKeys: [...loadBadgeArtworkKeys()],
      limits: {
        codeMinLength: 2,
        codeMaxLength: 32,
        nameMaxLength: 80,
        descriptionMaxLength: 500,
        claimTermsPerLocale: 200,
        claimTermMaxLength: 100,
        reasonMaxLength: 500,
      },
    });
  });
});
