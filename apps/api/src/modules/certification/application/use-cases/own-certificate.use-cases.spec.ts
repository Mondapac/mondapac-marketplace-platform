import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import sharp from 'sharp';
import {
  fakeCounterKeys,
  fakeIndexKeys,
  FakeCipher,
  MemoryCertificates,
  MemoryCounters,
  MemoryOutbox,
  MemoryTypeCatalog,
  MemoryVault,
  passThroughUnitOfWork,
  zonesOf,
} from '../../../../../test/support/certification-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { SharpDocumentIntake } from '../../infrastructure/sharp-document-intake';
import { ownerOf, type OwnCertificateDependencies } from '../own/own-certificate.shared';
import { OwnCertificateCreate } from './own-certificate-create.use-case';
import { OwnCertificateDeleteDraft } from './own-certificate-delete-draft.use-case';
import { OwnCertificateDocumentRead } from './own-certificate-document-read.use-case';
import { OwnCertificateOptions } from './own-certificate-options.use-case';
import { OwnCertificateRead } from './own-certificate-read.use-case';
import { OwnCertificateRemoveDocument } from './own-certificate-remove-document.use-case';
import { OwnCertificateSaveDraft } from './own-certificate-save-draft.use-case';
import { OwnCertificateSubmit } from './own-certificate-submit.use-case';
import { OwnCertificateUploadDocument } from './own-certificate-upload-document.use-case';
import { OwnCertificateWithdraw } from './own-certificate-withdraw.use-case';
import { OwnCertificatesList } from './own-certificates-list.use-case';

// The seller side of a certificate in memory (certification design 3, 7; slices 3 to 5), on both
// Market fixtures with the real gate and the real file intake. The SQL is in
// test/db/certification-seller-certificate.db-spec.ts, the routes in
// test/certification-seller-certificates.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n',
);
const JS_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page /AA <</S /JavaScript>>>> endobj\n%%EOF\n',
);
const b64 = (bytes: Buffer): string => bytes.toString('base64');
const png = (color: string): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
    .png()
    .toBuffer();

