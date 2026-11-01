import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { OwnOfferAddTag } from '../../src/modules/catalog/application/use-cases/own-offer-add-tag.use-case';
import { OwnOfferRecordAttestation } from '../../src/modules/catalog/application/use-cases/own-offer-record-attestation.use-case';
import { OwnOfferSetHandling } from '../../src/modules/catalog/application/use-cases/own-offer-set-handling.use-case';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakeClaimEvaluator,
  RecordingOutbox,
  allowedDecision,
  refusedDecision,
} from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// `own-offer.record-attestation` on PostgreSQL (ADR-0012 d4; catalog design 4.4, 5.4, 8.2), for
// both Market fixtures, with the real repositories and ClaimQueryBuilder (product lock first,
// facts read again in the write unit). The certification answer is a fake that allows the
// manufacturer basis only with the attestation recorded, as `evaluateClaims` does. Proved: the
// record keeps who and when, the history rows carry their own kinds and the author, a withdrawal
// suspends a manufacturer-basis tag and takes the Offer off sale, a recording restores it, and an
// unanswered check changes nothing.

const T0 = '2026-10-17T00:00:00Z';
const T1 = Temporal.Instant.from('2026-10-17T03:00:00Z');
const HASH = `sha256:${'a'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)(
  'catalog own-offer record-attestation in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    let owner: Client;
    let persistence: Persistence;

    beforeAll(async () => {
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      persistence = createPersistence();
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    async function insert(table: string, row: Record<string, unknown>) {
      await owner.query(
        `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
          .map((_, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(row),
      );
    }

    /** A published PLATFORM product with one variant and a published Offer of the seller on it. */
    async function publishedOffer(
      sellerId: Id<'Seller'>,
      handling = 'SEALED_ORIGINAL',
    ): Promise<string> {
      const productId = uuid7();
      const variantId = uuid7();
      await insert('products', {
        id: productId,
        ...base,
        scope: 'PLATFORM',
        owner_seller_id: null,
        created_by_seller_id: null,
        type_code: 'simple',
        variant_model: 'single',
        family_code: 'default',
        product_code: `A${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        status: 'draft',
        own_brand: false,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      });
      await insert('product_variants', {
        id: variantId,
        ...base,
        product_id: productId,
        variant_model: 'single',
        state: 'published',
        created_at: T0,
        published_at: T0,
      });
      const familyId = uuid7();
      const familyRevisionId = uuid7();
      await insert('attribute_families', {
        id: familyId,
        ...base,
        code: `f-${randomUUID().slice(0, 10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0,
      });
      await insert('attribute_family_revisions', {
        id: familyRevisionId,
        ...base,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0,
      });
      const revisionId = uuid7();
      await insert('product_revisions', {
        id: revisionId,
        ...base,
        product_id: productId,
        revision_no: 1,
        revision_kind: 'submission',
        base_revision_id: null,
        reverted_from_revision_id: null,
        family_revision_id: familyRevisionId,
        definition_revision_ids: [],
        tax_category_code: 'standard',
        attribute_values: '{}',
        field_provenance: null,
        sensitive: false,
        sensitive_reasons: [],
        content_schema_version: 1,
        content_hash: HASH,
        author_kind: 'seller',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0,
      });
      await insert('product_revision_variants', {
        ...base,
        revision_id: revisionId,
        variant_id: variantId,
        product_id: productId,
        position: 0,
        option_key: '',
        option_values: '{}',
        labels: '{}',
      });
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $2,
                version = 2 WHERE id = $1`,
        [productId, revisionId],
      );
      const offerId = uuid7();
      await insert('offers', {
        id: offerId,
        ...base,
        seller_id: sellerId,
        product_id: productId,
        seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
        condition_code: 'new',
        description: '{}',
        handling,
        attestation_recorded_at: null,
        attestation_account_id: null,
        status: 'published',
        off_sale_type_not_allowed: false,
        off_sale_product_retired: false,
        off_sale_product_not_listed: false,
        off_sale_tag_suspended: false,
        off_sale_product_paused: false,
        off_sale_description_claim_text: false,
        listed: true,
        submitted_at: T0,
        first_published_at: T0,
        deleted_at: null,
        version: 1,
        created_at: T0,
      });
      return offerId;
    }

    const certificate = {
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    };
    const issuerId = uuid7() as Id;
    /** The manufacturer basis: allowed only on a SEALED_ORIGINAL Offer with the attestation. */
    const evaluator = new FakeClaimEvaluator(
      (query) =>
        query.handling === 'SEALED_ORIGINAL' && query.attestationRecorded
          ? allowedDecision(query, certificate, {
              basis: 'MANUFACTURER',
              certificate: {
                kind: 'manufacturer',
                certificateId: certificate.certificateId,
                versionId: certificate.versionId,
                issuerId,
                typeRevisionId: certificate.typeRevisionId,
                validUntil: null,
              },
              badge: {
                ...allowedDecision(query, certificate).badge!,
                basis: 'MANUFACTURER',
                sellerClaim: false,
              },
            })
          : refusedDecision(query, 'attestation-missing'),
      [typeCode],
    );

    function rig(sellerId: Id<'Seller'>, accountId: Id<'Account'>) {
      const deps = {
        unitOfWork: persistence.unitOfWork,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: new ClaimQueryBuilder({
          products: new PrismaProductRepository(persistence.service),
          revisions: new PrismaProductRevisionRepository(persistence.service),
          categoryPaths: new PrismaCategoryPathsReader(persistence.service),
        }),
        evaluator,
        outbox: new RecordingOutbox(),
        clock: new FixedClock(T1),
      };
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );
      return {
        context,
        outbox: deps.outbox,
        record: new OwnOfferRecordAttestation(gate, deps),
        addTag: new OwnOfferAddTag(gate, { ...deps, ids }),
        setHandling: new OwnOfferSetHandling(gate, deps),
      };
    }

    const offerRow = async (offerId: string) =>
      (
        await owner.query(
          `SELECT attestation_recorded_at, attestation_account_id, listed, off_sale_tag_suspended,
                  version FROM catalog.offers WHERE market_id = $1 AND id = $2`,
          [market.marketId, offerId],
        )
      ).rows[0] as {
        attestation_recorded_at: Date | null;
        attestation_account_id: string | null;
        listed: boolean;
        off_sale_tag_suspended: boolean;
        version: number;
      };
    const offerHistory = async (offerId: string) =>
      (
        await owner.query(
          `SELECT change_kind, changed_fields, attestation_recorded, actor_kind, actor_account_id
             FROM catalog.offer_history WHERE market_id = $1 AND offer_id = $2
            ORDER BY offer_version`,
          [market.marketId, offerId],
        )
      ).rows as Record<string, unknown>[];
    const tagRow = async (offerId: string) =>
      (
        await owner.query(
          `SELECT status, basis, last_reason_code, last_change_cause
             FROM catalog.offer_tags WHERE market_id = $1 AND offer_id = $2`,
          [market.marketId, offerId],
        )
      ).rows[0] as Record<string, unknown>;

    it('records who and when, then a withdrawal suspends the manufacturer tag and a new record restores it', async () => {
      evaluator.unavailable = false;
      const sellerId = uuid7() as Id<'Seller'>;
      const accountId = uuid7() as Id<'Account'>;
      const offerId = await publishedOffer(sellerId);
      const r = rig(sellerId, accountId);

      // Without the attestation the manufacturer basis is refused.
      expect(await r.addTag.execute(r.context, { offerId, typeCode })).toMatchObject({
        ok: false,
        error: { code: 'claim.tag-not-allowed' },
      });

      const recorded = await r.record.execute(r.context, { offerId, attested: true });
      expect(recorded).toEqual({
        ok: true,
        value: { changedFields: ['attestation'], attestationRecordedAt: T1.toString() },
      });
      expect(await offerRow(offerId)).toMatchObject({
        attestation_recorded_at: new Date(T1.epochMilliseconds),
        attestation_account_id: accountId,
        version: 2,
      });
      expect(await r.addTag.execute(r.context, { offerId, typeCode })).toEqual({
        ok: true,
        value: { typeCode, status: 'active', basis: 'MANUFACTURER' },
      });

      const withdrawn = await r.record.execute(r.context, { offerId, attested: false });
      expect(withdrawn).toEqual({
        ok: true,
        value: { changedFields: ['attestation'], attestationRecordedAt: null },
      });
      expect(await offerRow(offerId)).toMatchObject({
        attestation_recorded_at: null,
        attestation_account_id: null,
        listed: false,
        off_sale_tag_suspended: true,
      });
      expect(await tagRow(offerId)).toEqual({
        status: 'suspended',
        basis: 'MANUFACTURER',
        last_reason_code: 'attestation-missing',
        last_change_cause: 'attestation-change',
      });

      expect((await r.record.execute(r.context, { offerId, attested: true })).ok).toBe(true);
      expect(await offerRow(offerId)).toMatchObject({
        listed: true,
        off_sale_tag_suspended: false,
      });
      expect(await tagRow(offerId)).toMatchObject({
        status: 'active',
        last_change_cause: 'attestation-change',
      });

      const kinds = (await offerHistory(offerId)).filter((row) =>
        String(row.change_kind).startsWith('attestation-'),
      );
      expect(kinds).toEqual([
        {
          change_kind: 'attestation-recorded',
          changed_fields: ['attestation'],
          attestation_recorded: true,
          actor_kind: 'seller',
          actor_account_id: accountId,
        },
        {
          change_kind: 'attestation-withdrawn',
          changed_fields: ['attestation'],
          attestation_recorded: false,
          actor_kind: 'seller',
          actor_account_id: accountId,
        },
        {
          change_kind: 'attestation-recorded',
          changed_fields: ['attestation'],
          attestation_recorded: true,
          actor_kind: 'seller',
          actor_account_id: accountId,
        },
      ]);
      const tagHistory = await owner.query(
        `SELECT to_status, entry_path FROM catalog.offer_tag_history
          WHERE market_id = $1 AND offer_id = $2 ORDER BY change_seq`,
        [market.marketId, offerId],
      );
      expect(tagHistory.rows).toEqual([
        { to_status: 'active', entry_path: 'tag-add' },
        { to_status: 'suspended', entry_path: 'attestation-change' },
        { to_status: 'active', entry_path: 'attestation-change' },
      ]);
    });

    it('clears the attestation when handling leaves SEALED_ORIGINAL; back again keeps the tag suspended until a new record (Hassan M-1)', async () => {
      evaluator.unavailable = false;
      const sellerId = uuid7() as Id<'Seller'>;
      const accountId = uuid7() as Id<'Account'>;
      const offerId = await publishedOffer(sellerId);
      const r = rig(sellerId, accountId);
      expect((await r.record.execute(r.context, { offerId, attested: true })).ok).toBe(true);
      expect((await r.addTag.execute(r.context, { offerId, typeCode })).ok).toBe(true);

      expect(await r.setHandling.execute(r.context, { offerId, handling: 'REPACKED' })).toEqual({
        ok: true,
        value: { changedFields: ['handling', 'attestation'] },
      });
      expect(await offerRow(offerId)).toMatchObject({
        attestation_recorded_at: null,
        attestation_account_id: null,
        listed: false,
        off_sale_tag_suspended: true,
      });
      expect((await offerHistory(offerId)).at(-1)).toEqual({
        change_kind: 'edited',
        changed_fields: ['handling', 'attestation'],
        attestation_recorded: false,
        actor_kind: 'seller',
        actor_account_id: accountId,
      });
      expect(await tagRow(offerId)).toMatchObject({
        status: 'suspended',
        last_change_cause: 'handling-change',
      });

      expect(
        await r.setHandling.execute(r.context, { offerId, handling: 'SEALED_ORIGINAL' }),
      ).toEqual({ ok: true, value: { changedFields: ['handling'] } });
      expect(await offerRow(offerId)).toMatchObject({
        attestation_recorded_at: null,
        listed: false,
      });
      expect(await tagRow(offerId)).toMatchObject({
        status: 'suspended',
        last_reason_code: 'attestation-missing',
      });

      expect((await r.record.execute(r.context, { offerId, attested: true })).ok).toBe(true);
      expect(await offerRow(offerId)).toMatchObject({
        listed: true,
        off_sale_tag_suspended: false,
      });
      expect(await tagRow(offerId)).toMatchObject({
        status: 'active',
        last_change_cause: 'attestation-change',
      });
    });

    it('changes nothing when the check is unavailable, and refuses another handling', async () => {
      evaluator.unavailable = false;
      const sellerId = uuid7() as Id<'Seller'>;
      const accountId = uuid7() as Id<'Account'>;
      const offerId = await publishedOffer(sellerId);
      const r = rig(sellerId, accountId);
      expect((await r.record.execute(r.context, { offerId, attested: true })).ok).toBe(true);
      expect((await r.addTag.execute(r.context, { offerId, typeCode })).ok).toBe(true);
      const before = await offerRow(offerId);

      evaluator.unavailable = true;
      try {
        expect(await r.record.execute(r.context, { offerId, attested: false })).toEqual({
          ok: false,
          error: { code: 'claim.check-unavailable' },
        });
      } finally {
        evaluator.unavailable = false;
      }
      expect(await offerRow(offerId)).toEqual(before);
      expect(await tagRow(offerId)).toMatchObject({ status: 'active' });

      const repacked = await publishedOffer(sellerId, 'REPACKED');
      expect(await r.record.execute(r.context, { offerId: repacked, attested: true })).toEqual({
        ok: false,
        error: { code: 'offer.attestation-needs-sealed-original' },
      });
      expect(await offerRow(repacked)).toMatchObject({
        attestation_recorded_at: null,
        version: 1,
      });
    });
  },
);
