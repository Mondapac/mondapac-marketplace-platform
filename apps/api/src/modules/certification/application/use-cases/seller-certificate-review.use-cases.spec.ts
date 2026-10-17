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
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { checkCodesFor } from '../../domain/review';
import { CheckedInReviewPolicy } from '../../infrastructure/review-policy/checked-in-review-policy';
import type { ReviewSubmission } from '../ports/review.repository';
import type { ReviewDependencies } from '../review/review.shared';
import { ApproveSellerCertificate } from './seller-certificate-approve.use-case';
import { DeclineSellerCertificate } from './seller-certificate-decline.use-case';
import { SellerCertificateOverview } from './seller-certificate-overview.use-case';
import { SellerCertificateRecordCheck } from './seller-certificate-record-check.use-case';
import { SellerCertificateRecordConfirmation } from './seller-certificate-record-confirmation.use-case';
import { SellerCertificateRecordScope } from './seller-certificate-record-scope.use-case';
import { RequestChangesSellerCertificate } from './seller-certificate-request-changes.use-case';
import { SellerCertificateReviewDocumentRead } from './seller-certificate-review-document-read.use-case';
import { SellerCertificateReviewRead } from './seller-certificate-review-read.use-case';
import { SellerCertificatesQueue } from './seller-certificates-queue.use-case';

