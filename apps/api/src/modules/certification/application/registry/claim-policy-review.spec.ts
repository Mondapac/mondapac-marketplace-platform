import { loadBadgeArtworkKeys } from '../../infrastructure/badge-artwork-keys';
import { Logger } from '@nestjs/common';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
  FakeCatalogReferences,
  MemoryClaimPolicies,
} from '../../../../../test/support/certification-claim-policy-fakes';
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
import type { RevertRequest } from '../../../system-requests';
import { CERTIFICATION_CLAIM_POLICY_EDIT } from '../../contracts/permissions';
import type { TypeRevisionContent } from '../../domain/type-revision';
import { ClaimPolicyApproveRelaxation } from '../use-cases/claim-policy-approve-relaxation.use-case';
import { ClaimPolicyRead } from '../use-cases/claim-policy-read.use-case';
import { ClaimPolicySaveRevision } from '../use-cases/claim-policy-save-revision.use-case';
import { CLAIM_POLICY_SUBJECT_KIND } from './certification-review';
import type { ClaimPolicyDependencies } from './claim-policy.shared';
import { ClaimPolicyReverter } from './registry-reverters';

// Admin Inbox › System requests, area certification, for claim basis policies (CERT-42, ADR-0012
// d2), in memory on both Market fixtures. A published save only tightens, so restoring the rows
// before it always loosens: the reverter answers `not-permitted` and the request stays open (a
// revert never loosens enforcement; undoing a tightening is a relaxation for a second admin). The
// reverter's write path is shown on requests whose rows before are stricter, as the safety rule
// allows. The SQL and the real recorder are in test/db/certification-system-requests.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const REQUEST_ID = (() => {
  const parsed = parseId<'SystemRequest'>('01990000-0000-7000-8000-0000005e0bcd');
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
})();