describe.each(['AU', 'ZZ'] as const)('own certificates in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  function rig(options: { draftQuotaBytes?: number; zone?: string | null } = {}) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const sellerId = ids.next<'Seller'>();
    const otherSeller = ids.next<'Seller'>();
    const certificates = new MemoryCertificates();
    const types = new MemoryTypeCatalog();
    const counters = new MemoryCounters();
    const vault = new MemoryVault();
    const outbox = new MemoryOutbox();
    const cipher = new FakeCipher();

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
    const retired = {
      ...halal,
      typeId: ids.next<'CertificationType'>(),
      code: 'kosher',
      status: 'inactive' as const,
      revisionId: ids.next<'CertificationTypeRevision'>(),
    };
    for (const type of [halal, vegan, retired]) {
      types.addType(market, type);
      certificates.typeCodes.set(type.typeId, type.code);
    }
    const activeIssuer = {
      id: ids.next<'Issuer'>(),
      typeId: halal.typeId,
      displayName: 'Halal Authority',
      state: 'active' as const,
    };
    const closedIssuer = {
      id: ids.next<'Issuer'>(),
      typeId: halal.typeId,
      displayName: 'Old Authority',
      state: 'derecognised' as const,
    };
    const veganIssuer = { ...activeIssuer, id: ids.next<'Issuer'>(), typeId: vegan.typeId };
    for (const issuer of [activeIssuer, closedIssuer, veganIssuer]) types.addIssuer(market, issuer);

    const zone = options.zone === undefined ? 'Australia/Brisbane' : options.zone;
    const deps: OwnCertificateDependencies = {
      unitOfWork: passThroughUnitOfWork,
      certificates,
      types,
      vault,
      intake: new SharpDocumentIntake(),
      cipher,
      counters,
      counterKeys: fakeCounterKeys,
      indexKeys: fakeIndexKeys,
      zones: zonesOf({
        [sellerId]: { zone, addressZone: zone },
        [otherSeller]: { zone, addressZone: zone },
      }),
      outbox,
      clock,
      ids,
      draftQuotaBytes: options.draftQuotaBytes ?? 200 * 1024 * 1024,
    };

    const contextOf = (
      seller: Id<'Seller'> | null = sellerId,
      population: 'seller' | 'customer' | 'admin' = 'seller',
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

    const useCases = {
      create: new OwnCertificateCreate(gate, deps),
      saveDraft: new OwnCertificateSaveDraft(gate, deps),
      deleteDraft: new OwnCertificateDeleteDraft(gate, deps),
      upload: new OwnCertificateUploadDocument(gate, deps),
      remove: new OwnCertificateRemoveDocument(gate, deps),
      submit: new OwnCertificateSubmit(gate, deps),
      withdraw: new OwnCertificateWithdraw(gate, deps),
      list: new OwnCertificatesList(gate, deps),
      read: new OwnCertificateRead(gate, deps),
      readDocument: new OwnCertificateDocumentRead(gate, deps),
      options: new OwnCertificateOptions(gate, deps),
    };
    return {
      clock,
      sellerId,
      otherSeller,
      certificates,
      counters,
      vault,
      outbox,
      deps,
      halal,
      vegan,
      activeIssuer,
      closedIssuer,
      veganIssuer,
      contextOf,
      ...useCases,
    };
  }
  type Rig = ReturnType<typeof rig>;

  async function unwrap<T, E>(promise: Promise<Result<T, E>>): Promise<T> {
    const result = await promise;
    if (!result.ok) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  const draftOf = (r: Rig, overrides: Record<string, unknown> = {}) => ({
    issuerId: r.activeIssuer.id,
    certificateNumber: 'HC-2026-001',
    issueDate: '2026-01-01',
    expiryDate: '2027-12-31',
    selfDeclared: null,
    selfDeclarationNote: null,
    ...overrides,
  });

  async function newHalal(r: Rig): Promise<string> {
    const created = await unwrap(r.create.execute(r.contextOf(), { typeCode: 'halal' }));
    return created.certificateId;
  }

  async function completeHalal(r: Rig): Promise<string> {
    const certificateId = await newHalal(r);
    await unwrap(r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) }));
    await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
    return certificateId;
  }

  /** A seller context carrying the reserved acting-as marker (Login as Seller). */
  const actingAs = (context: CallContext): CallContext =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { accountId: 'x', sellerId: 'y' } },
    }) as unknown as CallContext;

  describe('the owner of a call', () => {
    it('reads the seller from the actor, and refuses an acting-as session for a write only', () => {
      const r = rig();
      const context = r.contextOf();
      expect(ownerOf(context, { write: true })).toMatchObject({ sellerId: r.sellerId });
      expect(ownerOf(actingAs(context), { write: true })).toBeNull();
      expect(ownerOf(actingAs(context), { write: false })).toMatchObject({ sellerId: r.sellerId });
      expect(ownerOf(r.contextOf(null, 'customer'), { write: false })).toBeNull();
      expect(ownerOf(r.contextOf(null, 'admin'), { write: false })).toBeNull();
    });
  });

  describe('access declarations', () => {
    it('names every use case and needs the view or manage key', () => {
      const rules = [
        [OwnCertificateCreate, 'certification.own-certificate-create', 'manage'],
        [OwnCertificateSaveDraft, 'certification.own-certificate-save-draft', 'manage'],
        [OwnCertificateDeleteDraft, 'certification.own-certificate-delete-draft', 'manage'],
        [OwnCertificateUploadDocument, 'certification.own-certificate-upload-document', 'manage'],
        [OwnCertificateRemoveDocument, 'certification.own-certificate-remove-document', 'manage'],
        [OwnCertificateSubmit, 'certification.own-certificate-submit', 'manage'],
        [OwnCertificateWithdraw, 'certification.own-certificate-withdraw', 'manage'],
        [OwnCertificatesList, 'certification.own-certificates-list', 'view'],
        [OwnCertificateRead, 'certification.own-certificate-read', 'view'],
        [OwnCertificateDocumentRead, 'certification.own-certificate-document-read', 'view'],
        [OwnCertificateOptions, 'certification.own-certificate-options', 'view'],
      ] as const;
      for (const [type, name, key] of rules) {
        expect(type.access).toEqual({
          name,
          rule: { kind: 'permissions', allOf: [`certification.own-certificate.${key}`] },
          whenSellerNotApproved: 'allow',
        });
      }
    });
  });

  describe('create', () => {
    it('starts an empty draft of an active type', async () => {
      const r = rig();
      const created = await unwrap(r.create.execute(r.contextOf(), { typeCode: 'halal' }));
      expect(created).toMatchObject({
        typeCode: 'halal',
        status: 'draft',
        recordStatus: 'draft',
        editable: true,
        deletable: true,
        withdrawable: false,
      });
      expect(r.certificates.certificates.size).toBe(1);
    });

    it('refuses a second open certificate of the same type, not of another type', async () => {
      const r = rig();
      await newHalal(r);
      await expect(r.create.execute(r.contextOf(), { typeCode: 'halal' })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.exists' },
      });
      await unwrap(r.create.execute(r.contextOf(), { typeCode: 'vegan' }));
    });

    it('gives another seller their own certificate of the same type', async () => {
      const r = rig();
      await newHalal(r);
      await unwrap(r.create.execute(r.contextOf(r.otherSeller), { typeCode: 'halal' }));
      expect(r.certificates.certificates.size).toBe(2);
    });

    it('refuses an unknown type, an inactive type and a malformed code', async () => {
      const r = rig();
      await expect(r.create.execute(r.contextOf(), { typeCode: 'nope' })).resolves.toEqual({
        ok: false,
        error: { code: 'type.not-found' },
      });
      await expect(r.create.execute(r.contextOf(), { typeCode: 'kosher' })).resolves.toEqual({
        ok: false,
        error: { code: 'type.inactive' },
      });
      await expect(
        r.create.execute(r.contextOf(), { typeCode: 'Not A Code!' }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('refuses a customer, an admin and an acting-as session', async () => {
      const r = rig();
      for (const context of [
        r.contextOf(null, 'customer'),
        r.contextOf(null, 'admin'),
        actingAs(r.contextOf()),
      ]) {
        const result = await r.create.execute(context, { typeCode: 'halal' });
        expect(result.ok).toBe(false);
      }
      expect(r.certificates.certificates.size).toBe(0);
    });
  });

  describe('save draft', () => {
    it('keeps the number and the note encrypted and gives the draft back in clear', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const saved = await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { selfDeclarationNote: 'a private note' }),
        }),
      );
      expect(saved.draft).toEqual({
        issuerId: r.activeIssuer.id,
        certificateNumber: 'HC-2026-001',
        issueDate: '2026-01-01',
        expiryDate: '2027-12-31',
        selfDeclared: null,
        selfDeclarationNote: 'a private note',
      });
      const stored = r.certificates.certificates.get(certificateId)!;
      expect(stored.draft.certificateNumberCiphertext).toMatch(/^v1\./);
      expect(JSON.stringify(stored.draft)).not.toContain('HC-2026-001');
      expect(JSON.stringify(stored.draft)).not.toContain('a private note');
      expect(stored.version).toBe(2);
    });

    it('overwrites the whole draft: null clears a field', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await unwrap(r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) }));
      const cleared = await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: null, issuerId: null }),
        }),
      );
      expect(cleared.draft).toMatchObject({ certificateNumber: null, issuerId: null });
    });

    it('refuses a malformed draft with the fields', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const result = await r.saveDraft.execute(r.contextOf(), {
        certificateId,
        draft: draftOf(r, { expiryDate: 'tomorrow' }),
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'expiryDate', code: 'format' }] },
      });
    });

    it('refuses an issuer that is unknown, of another type, or on a type with no registry', async () => {
      const r = rig();
      const halalId = await newHalal(r);
      const unknownIssuer = '01990000-0000-7000-8000-0000000fffff';
      const unknown = await r.saveDraft.execute(r.contextOf(), {
        certificateId: halalId,
        draft: draftOf(r, { issuerId: unknownIssuer }),
      });
      expect(unknown).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const wrongType = await r.saveDraft.execute(r.contextOf(), {
        certificateId: halalId,
        draft: draftOf(r, { issuerId: r.veganIssuer.id }),
      });
      expect(wrongType).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const veganId = (await unwrap(r.create.execute(r.contextOf(), { typeCode: 'vegan' })))
        .certificateId;
      const noRegistry = await r.saveDraft.execute(r.contextOf(), {
        certificateId: veganId,
        draft: draftOf(r, { issuerId: r.veganIssuer.id }),
      });
      expect(noRegistry).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'issuerId' }] },
      });
    });

    it("does not show another seller's certificate: the same refusal as an unknown id", async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const foreign = await r.saveDraft.execute(r.contextOf(r.otherSeller), {
        certificateId,
        draft: draftOf(r),
      });
      const unknown = await r.saveDraft.execute(r.contextOf(), {
        certificateId: '01990000-0000-7000-8000-0000000eeeee',
        draft: draftOf(r),
      });
      expect(foreign).toEqual({ ok: false, error: { code: 'certificate.not-found' } });
      expect(unknown).toEqual(foreign);
    });

    it('answers a conflict when the record moved under the save', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      r.certificates.failNextWrite = new StaleAggregateError('seller-certification', certificateId);
      const result = await r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) });
      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    });

    it('throttles the 61st save of an account in a minute, and not another account', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const account = r.contextOf();
      for (let i = 0; i < 60; i += 1) {
        const saved = await r.saveDraft.execute(account, { certificateId, draft: draftOf(r) });
        expect(saved.ok).toBe(true);
      }
      const last = await r.saveDraft.execute(account, { certificateId, draft: draftOf(r) });
      expect(last).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      await expect(
        r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe('files', () => {
    it('accepts a PDF and a PNG, stores them in the vault and counts the quota', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const first = await unwrap(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }),
      );
      const second = await unwrap(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(await png('#336699')) }),
      );
      expect(first).toMatchObject({ position: 1, mediaType: 'application/pdf', pageCount: 1 });
      expect(second).toMatchObject({ position: 2, mediaType: 'image/png', pageCount: null });
      expect(r.vault.objects.size).toBe(2);
      for (const key of r.vault.objects.keys()) {
        expect(key).toBe(`certification/${r.sellerId}/${key.split('/').pop()}`);
      }
      expect(r.certificates.quotas.get(r.sellerId)).toBe(
        r.certificates.documents.get(first.documentId)!.byteSize +
          r.certificates.documents.get(second.documentId)!.byteSize,
      );
    });

    it('refuses a PDF with a script and stores nothing', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const result = await r.upload.execute(r.contextOf(), { certificateId, data: b64(JS_PDF) });
      expect(result).toEqual({ ok: false, error: { code: 'file.active-content' } });
      expect(r.vault.objects.size).toBe(0);
      expect(r.certificates.documents.size).toBe(0);
      expect(r.certificates.quotas.get(r.sellerId) ?? 0).toBe(0);
    });

    it('refuses bytes with the wrong magic and a file over 10 MiB', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(Buffer.from('plain text')) }),
      ).resolves.toEqual({ ok: false, error: { code: 'file.unsupported-type' } });
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(big) }),
      ).resolves.toEqual({ ok: false, error: { code: 'file.too-large' } });
      expect(r.vault.objects.size).toBe(0);
    });

    it('refuses text that is not base64', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: 'not base64!!' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: '' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('allows at most 10 files on a certificate', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      for (let i = 0; i < 10; i += 1) {
        await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      }
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }),
      ).resolves.toEqual({ ok: false, error: { code: 'document.limit-reached' } });
      expect(r.vault.objects.size).toBe(10);
    });

    it('holds a seller to the draft quota and discards the object of a refused file', async () => {
      const r = rig({ draftQuotaBytes: PDF.length + 10 });
      const certificateId = await newHalal(r);
      await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }),
      ).resolves.toEqual({ ok: false, error: { code: 'draft-quota.exceeded' } });
      expect(r.vault.objects.size).toBe(1);
    });

    it('limits an unapproved seller (no zone) to 10 uploads a day, an approved one to 30', async () => {
      const unapproved = rig({ zone: null });
      const idA = await newHalal(unapproved);
      let result: Result<unknown, { code: string }> = { ok: true, value: null };
      for (let i = 0; i < 11; i += 1) {
        result = await unapproved.upload.execute(unapproved.contextOf(), {
          certificateId: idA,
          data: b64(JS_PDF),
        });
      }
      expect(result).toMatchObject({ ok: false, error: { code: 'request.throttled' } });

      const approved = rig();
      const idB = await newHalal(approved);
      for (let i = 0; i < 30; i += 1) {
        result = await approved.upload.execute(approved.contextOf(), {
          certificateId: idB,
          data: b64(JS_PDF),
        });
        expect(result).toMatchObject({ error: { code: 'file.active-content' } });
      }
      result = await approved.upload.execute(approved.contextOf(), {
        certificateId: idB,
        data: b64(JS_PDF),
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    });

    it("keeps one seller's file away from another seller", async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await expect(
        r.upload.execute(r.contextOf(r.otherSeller), { certificateId, data: b64(PDF) }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.not-found' } });
    });

    it('removes a file, discards its object and gives its bytes back', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const file = await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      await unwrap(r.remove.execute(r.contextOf(), { certificateId, documentId: file.documentId }));
      expect(r.vault.objects.size).toBe(0);
      expect(r.certificates.documents.size).toBe(0);
      expect(r.certificates.quotas.get(r.sellerId)).toBe(0);
      await expect(
        r.remove.execute(r.contextOf(), { certificateId, documentId: file.documentId }),
      ).resolves.toEqual({ ok: false, error: { code: 'document.not-found' } });
    });

    it('gives the bytes back to the owner only', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const file = await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      const read = await unwrap(
        r.readDocument.execute(r.contextOf(), { certificateId, documentId: file.documentId }),
      );
      expect(read.contentType).toBe('application/pdf');
      expect(read.bytes.equals(PDF)).toBe(true);
      await expect(
        r.readDocument.execute(r.contextOf(r.otherSeller), {
          certificateId,
          documentId: file.documentId,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'document.not-found' } });
    });

    it('cannot open a file after the seller key was destroyed', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const file = await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      r.vault.destroyed.add(r.sellerId);
      const result = await r.readDocument.execute(r.contextOf(), {
        certificateId,
        documentId: file.documentId,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('submit', () => {
    it('names what is missing', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      const result = await r.submit.execute(r.contextOf(), { certificateId });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'certificate.incomplete',
          fields: [
            { path: 'issuerId', code: 'required' },
            { path: 'certificateNumber', code: 'required' },
            { path: 'expiryDate', code: 'required' },
            { path: 'documents', code: 'required' },
          ],
        },
      });
    });

    it('freezes the draft into a submission, goes in review and records history and the event', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      const submitted = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(submitted).toMatchObject({ certificateId, kind: 'initial' });

      const [submission] = r.certificates.submissions;
      expect(submission!.write).toMatchObject({
        certificateId,
        sellerId: r.sellerId,
        typeId: r.halal.typeId,
        typeRevisionId: r.halal.revisionId,
        submissionNo: 1,
        kind: 'initial',
        issuerId: r.activeIssuer.id,
        submittedZone: 'Australia/Brisbane',
        fromStatus: 'draft',
        toStatus: 'in-review',
      });
      expect(submission!.write.certificateNumberCiphertext).toMatch(/^v1\./);
      expect(submission!.write.contentHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      expect(submission!.write.documentIds).toHaveLength(1);
      const root = r.certificates.certificates.get(certificateId)!;
      expect(root.status).toBe('in-review');
      expect(root.pendingSubmissionId).toBe(submission!.write.submissionId);
      expect(r.certificates.history).toEqual([
        {
          certificateId,
          fromStatus: 'draft',
          toStatus: 'in-review',
          submissionId: submission!.write.submissionId,
          reasonCode: null,
        },
      ]);
      expect(r.outbox.events).toHaveLength(1);
      expect(r.outbox.events[0]).toMatchObject({
        type: 'certification.seller-certification-submitted.v1',
        aggregateId: certificateId,
        payload: {
          sellerCertificationId: certificateId,
          sellerId: r.sellerId,
          submissionId: submission!.write.submissionId,
          kind: 'initial',
        },
      });
      // The files joined a submission: they no longer count against the draft quota.
      expect(r.certificates.quotas.get(r.sellerId)).toBe(0);
    });

    it('refuses a second submit while one is pending, and unconfirmed edits to the draft', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.has-pending-submission' },
      });
      // Withdraw by edit (slice 8): a change needs the seller's confirmation first.
      await expect(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: 'HC-2026-009' }),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.edit-withdraws-submission' } });
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.edit-withdraws-submission' } });
    });

    it('refuses an issuer that is no longer active', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { issuerId: r.closedIssuer.id }),
        }),
      ).catch(() => undefined);
      // A closed issuer cannot be picked, so move the issuer's state after the pick.
      await unwrap(r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) }));
      await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      const picked = await r.deps.types.issuer(market, r.activeIssuer.id);
      Object.assign(picked!, { state: 'derecognised' });
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'issuer.not-active' },
      });
    });

    it('refuses a certificate that already expired in the seller zone', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { issueDate: '2025-01-01', expiryDate: '2026-10-15' }),
        }),
      );
      await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.expired' },
      });
    });

    it('judges the expiry in the seller zone, not in UTC', async () => {
      // 2026-10-16T00:00Z is 10:00 on the 16th in Brisbane: the 15th has ended there. In Honolulu
      // it is still the 15th (14:00), so a certificate that expires on the 15th is still valid.
      const r = rig({ zone: 'Pacific/Honolulu' });
      const certificateId = await newHalal(r);
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { issueDate: '2025-01-01', expiryDate: '2026-10-15' }),
        }),
      );
      await unwrap(r.upload.execute(r.contextOf(), { certificateId, data: b64(PDF) }));
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toMatchObject({
        ok: true,
      });
    });

    it('refuses a seller with no zone', async () => {
      const r = rig({ zone: null });
      const certificateId = await completeHalal(r);
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'seller.zone-missing' },
      });
    });

    it('takes a self-declaration with the tick alone and keeps no number or issuer', async () => {
      const r = rig();
      const created = await unwrap(r.create.execute(r.contextOf(), { typeCode: 'vegan' }));
      await expect(
        r.submit.execute(r.contextOf(), { certificateId: created.certificateId }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'certificate.incomplete', fields: [{ path: 'selfDeclared' }] },
      });
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId: created.certificateId,
          draft: draftOf(r, { issuerId: null, selfDeclared: true, expiryDate: null }),
        }),
      );
      await unwrap(r.submit.execute(r.contextOf(), { certificateId: created.certificateId }));
      const write = r.certificates.submissions[0]!.write;
      expect(write).toMatchObject({
        issuerId: null,
        certificateNumberCiphertext: null,
        selfDeclared: true,
        kind: 'initial',
      });
    });

    it('allows five submissions a day per certificate, and no more', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      for (let i = 0; i < 5; i += 1) {
        await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
        await unwrap(r.withdraw.execute(r.contextOf(), { certificateId }));
      }
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toMatchObject({
        ok: false,
        error: { code: 'request.throttled' },
      });
      expect(r.certificates.submissions).toHaveLength(5);
    });

    it("does not submit another seller's certificate", async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await expect(
        r.submit.execute(r.contextOf(r.otherSeller), { certificateId }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.not-found' } });
    });

    it('answers a conflict when the record moved under the submit', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      r.certificates.failNextWrite = new StaleAggregateError('seller-certification', certificateId);
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      expect(r.certificates.submissions).toHaveLength(0);
      expect(r.outbox.events).toHaveLength(0);
    });
  });

  describe('withdraw', () => {
    it('takes a first submission back to draft with history and the event', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      const summary = await unwrap(r.withdraw.execute(r.contextOf(), { certificateId }));
      expect(summary).toMatchObject({ recordStatus: 'draft', editable: true, withdrawable: false });
      expect(r.certificates.submissions[0]!.withdrawn).toMatchObject({ cause: 'cancelled' });
      expect(r.certificates.history.at(-1)).toMatchObject({
        fromStatus: 'in-review',
        toStatus: 'draft',
        reasonCode: 'cancelled',
      });
      expect(r.outbox.events.at(-1)).toMatchObject({
        type: 'certification.seller-certification-withdrawn.v1',
        payload: { cause: 'cancelled', sellerId: r.sellerId },
      });
    });

    it('refuses when nothing is pending', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      await expect(r.withdraw.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.no-pending-submission' },
      });
    });

    it('keeps a renewal of an approved certificate approved and takes only the renewal back', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      // The review package approves it; here the record is moved by hand.
      const root = r.certificates.certificates.get(certificateId)!;
      root.status = 'approved';
      root.approvedSubmissionId = root.pendingSubmissionId;
      root.pendingSubmissionId = null;
      root.pendingKind = null;
      root.approvedBoundaryAt = T0.add({ hours: 24 * 200 });
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2028-12-31' }),
        }),
      );
      const renewal = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(renewal.kind).toBe('renewal');
      expect(root.status).toBe('approved');
      expect(root.pendingSubmissionId).not.toBeNull();
      const back = await unwrap(r.withdraw.execute(r.contextOf(), { certificateId }));
      expect(back).toMatchObject({ recordStatus: 'approved', status: 'approved' });
      expect(root.approvedSubmissionId).not.toBeNull();
    });
  });

  describe('withdraw by edit, resubmission and renewal (slice 8, AC 14, AC 15)', () => {
    /** Plays the reviewer's approval of the pending submission (slice 7 writes it for real). */
    function approveByHand(r: Rig, certificateId: string, boundary = T0.add({ hours: 24 * 200 })) {
      const root = r.certificates.certificates.get(certificateId)!;
      r.certificates.decisions.set(root.pendingSubmissionId!, 'approved');
      root.status = 'approved';
      root.approvedSubmissionId = root.pendingSubmissionId;
      root.pendingSubmissionId = null;
      root.pendingKind = null;
      root.approvedBoundaryAt = boundary;
      root.version += 1;
      return root;
    }
    /** Plays the reviewer's "changes needed" on the pending submission. */
    function sendBackByHand(r: Rig, certificateId: string) {
      const root = r.certificates.certificates.get(certificateId)!;
      r.certificates.decisions.set(root.pendingSubmissionId!, 'changes-requested');
      if (root.approvedSubmissionId === null) root.status = 'changes-needed';
      root.pendingSubmissionId = null;
      root.pendingKind = null;
      root.version += 1;
      return root;
    }
    async function pendingFirst(r: Rig) {
      const certificateId = await completeHalal(r);
      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      return certificateId;
    }
    async function pendingRenewal(r: Rig) {
      const certificateId = await pendingFirst(r);
      approveByHand(r, certificateId);
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2029-12-31' }),
        }),
      );
      const renewal = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(renewal.kind).toBe('renewal');
      return { certificateId, renewalId: renewal.submissionId };
    }
    const withdrawnEvents = (r: Rig) =>
      r.outbox.events.filter((e) => e.type === 'certification.seller-certification-withdrawn.v1');

    it('writes nothing for an unchanged save while a submission is pending', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const root = r.certificates.certificates.get(certificateId)!;
      const version = root.version;
      const saved = await unwrap(
        r.saveDraft.execute(r.contextOf(), { certificateId, draft: draftOf(r) }),
      );
      expect(saved).toMatchObject({
        withdrawnSubmissionId: null,
        certificate: { status: 'awaiting-review', withdrawable: true },
      });
      expect(root.version).toBe(version);
      expect(root.pendingSubmissionId).not.toBeNull();
      expect(withdrawnEvents(r)).toHaveLength(0);
    });

    it('refuses a change to a pending submission until the seller confirms, writing nothing', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const root = r.certificates.certificates.get(certificateId)!;
      const version = root.version;
      await expect(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: 'HC-2026-002' }),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.edit-withdraws-submission' } });
      expect(root.version).toBe(version);
      expect(root.pendingSubmissionId).not.toBeNull();
      expect(r.certificates.submissions[0]!.withdrawn).toBeNull();
      await expect(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: 'HC-2026-002' }),
          withdrawPending: 'yes',
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'withdrawPending', code: 'type' }] },
      });
    });

    it('withdraws a first submission by edit: draft, history, event, one version step', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const root = r.certificates.certificates.get(certificateId)!;
      const version = root.version;
      const pendingId = root.pendingSubmissionId!;
      const saved = await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: 'HC-2026-002' }),
          withdrawPending: true,
        }),
      );
      expect(saved).toMatchObject({
        withdrawnSubmissionId: pendingId,
        certificate: {
          recordStatus: 'draft',
          status: 'draft',
          editable: true,
          withdrawable: false,
        },
        draft: { certificateNumber: 'HC-2026-002' },
      });
      expect(root.version).toBe(version + 1);
      expect(root.pendingSubmissionId).toBeNull();
      expect(r.certificates.submissions[0]!.withdrawn).toMatchObject({ cause: 'edited' });
      expect(r.certificates.history.at(-1)).toMatchObject({
        fromStatus: 'in-review',
        toStatus: 'draft',
        reasonCode: 'edited',
      });
      expect(withdrawnEvents(r)).toHaveLength(1);
      expect(withdrawnEvents(r)[0]).toMatchObject({
        aggregateVersion: version + 1,
        payload: { cause: 'edited', submissionId: pendingId },
      });
      const read = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(read.draft.certificateNumber).toBe('HC-2026-002');
    });

    it('withdraws only the renewal by edit: the approved certificate stays as it was', async () => {
      const r = rig();
      const { certificateId, renewalId } = await pendingRenewal(r);
      const root = r.certificates.certificates.get(certificateId)!;
      const approvedId = root.approvedSubmissionId;
      const boundary = root.approvedBoundaryAt;
      const listed = await unwrap(r.list.execute(r.contextOf(), {}));
      expect(listed.certificates[0]!.status).toBe('approved-renewal-pending');
      const saved = await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2030-06-30' }),
          withdrawPending: true,
        }),
      );
      expect(saved.withdrawnSubmissionId).toBe(renewalId);
      expect(saved.certificate).toMatchObject({ recordStatus: 'approved', status: 'approved' });
      expect(root.approvedSubmissionId).toBe(approvedId);
      expect(root.approvedBoundaryAt).toEqual(boundary);
      expect(r.certificates.history.at(-1)).toMatchObject({
        fromStatus: 'approved',
        toStatus: 'approved',
        reasonCode: 'edited',
      });
    });

    it('treats adding or removing a file of a pending submission as an edit', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const objects = r.vault.objects.size;
      await expect(
        r.upload.execute(r.contextOf(), { certificateId, data: b64(await png('#00ff00')) }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.edit-withdraws-submission' } });
      // Refused before the file is read or stored.
      expect(r.vault.objects.size).toBe(objects);
      const added = await unwrap(
        r.upload.execute(r.contextOf(), {
          certificateId,
          data: b64(await png('#00ff00')),
          withdrawPending: true,
        }),
      );
      expect(added.withdrawnSubmissionId).not.toBeNull();
      expect(r.certificates.certificates.get(certificateId)!.status).toBe('draft');
      expect(withdrawnEvents(r)).toHaveLength(1);

      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      const [first] = await r.certificates.listDocuments(market, certificateId as never);
      await expect(
        r.remove.execute(r.contextOf(), { certificateId, documentId: first!.id }),
      ).resolves.toEqual({ ok: false, error: { code: 'certificate.edit-withdraws-submission' } });
      const removed = await unwrap(
        r.remove.execute(r.contextOf(), {
          certificateId,
          documentId: first!.id,
          withdrawPending: true,
        }),
      );
      expect(removed).toMatchObject({ removed: true });
      expect(removed.withdrawnSubmissionId).not.toBeNull();
      expect(withdrawnEvents(r)).toHaveLength(2);
      // The submitted file only left the draft; the submissions keep it.
      expect(r.certificates.documents.has(first!.id)).toBe(true);
    });

    it('refuses withdraw by edit in an acting-as session and on a stale record', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const edit = { certificateId, draft: draftOf(r, { certificateNumber: 'X-1' }) };
      await expect(
        r.saveDraft.execute(actingAs(r.contextOf()), { ...edit, withdrawPending: true }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      r.certificates.failNextWrite = new StaleAggregateError('seller-certification', certificateId);
      await expect(
        r.saveDraft.execute(r.contextOf(), { ...edit, withdrawPending: true }),
      ).resolves.toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(r.certificates.certificates.get(certificateId)!.pendingSubmissionId).not.toBeNull();
      expect(withdrawnEvents(r)).toHaveLength(0);
    });

    it('resubmits after changes were requested, as a resubmission of the same record', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      sendBackByHand(r, certificateId);
      const read = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(read.certificate).toMatchObject({ status: 'changes-needed', editable: true });
      // The earlier answers are kept in the draft (the correction form is prefilled).
      expect(read.draft.certificateNumber).toBe('HC-2026-001');
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { certificateNumber: 'HC-2026-001A' }),
        }),
      );
      const again = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(again.kind).toBe('resubmission');
      const root = r.certificates.certificates.get(certificateId)!;
      expect(root).toMatchObject({ status: 'in-review', pendingSubmissionId: again.submissionId });
      expect(r.certificates.submissions.map((s) => s.write.submissionNo)).toEqual([1, 2]);
      expect(r.outbox.events.at(-1)).toMatchObject({
        type: 'certification.seller-certification-submitted.v1',
        payload: { kind: 'resubmission' },
      });
    });

    it('shows a renewal sent back as approved-renewal-changes-needed until it is sent again', async () => {
      const r = rig();
      const { certificateId } = await pendingRenewal(r);
      const root = sendBackByHand(r, certificateId);
      expect(root.status).toBe('approved');
      const read = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(read.certificate).toMatchObject({
        status: 'approved-renewal-changes-needed',
        recordStatus: 'approved',
        submitBy: root.approvedBoundaryAt!.toString(),
        editable: true,
      });
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2029-11-30' }),
        }),
      );
      const correction = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(correction.kind).toBe('renewal');
      const after = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(after.certificate.status).toBe('approved-renewal-pending');
      // A cancelled renewal leaves the plain approved status.
      await unwrap(r.withdraw.execute(r.contextOf(), { certificateId }));
      const cancelled = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(cancelled.certificate.status).toBe('approved');
    });

    it('renews an expired record, but never with a certificate that is itself expired', async () => {
      const r = rig();
      const certificateId = await pendingFirst(r);
      const root = approveByHand(r, certificateId, T0.subtract({ hours: 1 }));
      root.status = 'expired';
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2026-10-15' }),
        }),
      );
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.expired' },
      });
      await unwrap(
        r.saveDraft.execute(r.contextOf(), {
          certificateId,
          draft: draftOf(r, { expiryDate: '2028-10-15' }),
        }),
      );
      const renewal = await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      expect(renewal.kind).toBe('renewal');
      expect(root.status).toBe('expired');
      const read = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(read.certificate.status).toBe('expired-renewal-pending');
    });

    it('keeps one open submission per certificate and never renews a revoked or declined one', async () => {
      const r = rig();
      const { certificateId } = await pendingRenewal(r);
      await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.has-pending-submission' },
      });
      const root = r.certificates.certificates.get(certificateId)!;
      for (const status of ['revoked', 'declined'] as const) {
        root.status = status;
        root.pendingSubmissionId = null;
        root.pendingKind = null;
        await expect(
          r.saveDraft.execute(r.contextOf(), {
            certificateId,
            draft: draftOf(r, { expiryDate: '2030-01-01' }),
            withdrawPending: true,
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'certificate.not-editable' } });
        await expect(r.submit.execute(r.contextOf(), { certificateId })).resolves.toEqual({
          ok: false,
          error: { code: 'certificate.not-submittable' },
        });
      }
    });
  });

  describe('delete draft', () => {
    it('deletes a draft that was never submitted, with its files and objects', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await unwrap(r.deleteDraft.execute(r.contextOf(), { certificateId }));
      expect(r.certificates.certificates.size).toBe(0);
      expect(r.certificates.documents.size).toBe(0);
      expect(r.vault.objects.size).toBe(0);
      expect(r.certificates.quotas.get(r.sellerId)).toBe(0);
    });

    it('refuses once a submission exists', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      await unwrap(r.submit.execute(r.contextOf(), { certificateId }));
      await unwrap(r.withdraw.execute(r.contextOf(), { certificateId }));
      await expect(r.deleteDraft.execute(r.contextOf(), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.has-submissions' },
      });
      expect(r.certificates.certificates.size).toBe(1);
    });
  });

  describe('reads', () => {
    it("lists the seller's own certificates newest first, page by page", async () => {
      const r = rig();
      await newHalal(r);
      r.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const second = await unwrap(r.create.execute(r.contextOf(), { typeCode: 'vegan' }));
      await unwrap(r.create.execute(r.contextOf(r.otherSeller), { typeCode: 'vegan' }));
      const firstPage = await unwrap(r.list.execute(r.contextOf(), { limit: 1 }));
      expect(firstPage.certificates.map((c) => c.certificateId)).toEqual([second.certificateId]);
      expect(firstPage.nextAfterId).toBe(second.certificateId);
      const secondPage = await unwrap(
        r.list.execute(r.contextOf(), { limit: 1, afterId: firstPage.nextAfterId }),
      );
      expect(secondPage.certificates.map((c) => c.typeCode)).toEqual(['halal']);
      expect(secondPage.nextAfterId).toBeNull();
    });

    it('reads a certificate with its draft in clear and its files', async () => {
      const r = rig();
      const certificateId = await completeHalal(r);
      const read = await unwrap(r.read.execute(r.contextOf(), { certificateId }));
      expect(read.certificate).toMatchObject({ certificateId, typeCode: 'halal', status: 'draft' });
      expect(read.draft).toMatchObject({ certificateNumber: 'HC-2026-001' });
      expect(read.documents).toHaveLength(1);
      expect(JSON.stringify(read)).not.toContain('objectKey');
      expect(JSON.stringify(read)).not.toContain('cleanSha256');
      await expect(r.read.execute(r.contextOf(r.otherSeller), { certificateId })).resolves.toEqual({
        ok: false,
        error: { code: 'certificate.not-found' },
      });
    });

    it('lists the active types with their form settings and active issuers', async () => {
      const r = rig();
      const { types } = await unwrap(r.options.execute(r.contextOf(), {}));
      expect(types.map((t) => t.code).sort()).toEqual(['halal', 'vegan']);
      const halal = types.find((t) => t.code === 'halal')!;
      expect(halal).toMatchObject({
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
        issuers: [{ issuerId: r.activeIssuer.id, displayName: 'Halal Authority' }],
      });
      expect(types.find((t) => t.code === 'vegan')!.issuers).toEqual([]);
    });

    it('refuses a customer and an admin on every read', async () => {
      const r = rig();
      const certificateId = await newHalal(r);
      for (const context of [r.contextOf(null, 'customer'), r.contextOf(null, 'admin')]) {
        expect((await r.list.execute(context, {})).ok).toBe(false);
        expect((await r.read.execute(context, { certificateId })).ok).toBe(false);
        expect((await r.options.execute(context, {})).ok).toBe(false);
      }
    });
  });

  describe('failures of a dependency', () => {
    it('answers unavailable, never a pass, when the counters are down', async () => {
      const r = rig();
      r.counters.failing = true;
      await expect(r.create.execute(r.contextOf(), { typeCode: 'halal' })).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(r.certificates.certificates.size).toBe(0);
    });

    it('answers unavailable when the registry cannot be read', async () => {
      const r = rig();
      (r.deps.types as unknown as { unavailable: boolean }).unavailable = true;
      await expect(r.create.execute(r.contextOf(), { typeCode: 'halal' })).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });
  });
});
