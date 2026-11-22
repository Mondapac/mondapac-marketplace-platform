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
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import type { TypeRevisionContent } from '../../domain/type-revision';
import { TypeApproveRelaxation } from '../use-cases/type-approve-relaxation.use-case';
import { TypeRead } from '../use-cases/type-read.use-case';
import { TypeSaveRevision } from '../use-cases/type-save-revision.use-case';
import { TYPE_REVISION_SUBJECT_KIND } from './certification-review';
import { TypeRevisionReverter } from './registry-reverters';
import type { RegistryDependencies } from './registry.shared';

// Admin Inbox › System requests, area certification, for type revisions, in memory on both Market
// fixtures: a published save opens its review in its own unit (a missing note refuses the save
// and leaves nothing), a relaxing save waits for a second admin and opens nothing, and the
// reverter restores only what relaxes nothing (CERT-21: a revert never loosens enforcement), with
// the save's event and its own audit row. The SQL and the real recorder are in
// test/db/certification-system-requests.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const REQUEST_ID = (() => {
  const parsed = parseId<'SystemRequest'>('01990000-0000-7000-8000-0000005e0abc');
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
})();

async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe.each(['AU', 'ZZ'] as const)('type revision reviews in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = markets.get(market.marketId).supportedLocales;

  const contentOf = (
    overrides: Partial<TypeRevisionContent> = {},
    name = 'Qorvane',
    terms: readonly string[] = ['qorvane'],
  ): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: false,
    defaultBasis: 'SELLER_REQUIRED',
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'seal',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        { name, customerDescription: 'Holds a certificate.', claimTerms: [...terms] },
      ]),
    ),
    ...overrides,
  });

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  function rig(reviewed = true, seed: TypeRevisionContent = contentOf()) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const registry = new MemoryRegistry();
    const audit = new RecordingAudit();
    const outbox = new MemoryOutbox();
    const review = new RecordingReview();
    if (reviewed) review.review('certification', 'medium');
    let marketLocales: readonly string[] = locales;
    const deps: RegistryDependencies = {
      unitOfWork: registry.unitOfWork,
      registry,
      cipher: new FakeRegistryCipher(),
      audit,
      outbox,
      clock,
      ids,
      review,
      supportedLocales: () => marketLocales,
      badgeArtworkKeys: loadBadgeArtworkKeys(),
    };
    const typeId = ids.next<'CertificationType'>();
    const seedRevision = ids.next<'CertificationTypeRevision'>();
    registry.addType(
      market,
      { id: typeId, code: 'qorvane', status: 'active' },
      { id: seedRevision, content: seed },
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
    // The keys the decider holds, as the gate's authorisation check answers them.
    const held = new Set<string>([CERTIFICATION_TYPE_EDIT.key]);
    let checkFails = false;
    const authorisation: AuthorisationCheck = {
      check: (_context, declaration) => {
        if (checkFails) return Promise.reject(new Error('identity unavailable'));
        const rule = declaration.rule as { readonly allOf?: readonly string[] };
        return Promise.resolve(
          (rule.allOf ?? []).every((key) => held.has(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' as const } },
        );
      },
    };
    const reverter = new TypeRevisionReverter(deps, authorisation);
    const revert = async (request: RevertRequest, by: CallContext = admin()) => {
      const result = await registry.unitOfWork.run(market, async () =>
        ok(await reverter.revert(by, request)),
      );
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    return {
      ids,
      registry,
      audit,
      outbox,
      review,
      typeId,
      seedRevision,
      admin,
      revert,
      held,
      failCheck: () => (checkFails = true),
      check: (by: CallContext) => reverter.check(by),
      setLocales: (next: readonly string[]) => (marketLocales = next),
      save: new TypeSaveRevision(gate, deps),
      read: new TypeRead(gate, deps),
      approve: new TypeApproveRelaxation(gate, deps),
    };
  }
  type Rig = ReturnType<typeof rig>;

  const published = (r: Rig) => r.registry.state.types.get(r.typeId)!.publishedRevisionId;
  const versionOf = (r: Rig) => r.registry.state.types.get(r.typeId)!.version;
  /** The request a reviewer decides, from the opening the recorder kept. */
  const requestOf = (r: Rig, index = 0): RevertRequest => {
    const opened = r.review.opened[index]!;
    return {
      requestId: REQUEST_ID,
      subjectRef: opened.subjectRef,
      before: opened.before,
      after: opened.after,
    };
  };

  it('reads whether a save is reviewed, and at which risk', async () => {
    const r = rig();
    const read = await unwrap(r.read.execute(r.admin(), { typeId: r.typeId }));
    expect(read.review).toEqual({ reviewed: true, risk: 'medium' });
    expect(r.review.asked).toEqual(['certification']);
    const off = rig(false);
    const plain = await unwrap(off.read.execute(off.admin(), { typeId: off.typeId }));
    expect(plain.review).toEqual({ reviewed: false, risk: 'low' });
  });

  it('refuses a published save without a note and keeps nothing of it', async () => {
    const r = rig();
    const result = await r.save.execute(r.admin(), {
      typeId: r.typeId,
      version: 1,
      content: contentOf({}, 'Qorvane Seal'),
    });
    expect(!result.ok && result.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(published(r)).toBe(r.seedRevision);
    expect(versionOf(r)).toBe(1);
    expect(r.registry.state.revisions.size).toBe(1);
    // The memory outbox and audit are outside the fake unit; the database spec shows the event
    // and the audit row roll back with the save.
  });

  it('opens the review of a published save in its unit and answers the request', async () => {
    const r = rig();
    const saved = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({ badgeIconKey: 'leaf' }, 'Qorvane Seal'),
        note: 'Brand refresh',
      }),
    );
    expect(saved).toMatchObject({
      outcome: 'published',
      revisionNo: 2,
      request: { id: expect.any(String) as string, number: 1 },
    });
    expect(r.review.opened).toEqual([
      {
        area: 'certification',
        subjectKind: TYPE_REVISION_SUBJECT_KIND,
        subjectRef: r.typeId,
        before: { revisionId: r.seedRevision, revisionNo: 1 },
        after: {
          revisionId: saved.revisionId,
          revisionNo: 2,
          changed: ['badgeIconKey', ...[...locales].sort().map((l) => `names.${l}`)],
          changedCount: 1 + locales.length,
        },
        note: 'Brand refresh',
      },
    ]);
  });

  it('opens nothing where the area is not reviewed, nor for a relaxing save', async () => {
    const off = rig(false);
    const saved = await unwrap(
      off.save.execute(off.admin(), {
        typeId: off.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
      }),
    );
    expect(saved).toMatchObject({ outcome: 'published', request: null });
    expect(off.review.opened).toEqual([]);

    const r = rig();
    const relaxing = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({ requiresIssuerRegistry: false }),
      }),
    );
    expect(relaxing).toMatchObject({ outcome: 'pending-second-admin', request: null });
    expect(r.review.opened).toEqual([]);
  });

  it('reverts a neutral edit as a new revision, with the save event and its audit row', async () => {
    const r = rig();
    const author = r.admin();
    const saved = await unwrap(
      r.save.execute(author, {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    r.outbox.events.length = 0;
    r.audit.entries.length = 0;
    const reviewer = r.admin();
    expect(await r.revert(requestOf(r), reviewer)).toBe('reverted');

    const now = published(r);
    expect(now).not.toBe(saved.revisionId);
    expect(now).not.toBe(r.seedRevision);
    const restored = r.registry.state.revisions.get(now)!;
    expect(restored.content).toEqual(contentOf());
    expect(restored.revisionNo).toBe(3);
    expect(restored.authorAccountId).toBe(
      (reviewer.actor as { readonly accountId: string }).accountId,
    );
    expect(restored.changeReasonCiphertext).toBeNull();
    expect(versionOf(r)).toBe(3);
    expect(r.outbox.events).toEqual([
      expect.objectContaining({
        type: 'certification.certification-type-revised.v1',
        payload: { typeId: r.typeId, revisionId: now, claimTermsChanged: false },
      }),
    ]);
    expect(r.audit.entries).toEqual([
      expect.objectContaining({
        action: 'certification.type.reverted',
        targetId: r.typeId,
        before: { revisionId: saved.revisionId },
        after: {
          revisionId: now,
          restoredRevisionId: r.seedRevision,
          claimTermsChanged: false,
          requestId: REQUEST_ID,
        },
      }),
    ]);
    // The revision after is no longer published: a second decision finds it changed.
    expect(await r.revert(requestOf(r))).toBe('changed-since');
  });

  it.each([
    ['a setting it tightened', { requiresExpiry: true }, undefined],
    ['a claim term it added', {}, ['qorvane', 'qorvane seal']],
  ] as const)(
    'never loosens enforcement: restoring %s is not permitted and writes nothing',
    async (_label, overrides, terms) => {
      const r = rig();
      await unwrap(
        r.save.execute(r.admin(), {
          typeId: r.typeId,
          version: 1,
          content: contentOf(overrides, 'Qorvane', terms),
          note: 'Stricter',
        }),
      );
      const before = published(r);
      const revisions = r.registry.state.revisions.size;
      r.outbox.events.length = 0;
      r.audit.entries.length = 0;
      expect(await r.revert(requestOf(r))).toBe('not-permitted');
      expect(published(r)).toBe(before);
      expect(versionOf(r)).toBe(2);
      expect(r.registry.state.revisions.size).toBe(revisions);
      expect(r.outbox.events).toEqual([]);
      expect(r.audit.entries).toEqual([]);
    },
  );

  it('is not permitted while a relaxation of the type waits for a second admin', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 2,
        content: contentOf({ requiresIssuerRegistry: false }, 'Qorvane Seal'),
      }),
    );
    const before = published(r);
    expect(await r.revert(requestOf(r))).toBe('not-permitted');
    expect(published(r)).toBe(before);
  });

  it('is not permitted while a reactivation of the type waits for a second admin', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    const pending = await r.registry.unitOfWork.run(market, async () =>
      ok(
        await r.registry.addProposal(market, {
          id: r.ids.next<'RelaxationProposal'>(),
          subject: 'type-reactivation',
          subjectId: r.typeId,
          basedOnRevisionId: published(r),
          proposedRevisionId: null,
          proposedExpertReferenceCiphertext: null,
          proposerAccountId: r.ids.next<'Account'>(),
          changeReasonCiphertext: null,
          proposedAt: T0,
        }),
      ),
    );
    expect(pending).toEqual({ ok: true, value: null });
    const before = published(r);
    expect(await r.revert(requestOf(r))).toBe('not-permitted');
    expect(published(r)).toBe(before);
  });

  describe('a type revert goes through only for an edit of names, descriptions or the badge icon', () => {
    // The least strict content a type can hold, so every setting can be tightened by a save that
    // is published at once (a tightening relaxes nothing, so it opens a request).
    const lax = (): TypeRevisionContent =>
      contentOf({
        verificationMode: 'SELF_DECLARATION',
        requiresIssuerRegistry: false,
        requiresDocument: false,
        requiresExpiry: false,
        defaultBasis: 'SELLER_REQUIRED',
        autoApproveSelfDeclaration: true,
      });
    const edits: readonly (readonly [string, TypeRevisionContent, 'reverted' | 'not-permitted'])[] =
      [
        ['the names', { ...lax(), ...renamed('Qorvane Seal') }, 'reverted'],
        ['the descriptions', { ...lax(), ...described('Holds a seal.') }, 'reverted'],
        ['the badge icon', { ...lax(), badgeIconKey: 'leaf' }, 'reverted'],
        [
          'names, descriptions and the icon together',
          { ...lax(), ...renamed('Qorvane Seal', 'Holds a seal.'), badgeIconKey: 'leaf' },
          'reverted',
        ],
        [
          'auto-approval switched off',
          { ...lax(), autoApproveSelfDeclaration: false },
          'not-permitted',
        ],
        ['a document now required', { ...lax(), requiresDocument: true }, 'not-permitted'],
        ['an expiry now required', { ...lax(), requiresExpiry: true }, 'not-permitted'],
        ['a stricter default basis', { ...lax(), defaultBasis: 'NOT_APPLICABLE' }, 'not-permitted'],
        ['a claim term added', withTerms(lax(), ['qorvane', 'qorvane seal']), 'not-permitted'],
        [
          'a rename together with a tightened setting',
          { ...lax(), ...renamed('Qorvane Seal'), requiresExpiry: true },
          'not-permitted',
        ],
      ];

    function renamed(name: string, description?: string): Pick<TypeRevisionContent, 'locales'> {
      return {
        locales: Object.fromEntries(
          Object.entries(lax().locales).map(([l, text]) => [
            l,
            { ...text, name, customerDescription: description ?? text.customerDescription },
          ]),
        ),
      };
    }
    function described(description: string): Pick<TypeRevisionContent, 'locales'> {
      return renamed('Qorvane', description);
    }
    function withTerms(base: TypeRevisionContent, terms: readonly string[]): TypeRevisionContent {
      return {
        ...base,
        locales: Object.fromEntries(
          Object.entries(base.locales).map(([l, text]) => [l, { ...text, claimTerms: [...terms] }]),
        ),
      };
    }

    it.each(edits)('restoring %s answers %s', async (_label, content, expected) => {
      const r = rig(true, lax());
      const saved = await unwrap(
        r.save.execute(r.admin(), { typeId: r.typeId, version: 1, content, note: 'Edit' }),
      );
      expect(saved).toMatchObject({ outcome: 'published' });
      const revisions = r.registry.state.revisions.size;
      expect(await r.revert(requestOf(r))).toBe(expected);
      if (expected === 'reverted') {
        expect(r.registry.state.revisions.get(published(r))!.content).toEqual(lax());
      } else {
        expect(published(r)).toBe(saved.revisionId);
        expect(r.registry.state.revisions.size).toBe(revisions);
      }
    });

    // A seller's own declaration never names an issuer (type.issuer-registry-not-allowed), so the
    // issuer registry is tightened on a type with an issuer's certificate.
    it('restoring the issuer registry now required answers not-permitted', async () => {
      const base = contentOf({ requiresIssuerRegistry: false });
      const r = rig(true, base);
      const saved = await unwrap(
        r.save.execute(r.admin(), {
          typeId: r.typeId,
          version: 1,
          content: { ...base, requiresIssuerRegistry: true },
          note: 'Edit',
        }),
      );
      expect(saved).toMatchObject({ outcome: 'published' });
      const revisions = r.registry.state.revisions.size;
      expect(await r.revert(requestOf(r))).toBe('not-permitted');
      expect(published(r)).toBe(saved.revisionId);
      expect(r.registry.state.revisions.size).toBe(revisions);
    });
  });

  it('locks the type row before a relaxing save checks for a pending proposal', async () => {
    const r = rig();
    let locked = false;
    // A revert of the type publishes between the save's read and its lock: the lock finds the
    // version moved and the save is refused before it writes a revision or a proposal.
    r.registry.beforeTypeLock = () => {
      locked = true;
      r.registry.state.types.get(r.typeId)!.version += 1;
    };
    const raced = await r.save.execute(r.admin(), {
      typeId: r.typeId,
      version: 1,
      content: contentOf({ requiresIssuerRegistry: false }),
    });
    expect(locked).toBe(true);
    expect(!raced.ok && raced.error).toEqual({ code: 'conflict.stale' });
    expect(r.registry.state.revisions.size).toBe(1);
    expect(await r.registry.pendingProposal(market, 'type-revision', r.typeId)).toBeNull();

    // Unraced, the same save takes the lock and waits for a second admin.
    r.registry.state.types.get(r.typeId)!.version = 1;
    r.registry.beforeTypeLock = () => (locked = true);
    locked = false;
    const relaxing = await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({ requiresIssuerRegistry: false }),
      }),
    );
    expect(locked).toBe(true);
    expect(relaxing).toMatchObject({ outcome: 'pending-second-admin' });
  });

  it('answers changed-since after a later publication, also one that races the lock', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    // Another admin's save is published between the reverter's read and its lock.
    r.registry.beforeTypeLock = () => {
      r.registry.state.types.get(r.typeId)!.version += 1;
    };
    expect(await r.revert(requestOf(r))).toBe('changed-since');
    r.registry.state.types.get(r.typeId)!.version = 2;

    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 2,
        content: contentOf({}, 'Qorvane Mark'),
        note: 'Rename again',
      }),
    );
    const latest = published(r);
    expect(await r.revert(requestOf(r, 0))).toBe('changed-since');
    expect(published(r)).toBe(latest);
  });

  it('answers gone for an unknown type, values it did not write, or content the Market no longer takes', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    const request = requestOf(r);
    expect(await r.revert({ ...request, subjectRef: r.ids.next<'CertificationType'>() })).toBe(
      'gone',
    );
    expect(await r.revert({ ...request, subjectRef: 'not-an-id' })).toBe('gone');
    expect(await r.revert({ ...request, before: { revisionId: 7 } })).toBe('gone');
    expect(
      await r.revert({
        ...request,
        before: { revisionId: r.ids.next<'CertificationTypeRevision'>() },
      }),
    ).toBe('gone');
    // The Market added a locale: the content before names too few.
    r.setLocales([...locales, 'xx-XX']);
    expect(await r.revert(request)).toBe('gone');
    r.setLocales(locales);
    expect(await r.revert(request)).toBe('reverted');
  });

  it('checks before the decision unit that the decider holds the type edit key, failing closed', async () => {
    const r = rig();
    expect(await r.check(r.admin())).toBe('ok');
    expect(await r.check(r.admin(true))).toBe('not-permitted');
    r.held.clear();
    expect(await r.check(r.admin())).toBe('not-permitted');
    r.held.add(CERTIFICATION_TYPE_EDIT.key);
    r.failCheck();
    expect(await r.check(r.admin())).toBe('not-permitted');
  });

  it('refuses to revert outside a signed-in admin acting as themselves', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    await expect(r.revert(requestOf(r), r.admin(true))).rejects.toThrow(/acting as themselves/);
  });

  it('keeps each Market apart: a request of one Market finds nothing in another', async () => {
    const r = rig();
    await unwrap(
      r.save.execute(r.admin(), {
        typeId: r.typeId,
        version: 1,
        content: contentOf({}, 'Qorvane Seal'),
        note: 'Rename',
      }),
    );
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const other = testCallContext(
      otherMarket,
      testAuthenticatedActor(otherMarket, {
        population: 'admin',
        accountId: r.ids.next<'Account'>(),
        sessionId: r.ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    expect(await r.revert(requestOf(r), other)).toBe('gone');
  });
});
