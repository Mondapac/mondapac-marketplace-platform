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
import {
  fakeCounterKeys,
  FakeCipher,
  MemoryCertificates,
  MemoryCounters,
  MemoryOutbox,
  MemoryTypeCatalog,
  MemoryVault,
  passThroughUnitOfWork,
  zonesOf,
} from '../../../../../test/support/certification-fakes';
import { MemoryIssuerRequests } from '../../../../../test/support/certification-issuer-request-fakes';
import {
  FixedReviewSellers,
  RecordingAudit,
} from '../../../../../test/support/certification-review-fakes';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigCertificationMailPolicy } from '../../infrastructure/config-certification-mail-policy';
import { CheckedInReviewPolicy } from '../../infrastructure/review-policy/checked-in-review-policy';
import { SharpDocumentIntake } from '../../infrastructure/sharp-document-intake';
import type { IssuerRequestDependencies } from '../issuer-requests/issuer-request.shared';
import type { OwnCertificateDependencies } from '../own/own-certificate.shared';
import { IssuerRequestAnswer } from './issuer-request-answer.use-case';
import { IssuerRequestDocumentRead } from './issuer-request-document-read.use-case';
import { IssuerRequestRead } from './issuer-request-read.use-case';
import { IssuerRequestsQueue } from './issuer-requests-queue.use-case';
import { OwnCertificateCreate } from './own-certificate-create.use-case';
import { OwnCertificatesList } from './own-certificates-list.use-case';
import { OwnIssuerRequestCreate } from './own-issuer-request-create.use-case';
import { SendIssuerRequestMail } from './send-issuer-request-mail.use-case';

// "My issuer is not listed" in memory (certification design 2.1, 3.3, 7.2, 12; slice 6), on both
// Market fixtures with the real gate, the real file intake and the real Market policies. The SQL is
// in test/db/certification-issuer-request.db-spec.ts, the routes in
// test/certification-issuer-requests.e2e.spec.ts. Hassan's check for the slice: the typed name never
// reaches an issuer, so a canary name is searched for in every event, audit row, log line and mail.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n',
);
const JS_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page /AA <</S /JavaScript>>>> endobj\n%%EOF\n',
);
const CANARY = 'Canary Certifiers 7Q9 of Nowhere';

