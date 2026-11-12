import type {
  AttributeField,
  AttributeSchema,
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryMissingDetailsEmailStore } from '../../../../../test/support/catalog-missing-details-email-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { MAX_NOTICE_ATTEMPTS } from '../../domain/certificate-expiry-notice';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { ConfigSellerPanelLinks } from '../../infrastructure/config-seller-panel-links';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';
import type {
  ProductDetailsGapReader,
  PublishedProductsFilter,
  PublishedProductValues,
} from '../ports/product-details-gap.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import {
  englishLocaleOf,
  ProductsMissingDetailsEmailSellers,
} from './products-missing-details-email-sellers.use-case';
import { SendMissingDetailsEmails } from './send-missing-details-emails.use-case';

// "Email sellers" of the Missing details report (attributes A4-4) in memory, on both Market
// fixtures: the selection is judged again with the report's rule, one email per seller in the
// approved English text with English detail names (ZZ's default locale is Japanese), the 7-day
// throttle by the injected clock, one pending email per seller, the dry run, the audit rows, the
// access rule (key, admin population, no acting-as) and the closed input; then the job that sends
// the stored text through identity's contact point. The SQL is in
// test/db/catalog-missing-details-emails.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const links = new ConfigSellerPanelLinks(markets);
const T0 = Temporal.Instant.from('2026-11-12T10:00:00Z');
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ADMIN = ID(0xa1);
const SELLER_A = ID(0x2a) as Id<'Seller'>;
const SELLER_B = ID(0x2b) as Id<'Seller'>;

const field = (code: string): AttributeField => ({
  code,
  dataType: 'text',
  localizable: false,
  required: true,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: { maxLength: 100 },
});