// The admin review of a seller certificate in memory (certification design 3.2, 7.2; slice 7), on
// both Market fixtures with the real gate, the real Market policies and the real use cases. The
// SQL is in test/db/certification-review.db-spec.ts, the routes in
// test/certification-review.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('admin review of a seller certificate, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const policies = new CheckedInReviewPolicy();

  function rig(
    options: {
      issuerState?: 'active' | 'derecognised';
      expiry?: string;
      zone?: string | null;
      mode?: 'THIRD_PARTY_DOCUMENT' | 'SELF_DECLARATION';
      downloads?: boolean;
    } = {},
  ) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const sellerId = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    const typeId = ids.next<'CertificationType'>();
    const issuerId = ids.next<'Issuer'>();
    const channelId = ids.next<'IssuerContactChannel'>();
    const certificateId = ids.next<'SellerCertification'>();
    const submissionId = ids.next<'Submission'>();
    const documentId = ids.next<'UploadedDocument'>();
    const mode = options.mode ?? 'THIRD_PARTY_DOCUMENT';
    const cipher = new FakeCipher();
    const vault = new MemoryVault();
    const outbox = new MemoryOutbox();
    const audit = new RecordingAudit();
    const sellers = new FixedReviewSellers();
    vault.objects.set('obj-1', Buffer.from('%PDF-1.4 clean'));

    const third = mode === 'THIRD_PARTY_DOCUMENT';
    const submission: ReviewSubmission = {
      id: submissionId,
      submissionNo: 1,
      kind: 'initial',
      typeRevisionId: ids.next<'CertificationTypeRevision'>(),
      verificationMode: mode,
      requiresIssuerRegistry: third,
      requiresDocument: third,
      requiresExpiry: third,
      issuer: third
        ? {
            id: issuerId,
            typeId,
            displayName: 'Halal Authority',
            state: options.issuerState ?? 'active',
            channels: [
              { id: channelId, kind: 'web-page', value: 'https://example.test', retired: false },
            ],
          }
        : null,
      certificateNumberCiphertext: third
        ? `v1.${Buffer.from('submission-certificate-number|HC-1234').toString('base64url')}`
        : null,
      issueDate: third ? Temporal.PlainDate.from('2026-01-01') : null,
      expiryDate: third ? Temporal.PlainDate.from(options.expiry ?? '2028-01-01') : null,
      selfDeclared: third ? null : true,
      selfDeclarationNoteCiphertext: null,
      submittedZone: 'Australia/Brisbane',
      submittedAt: Temporal.Instant.from('2026-10-16T01:00:00Z'),
      documents: third
        ? [
            {
              id: documentId,
              position: 1,
              mediaType: 'application/pdf',
              byteSize: 14,
              pageCount: 1,
              createdAt: T0,
              objectKey: 'obj-1',
              dataKeyEnvelope: 'v1.x',
              cleanSha256: Buffer.alloc(32),
              submitted: true,
              purpose: 'seller-certificate',
            },
          ]
        : [],
      checks: [],
      scope: null,
      confirmation: null,
      decision: null,
    };
    const reviews = new MemoryReviews(
      code,
      {
        id: certificateId,
        sellerId,
        typeId,
        typeCode: third ? 'halal' : 'vegan',
        status: 'in-review',
        pendingSubmissionId: submissionId,
        pendingKind: 'initial',
        approvedSubmissionId: null,
        approvedBoundaryAt: null,
        approvedIssuerState: null,
        submissionCount: 1,
        statusChangedAt: T0,
        lastChangedAt: T0,
        createdAt: T0,
        version: 3,
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
    const zone = options.zone === undefined ? 'Australia/Brisbane' : options.zone;
    const deps: ReviewDependencies = {
      unitOfWork: passThroughUnitOfWork,
      reviews,
      cipher,
      vault,
      audit,
      zones: zonesOf({ [sellerId]: { zone, addressZone: zone } }),
      sellers,
      policies,
      outbox,
      clock,
      ids,
      documentDownloadEnabled: options.downloads ?? false,
    };
    const actor = (population: 'admin' | 'seller' | 'customer' = 'admin'): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: population === 'seller' ? sellerId : null,
        }),
      );
    const useCases = {
      queue: new SellerCertificatesQueue(gate, deps),
      read: new SellerCertificateReviewRead(gate, deps),
      document: new SellerCertificateReviewDocumentRead(gate, deps),
      check: new SellerCertificateRecordCheck(gate, deps),
      scope: new SellerCertificateRecordScope(gate, deps),
      confirm: new SellerCertificateRecordConfirmation(gate, deps),
      approve: new ApproveSellerCertificate(gate, deps),
      changes: new RequestChangesSellerCertificate(gate, deps),
      decline: new DeclineSellerCertificate(gate, deps),
      overview: new SellerCertificateOverview(gate, deps),
    };
    const required = checkCodesFor(policies.policyFor(market), mode)
      .filter((c) => c.required)
      .map((c) => c.code);
    const reasons = policies.policyFor(market).reasons;
    return {
      ...useCases,
      deps,
      actor,
      reviews,
      outbox,
      audit,
      cipher,
      sellers,
      ids,
      sellerId,
      otherSeller,
      certificateId,
      submissionId,
      documentId,
      channelId,
      required,
      reasons,
      version: () => reviews.certificate.version,
      async recordAll(context: CallContext) {
        for (const checkCode of required) {
          const result = await useCases.check.execute(context, {
            certificateId,
            submissionId,
            checkCode,
            result: 'done',
          });
          expect(result.ok).toBe(true);
        }
      },
      async recordScope(context: CallContext) {
        const result = await useCases.scope.execute(context, {
          certificateId,
          submissionId,
          location: 'Brisbane QLD',
          scope: 'Beef products',
        });
        expect(result.ok).toBe(true);
      },
    };
  }

  describe('the queue and the page', () => {
    it('lists the pending submission with the store name and no personal data', async () => {
      const r = rig();
      const result = await r.queue.execute(r.actor(), {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.total).toBe(1);
      expect(result.value.items[0]).toMatchObject({
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
        storeName: 'Example Store',
        typeCode: 'halal',
      });
      expect(JSON.stringify(result.value)).not.toContain('HC-1234');
    });

    it.each(['seller', 'customer'] as const)('refuses a %s caller everywhere', async (who) => {
      const r = rig();
      const context = r.actor(who);
      const refused = { ok: false, error: { code: 'access.denied' } };
      expect(await r.queue.execute(context, {})).toEqual(refused);
      expect(await r.read.execute(context, { certificateId: r.certificateId })).toEqual(refused);
      expect(
        await r.approve.execute(context, {
          certificateId: r.certificateId,
          submissionId: r.submissionId,
          version: 3,
        }),
      ).toEqual(refused);
      expect(r.outbox.events).toEqual([]);
    });

    it('refuses an anonymous caller', async () => {
      const r = rig();
      const result = await r.queue.execute(testCallContext(market, 'anonymous'), {});
      expect(result).toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
    });

    it('shows the decrypted fields, the checks, a hint and audits the read', async () => {
      const r = rig();
      r.reviews.hints = [
        {
          kind: 'number',
          certificateId: r.ids.next<'SellerCertification'>(),
          sellerId: r.otherSeller,
        },
      ];
      const result = await r.read.execute(r.actor(), {
        certificateId: r.certificateId,
        reason: 'duplicate-hint',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.submission.certificateNumber).toBe('HC-1234');
      expect(result.value.certificate.version).toBe(3);
      expect(result.value.checks.map((c) => c.code)).toEqual(expect.arrayContaining(r.required));
      expect(result.value.checks.every((c) => c.result === null)).toBe(true);
      expect(result.value.duplicateHints).toHaveLength(1);
      expect(result.value.business.status).toBe('ok');
      expect(r.audit.entries.map((e) => e.action)).toEqual(['certification.review-page.viewed']);
    });

    it('answers certificate.not-found for an unknown certificate and validates ids', async () => {
      const r = rig();
      const unknown = r.ids.next<'SellerCertification'>();
      expect(await r.read.execute(r.actor(), { certificateId: unknown })).toEqual({
        ok: false,
        error: { code: 'certificate.not-found' },
      });
      const bad = await r.read.execute(r.actor(), { certificateId: 'nope' });
      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('still shows the page when the business details are refused', async () => {
      const r = rig();
      r.sellers.details = { status: 'denied' };
      const result = await r.read.execute(r.actor(), { certificateId: r.certificateId });
      expect(result.ok && result.value.business.status).toBe('denied');
    });
  });

  describe('guards that fail closed', () => {
    it('never approves a revoked record', async () => {
      const r = rig();
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      r.reviews.certificate.status = 'revoked';
      const result = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      expect(result).toEqual({ ok: false, error: { code: 'certificate.revoked' } });
      expect(r.outbox.events).toEqual([]);
    });

    it('refuses an approval of a type that needs an expiry when the submission has none', async () => {
      const r = rig();
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      r.reviews.submission.expiryDate = null;
      const result = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      expect(result).toEqual({ ok: false, error: { code: 'certificate.incomplete' } });
    });
  });

  describe('files', () => {
    it('answers document.not-found for the file of another certificate', async () => {
      const r = rig({ downloads: true });
      // An id that is well formed and exists elsewhere, but is not a file of this submission.
      const stranger = { documentId: r.ids.next<'UploadedDocument'>() };
      expect(
        await r.document.execute(r.actor(), {
          certificateId: r.certificateId,
          documentId: stranger.documentId,
        }),
      ).toEqual({ ok: false, error: { code: 'document.not-found' } });
    });

    it('is off by default and audited when on', async () => {
      const off = rig();
      expect(
        await off.document.execute(off.actor(), {
          certificateId: off.certificateId,
          documentId: off.documentId,
        }),
      ).toEqual({ ok: false, error: { code: 'document.download-disabled' } });

      const on = rig({ downloads: true });
      const result = await on.document.execute(on.actor(), {
        certificateId: on.certificateId,
        documentId: on.documentId,
      });
      expect(result.ok && result.value.contentType).toBe('application/pdf');
      expect(on.audit.entries.map((e) => e.action)).toEqual(['certification.document.downloaded']);
      const other = await on.document.execute(on.actor(), {
        certificateId: on.certificateId,
        documentId: on.ids.next<'UploadedDocument'>(),
      });
      expect(other).toEqual({ ok: false, error: { code: 'document.not-found' } });
    });
  });

  describe('checks, scope and approval', () => {
    it('refuses to approve until the required checks and the scope are recorded', async () => {
      const r = rig();
      const context = r.actor();
      const input = { certificateId: r.certificateId, submissionId: r.submissionId, version: 3 };
      const open = await r.approve.execute(context, input);
      expect(open).toMatchObject({ ok: false, error: { code: 'review.checks-incomplete' } });
      if (!open.ok && open.error.code === 'review.checks-incomplete') {
        expect(open.error.fields.map((f) => f.path).sort()).toEqual([...r.required].sort());
      }

      await r.recordAll(context);
      expect(await r.approve.execute(context, input)).toEqual({
        ok: false,
        error: { code: 'review.scope-missing' },
      });

      await r.recordScope(context);
      const done = await r.approve.execute(context, input);
      expect(done).toMatchObject({
        ok: true,
        value: { outcome: 'approved', status: 'approved', version: 4 },
      });
      expect(r.reviews.certificate.approvedSubmissionId).toBe(r.submissionId);
      expect(r.reviews.certificate.approvedBoundaryAt).not.toBeNull();
      expect(r.outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-approved.v1',
      ]);
      expect(r.audit.entries.map((e) => e.action)).toContain(
        'certification.seller-certification.approved',
      );
    });

    it('takes the latest result of a check: a later problem blocks the approval', async () => {
      const r = rig();
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      await r.check.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        checkCode: r.required[0],
        result: 'problem',
      });
      const result = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'review.checks-incomplete' } });
    });

    it('refuses an unknown check, a bad result and a foreign submission', async () => {
      const r = rig();
      const context = r.actor();
      const base = { certificateId: r.certificateId, submissionId: r.submissionId };
      expect(
        await r.check.execute(context, { ...base, checkCode: 'no-such-check', result: 'done' }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await r.check.execute(context, { ...base, checkCode: r.required[0], result: 'maybe' }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await r.check.execute(context, {
          ...base,
          submissionId: r.ids.next<'Submission'>(),
          checkCode: r.required[0],
          result: 'done',
        }),
      ).toEqual({ ok: false, error: { code: 'review.not-current-submission' } });
    });

    it('refuses an approval on a moved version and on a submission that is not pending', async () => {
      const r = rig();
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      const stale = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 2,
      });
      expect(stale).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      const wrong = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.ids.next<'Submission'>(),
        version: 3,
      });
      expect(wrong).toEqual({ ok: false, error: { code: 'review.not-current-submission' } });
      expect(r.outbox.events).toEqual([]);
      expect(r.reviews.certificate.status).toBe('in-review');
    });

    it('refuses to approve twice', async () => {
      const r = rig();
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      const input = { certificateId: r.certificateId, submissionId: r.submissionId, version: 3 };
      expect((await r.approve.execute(context, input)).ok).toBe(true);
      expect(await r.approve.execute(context, input)).toEqual({
        ok: false,
        error: { code: 'review.not-current-submission' },
      });
      expect(r.outbox.events).toHaveLength(1);
    });

    it('refuses a derecognised issuer', async () => {
      const r = rig({ issuerState: 'derecognised' });
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      expect(
        await r.approve.execute(context, {
          certificateId: r.certificateId,
          submissionId: r.submissionId,
          version: 3,
        }),
      ).toEqual({ ok: false, error: { code: 'issuer.not-active' } });
    });

    it('refuses a certificate whose expiry boundary has passed', async () => {
      const r = rig({ expiry: '2026-10-16' });
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      expect(
        await r.approve.execute(context, {
          certificateId: r.certificateId,
          submissionId: r.submissionId,
          version: 3,
        }),
      ).toEqual({ ok: false, error: { code: 'certificate.expired' } });
    });

    it('refuses when the seller has no approved zone', async () => {
      const r = rig({ zone: null });
      const context = r.actor();
      await r.recordAll(context);
      await r.recordScope(context);
      expect(
        await r.approve.execute(context, {
          certificateId: r.certificateId,
          submissionId: r.submissionId,
          version: 3,
        }),
      ).toEqual({ ok: false, error: { code: 'seller.zone-missing' } });
    });

    it('approves a self-declaration without scope or issuer', async () => {
      const r = rig({ mode: 'SELF_DECLARATION' });
      const context = r.actor();
      await r.recordAll(context);
      const result = await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      expect(result).toMatchObject({ ok: true, value: { status: 'approved' } });
    });

    it('rejects a reason on approve', async () => {
      const r = rig();
      const result = await r.approve.execute(r.actor(), {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
        reasonCode: r.reasons[0]!.code,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('request changes and decline', () => {
    it('requests changes with a reason of the Market and seals the text', async () => {
      const r = rig();
      const reason = r.reasons.find((x) => x.outcomes.includes('changes-requested'))!;
      const result = await r.changes.execute(r.actor(), {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
        reasonCode: reason.code,
        reasonText: 'The last page is cut off.',
      });
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'changes-requested', status: 'changes-needed', version: 4 },
      });
      const stored = r.reviews.submission.decision!;
      expect(stored.reasonCode).toBe(reason.code);
      expect(stored.reasonTextCiphertext).not.toContain('cut off');
      expect(r.outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-changes-requested.v1',
      ]);
      const sealed = await r.cipher.open(
        market,
        r.sellerId,
        'decision-reason-text',
        stored.reasonTextCiphertext!,
      );
      expect(sealed.ok && sealed.value).toBe('The last page is cut off.');
    });

    it('declines with a reason that allows declining, and not with one that does not', async () => {
      const r = rig();
      const changesOnly = r.reasons.find((x) => !x.outcomes.includes('declined'))!;
      const refused = await r.decline.execute(r.actor(), {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
        reasonCode: changesOnly.code,
      });
      expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });

      const reason = r.reasons.find((x) => x.outcomes.includes('declined'))!;
      const result = await r.decline.execute(r.actor(), {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
        reasonCode: reason.code,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'declined', status: 'declined' },
      });
      expect(r.outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-declined.v1',
      ]);
    });

    it('needs a reason code and keeps the text short and plain', async () => {
      const r = rig();
      const base = { certificateId: r.certificateId, submissionId: r.submissionId, version: 3 };
      expect(await r.changes.execute(r.actor(), base)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      const reason = r.reasons.find((x) => x.outcomes.includes('changes-requested'))!;
      expect(
        await r.changes.execute(r.actor(), {
          ...base,
          reasonCode: reason.code,
          reasonText: 'x'.repeat(1001),
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await r.changes.execute(r.actor(), {
          ...base,
          reasonCode: reason.code,
          reasonText: 'bad\u0000text',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(r.outbox.events).toEqual([]);
    });
  });

  describe('issuer confirmation', () => {
    const confirmation = (r: ReturnType<typeof rig>, extra: object = {}) => ({
      certificateId: r.certificateId,
      submissionId: r.submissionId,
      channelId: r.channelId,
      confirmedOn: '2026-10-16',
      reference: 'Phone call, ref 77',
      confirmsNumber: true,
      confirmsHolder: true,
      ...extra,
    });

    it('records one confirmation, moves the version and publishes an event', async () => {
      const r = rig();
      const first = await r.confirm.execute(r.actor(), confirmation(r));
      expect(first).toMatchObject({ ok: true, value: { version: 4 } });
      expect(r.outbox.events.map((e) => e.type)).toEqual([
        'certification.seller-certification-issuer-confirmed.v1',
      ]);
      expect(await r.confirm.execute(r.actor(), confirmation(r))).toEqual({
        ok: false,
        error: { code: 'confirmation.exists' },
      });
      // The decision after it must name the new version.
      const stale = await r.approve.execute(r.actor(), {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      expect(stale).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    });

    it('needs both ticks, a registered channel, a real date and a reference', async () => {
      const r = rig();
      for (const extra of [
        { confirmsNumber: false },
        { confirmsHolder: false },
        { channelId: r.ids.next<'IssuerContactChannel'>() },
        { confirmedOn: '2026-02-30' },
        { confirmedOn: '2030-01-01' },
        { reference: '' },
      ]) {
        expect(await r.confirm.execute(r.actor(), confirmation(r, extra))).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(r.outbox.events).toEqual([]);
    });

    it('refuses a submission with no issuer', async () => {
      const r = rig({ mode: 'SELF_DECLARATION' });
      expect(await r.confirm.execute(r.actor(), confirmation(r))).toEqual({
        ok: false,
        error: { code: 'confirmation.no-issuer' },
      });
    });
  });

  describe('overview', () => {
    it('answers codes only: waiting, then valid after the approval', async () => {
      const r = rig();
      const context = r.actor();
      const waiting = await r.overview.execute(context, { sellerIds: [r.sellerId, r.otherSeller] });
      expect(waiting).toEqual({
        ok: true,
        value: [
          { sellerId: r.sellerId, validTypeCodes: [], awaitingReviewTypeCodes: ['halal'] },
          { sellerId: r.otherSeller, validTypeCodes: [], awaitingReviewTypeCodes: [] },
        ],
      });
      await r.recordAll(context);
      await r.recordScope(context);
      await r.approve.execute(context, {
        certificateId: r.certificateId,
        submissionId: r.submissionId,
        version: 3,
      });
      const approved = await r.overview.execute(context, { sellerIds: [r.sellerId] });
      expect(approved).toEqual({
        ok: true,
        value: [{ sellerId: r.sellerId, validTypeCodes: ['halal'], awaitingReviewTypeCodes: [] }],
      });
    });

    it('refuses more than 100 sellers and a non-admin caller', async () => {
      const r = rig();
      const many = Array.from({ length: 101 }, () => r.ids.next<'Seller'>());
      expect(await r.overview.execute(r.actor(), { sellerIds: many })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await r.overview.execute(r.actor('seller'), { sellerIds: [r.sellerId] })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });
});