async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe.each(['AU', 'ZZ'] as const)('claim policy reviews in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = markets.get(market.marketId).supportedLocales;

  const content: TypeRevisionContent = {
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
  };

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  function rig(reviewed = true) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const registry = new MemoryRegistry();
    const policies = new MemoryClaimPolicies(registry);
    const catalog = new FakeCatalogReferences();
    const audit = new RecordingAudit();
    const outbox = new MemoryOutbox();
    const review = new RecordingReview();
    if (reviewed) review.review('certification', 'medium');
    const deps: ClaimPolicyDependencies = {
      unitOfWork: policies.unitOfWork,
      registry,
      policies,
      catalog,
      cipher: new FakeRegistryCipher(),
      audit,
      outbox,
      clock,
      ids,
      review,
      supportedLocales: (m) => markets.get(m.marketId).supportedLocales,
      badgeArtworkKeys: loadBadgeArtworkKeys(),
    };
    const typeId = ids.next<'CertificationType'>();
    registry.addType(
      market,
      { id: typeId, code: 'qorvane', status: 'active' },
      { id: ids.next<'CertificationTypeRevision'>(), content },
      T0,
      'seed',
    );
    const food = ids.next<'Category'>();
    catalog.add(market, food);
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    const held = new Set<string>([CERTIFICATION_CLAIM_POLICY_EDIT.key]);
    const authorisation: AuthorisationCheck = {
      check: (_context, declaration) => {
        const rule = declaration.rule as { readonly allOf?: readonly string[] };
        return Promise.resolve(
          (rule.allOf ?? []).every((key) => held.has(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' as const } },
        );
      },
    };
    const reverter = new ClaimPolicyReverter(deps, authorisation);
    const revert = async (request: RevertRequest, by: CallContext = admin()) => {
      const result = await policies.unitOfWork.run(market, async () =>
        ok(await reverter.revert(by, request)),
      );
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const row = (basis: string) => ({ selector: 'platform-category', categoryId: food, basis });
    return {
      ids,
      registry,
      policies,
      audit,
      outbox,
      review,
      typeId,
      food,
      row,
      admin,
      revert,
      catalog,
      held,
      check: (request: RevertRequest, by: CallContext = admin()) => reverter.check(by, request),
      save: new ClaimPolicySaveRevision(gate, deps),
      read: new ClaimPolicyRead(gate, deps),
      approve: new ClaimPolicyApproveRelaxation(gate, deps),
    };
  }
  type Rig = ReturnType<typeof rig>;

  const policyOf = (r: Rig) => [...r.policies.state.policies.values()][0]!;
  const rowsOf = (r: Rig) => r.policies.state.revisions.get(policyOf(r).publishedRevisionId!)!.rows;
  const requestOf = (r: Rig, index = 0): RevertRequest => {
    const opened = r.review.opened[index]!;
    return {
      requestId: REQUEST_ID,
      subjectRef: opened.subjectRef,
      before: opened.before,
      after: opened.after,
    };
  };

  /** A relaxing revision, published by a second admin's approval (it opens no request). */
  async function relaxed(r: Rig, version: number, basis: string) {
    const pending = await unwrap(
      r.save.execute(r.admin(), { typeId: r.typeId, version, rows: [r.row(basis)] }),
    );
    if (pending.outcome !== 'pending-second-admin') throw new Error('not pending');
    await unwrap(
      r.approve.execute(r.admin(), {
        typeId: r.typeId,
        proposalId: pending.proposalId,
        version: 1,
      }),
    );
    return pending.revisionId;
  }

  it('reads whether a save is reviewed, and at which risk', async () => {
    const r = rig();
    const read = await unwrap(r.read.execute(r.admin(), { typeId: r.typeId }));
    expect(read.review).toEqual({ reviewed: true, risk: 'medium' });
  });

  it('refuses a published save without a note and keeps no policy', async () => {
    const r = rig();
    const result = await r.save.execute(r.admin(), {
      typeId: r.typeId,
      version: 0,
      rows: [r.row('NOT_APPLICABLE')],
    });
    expect(!result.ok && result.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(r.policies.state.policies.size).toBe(0);
    expect(r.policies.state.revisions.size).toBe(0);
  });

  it('opens the review of a published save with the revisions before and after', async () => {
    const r = rig();
    const saved = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims on food',
      }),
    );
    expect(saved).toMatchObject({
      outcome: 'published',
      request: { id: expect.any(String) as string, number: 1 },
    });
    expect(r.review.opened).toEqual([
      {
        area: 'certification',
        subjectKind: CLAIM_POLICY_SUBJECT_KIND,
        subjectRef: r.typeId,
        before: { revisionId: null, revisionNo: null },
        after: {
          revisionId: saved.revisionId,
          revisionNo: 1,
          changed: [`row:${r.food}`],
          changedCount: 1,
        },
        note: 'No claims on food',
      },
    ]);
    const second = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 2,
        rows: [
          r.row('NOT_APPLICABLE'),
          { selector: 'handling', handling: 'SEALED_ORIGINAL', basis: 'NOT_APPLICABLE' },
        ],
        note: 'Sealed goods too',
      }),
    );
    expect(r.review.opened[1]).toMatchObject({
      before: { revisionId: saved.revisionId, revisionNo: 1 },
      after: { revisionId: second.revisionId, revisionNo: 2 },
    });
  });

  it('opens nothing where the area is not reviewed, nor for a relaxing save', async () => {
    const off = rig(false);
    const saved = await unwrap(
      off.save.execute(off.admin(), {
        typeId: off.typeId,
        version: 0,
        rows: [off.row('NOT_APPLICABLE')],
      }),
    );
    expect(saved).toMatchObject({ outcome: 'published', request: null });
    expect(off.review.opened).toEqual([]);

    const r = rig();
    const pending = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('SELLER_OR_MANUFACTURER')],
      }),
    );
    expect(pending).toMatchObject({ outcome: 'pending-second-admin', request: null });
    expect(r.review.opened).toEqual([]);
  });

  /** The policy, its revisions, events and audit rows are as they were. */
  async function refusedWithoutWriting(r: Rig, request: RevertRequest, outcome: string) {
    const policy = { ...policyOf(r) };
    const revisions = r.policies.state.revisions.size;
    r.outbox.events.length = 0;
    r.audit.entries.length = 0;
    expect(await r.revert(request)).toBe(outcome);
    expect(policyOf(r)).toEqual(policy);
    expect(r.policies.state.revisions.size).toBe(revisions);
    expect(r.outbox.events).toEqual([]);
    expect(r.audit.entries).toEqual([]);
  }

  it('never loosens enforcement: reverting a first save (no rows before) is not permitted', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    await refusedWithoutWriting(r, requestOf(r), 'not-permitted');
  });

  it('answers not-permitted for the revert of every request a claim-policy save opens', async () => {
    // A claim-policy save is published at once only when it relaxes nothing, so restoring the
    // rows before always loosens enforcement: every such request can be approved, never reverted.
    const r = rig();
    const meat = r.ids.next<'Category'>();
    r.catalog.add(market, meat);
    const rowOf = (categoryId: string, basis: string) => ({
      selector: 'platform-category',
      categoryId,
      basis,
    });
    const versionOf = () => [...r.policies.state.policies.values()][0]?.version ?? 0;
    const publish = async (rows: readonly ReturnType<typeof rowOf>[], note: string) => {
      const saved = await unwrap(
        r.save.execute(r.admin(), { typeId: r.typeId, version: versionOf(), rows, note }),
      );
      expect(saved).toMatchObject({
        outcome: 'published',
        request: { number: expect.any(Number) as number },
      });
      const request = requestOf(r, r.review.opened.length - 1);
      expect(await r.check(request)).toBe('ok');
      await refusedWithoutWriting(r, request, 'not-permitted');
    };

    // The first save, of a seller-required row and of a no-claims row.
    await publish([rowOf(r.food, 'SELLER_REQUIRED')], 'Seller needed');
    // A stricter basis for a row.
    await publish([rowOf(r.food, 'NOT_APPLICABLE')], 'No claims');
    // A row added.
    await publish(
      [rowOf(r.food, 'NOT_APPLICABLE'), rowOf(meat, 'SELLER_REQUIRED')],
      'Meat needs a seller',
    );
    // After a relaxation a second admin approved (it opens no request), a save that tightens
    // the relaxed row again.
    const pending = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: versionOf(),
        rows: [rowOf(r.food, 'NOT_APPLICABLE'), rowOf(meat, 'SELLER_OR_MANUFACTURER')],
      }),
    );
    if (pending.outcome !== 'pending-second-admin') throw new Error('not pending');
    await unwrap(
      r.approve.execute(r.admin(), {
        typeId: r.typeId,
        proposalId: pending.proposalId,
        version: 1,
      }),
    );
    await publish(
      [rowOf(r.food, 'NOT_APPLICABLE'), rowOf(meat, 'NOT_APPLICABLE')],
      'No meat claims',
    );
    expect(r.review.opened).toHaveLength(4);
  });

  it('never loosens enforcement: reverting a stricter row is not permitted', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('SELLER_REQUIRED')],
        note: 'Seller needed',
      }),
    );
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 2,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    await refusedWithoutWriting(r, requestOf(r, 1), 'not-permitted');
    // The first request's revision is no longer published.
    await refusedWithoutWriting(r, requestOf(r, 0), 'changed-since');
  });

  it('restores stricter rows before as a new revision, with the save event and its audit row', async () => {
    const r = rig();
    const strict = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    const loose = await relaxed(r, 2, 'SELLER_OR_MANUFACTURER');
    r.outbox.events.length = 0;
    r.audit.entries.length = 0;
    const policy = { ...policyOf(r) };
    const request: RevertRequest = {
      requestId: REQUEST_ID,
      subjectRef: r.typeId,
      before: { revisionId: strict.revisionId, revisionNo: 1 },
      after: { revisionId: loose, revisionNo: 2 },
    };
    expect(await r.revert(request)).toBe('reverted');
    const now = policyOf(r).publishedRevisionId!;
    expect(now).not.toBe(strict.revisionId);
    expect(rowsOf(r)).toEqual([
      { selector: { kind: 'platform-category', categoryId: r.food }, basis: 'NOT_APPLICABLE' },
    ]);
    expect(policyOf(r).version).toBe(policy.version + 1);
    expect(r.outbox.events).toEqual([
      expect.objectContaining({
        type: 'certification.claim-policy-changed.v1',
        payload: { policyId: policy.id, revisionId: now, typeId: r.typeId },
      }),
    ]);
    expect(r.audit.entries).toEqual([
      expect.objectContaining({
        action: 'certification.claim-policy.reverted',
        targetId: policy.id,
        before: { revisionId: loose },
        after: {
          typeId: r.typeId,
          revisionId: now,
          restoredRevisionId: strict.revisionId,
          requestId: REQUEST_ID,
        },
      }),
    ]);
    expect(await r.revert(request)).toBe('changed-since');
  });

  it('checks before the decision unit: the edit key and every category a restored row names, failing closed', async () => {
    const r = rig();
    const strict = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    const loose = await relaxed(r, 2, 'SELLER_OR_MANUFACTURER');
    const request: RevertRequest = {
      requestId: REQUEST_ID,
      subjectRef: r.typeId,
      before: { revisionId: strict.revisionId, revisionNo: 1 },
      after: { revisionId: loose, revisionNo: 2 },
    };
    expect(await r.check(request)).toBe('ok');
    expect(r.catalog.calls.at(-1)).toEqual([r.food]);

    r.held.clear();
    expect(await r.check(request)).toBe('not-permitted');
    r.held.add(CERTIFICATION_CLAIM_POLICY_EDIT.key);

    // The category was retired since: restoring its row is refused, as a save of it would be.
    r.catalog.categories.get(market.marketId)!.delete(r.food);
    expect(await r.check(request)).toBe('not-permitted');
    r.catalog.add(market, r.food);
    r.catalog.fail = true;
    expect(await r.check(request)).toBe('not-permitted');
    r.catalog.fail = false;

    // A subject that moved on is left to the revert, which writes nothing.
    expect(await r.check({ ...request, after: { revisionId: strict.revisionId } })).toBe('ok');
    expect(await r.revert({ ...request, after: { revisionId: strict.revisionId } })).toBe(
      'changed-since',
    );
  });

  it('restores no rows when only a manufacturer basis row would go, audited with no restored revision', async () => {
    // No save opens a request with no revision before whose revert relaxes nothing (a first
    // published save always adds a row that is not a manufacturer basis, see above). The path is
    // kept so the reverter decides by the rule, not by that invariant of the save; the request is
    // built by hand here.
    const r = rig();
    const loose = await relaxed(r, 0, 'SELLER_OR_MANUFACTURER');
    r.outbox.events.length = 0;
    r.audit.entries.length = 0;
    const policy = { ...policyOf(r) };
    const request: RevertRequest = {
      requestId: REQUEST_ID,
      subjectRef: r.typeId,
      before: { revisionId: null, revisionNo: null },
      after: { revisionId: loose, revisionNo: 1 },
    };
    expect(await r.revert(request)).toBe('reverted');
    expect(rowsOf(r)).toEqual([]);
    const now = policyOf(r).publishedRevisionId!;
    expect(r.audit.entries).toEqual([
      expect.objectContaining({
        action: 'certification.claim-policy.reverted',
        targetId: policy.id,
        before: { revisionId: loose },
        after: {
          typeId: r.typeId,
          revisionId: now,
          restoredRevisionId: null,
          requestId: REQUEST_ID,
        },
      }),
    ]);
    expect(r.outbox.events).toEqual([
      expect.objectContaining({
        type: 'certification.claim-policy-changed.v1',
        payload: { policyId: policy.id, revisionId: now, typeId: r.typeId },
      }),
    ]);
  });

  it('is not permitted while a relaxation waits, and changed-since when the lock races', async () => {
    const r = rig();
    const strict = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    const loose = await relaxed(r, 2, 'SELLER_REQUIRED');
    const request: RevertRequest = {
      requestId: REQUEST_ID,
      subjectRef: r.typeId,
      before: { revisionId: strict.revisionId, revisionNo: 1 },
      after: { revisionId: loose, revisionNo: 2 },
    };
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 3,
        rows: [r.row('SELLER_OR_MANUFACTURER')],
      }),
    );
    expect(await r.revert(request)).toBe('not-permitted');

    const other = rig();
    const first = await unwrap(
      other.save.execute(other.admin(), {
        typeId: other.typeId,
        version: 0,
        rows: [other.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    const looser = await relaxed(other, 2, 'SELLER_REQUIRED');
    other.policies.beforeLock = () => {
      policyOf(other).version += 1;
    };
    expect(
      await other.revert({
        requestId: REQUEST_ID,
        subjectRef: other.typeId,
        before: { revisionId: first.revisionId, revisionNo: 1 },
        after: { revisionId: looser, revisionNo: 2 },
      }),
    ).toBe('changed-since');
  });

  it('answers gone for an unknown type, a revision of another policy or values it did not write', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 0,
        rows: [r.row('NOT_APPLICABLE')],
        note: 'No claims',
      }),
    );
    const request = requestOf(r);
    expect(await r.revert({ ...request, subjectRef: 'nope' })).toBe('gone');
    expect(
      await r.revert({
        ...request,
        subjectRef: '01990000-0000-7000-8000-0000000000ff',
      }),
    ).toBe('gone');
    expect(await r.revert({ ...request, after: { revisionId: 'x' } })).toBe('gone');
    expect(
      await r.revert({
        ...request,
        before: { revisionId: '01990000-0000-7000-8000-0000000000fe' },
      }),
    ).toBe('gone');
  });
});
