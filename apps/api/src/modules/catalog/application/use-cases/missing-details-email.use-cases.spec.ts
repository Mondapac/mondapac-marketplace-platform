import type {
  AttributeField,
  AttributeSchema,
  CallContext,
  Id,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { AttributeRepository } from '../ports/attribute.repository';
import type {
  MissingDetailsEmailDraft,
  MissingDetailsEmailEnd,
  MissingDetailsEmailKey,
  MissingDetailsEmailRecord,
  MissingDetailsEmailStore,
  PendingMissingDetailsEmail,
} from '../ports/missing-details-email.store';
import type { MissingDetailsMailSettings } from '../ports/missing-details-mail-settings';
import type {
  ProductDetailsGapReader,
  PublishedProductValues,
} from '../ports/product-details-gap.reader';
import { MissingDetailsEmailSellers } from './missing-details-email-sellers.use-case';
import { SendMissingDetailsEmails } from './send-missing-details-emails.use-case';

// "Email sellers" in memory, on both Market fixtures (attributes package A4-4): the access rule, the
// judgement repeated on the server, the 7-day limit per seller and product, the preview that writes
// nothing, the audit row (ids and counts), and the job: one English mail per seller, no address
// means skipped, a failed send is retried and then given up.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const DAY = 86_400_000;
const T0 = Temporal.Instant.from('2026-11-11T04:00:00Z');

const field = (code: string, over: Partial<AttributeField> = {}): AttributeField => ({
  code,
  dataType: 'text',
  localizable: false,
  required: true,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: { maxLength: 100 },
  ...over,
});
const schema: AttributeSchema = {
  schemaRef: { familyRevisionId: 'fam-rev-1', definitionRevisionIds: [] } as never,
  fields: [field('origin'), field('storage')],
};

class MemoryStore implements MissingDetailsEmailStore {
  rows = new Map<
    string,
    MissingDetailsEmailDraft & {
      state: MissingDetailsEmailRecord['state'];
      outcome: string | null;
      attempts: number;
      requestedAt: Temporal.Instant;
    }
  >();
  private key = (k: MissingDetailsEmailKey) => `${k.sellerId}:${k.productId}`;
  latest(_m: MarketContext, pairs: readonly MissingDetailsEmailKey[]) {
    return Promise.resolve(
      pairs.flatMap((pair) => {
        const row = this.rows.get(this.key(pair));
        return row === undefined
          ? []
          : [
              {
                sellerId: row.sellerId,
                productId: row.productId,
                state: row.state,
                requestedAt: row.requestedAt,
              },
            ];
      }),
    );
  }
  claim(
    _m: MarketContext,
    draft: MissingDetailsEmailDraft,
    claim: { requestedBy: Id<'Account'>; now: Temporal.Instant; notAfter: Temporal.Instant },
  ) {
    const row = this.rows.get(this.key(draft));
    if (
      row !== undefined &&
      (row.state === 'pending' ||
        (row.state === 'sent' &&
          row.requestedAt.epochMilliseconds > claim.notAfter.epochMilliseconds))
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(this.key(draft), {
      ...draft,
      state: 'pending',
      outcome: null,
      attempts: 0,
      requestedAt: claim.now,
    });
    return Promise.resolve(true);
  }
  pending(): Promise<readonly PendingMissingDetailsEmail[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.state === 'pending').map((row) => ({ ...row })),
    );
  }
  settle(
    _m: MarketContext,
    key: MissingDetailsEmailKey,
    end: MissingDetailsEmailEnd | { state: 'pending'; attempts: number },
  ) {
    const row = this.rows.get(this.key(key));
    if (row === undefined || row.state !== 'pending') return Promise.resolve(false);
    row.state = end.state;
    row.attempts = end.attempts;
    row.outcome = 'outcome' in end ? end.outcome : null;
    return Promise.resolve(true);
  }
}