async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe.each(['AU', 'ZZ'] as const)('issuer requests in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const policies = new CheckedInReviewPolicy();
  const reasonOf = (): string => policies.policyFor(market).issuerRequestReasons[0]!.code;

  let logs: unknown[];
  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        const [message] = args;
        logs.push(message);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  function rig(options: { downloads?: boolean } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const sellerId = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    const certificates = new MemoryCertificates();
    const requests = new MemoryIssuerRequests(certificates.openIssuerRequests);
    const types = new MemoryTypeCatalog();
    const counters = new MemoryCounters();
    const vault = new MemoryVault();
    const outbox = new MemoryOutbox();
    const cipher = new FakeCipher();
    const audit = new RecordingAudit();

    const halal = {
      typeId: ids.next<'CertificationType'>(),
      code: 'halal',
      status: 'active' as const,
      revisionId: ids.next<'CertificationTypeRevision'>(),
      verificationMode: 'THIRD_PARTY_DOCUMENT' as const,
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      names: { en: 'Halal' },
    };
    const vegan = {
      ...halal,
      typeId: ids.next<'CertificationType'>(),
      code: 'vegan',
      revisionId: ids.next<'CertificationTypeRevision'>(),
      verificationMode: 'SELF_DECLARATION' as const,
      requiresIssuerRegistry: false,
      requiresDocument: false,
      requiresExpiry: false,
      names: { en: 'Vegan' },
    };
    const kosher = {
      ...halal,
      typeId: ids.next<'CertificationType'>(),
      code: 'kosher',
      status: 'inactive' as const,
      revisionId: ids.next<'CertificationTypeRevision'>(),
    };
    for (const type of [halal, vegan, kosher]) {
      types.addType(market, type);
      certificates.typeCodes.set(type.typeId, type.code);
      requests.typeCodes.set(type.typeId, type.code);
    }
    const activeIssuer = {
      id: ids.next<'Issuer'>(),
      typeId: halal.typeId,
      displayName: 'Halal Authority',
      state: 'active' as const,
    };
    const proposedIssuer = {
      ...activeIssuer,
      id: ids.next<'Issuer'>(),
      state: 'proposed' as const,
    };
    const otherTypeIssuer = { ...activeIssuer, id: ids.next<'Issuer'>(), typeId: kosher.typeId };
    for (const issuer of [activeIssuer, proposedIssuer, otherTypeIssuer]) {
      types.addIssuer(market, issuer);
    }

    const zones = zonesOf({
      [sellerId]: { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' },
    });
    const deps: IssuerRequestDependencies = {
      unitOfWork: passThroughUnitOfWork,
      requests,
      types,
      vault,
      intake: new SharpDocumentIntake(),
      cipher,
      counters,
      counterKeys: fakeCounterKeys,
      zones,
      sellers: new FixedReviewSellers(),
      policies,
      audit,
      outbox,
      clock,
      ids,
      documentDownloadEnabled: options.downloads ?? true,
    };
    const ownDeps = {
      unitOfWork: passThroughUnitOfWork,
      certificates,
      types,
      vault,
      intake: new SharpDocumentIntake(),
      cipher,
      counters,
      counterKeys: fakeCounterKeys,
      indexKeys: { numberHmac: () => new Uint8Array(32), documentHmac: () => new Uint8Array(32) },
      zones,
      outbox,
      clock,
      ids,
      draftQuotaBytes: 200 * 1024 * 1024,
    } satisfies OwnCertificateDependencies;

    const contextOf = (
      population: 'seller' | 'admin' | 'customer' = 'seller',
      seller: Id<'Seller'> = sellerId,
    ): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: population === 'seller' ? seller : null,
        }),
      );
    const actingAs = (context: CallContext): CallContext =>
      ({
        ...context,
        actor: { ...context.actor, actingAs: { accountId: 'x', sellerId: 'y' } },
      }) as unknown as CallContext;

    const sent: MailMessage[] = [];
    const mail = new SendIssuerRequestMail(gate, {
      unitOfWork: { ...passThroughUnitOfWork, runOnce: fakeRunOnce(new Set<string>()) },
      requests,
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
    const delivery = (): EventDelivery => ({
      eventId: ids.next<'event'>(),
      subscriber: 'certification.issuer-request-mail',
      attempt: 1,
    });

    return {
      clock,
      ids,
      sellerId,
      otherSeller,
      requests,
      certificates,
      counters,
      vault,
      outbox,
      audit,
      sent,
      halal,
      vegan,
      kosher,
      activeIssuer,
      proposedIssuer,
      otherTypeIssuer,
      contextOf,
      actingAs,
      delivery,
      create: new OwnIssuerRequestCreate(gate, deps),
      queue: new IssuerRequestsQueue(gate, deps),
      read: new IssuerRequestRead(gate, deps),
      document: new IssuerRequestDocumentRead(gate, deps),
      answer: new IssuerRequestAnswer(gate, deps),
      mail,
      createCertificate: new OwnCertificateCreate(gate, ownDeps),
      listCertificates: new OwnCertificatesList(gate, ownDeps),
    };
  }
  type Rig = ReturnType<typeof rig>;

  const send = (r: Rig, over: Record<string, unknown> = {}, seller: Id<'Seller'> = r.sellerId) =>
    r.create.execute(r.contextOf('seller', seller), {
      typeCode: 'halal',
      issuerName: CANARY,
      data: PDF.toString('base64'),
      ...over,
    });

  describe('the seller sends a request (own-issuer-request.create)', () => {
    it('stores the typed name encrypted, the file with the issuer-request purpose, and answers no name', async () => {
      const r = rig();
      const view = await unwrap(send(r));
      expect(view).toEqual({
        issuerRequestId: expect.any(String) as string,
        typeCode: 'halal',
        state: 'open',
        createdAt: T0.toString(),
      });
      expect(JSON.stringify(view)).not.toContain(CANARY);
      const stored = r.requests.rows.get(view.issuerRequestId)!;
      expect(stored).toMatchObject({ marketId: code, sellerId: r.sellerId, state: 'open' });
      expect(stored.typedNameCiphertext).not.toContain(CANARY);
      expect(stored.typedNameCiphertext).toMatch(/^v1\./);
      expect(stored.documents).toEqual([
        expect.objectContaining({
          position: 1,
          mediaType: 'application/pdf',
          purpose: 'issuer-request',
        }),
      ]);
      expect(r.vault.objects.size).toBe(1);
      // No event and no audit row at creation: the queue is the admin's.
      expect(r.outbox.events).toEqual([]);
      expect(r.audit.entries).toEqual([]);
    });

    it('shows the draft of that type as draft-issuer-not-listed while the request is open', async () => {
      const r = rig();
      await unwrap(r.createCertificate.execute(r.contextOf(), { typeCode: 'halal' }));
      await unwrap(send(r));
      const list = await unwrap(r.listCertificates.execute(r.contextOf(), {}));
      expect(list.certificates.map((c) => c.status)).toEqual(['draft-issuer-not-listed']);
    });

    it('refuses an acting-as session, an unsure one and every non-seller', async () => {
      const r = rig();
      await expect(
        r.create.execute(r.actingAs(r.contextOf()), {
          typeCode: 'halal',
          issuerName: CANARY,
          data: PDF.toString('base64'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      const unsure = r.contextOf();
      const marked = {
        ...unsure,
        actor: { ...unsure.actor, actingAs: 'unknown' },
      } as unknown as CallContext;
      await expect(
        r.create.execute(marked, { typeCode: 'halal', issuerName: CANARY, data: 'AAAA' }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      for (const population of ['admin', 'customer'] as const) {
        await expect(
          r.create.execute(r.contextOf(population), {
            typeCode: 'halal',
            issuerName: CANARY,
            data: 'AAAA',
          }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
      expect(r.requests.rows.size).toBe(0);
    });

    it.each([
      [{ typeCode: 'HALAL' }, 'typeCode', 'format'],
      [{ issuerName: '  ' }, 'issuerName', 'required'],
      [{ issuerName: 'x'.repeat(201) }, 'issuerName', 'too-long'],
      [{ issuerName: 'bad\u0007name' }, 'issuerName', 'invalid-character'],
      [{ data: '' }, 'data', 'required'],
      [{ data: 'not base64!' }, 'data', 'format'],
    ])('validates %p', async (over, path, fieldCode) => {
      const r = rig();
      await expect(send(r, over)).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: fieldCode }] },
      });
    });

    it('takes an active registry type only', async () => {
      const r = rig();
      await expect(send(r, { typeCode: 'vegan' })).resolves.toEqual({
        ok: false,
        error: { code: 'type.no-issuer-registry' },
      });
      await expect(send(r, { typeCode: 'kosher' })).resolves.toEqual({
        ok: false,
        error: { code: 'type.inactive' },
      });
      await expect(send(r, { typeCode: 'unknown-type' })).resolves.toEqual({
        ok: false,
        error: { code: 'type.not-found' },
      });
      expect(r.vault.objects.size).toBe(0);
    });

    it('refuses a file the intake refuses and stores nothing', async () => {
      const r = rig();
      await expect(send(r, { data: JS_PDF.toString('base64') })).resolves.toEqual({
        ok: false,
        error: { code: 'file.active-content' },
      });
      expect(r.requests.rows.size).toBe(0);
      expect(r.vault.objects.size).toBe(0);
    });

    it('keeps one open request per seller and type; another seller and an answered one are free', async () => {
      const r = rig();
      const first = await unwrap(send(r));
      await expect(send(r)).resolves.toEqual({
        ok: false,
        error: { code: 'issuer-request.already-open' },
      });
      // Refused before the file work: only the first request's file is stored.
      expect(r.vault.objects.size).toBe(1);
      expect(r.requests.rows.size).toBe(1);
      await unwrap(send(r, {}, r.otherSeller));
      await unwrap(
        r.answer.execute(r.contextOf('admin'), {
          issuerRequestId: first.issuerRequestId,
          version: 1,
          outcome: 'not-accepted',
          reasonCode: reasonOf(),
        }),
      );
      await unwrap(send(r));
      expect(r.requests.rows.size).toBe(3);
    });

    it('answers already-open when a racing request wins the unique index, and discards the file', async () => {
      const r = rig();
      r.requests.raceNextAdd = true;
      await expect(send(r)).resolves.toEqual({
        ok: false,
        error: { code: 'issuer-request.already-open' },
      });
      expect(r.vault.objects.size).toBe(0);
      expect(r.requests.rows.size).toBe(0);
    });

    it('allows 3 requests a day per seller (design 7.5), a refused one included, and fails closed without counters', async () => {
      const r = rig();
      await unwrap(send(r));
      // The second and third are refused as already open, yet they count against the day.
      for (let n = 0; n < 2; n += 1) {
        await expect(send(r)).resolves.toEqual({
          ok: false,
          error: { code: 'issuer-request.already-open' },
        });
      }
      await expect(send(r)).resolves.toMatchObject({
        ok: false,
        error: { code: 'request.throttled' },
      });
      r.counters.failing = true;
      await expect(send(r)).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('discards the stored file when the write fails', async () => {
      const r = rig();
      r.requests.failNextWrite = new Error('down');
      await expect(send(r)).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(r.vault.objects.size).toBe(0);
    });
  });

  describe('the admin queue, read and file read', () => {
    it('lists open requests oldest first with clear fields only, paged', async () => {
      const r = rig();
      const first = await unwrap(send(r));
      r.clock.advance(Temporal.Duration.from({ minutes: 5 }));
      const second = await unwrap(send(r, {}, r.otherSeller));
      const page = await unwrap(r.queue.execute(r.contextOf('admin'), { limit: 1 }));
      expect(page.total).toBe(2);
      expect(page.items).toEqual([
        {
          issuerRequestId: first.issuerRequestId,
          version: 1,
          typeCode: 'halal',
          sellerId: r.sellerId,
          storeName: 'Example Store',
          documentCount: 1,
          createdAt: T0.toString(),
        },
      ]);
      const next = await unwrap(
        r.queue.execute(r.contextOf('admin'), { afterId: page.nextAfterId, limit: 1 }),
      );
      expect(next.items.map((i) => i.issuerRequestId)).toEqual([second.issuerRequestId]);
      expect(next.nextAfterId).toBeNull();
      expect(JSON.stringify([page, next])).not.toContain(CANARY);
    });

    it('refuses the queue to a seller and an unknown cursor', async () => {
      const r = rig();
      await expect(r.queue.execute(r.contextOf('seller'), {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(r.queue.execute(r.contextOf('admin'), { afterId: 'x' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('decrypts the typed name for the admin, audits the read and lists the answer choices', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const page = await unwrap(
        r.read.execute(r.contextOf('admin'), { issuerRequestId: sent.issuerRequestId }),
      );
      expect(page).toMatchObject({
        issuerRequestId: sent.issuerRequestId,
        state: 'open',
        typedIssuerName: CANARY,
        answer: null,
        activeIssuers: [{ issuerId: r.activeIssuer.id, displayName: 'Halal Authority' }],
        reasons: policies.policyFor(market).issuerRequestReasons.map(({ code: c, label }) => ({
          code: c,
          label,
        })),
      });
      expect(r.audit.entries.map((e) => [e.action, e.targetId, e.after])).toEqual([
        ['certification.issuer-request.viewed', sent.issuerRequestId, { sellerId: r.sellerId }],
      ]);
    });

    it('answers an unknown request and one of another Market alike', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const unknown = r.ids.next<'IssuerRequest'>();
      await expect(
        r.read.execute(r.contextOf('admin'), { issuerRequestId: unknown }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer-request.not-found' } });
      const foreign = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      const foreignAdmin = testCallContext(
        foreign,
        testAuthenticatedActor(foreign, {
          population: 'admin',
          accountId: r.ids.next<'Account'>(),
          sessionId: r.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      await expect(
        r.read.execute(foreignAdmin, { issuerRequestId: sent.issuerRequestId }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer-request.not-found' } });
    });

    it('serves the file of the request only, audited, and only while the switch is on', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const documentId = r.requests.rows.get(sent.issuerRequestId)!.documents[0]!.id;
      const file = await unwrap(
        r.document.execute(r.contextOf('admin'), {
          issuerRequestId: sent.issuerRequestId,
          documentId,
        }),
      );
      expect(file.contentType).toBe('application/pdf');
      expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(r.audit.entries.map((e) => [e.action, e.after])).toEqual([
        ['certification.issuer-request.document-downloaded', { documentId }],
      ]);
      await expect(
        r.document.execute(r.contextOf('admin'), {
          issuerRequestId: sent.issuerRequestId,
          documentId: r.ids.next<'UploadedDocument'>(),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'document.not-found' } });

      const off = rig({ downloads: false });
      const offSent = await unwrap(send(off));
      await expect(
        off.document.execute(off.contextOf('admin'), {
          issuerRequestId: offSent.issuerRequestId,
          documentId: off.requests.rows.get(offSent.issuerRequestId)!.documents[0]!.id,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'document.download-disabled' } });
    });
  });

  describe('the answer (issuer-requests.answer) and its mail', () => {
    it('answers issuer-added with an active issuer of the type: event, audit, mail, draft status back', async () => {
      const r = rig();
      await unwrap(r.createCertificate.execute(r.contextOf(), { typeCode: 'halal' }));
      const sent = await unwrap(send(r));
      const answered = await unwrap(
        r.answer.execute(r.contextOf('admin'), {
          issuerRequestId: sent.issuerRequestId,
          version: 1,
          outcome: 'issuer-added',
          issuerId: r.activeIssuer.id,
        }),
      );
      expect(answered).toEqual({
        issuerRequestId: sent.issuerRequestId,
        version: 2,
        state: 'issuer-added',
        answeredAt: T0.toString(),
      });
      expect(r.requests.rows.get(sent.issuerRequestId)).toMatchObject({
        state: 'issuer-added',
        issuerId: r.activeIssuer.id,
        answerReasonCode: null,
      });
      expect(r.outbox.events).toEqual([
        expect.objectContaining({
          type: 'certification.issuer-request-answered.v1',
          aggregateId: sent.issuerRequestId,
          aggregateVersion: 2,
          payload: {
            issuerRequestId: sent.issuerRequestId,
            sellerId: r.sellerId,
            outcome: 'issuer-added',
          },
        }),
      ]);
      expect(r.audit.entries.map((e) => [e.action, e.after])).toEqual([
        [
          'certification.issuer-request.answered',
          { outcome: 'issuer-added', issuerId: r.activeIssuer.id },
        ],
      ]);
      const list = await unwrap(r.listCertificates.execute(r.contextOf(), {}));
      expect(list.certificates.map((c) => c.status)).toEqual(['draft']);

      await unwrap(
        r.mail.execute(testCallContext(market, 'system'), {
          delivery: r.delivery(),
          issuerRequestId: sent.issuerRequestId,
          sellerId: r.sellerId,
          outcome: 'issuer-added',
        }),
      );
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]).toMatchObject({
        to: 'owner@example.test',
        subject: 'The issuer you asked about is now listed',
      });
      expect(r.sent[0]!.text).toContain('halal');
    });

    it('answers not-accepted with a reason of the Market, and the mail carries its label', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const reason = policies.policyFor(market).issuerRequestReasons[0]!;
      await unwrap(
        r.answer.execute(r.contextOf('admin'), {
          issuerRequestId: sent.issuerRequestId,
          version: 1,
          outcome: 'not-accepted',
          reasonCode: reason.code,
        }),
      );
      expect(r.requests.rows.get(sent.issuerRequestId)).toMatchObject({
        state: 'not-accepted',
        issuerId: null,
        answerReasonCode: reason.code,
      });
      expect(r.audit.entries.map((e) => e.after)).toEqual([
        { outcome: 'not-accepted', issuerId: null },
      ]);
      await unwrap(
        r.mail.execute(testCallContext(market, 'system'), {
          delivery: r.delivery(),
          issuerRequestId: sent.issuerRequestId,
          sellerId: r.sellerId,
          outcome: 'not-accepted',
        }),
      );
      expect(r.sent[0]!.text).toContain(`Reason: ${reason.label}`);
    });

    it('refuses a second answer, a stale version and the wrong answers', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const id = sent.issuerRequestId;
      const admin = () => r.contextOf('admin');
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 1,
          outcome: 'issuer-added',
          issuerId: r.proposedIssuer.id,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer.not-active' } });
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 1,
          outcome: 'issuer-added',
          issuerId: r.otherTypeIssuer.id,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer.not-found' } });
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 1,
          outcome: 'not-accepted',
          reasonCode: code === 'AU' ? 'registry-unknown' : 'issuer-not-recognised',
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer-request.reason-unknown' } });
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 1,
          outcome: 'issuer-added',
          issuerId: r.activeIssuer.id,
          reasonCode: reasonOf(),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        r.answer.execute(admin(), { issuerRequestId: id, version: 1, outcome: 'approved' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 7,
          outcome: 'not-accepted',
          reasonCode: reasonOf(),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(r.outbox.events).toEqual([]);

      await unwrap(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 1,
          outcome: 'not-accepted',
          reasonCode: reasonOf(),
        }),
      );
      await expect(
        r.answer.execute(admin(), {
          issuerRequestId: id,
          version: 2,
          outcome: 'issuer-added',
          issuerId: r.activeIssuer.id,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'issuer-request.already-answered' } });
    });

    it('refuses the answer to a seller and to an acting-as session', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const input = {
        issuerRequestId: sent.issuerRequestId,
        version: 1,
        outcome: 'not-accepted',
        reasonCode: reasonOf(),
      };
      await expect(r.answer.execute(r.contextOf('seller'), input)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(r.answer.execute(r.actingAs(r.contextOf('admin')), input)).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('skips the mail when the answer in the event is not the stored one', async () => {
      const r = rig();
      const sent = await unwrap(send(r));
      const result = await unwrap(
        r.mail.execute(testCallContext(market, 'system'), {
          delivery: r.delivery(),
          issuerRequestId: sent.issuerRequestId,
          sellerId: r.sellerId,
          outcome: 'issuer-added',
        }),
      );
      expect(result).toEqual({ code: 'issuer-request-mail.skipped', reason: 'answer.gone' });
      expect(r.sent).toEqual([]);
    });
  });

  it("never lets the typed name reach an event, an audit row, a log line or a mail (Hassan's check)", async () => {
    const r = rig();
    await unwrap(r.createCertificate.execute(r.contextOf(), { typeCode: 'halal' }));
    const sent = await unwrap(send(r));
    // A refused request too: a validation answer names the field, never the value.
    const refused = await send(r, { issuerName: `${CANARY}\u0000` });
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    await unwrap(r.queue.execute(r.contextOf('admin'), {}));
    await unwrap(r.read.execute(r.contextOf('admin'), { issuerRequestId: sent.issuerRequestId }));
    for (const outcome of ['not-accepted'] as const) {
      await unwrap(
        r.answer.execute(r.contextOf('admin'), {
          issuerRequestId: sent.issuerRequestId,
          version: 1,
          outcome,
          reasonCode: reasonOf(),
        }),
      );
      await unwrap(
        r.mail.execute(testCallContext(market, 'system'), {
          delivery: r.delivery(),
          issuerRequestId: sent.issuerRequestId,
          sellerId: r.sellerId,
          outcome,
        }),
      );
    }
    expect(r.sent).toHaveLength(1);
    expect(r.outbox.events).toHaveLength(1);
    expect(r.audit.entries.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    const everything = JSON.stringify({
      events: r.outbox.events,
      // The call context is the caller's, not audit content (it holds no seller text).
      audit: r.audit.entries.map((entry) => ({ ...entry, context: undefined })),
      logs,
      mail: r.sent,
    });
    expect(everything).not.toContain(CANARY);
    expect(everything.toLowerCase()).not.toContain('canary');
  });
});