describe.each(['AU', 'ZZ'] as const)(
  'emailing sellers about missing details in market %s',
  (code) => {
    const market: MarketContext = testMarketContext(code, 'default');
    const locales = policy.locales(market);
    const english = englishLocaleOf(locales);

    const admin = (population: 'admin' | 'seller' = 'admin'): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ADMIN as never,
          sessionId: ID(0xa2) as never,
          sellerId: population === 'seller' ? SELLER_A : null,
        }),
      );
    const actingAs = (): CallContext => {
      const base = admin();
      return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
    };
    const system = () => testCallContext(market, 'system');

    // Products: the names per locale; `values` filled leaves nothing missing.
    interface Stored extends Omit<PublishedProductValues, 'name'> {
      readonly names: Record<string, string>;
    }
    let products: Stored[];
    let filters: PublishedProductsFilter[];
    let emails: MemoryMissingDetailsEmailStore;
    let audits: AuditEntry[];
    let units: (UnitOfWorkOptions | undefined)[];
    let allow: boolean;
    let sent: MailMessage[];
    let transportFails: boolean;
    let contacts: Map<string, string | null>;
    let clock: FixedClock;

    const reader: ProductDetailsGapReader = {
      published: (_m, filter) => {
        filters.push(filter);
        return Promise.resolve(
          products
            .filter((p) => filter.productIds == null || filter.productIds.includes(p.productId))
            .slice(0, filter.limit)
            .map(({ names, ...rest }) => ({ ...rest, name: names[filter.locale] ?? null })),
        );
      },
    };
    const schema: AttributeSchema = {
      schemaRef: { familyRevisionId: 'fam-rev-1', definitionRevisionIds: [] } as never,
      fields: [field('origin'), field('net_quantity'), field('nameless')],
    };
    const attributes = {
      loadSchema: (_m: MarketContext, familyCode: string) =>
        Promise.resolve(familyCode === 'pantry' ? schema : null),
      definitionIdByCode: (_m: MarketContext, attributeCode: string) =>
        Promise.resolve(`def:${attributeCode}`),
    } as unknown as AttributeRepository;
    // English and default-locale names; `nameless` has none in English (its code is shown).
    const definitionNames: Record<string, Record<string, string>> = {
      'def:origin': { [english]: 'Country of origin', [locales.default]: 'Country of origin' },
      'def:net_quantity': { [english]: 'Net weight or volume', 'xx-XX': 'Other' },
      'def:nameless': code === 'ZZ' ? { 'ja-JP': '名前' } : {},
    };
    if (code === 'ZZ') definitionNames['def:origin']!['ja-JP'] = '原産国';
    const attributeStore = {
      findById: (_m: MarketContext, id: string) =>
        Promise.resolve({ state: { names: definitionNames[id] ?? {} } }),
    } as unknown as AttributeDefinitionStore;
    const familyResolver = {
      open: () =>
        Promise.resolve({
          resolve: (categoryId: string | null) =>
            Promise.resolve(
              categoryId === null
                ? ({ ok: false, code: 'family.unavailable' } as const)
                : ({ ok: true, familyCode: categoryId.slice(4) } as const),
            ),
        }),
    } as unknown as ProductFamilyResolver;
    const sellerNames: SellerNamesReader = {
      storeNames: (_c, ids) =>
        Promise.resolve(
          new Map(
            ids
              .filter((id) => id === SELLER_A || id === SELLER_B)
              .map((id) => [id, id === SELLER_A ? 'Fuego Pantry' : 'Nonna’s Table'] as const),
          ),
        ),
    };
    const check: AuthorisationCheck = {
      check: (context, declaration) =>
        Promise.resolve(
          (declaration.rule.kind === 'system' && context.actor.kind === 'system') ||
            (allow &&
              declaration.rule.kind === 'permissions' &&
              declaration.rule.allOf.includes(CATALOG_ATTRIBUTE_EDIT.key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        ),
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push(o);
        return work();
      },
    } as unknown as UnitOfWork;
    const audit: AuditWriter = {
      record: (_c, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const ownerContacts: OfferOwnerContact = {
      emailOf: (_c, sellerId) => Promise.resolve(contacts.get(sellerId) ?? null),
    };
    const mailTransport: MailTransport = {
      send: (message) => {
        if (transportFails) return Promise.reject(new Error('down'));
        sent.push(message);
        return Promise.resolve();
      },
    };
    const mailSettings: OfferOwnerMailSettings = {
      sender: () => ({ address: 'no-reply@example.test', name: 'Mondapac' }),
      zone: () => 'UTC',
    };

    const build = () => {
      const gate = createUseCaseGate(markets, check);
      return {
        email: new ProductsMissingDetailsEmailSellers(gate, {
          unitOfWork,
          detailsGapReader: reader,
          attributes,
          attributeStore,
          policy,
          familyResolver,
          detailsEmails: emails,
          sellerNames,
          sellerLinks: links,
          audit,
          clock,
          ids: new SequenceIdGenerator(clock),
        }),
        send: new SendMissingDetailsEmails(gate, {
          unitOfWork,
          detailsEmails: emails,
          ownerContacts,
          mailTransport,
          mailSettings,
          clock,
        }),
      };
    };

    const product = (n: number, over: Partial<Stored> = {}): Stored => ({
      productId: ID(0x1000 + n),
      productCode: `P${n}`,
      ownerSellerId: SELLER_A,
      revisionFamilyCode: 'pantry',
      primaryCategoryId: 'cat:pantry',
      names:
        english === locales.default
          ? { [english]: `Product ${n}` }
          : { [english]: `Product ${n}`, [locales.default]: `製品 ${n}` },
      attributeValues: { origin: 'x', net_quantity: 'x', nameless: 'x' },
      ...over,
    });
    const lacking = (n: number, missing: string[], over: Partial<Stored> = {}): Stored => {
      const values: Record<string, string> = { origin: 'x', net_quantity: 'x', nameless: 'x' };
      for (const m of missing) delete values[m];
      return product(n, { attributeValues: values, ...over });
    };

    beforeEach(() => {
      products = [];
      filters = [];
      emails = new MemoryMissingDetailsEmailStore();
      audits = [];
      units = [];
      allow = true;
      sent = [];
      transportFails = false;
      contacts = new Map([
        [SELLER_A, 'owner-a@example.test'],
        [SELLER_B, 'owner-b@example.test'],
      ]);
      clock = new FixedClock(T0);
    });

    it('names English things: the default locale when English, else the first English one', () => {
      expect(englishLocaleOf({ default: 'en-AU', supported: ['en-AU'] })).toBe('en-AU');
      expect(englishLocaleOf({ default: 'ja-JP', supported: ['ja-JP', 'en-US'] })).toBe('en-US');
      expect(englishLocaleOf({ default: 'de-DE', supported: ['de-DE'] })).toBe('de-DE');
      expect(english.startsWith('en')).toBe(true);
    });

    it('queues one email per seller with only its selected products and their English detail names', async () => {
      products = [
        lacking(1, ['origin', 'net_quantity']),
        lacking(2, ['origin'], { ownerSellerId: SELLER_B }),
        lacking(3, ['nameless']),
        lacking(4, ['origin']), // not selected
      ];
      const result = await build().email.execute(admin(), {
        productIds: [ID(0x1003), ID(0x1001), ID(0x1002)],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        dryRun: false,
        notEmailed: [],
        sellers: [
          {
            sellerId: SELLER_A,
            storeName: 'Fuego Pantry',
            status: 'queued',
            preview: null,
            products: [
              { productId: ID(0x1003), status: 'emailed', lastEmailedAt: null },
              { productId: ID(0x1001), status: 'emailed', lastEmailedAt: null },
            ],
          },
          { sellerId: SELLER_B, storeName: 'Nonna’s Table', status: 'queued' },
        ],
      });
      // The read asked for the English names of the selected products only.
      expect(filters).toEqual([
        expect.objectContaining({
          productIds: [ID(0x1003), ID(0x1001), ID(0x1002)],
          locale: english,
        }),
      ]);
      const stored = emails.all(market).map((e) => e.state);
      expect(stored).toHaveLength(2);
      const a = stored.find((s) => s.sellerId === SELLER_A)!;
      expect(a).toMatchObject({
        productIds: [ID(0x1003), ID(0x1001)],
        requestedByAccountId: ADMIN,
        requestedAt: T0,
        noticeState: 'pending',
        subject: '2 of your products need more details',
      });
      expect(a.text).toContain('Hi Fuego Pantry,\n');
      expect(a.text).toContain(
        '\n- Product 3: nameless\n- Product 1: Country of origin, Net weight or volume\n',
      );
      expect(a.text).toContain(`Open your products: ${links.productsUrl(market)}\n`);
      expect(a.text).not.toMatch(/原産国|製品|名前/);
      const b = stored.find((s) => s.sellerId === SELLER_B)!;
      expect(b.subject).toBe('1 of your products needs more details');
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'catalog.missing-details-email.queued',
          targetType: 'catalog.missing-details-email',
          targetId: a.id,
          after: { sellerId: SELLER_A, productCount: 2, throttledCount: 0 },
        }),
        expect.objectContaining({
          targetId: b.id,
          after: { sellerId: SELLER_B, productCount: 1, throttledCount: 0 },
        }),
      ]);
      expect(units).toEqual([{ readOnly: true }, undefined]);
    });

    it('answers a dry run with each preview and stores and audits nothing', async () => {
      products = [lacking(1, ['origin'])];
      const result = await build().email.execute(admin(), {
        productIds: [ID(0x1001)],
        dryRun: true,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          dryRun: true,
          sellers: [
            {
              status: 'queued',
              emailId: null,
              preview: {
                subject: '1 of your products needs more details',
                text: expect.stringContaining('- Product 1: Country of origin') as unknown,
              },
            },
          ],
        },
      });
      expect(emails.all(market)).toEqual([]);
      expect(audits).toEqual([]);
      expect(units).toEqual([{ readOnly: true }, { readOnly: true }]);
    });

    it('sends the queued email through the job, then throttles the same product for 7 days', async () => {
      products = [lacking(1, ['origin']), lacking(2, ['origin'])];
      const uc = build();
      await uc.email.execute(admin(), { productIds: [ID(0x1001)] });
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const run = await uc.send.execute(system(), {});
      expect(run).toMatchObject({ ok: true, value: { examined: 1, sent: 1 } });
      expect(sent).toEqual([
        expect.objectContaining({
          to: 'owner-a@example.test',
          from: { address: 'no-reply@example.test', name: 'Mondapac' },
          subject: '1 of your products needs more details',
        }),
      ]);
      const sentAt = T0.add({ minutes: 1 });
      expect(emails.all(market)[0]?.state).toMatchObject({ noticeState: 'sent', sentAt });

      // Six days later: product 1 is throttled, product 2 goes in a new email.
      clock.set(T0.add({ hours: 6 * 24 }));
      const again = await uc.email.execute(admin(), { productIds: [ID(0x1001), ID(0x1002)] });
      expect(again).toMatchObject({
        ok: true,
        value: {
          sellers: [
            {
              status: 'queued',
              products: [
                { productId: ID(0x1001), status: 'throttled', lastEmailedAt: sentAt.toString() },
                { productId: ID(0x1002), status: 'emailed', lastEmailedAt: null },
              ],
            },
          ],
        },
      });
      expect(audits.at(-1)).toMatchObject({ after: { productCount: 1, throttledCount: 1 } });
      await uc.send.execute(system(), {});

      // Only product 1 again, within the window: throttled, nothing queued.
      const throttled = await uc.email.execute(admin(), { productIds: [ID(0x1001)] });
      expect(throttled).toMatchObject({
        ok: true,
        value: { sellers: [{ status: 'throttled', emailId: null }] },
      });

      // Seven days after the first was requested, product 1 may be emailed again.
      clock.set(T0.add({ hours: 7 * 24, minutes: 1 }));
      const later = await uc.email.execute(admin(), { productIds: [ID(0x1001)] });
      expect(later).toMatchObject({ ok: true, value: { sellers: [{ status: 'queued' }] } });
    });

    it('holds back a seller whose earlier email still waits, and refuses a concurrent queue as busy', async () => {
      products = [lacking(1, ['origin']), lacking(2, ['origin'])];
      const uc = build();
      await uc.email.execute(admin(), { productIds: [ID(0x1001)] });
      const waiting = await uc.email.execute(admin(), { productIds: [ID(0x1002)] });
      expect(waiting).toMatchObject({
        ok: true,
        value: { sellers: [{ status: 'skipped', products: [{ status: 'email-pending' }] }] },
      });
      // Another request queued between this request's read and its insert.
      const racing = Object.assign(Object.create(emails) as MemoryMissingDetailsEmailStore, {
        pendingSellers: () => Promise.resolve(new Set<string>()),
      });
      const gate = createUseCaseGate(markets, check);
      const raced = new ProductsMissingDetailsEmailSellers(gate, {
        unitOfWork,
        detailsGapReader: reader,
        attributes,
        attributeStore,
        policy,
        familyResolver,
        detailsEmails: racing,
        sellerNames,
        sellerLinks: links,
        audit,
        clock,
        ids: new SequenceIdGenerator(clock),
      });
      audits = [];
      expect(await raced.execute(admin(), { productIds: [ID(0x1002)] })).toEqual({
        ok: false,
        error: { code: 'missing-details-email.busy' },
      });
      expect(audits).toEqual([]);
    });

    it('emails nobody about a complete product, a PLATFORM product or an unknown one', async () => {
      products = [product(1), lacking(2, ['origin'], { ownerSellerId: null })];
      const result = await build().email.execute(admin(), {
        productIds: [ID(0x1001), ID(0x1002), ID(0x1009), ID(0x1001)],
      });
      expect(result).toEqual({
        ok: true,
        value: {
          dryRun: false,
          sellers: [
            {
              sellerId: SELLER_A,
              storeName: 'Fuego Pantry',
              status: 'skipped',
              emailId: null,
              products: [
                { productId: ID(0x1001), status: 'no-missing-details', lastEmailedAt: null },
              ],
              preview: null,
            },
          ],
          notEmailed: [
            { productId: ID(0x1002), reason: 'no-seller' },
            { productId: ID(0x1009), reason: 'not-found' },
          ],
        },
      });
      expect(emails.all(market)).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('skips a seller without a usable address and retries a failed send until it fails', async () => {
      products = [lacking(1, ['origin']), lacking(2, ['origin'], { ownerSellerId: SELLER_B })];
      contacts.set(SELLER_B, null);
      const uc = build();
      await uc.email.execute(admin(), { productIds: [ID(0x1001), ID(0x1002)] });
      transportFails = true;
      const first = await uc.send.execute(system(), {});
      expect(first).toMatchObject({ ok: true, value: { skipped: 1, deferred: 1, sent: 0 } });
      const a = () => emails.all(market).find((e) => e.state.sellerId === SELLER_A)!.state;
      expect(emails.all(market).find((e) => e.state.sellerId === SELLER_B)?.state.noticeState).toBe(
        'skipped',
      );
      for (let attempt = 2; attempt <= MAX_NOTICE_ATTEMPTS; attempt += 1) {
        clock.set(a().noticeNextAttemptAt ?? clock.now());
        await uc.send.execute(system(), {});
      }
      expect(a()).toMatchObject({ noticeState: 'failed', sentAt: null });
      expect(sent).toEqual([]);
    });

    it.each([
      ['no productIds', {}, 'productIds'],
      ['an empty list', { productIds: [] }, 'productIds'],
      ['a string', { productIds: 'x' }, 'productIds'],
      ['a malformed id', { productIds: ['not-a-uuid'] }, 'productIds'],
      [
        '101 ids',
        { productIds: Array.from({ length: 101 }, (_, i) => ID(0x5000 + i)) },
        'productIds',
      ],
      ['a dryRun that is not a boolean', { productIds: [ID(1)], dryRun: 'yes' }, 'dryRun'],
      ['an unknown key', { productIds: [ID(1)], other: 1 }, 'other'],
    ])('refuses %s', async (_label, input, path) => {
      const result = await build().email.execute(admin(), input);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path }] },
      });
      expect(filters).toEqual([]);
    });

    it('refuses without the key, outside the admin population and in an acting-as session', async () => {
      products = [lacking(1, ['origin'])];
      const input = { productIds: [ID(0x1001)] };
      allow = false;
      expect(await build().email.execute(admin(), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      allow = true;
      expect(await build().email.execute(admin('seller'), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await build().email.execute(actingAs(), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(emails.all(market)).toEqual([]);
      expect(await build().send.execute(admin(), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  },
);