describe.each(['AU', 'ZZ'] as const)('Email sellers in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locale = policy.locales(market).default;

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: null,
      }),
    );
  const system = (): CallContext => testCallContext(market, 'system');

  let store: MemoryStore;
  let rows: PublishedProductValues[];
  let allow: boolean;
  let page: string | null;
  let audits: unknown[];
  let sent: MailMessage[];
  let address: string | null;
  let sendFails: boolean;
  let now: Temporal.Instant;

  const check: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const gapReader: ProductDetailsGapReader = {
    publishedByIds: (_m, ids) => Promise.resolve(rows.filter((row) => ids.includes(row.productId))),
    published: () => Promise.resolve([]),
  };
  const attributes = {
    loadSchema: () => Promise.resolve(schema),
  } as unknown as AttributeRepository;
  const attributeAdminReader = {
    definitions: () =>
      Promise.resolve([
        { code: 'origin', revision: { names: { [locale]: 'Country of origin' } } },
        { code: 'storage', revision: { names: { [locale]: 'Storage' } } },
      ]),
  } as unknown as AttributeAdminReader;
  const familyResolver = {
    open: () =>
      Promise.resolve({
        resolve: () => Promise.resolve({ ok: true, familyCode: 'pantry' } as const),
      }),
  } as unknown as ProductFamilyResolver;
  const settings: MissingDetailsMailSettings = {
    sender: () => ({ address: 'noreply@mondapac.test', name: 'Mondapac' }),
    productsPage: () => page,
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const clock = { now: () => now } as never;

  const request = () =>
    new MissingDetailsEmailSellers(createUseCaseGate(markets, check), {
      unitOfWork,
      detailsGapReader: gapReader,
      attributes,
      attributeAdminReader,
      familyResolver,
      policy,
      sellerNames: {
        storeNames: () => Promise.resolve(new Map([[ID(0x2000) as never, 'Fresh Co']])),
      },
      emailStore: store,
      missingDetailsMailSettings: settings,
      audit,
      clock,
    });
  const job = () =>
    new SendMissingDetailsEmails(createUseCaseGate(markets, check), {
      unitOfWork,
      emailStore: store,
      ownerContacts: {
        emailOf: () => Promise.resolve(address),
      },
      mailTransport: {
        send: (message: MailMessage) => {
          if (sendFails) return Promise.reject(new Error('smtp down'));
          sent.push(message);
          return Promise.resolve();
        },
      },
      missingDetailsMailSettings: settings,
      clock,
    });

  const product = (
    n: number,
    over: Partial<PublishedProductValues> = {},
  ): PublishedProductValues => ({
    productId: ID(0x1000 + n),
    productCode: `P${n}`,
    ownerSellerId: ID(0x2000),
    revisionFamilyCode: 'pantry',
    primaryCategoryId: 'cat:pantry',
    name: `Product ${n}`,
    attributeValues: {},
    ...over,
  });

  beforeEach(() => {
    store = new MemoryStore();
    rows = [product(1), product(2, { attributeValues: { origin: 'AU' } })];
    allow = true;
    page = 'https://seller.test/products';
    audits = [];
    sent = [];
    address = 'owner@seller.test';
    sendFails = false;
    now = T0;
  });

  it('is refused without the permission, and for a seller or a malformed request', async () => {
    allow = false;
    expect((await request().execute(admin(), { productIds: [ID(0x1001)] })).ok).toBe(false);
    allow = true;
    const bad = [{}, { productIds: [] }, { productIds: ['x'] }, { productIds: [ID(1)], extra: 1 }];
    for (const input of bad) {
      const result = await request().execute(admin(), input);
      expect(result.ok ? 'ok' : result.error.code).toBe('validation.failed');
    }
    expect((await request().execute(admin(), { productIds: [ID(0x1001)], dryRun: 'yes' })).ok).toBe(
      false,
    );
  });

  it('is refused in a Login as Seller (acting-as) session', async () => {
    const base = admin();
    const acting = {
      ...base,
      actor: { ...base.actor, actingAs: { sellerId: ID(0x2000) } },
    } as unknown as CallContext;
    const result = await request().execute(acting, { productIds: [ID(0x1001)] });
    expect(result.ok).toBe(false);
    expect(store.rows.size).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it('keeps the claims and the audit entry in one unit: they roll back together', async () => {
    const snapshot = new Map(store.rows);
    const rollingBack = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        try {
          const result = await work();
          if (!result.ok) throw new Error('rolled back');
          return result;
        } catch (error) {
          store.rows = new Map(snapshot);
          throw error;
        }
      },
    } as unknown as UnitOfWork;
    const failingAudit: AuditWriter = { record: () => Promise.reject(new Error('audit down')) };
    const useCase = new MissingDetailsEmailSellers(createUseCaseGate(markets, check), {
      unitOfWork: rollingBack,
      detailsGapReader: gapReader,
      attributes,
      attributeAdminReader,
      familyResolver,
      policy,
      sellerNames: { storeNames: () => Promise.resolve(new Map()) },
      emailStore: store,
      missingDetailsMailSettings: settings,
      audit: failingAudit,
      clock,
    });
    await expect(useCase.execute(admin(), { productIds: [ID(0x1001)] })).rejects.toThrow();
    // No claim survives a failed audit write, so the seller can be asked again at once.
    expect(store.rows.size).toBe(0);
  });

  it('judges the products again, groups them by seller and names the details in English', async () => {
    const result = await request().execute(admin(), {
      productIds: [ID(0x1001), ID(0x1002), ID(0x1003)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sellers).toHaveLength(1);
    expect(result.value.sellers[0]).toMatchObject({ sellerId: ID(0x2000), sellerName: 'Fresh Co' });
    expect(
      result.value.sellers[0]?.products.map((p) => [p.productCode, p.missing, p.status]),
    ).toEqual([
      ['P1', ['Country of origin', 'Storage'], 'queued'],
      ['P2', ['Storage'], 'queued'],
    ]);
    expect(result.value.ignored).toEqual([{ productId: ID(0x1003), reason: 'not-published' }]);
    expect(store.rows.size).toBe(2);
    expect(audits).toHaveLength(1);
  });

  it('leaves out platform products and products with nothing missing', async () => {
    rows = [
      product(1, { ownerSellerId: null }),
      product(2, { attributeValues: { origin: 'AU', storage: 'cool' } }),
    ];
    const result = await request().execute(admin(), { productIds: [ID(0x1001), ID(0x1002)] });
    expect(result.ok && result.value.sellers).toEqual([]);
    expect(result.ok && result.value.ignored).toEqual([
      { productId: ID(0x1001), reason: 'platform-product' },
      { productId: ID(0x1002), reason: 'nothing-missing' },
    ]);
    expect(audits).toHaveLength(0);
  });

  it('a preview writes nothing', async () => {
    const result = await request().execute(admin(), { productIds: [ID(0x1001)], dryRun: true });
    expect(result.ok && result.value.sellers[0]?.products[0]?.status).toBe('will-send');
    expect(store.rows.size).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it('asks a seller about a product at most once in 7 days, then again', async () => {
    await request().execute(admin(), { productIds: [ID(0x1001)] });
    // The mail goes out; a request still waiting in the queue is never replaced.
    await job().execute(system(), {});
    now = T0.add({ milliseconds: 6 * DAY });
    const early = await request().execute(admin(), { productIds: [ID(0x1001), ID(0x1002)] });
    expect(
      early.ok && early.value.sellers[0]?.products.map((p) => [p.productCode, p.status]),
    ).toEqual([
      ['P1', 'recently-emailed'],
      ['P2', 'queued'],
    ]);
    expect(early.ok && early.value.sellers[0]?.products[0]?.lastRequestedAt).toBe(T0.toString());
    const preview = await request().execute(admin(), { productIds: [ID(0x1001)], dryRun: true });
    expect(preview.ok && preview.value.sellers[0]?.products[0]?.status).toBe('recently-emailed');
    now = T0.add({ milliseconds: 7 * DAY + 1 });
    const later = await request().execute(admin(), { productIds: [ID(0x1001)] });
    expect(later.ok && later.value.sellers[0]?.products[0]?.status).toBe('queued');
  });

  it('writes no audit row for a seller whose every product was skipped', async () => {
    await request().execute(admin(), { productIds: [ID(0x1001)] });
    audits = [];
    await request().execute(admin(), { productIds: [ID(0x1001)] });
    expect(audits).toHaveLength(0);
  });

  it('a Market without the seller page sends no such mail', async () => {
    page = null;
    const result = await request().execute(admin(), { productIds: [ID(0x1001)] });
    expect(result.ok ? 'ok' : result.error.code).toBe('missing-details-email.unconfigured');
    expect(store.rows.size).toBe(0);
  });

  describe('the job', () => {
    it('sends one English mail per seller listing only that seller’s products', async () => {
      rows.push(product(3, { ownerSellerId: ID(0x2001) }));
      await request().execute(admin(), { productIds: [ID(0x1001), ID(0x1002), ID(0x1003)] });
      const result = await job().execute(system(), {});
      expect(result.ok && result.value).toMatchObject({ sellers: 2, sent: 3 });
      expect(sent).toHaveLength(2);
      const first = sent.find((m) => m.subject.startsWith('2 of'));
      expect(first?.text).toContain('- Product 1: Country of origin, Storage');
      expect(first?.text).toContain('- Product 2: Storage');
      expect(first?.text).not.toContain('Product 3');
      expect(sent.some((m) => m.subject === '1 of your products needs more details')).toBe(true);
      expect([...store.rows.values()].every((row) => row.state === 'sent')).toBe(true);
      // Sent once: a second run finds nothing pending.
      expect((await job().execute(system(), {})).ok && sent.length).toBe(2);
    });

    it('settles a seller without an address as skipped, and allows asking again at once', async () => {
      await request().execute(admin(), { productIds: [ID(0x1001)] });
      address = null;
      await job().execute(system(), {});
      expect(sent).toHaveLength(0);
      expect([...store.rows.values()][0]).toMatchObject({
        state: 'skipped',
        outcome: 'no-address',
      });
      const again = await request().execute(admin(), { productIds: [ID(0x1001)] });
      expect(again.ok && again.value.sellers[0]?.products[0]?.status).toBe('queued');
    });

    it('retries a failed send and gives up after three tries', async () => {
      await request().execute(admin(), { productIds: [ID(0x1001)] });
      sendFails = true;
      await job().execute(system(), {});
      await job().execute(system(), {});
      expect([...store.rows.values()][0]).toMatchObject({ state: 'pending', attempts: 2 });
      await job().execute(system(), {});
      expect([...store.rows.values()][0]).toMatchObject({
        state: 'failed',
        outcome: 'send-failed',
        attempts: 3,
      });
      sendFails = false;
      await job().execute(system(), {});
      expect(sent).toHaveLength(0);
    });

    it('is refused for anyone but the system, and waits when the Market has no seller page', async () => {
      expect((await job().execute(admin(), {})).ok).toBe(false);
      await request().execute(admin(), { productIds: [ID(0x1001)] });
      page = null;
      const result = await job().execute(system(), {});
      expect(result.ok ? 'ok' : result.error.code).toBe('missing-details-email.unconfigured');
      expect([...store.rows.values()][0]?.state).toBe('pending');
    });
  });
});
