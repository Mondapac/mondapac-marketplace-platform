import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeCipher,
  MemoryOutbox,
  MemoryVault,
  passThroughUnitOfWork,
  zonesOf,
} from '../../../../../test/support/certification-fakes';
import {
  FixedReviewSellers,
  MemoryReviews,
  RecordingAudit,
} from '../../../../../test/support/certification-review-fakes';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigCertificationMailPolicy } from '../../infrastructure/config-certification-mail-policy';
import { CheckedInReviewPolicy } from '../../infrastructure/review-policy/checked-in-review-policy';
import type { ReviewSubmission } from '../ports/review.repository';
import type { ReviewDependencies } from '../review/review.shared';
import { DeclineSellerCertificate } from './seller-certificate-decline.use-case';
import { SellerCertificateHistoryRead } from './seller-certificate-history-read.use-case';
import { RevokeSellerCertificate } from './seller-certificate-revoke.use-case';
import { SendDecisionMail } from './send-decision-mail.use-case';

// Revoke and the full history read (certification design 3.1, 7.2, 11, 12; slice 11; AC 16, AC 22)
// in memory, on both Market fixtures with the real gate, the real Market policies and the real use
// cases. The SQL and the races are in test/db/certification-revoke.db-spec.ts, the routes and the
// keys in test/certification-revoke.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('revoke and full history, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const policies = new CheckedInReviewPolicy();
  const policy = policies.policyFor(market);
  const revokeReason = policy.reasons.find((r) => r.outcomes.includes('revoked'))!;
  const declineOnly = policy.reasons.find(
    (r) => r.outcomes.includes('declined') && !r.outcomes.includes('revoked'),
  );
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  function rig(
    options: { status?: 'approved' | 'expired' | 'in-review' | 'declined'; renewal?: boolean } = {},
  ) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const sellerId = ids.next<'Seller'>();
    const typeId = ids.next<'CertificationType'>();
    const certificateId = ids.next<'SellerCertification'>();
    const approvedId = ids.next<'Submission'>();
    const renewalId = ids.next<'Submission'>();
    const approvedRevision = ids.next<'CertificationTypeRevision'>();
    const status = options.status ?? 'approved';
    const hasApproval = status === 'approved' || status === 'expired';
    const shown = options.renewal === true ? renewalId : approvedId;
    const submission = {
      id: shown,
      submissionNo: options.renewal === true ? 2 : 1,
      kind: options.renewal === true ? 'renewal' : 'initial',
      typeRevisionId:
        options.renewal === true ? ids.next<'CertificationTypeRevision'>() : approvedRevision,
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      issuer: null,
      certificateNumberCiphertext: null,
      issueDate: null,
      expiryDate: Temporal.PlainDate.from('2028-01-01'),
      selfDeclared: null,
      selfDeclarationNoteCiphertext: null,
      submittedZone: 'Australia/Brisbane',
      submittedAt: T0,
      documents: [],
      checks: [],
      scope: null,
      confirmation: null,
      decision: null,
    } as ReviewSubmission;
    const reviews = new MemoryReviews(
      code,
      {
        id: certificateId,
        sellerId,
        typeId,
        typeCode: 'halal',
        status,
        pendingSubmissionId: options.renewal === true || status === 'in-review' ? shown : null,
        pendingKind: options.renewal === true ? 'renewal' : null,
        approvedSubmissionId: hasApproval ? approvedId : null,
        approvedBoundaryAt: hasApproval ? Temporal.Instant.from('2028-01-01T14:00:00Z') : null,
        approvedIssuerState: hasApproval ? 'active' : null,
        issuerRequestOpen: false,
        latestOutcome: null,
        submissionCount: options.renewal === true ? 2 : 1,
        statusChangedAt: T0,
        lastChangedAt: T0,
        createdAt: T0,
        version: 5,
        draft: {
          issuerId: null,
          certificateNumberCiphertext: null,
          issueDate: null,
          expiryDate: null,
          selfDeclared: null,
          selfDeclarationNoteCiphertext: null,
        },
      },
      submission,
    );
    reviews.approvedTypeRevisionId = approvedRevision;
    const cipher = new FakeCipher();
    const outbox = new MemoryOutbox();
    const audit = new RecordingAudit();
    const deps: ReviewDependencies = {
      unitOfWork: passThroughUnitOfWork,
      reviews,
      cipher,
      vault: new MemoryVault(),
      audit,
      zones: zonesOf({}),
      sellers: new FixedReviewSellers(),
      policies,
      outbox,
      clock,
      ids,
      documentDownloadEnabled: false,
    };
    const admin = (m: MarketContext = market): CallContext =>
      testCallContext(
        m,
        testAuthenticatedActor(m, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    const seller = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
    const actingAs = (context: CallContext): CallContext =>
      ({
        ...context,
        actor: { ...context.actor, actingAs: { accountId: 'x', sellerId: 'y' } },
      }) as unknown as CallContext;
    return {
      revoke: new RevokeSellerCertificate(gate, deps),
      history: new SellerCertificateHistoryRead(gate, deps),
      decline: new DeclineSellerCertificate(gate, deps),
      reviews,
      outbox,
      audit,
      cipher,
      admin,
      seller,
      actingAs,
      sellerId,
      typeId,
      certificateId,
      approvedId,
      renewalId,
      approvedRevision,
    };
  }

  describe('revoke (AC 16)', () => {
    it.each(['approved', 'expired'] as const)(
      'revokes a %s record: status, history, audit, event; the note is sealed, never in the audit or the event',
      async (status) => {
        const r = rig({ status });
        const context = r.admin();
        const result = await r.revoke.execute(context, {
          certificateId: r.certificateId,
          version: 5,
          reasonCode: revokeReason.code,
          reasonText: 'Issuer phoned: suspended on 2026-10-01.',
        });
        expect(result).toEqual({
          ok: true,
          value: {
            certificateId: r.certificateId,
            status: 'revoked',
            submissionId: r.approvedId,
            withdrawnSubmissionId: null,
            version: 6,
            revokedAt: T0.toString(),
          },
        });
        expect(r.reviews.certificate).toMatchObject({ status: 'revoked', version: 6 });
        expect(r.reviews.fullHistory.at(-1)).toMatchObject({
          fromStatus: status,
          toStatus: 'revoked',
          submissionId: r.approvedId,
          actorKind: 'admin',
          reasonCode: revokeReason.code,
        });
        const note = r.reviews.fullHistory.at(-1)!.noteCiphertext!;
        expect(note).not.toContain('Issuer phoned');
        expect(await r.cipher.open(market, r.sellerId, 'history-note', note)).toEqual({
          ok: true,
          value: 'Issuer phoned: suspended on 2026-10-01.',
        });

        expect(r.audit.entries).toHaveLength(1);
        expect(r.audit.entries[0]).toMatchObject({
          action: 'certification.seller-certification.revoked',
          targetId: r.certificateId,
          after: {
            submissionId: r.approvedId,
            typeRevisionId: r.approvedRevision,
            withdrawnSubmissionId: null,
            noteGiven: true,
          },
        });
        expect(r.outbox.events).toHaveLength(1);
        expect(r.outbox.events[0]).toMatchObject({
          type: 'certification.seller-certification-revoked.v1',
          aggregateId: r.certificateId,
          aggregateVersion: 6,
          payload: {
            sellerCertificationId: r.certificateId,
            sellerId: r.sellerId,
            submissionId: r.approvedId,
            typeId: r.typeId,
          },
        });
        const leaked = JSON.stringify([r.audit.entries, r.outbox.events]);
        expect(leaked).not.toContain('Issuer phoned');
        expect(leaked).not.toContain(revokeReason.code);
      },
    );

    it('withdraws a pending renewal in the same unit (cause revoked); a later decision on it is refused', async () => {
      const r = rig({ renewal: true });
      const result = await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 5,
        reasonCode: revokeReason.code,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { withdrawnSubmissionId: r.renewalId, submissionId: r.approvedId, version: 6 },
      });
      expect(r.reviews.withdrawals).toEqual([{ submissionId: r.renewalId, cause: 'revoked' }]);
      expect(r.reviews.certificate).toMatchObject({ status: 'revoked', pendingSubmissionId: null });
      expect(r.audit.entries[0]).toMatchObject({
        after: { withdrawnSubmissionId: r.renewalId, noteGiven: false },
      });
      expect(r.outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-revoked.v1',
      ]);

      const decline = await r.decline.execute(r.admin(), {
        certificateId: r.certificateId,
        submissionId: r.renewalId,
        version: 6,
        reasonCode: policy.reasons.find((x) => x.outcomes.includes('declined'))!.code,
      });
      expect(decline).toEqual({ ok: false, error: { code: 'review.not-current-submission' } });
    });

    it('is terminal: a second revoke is certificate.revoked and writes nothing', async () => {
      const r = rig();
      await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 5,
        reasonCode: revokeReason.code,
      });
      const again = await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 6,
        reasonCode: revokeReason.code,
      });
      expect(again).toEqual({ ok: false, error: { code: 'certificate.revoked' } });
      expect(r.audit.entries).toHaveLength(1);
      expect(r.outbox.events).toHaveLength(1);
    });

    it.each(['in-review', 'declined'] as const)(
      'refuses a %s record that was never approved',
      async (status) => {
        const r = rig({ status });
        expect(
          await r.revoke.execute(r.admin(), {
            certificateId: r.certificateId,
            version: 5,
            reasonCode: revokeReason.code,
          }),
        ).toEqual({ ok: false, error: { code: 'certificate.not-revocable' } });
        expect(r.reviews.certificate.status).toBe(status);
      },
    );

    it('needs a reason of the Market listed for revoke (AC 16)', async () => {
      const r = rig();
      for (const [reasonCode, expected] of [
        [undefined, 'required'],
        ['', 'required'],
        ['no-such-reason', 'unknown'],
        ...(declineOnly === undefined ? [] : [[declineOnly.code, 'unknown']]),
      ] as const) {
        expect(
          await r.revoke.execute(r.admin(), {
            certificateId: r.certificateId,
            version: 5,
            reasonCode,
          }),
        ).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'reasonCode', code: expected }] },
        });
      }
      expect(
        await r.revoke.execute(r.admin(), {
          certificateId: r.certificateId,
          version: 5,
          reasonCode: revokeReason.code,
          reasonText: 'bad\u0007text',
        }),
      ).toMatchObject({ ok: false, error: { fields: [{ path: 'reasonText' }] } });
      expect(r.reviews.certificate.status).toBe('approved');
      expect(r.audit.entries).toHaveLength(0);
    });

    it('answers conflict.stale on an old version and writes nothing', async () => {
      const r = rig();
      expect(
        await r.revoke.execute(r.admin(), {
          certificateId: r.certificateId,
          version: 4,
          reasonCode: revokeReason.code,
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(r.reviews.certificate).toMatchObject({ status: 'approved', version: 5 });
    });

    it('refuses acting-as, a seller and another Market (one not-found), and a bad id or version', async () => {
      const r = rig();
      const input = { certificateId: r.certificateId, version: 5, reasonCode: revokeReason.code };
      expect(await r.revoke.execute(r.actingAs(r.admin()), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await r.revoke.execute(r.seller(), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const elsewhere = await r.revoke.execute(r.admin(otherMarket), {
        ...input,
        reasonCode: policies
          .policyFor(otherMarket)
          .reasons.find((x) => x.outcomes.includes('revoked'))!.code,
      });
      expect(elsewhere).toEqual({ ok: false, error: { code: 'certificate.not-found' } });
      expect(await r.revoke.execute(r.admin(), { ...input, certificateId: 'nope' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await r.revoke.execute(r.admin(), { ...input, version: '5' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(r.reviews.certificate.status).toBe('approved');
    });
  });

  describe('full history read (AC 22, VER-14)', () => {
    it('returns every row newest first with the reason label and the decrypted note, paged, and audits each read', async () => {
      const r = rig({ renewal: true });
      await r.decline.execute(r.admin(), {
        certificateId: r.certificateId,
        submissionId: r.renewalId,
        version: 5,
        reasonCode: policy.reasons.find((x) => x.outcomes.includes('declined'))!.code,
      });
      await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 6,
        reasonCode: revokeReason.code,
        reasonText: 'Note for the file.',
      });
      r.audit.entries.length = 0;

      const first = await r.history.execute(r.admin(), {
        certificateId: r.certificateId,
        limit: 1,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.entries).toEqual([
        expect.objectContaining({
          toStatus: 'revoked',
          fromStatus: 'approved',
          actorKind: 'admin',
          reasonCode: revokeReason.code,
          reasonLabel: revokeReason.label,
          note: 'Note for the file.',
          submissionId: r.approvedId,
        }),
      ]);
      expect(first.value.nextBeforeId).toBe(first.value.entries[0]!.id);

      const second = await r.history.execute(r.admin(), {
        certificateId: r.certificateId,
        beforeId: first.value.nextBeforeId,
        limit: '10',
      });
      expect(second).toMatchObject({
        ok: true,
        value: { entries: [{ toStatus: 'approved', note: null }], nextBeforeId: null },
      });

      expect(r.audit.entries.map((e) => [e.action, e.after])).toEqual([
        ['certification.history.viewed', { historyIds: [first.value.entries[0]!.id] }],
        [
          'certification.history.viewed',
          { historyIds: [second.ok ? second.value.entries[0]!.id : null] },
        ],
      ]);
      expect(JSON.stringify(r.audit.entries)).not.toContain('Note for the file');
    });

    it('shows an unreadable note (erased key) as none', async () => {
      const r = rig();
      await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 5,
        reasonCode: revokeReason.code,
        reasonText: 'Private.',
      });
      r.cipher.destroyed.add(r.sellerId);
      const read = await r.history.execute(r.admin(), { certificateId: r.certificateId });
      expect(read).toMatchObject({ ok: true, value: { entries: [{ note: null }] } });
    });

    it('refuses a seller, another Market, a bad cursor and a bad limit', async () => {
      const r = rig();
      expect(await r.history.execute(r.seller(), { certificateId: r.certificateId })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await r.history.execute(r.admin(otherMarket), { certificateId: r.certificateId }),
      ).toEqual({ ok: false, error: { code: 'certificate.not-found' } });
      for (const input of [{ beforeId: 'x' }, { limit: 0 }, { limit: 101 }, { limit: 'ten' }]) {
        expect(
          await r.history.execute(r.admin(), { certificateId: r.certificateId, ...input }),
        ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      expect(r.audit.entries).toHaveLength(0);
    });
  });

  describe('the revoke mail (design 12)', () => {
    function mailRig() {
      const r = rig();
      const sent: MailMessage[] = [];
      const handled = new Set<string>();
      const mail = new SendDecisionMail(gate, {
        unitOfWork: {
          run: <T, E>(
            _m: MarketContext,
            work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
          ) => work(),
          runOnce: fakeRunOnce(handled),
        },
        reviews: r.reviews,
        contacts: { emailOf: () => Promise.resolve('owner@example.test') },
        transport: {
          send: (message) => {
            sent.push(message);
            return Promise.resolve();
          },
        },
        mailPolicy: new ConfigCertificationMailPolicy(markets),
        policies,
      });
      let n = 0;
      const deliver = () =>
        mail.execute(testCallContext(market, 'system'), {
          delivery: {
            eventId: `01990000-0000-7000-8000-00000000${(n += 1).toString().padStart(4, '0')}`,
            subscriber: 'certification.revoked-mail',
            attempt: 1,
          } as never,
          certificateId: r.certificateId,
          sellerId: r.sellerId,
          submissionId: r.approvedId,
          decision: 'revoked',
        });
      return { ...r, sent, deliver };
    }

    it("sends the Market's reason label, never the note, once the record is revoked", async () => {
      const r = mailRig();
      await r.revoke.execute(r.admin(), {
        certificateId: r.certificateId,
        version: 5,
        reasonCode: revokeReason.code,
        reasonText: 'Secret admin note.',
      });
      expect(await r.deliver()).toEqual({ ok: true, value: { code: 'decision-mail.sent' } });
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]!.subject).toBe('Your certificate was revoked');
      expect(r.sent[0]!.text).toContain(`Reason: ${revokeReason.label}`);
      expect(r.sent[0]!.text).not.toContain('Secret admin note');
    });

    it('skips while the record is not revoked (decision gone)', async () => {
      const r = mailRig();
      expect(await r.deliver()).toEqual({
        ok: true,
        value: { code: 'decision-mail.skipped', reason: 'decision.gone' },
      });
      expect(r.sent).toHaveLength(0);
    });
  });
});
