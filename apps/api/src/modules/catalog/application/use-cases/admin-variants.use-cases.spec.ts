import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_ATTRIBUTE_EDIT,
  CATALOG_PRODUCT_VIEW,
  CATALOG_VARIANT_TYPE_EDIT,
  CATALOG_VARIANT_VIEW,
} from '../../contracts/permissions';
import {
  DEFAULT_VARIANT_TYPE_SETTINGS,
  VariantTypeSettings,
} from '../../domain/variant-type-settings';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { SheetWriter } from '../ports/sheet-writer';
import type {
  VariantAdminReader,
  VariantRow,
  VariantsQuery,
  VariantTypeRecord,
} from '../ports/variant-admin.reader';
import type { VariantTypeSettingsStore } from '../ports/variant-type-settings.store';
import { AdminVariantIssueCounts } from './admin-variant-issue-counts.use-case';
import { AdminVariantTypeGet } from './admin-variant-type-get.use-case';
import { AdminVariantTypesList } from './admin-variant-types-list.use-case';
import { AdminVariantsExport, VARIANTS_EXPORT_MAX_ROWS } from './admin-variants-export.use-case';
import { AdminVariantsList } from './admin-variants-list.use-case';
import { VariantTypeSettingsEdit } from './variant-type-settings-edit.use-case';

// The admin Catalogue > Variants page (variants V6) in memory, on both Market fixtures: each key
// lets its reads or its write through and nothing else, the inputs are closed, and the settings
// edit is versioned, claim-checked and audited. SQL is in test/db/catalog-variant-admin.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');

const VIEW = CATALOG_VARIANT_VIEW.key;
const TYPE_EDIT = CATALOG_VARIANT_TYPE_EDIT.key;
const ATTRIBUTE_EDIT = CATALOG_ATTRIBUTE_EDIT.key;

describe.each(['AU', 'ZZ'] as const)('admin Variants page in market %s (V6)', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const { default: locale, supported } = policy.locales(market);
  const TYPE_ID = ids.next<'AttributeDefinition'>();
  const OTHER_ID = ids.next<'AttributeDefinition'>();

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return {
      ...base,
      actor: { ...base.actor, actingAs: { adminAccountId: ids.next<'Account'>() } } as never,
    };
  };

  const typeRecord = (over: Partial<VariantTypeRecord> = {}): VariantTypeRecord => ({
    id: TYPE_ID,
    code: 'size',
    status: 'active',
    names: { [locale]: 'Size' },
    options: [
      { code: 'kg1', labels: { [locale]: '1 kg' }, active: true, position: 0 },
      { code: 'g500', labels: { [locale]: '500 g' }, active: true, position: 1 },
      { code: 'g250', labels: {}, active: false, position: 2 },
    ],
    settings: DEFAULT_VARIANT_TYPE_SETTINGS,
    settingsVersion: 0,
    ...over,
  });

  const row = (n: number, over: Partial<VariantRow> = {}): VariantRow => ({
    productId: `0197c1f0-0000-7000-8000-0000000a${String(n).padStart(4, '0')}` as Id<'Product'>,
    productCode: `MP-00${n}`,
    productName: `Rice ${n}`,
    productScope: 'PLATFORM',
    productPaused: false,
    variantId: `0197c1f0-0000-7000-8000-0000000b${String(n).padStart(4, '0')}` as Id<'Variant'>,
    variantNo: 1,
    variantCode: `MP-00${n}-01`,
    labels: { [locale]: '1 kg' },
    gtin: '09300000000011',
    duplicateGtin: false,
    sellers: 1,
    ownImages: 0,
    productImages: 1,
    missingLocales: [],
    ...over,
  });

  /**
   * A gate that holds `keys`: a rule's every key must be held, as the real permission check does.
   */
  function gateHolding(keys: readonly string[]) {
    const checked: AccessDeclaration[] = [];
    const check: AuthorisationCheck = {
      check: (_c, declaration) => {
        checked.push(declaration);
        const rule = declaration.rule as { kind: string; allOf?: readonly string[] };
        const allowed = rule.kind === 'permissions' && rule.allOf!.every((k) => keys.includes(k));
        return Promise.resolve(
          allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    return { gate: createUseCaseGate(markets, check), checked };
  }

  function setup(
    options: {
      keys?: readonly string[];
      types?: VariantTypeRecord[];
      rows?: VariantRow[];
      stored?: VariantTypeSettings | null;
      claimHits?: boolean;
      unitFails?: boolean;
      staleOnSave?: boolean;
    } = {},
  ) {
    const { gate, checked } = gateHolding(options.keys ?? [VIEW, TYPE_EDIT, ATTRIBUTE_EDIT]);
    const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
    const unitOfWork = {
      run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push({ market: m.marketId, options: o });
        return options.unitFails === true
          ? Promise.resolve({ ok: false, error: new Error('down') })
          : work();
      },
    } as unknown as UnitOfWork;
    const types = options.types ?? [typeRecord()];
    const rows = options.rows ?? [row(1), row(2)];
    const queries: VariantsQuery[] = [];
    const reader: VariantAdminReader = {
      variantTypes: (m, limit) => {
        expect(m.marketId).toBe(code);
        return Promise.resolve(types.slice(0, limit));
      },
      variantType: (_m, id) => Promise.resolve(types.find((t) => t.id === id) ?? null),
      typeCounts: (_m, codes) =>
        Promise.resolve(new Map(codes.map((c) => [c, { products: 3, liveVariants: 7 }]))),
      optionProductCounts: (_m, _c, codes) =>
        Promise.resolve(new Map(codes.map((c, i) => [c, i + 1]))),
      featureSetsUsing: (_m, codes) =>
        Promise.resolve(
          new Map(
            codes.map((c) => [
              c,
              [
                {
                  id: ids.next<'AttributeFamily'>(),
                  code: 'groceries',
                  names: { [locale]: 'Groceries' },
                },
              ],
            ]),
          ),
        ),
      variantsPage: (_m, query) => {
        queries.push(query);
        const start =
          query.after === null ? 0 : rows.findIndex((r) => r.variantId === query.after) + 1;
        const page = rows.slice(start, start + query.limit);
        const more = start + query.limit < rows.length;
        return Promise.resolve({ rows: page, nextAfter: more ? page.at(-1)!.variantId : null });
      },
      issueCounts: () =>
        Promise.resolve({
          'no-seller-selling': 1,
          'missing-gtin': 2,
          'duplicate-gtin': 3,
          'no-image': 4,
          'missing-language': 5,
        }),
    };
    const saved: { kind: 'add' | 'revise'; version: number; author: string }[] = [];
    let stored = options.stored ?? null;
    const store: VariantTypeSettingsStore = {
      find: () => Promise.resolve(stored),
      add: (_m, settings, author) => {
        saved.push({ kind: 'add', version: settings.state.version, author });
        stored = settings;
        return Promise.resolve();
      },
      saveRevision: (_m, settings, author) => {
        if (options.staleOnSave === true) {
          return Promise.reject(new StaleAggregateError('variant-type-settings', TYPE_ID));
        }
        saved.push({ kind: 'revise', version: settings.state.version, author });
        stored = settings;
        return Promise.resolve();
      },
    };
    const matched: { locale: string; text: string }[] = [];
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_c, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const clock = new FixedClock(T0);
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, groups) {
        for await (const group of groups) yield JSON.stringify(group);
      },
    } as SheetWriter;
    const readDeps = { unitOfWork, variantAdminReader: reader, policy };
    const edit = new VariantTypeSettingsEdit(gate, {
      unitOfWork,
      variantAdminReader: reader,
      variantTypeSettings: store,
      policy,
      matcher: {
        match: (_c, texts) => {
          matched.push(...texts);
          return Promise.resolve({
            ok: true,
            value: texts.map(() =>
              options.claimHits === true ? [{ term: 'halal', start: 0, end: 5 } as never] : [],
            ),
          });
        },
      },
      claimLocales: { covered: () => Promise.resolve({ ok: true, value: supported }) },
      audit,
      clock,
      ids,
    });
    return {
      checked,
      units,
      queries,
      saved,
      matched,
      audits,
      typesList: new AdminVariantTypesList(gate, readDeps),
      typeGet: new AdminVariantTypeGet(gate, readDeps),
      list: new AdminVariantsList(gate, readDeps),
      counts: new AdminVariantIssueCounts(gate, readDeps),
      exporter: new AdminVariantsExport(gate, { ...readDeps, sheetWriter, clock }),
      edit,
    };
  }

  const editInput = (over: Record<string, unknown> = {}) => ({
    id: TYPE_ID,
    version: 0,
    displayStyle: 'swatches',
    optionOrder: 'by-size',
    swatches: { kg1: '#aa0000', g250: '00aa00' },
    sellerHelp: { [locale]: '  Pick the weight on the pack.  ' },
    ...over,
  });

  async function text(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
    let out = '';
    for await (const chunk of chunks) out += typeof chunk === 'string' ? chunk : '';
    return out;
  }

  describe('access', () => {
    it('declares one rule per use case: the reads take the view key, the edit takes both edit keys', () => {
      const rule = (allOf: string[]) => ({ kind: 'permissions', allOf });
      expect(AdminVariantTypesList.access).toEqual({
        name: 'catalog.admin-variant-types-list',
        rule: rule([VIEW]),
      });
      expect(AdminVariantTypeGet.access.rule).toEqual(rule([VIEW]));
      expect(AdminVariantsList.access).toEqual({
        name: 'catalog.admin-variants-list',
        rule: rule([VIEW]),
      });
      expect(AdminVariantIssueCounts.access.rule).toEqual(rule([VIEW]));
      expect(AdminVariantsExport.access).toEqual({
        name: 'catalog.admin-variants-export',
        rule: rule([VIEW]),
      });
      expect(VariantTypeSettingsEdit.access).toEqual({
        name: 'catalog.variant-type-settings-edit',
        rule: rule([TYPE_EDIT, ATTRIBUTE_EDIT]),
      });
      expect(CATALOG_VARIANT_VIEW).toMatchObject({ scope: 'platform', protected: false });
      expect(CATALOG_VARIANT_TYPE_EDIT).toMatchObject({ scope: 'platform', protected: true });
    });

    it('catalog.variant.view alone: every read is allowed, the edit is refused before any read', async () => {
      const s = setup({ keys: [VIEW] });
      expect((await s.typesList.execute(context(), {})).ok).toBe(true);
      expect((await s.typeGet.execute(context(), { id: TYPE_ID })).ok).toBe(true);
      expect((await s.list.execute(context(), {})).ok).toBe(true);
      expect((await s.counts.execute(context(), {})).ok).toBe(true);
      expect((await s.exporter.execute(context(), {})).ok).toBe(true);
      const unitsBefore = s.units.length;
      expect(await s.edit.execute(context(), editInput())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(s.units).toHaveLength(unitsBefore);
      expect(s.saved).toEqual([]);
      expect(s.matched).toEqual([]);
    });

    it('without catalog.variant.view (catalog.product.view only): every read is refused', async () => {
      const s = setup({ keys: [CATALOG_PRODUCT_VIEW.key, TYPE_EDIT, ATTRIBUTE_EDIT] });
      for (const result of [
        await s.typesList.execute(context(), {}),
        await s.typeGet.execute(context(), { id: TYPE_ID }),
        await s.list.execute(context(), {}),
        await s.counts.execute(context(), {}),
        await s.exporter.execute(context(), {}),
      ]) {
        expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      expect(s.units).toEqual([]);
    });

    it.each([
      ['catalog.variant-type.edit without catalog.attribute.edit', [VIEW, TYPE_EDIT]],
      ['catalog.attribute.edit without catalog.variant-type.edit', [VIEW, ATTRIBUTE_EDIT]],
    ])('%s: the edit is refused', async (_name, keys) => {
      const s = setup({ keys });
      expect(await s.edit.execute(context(), editInput())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(s.saved).toEqual([]);
    });

    it('both edit keys: the edit is allowed', async () => {
      const s = setup({ keys: [TYPE_EDIT, ATTRIBUTE_EDIT] });
      expect((await s.edit.execute(context(), editInput())).ok).toBe(true);
    });

    it('refuses a seller session everywhere, and the edit in an acting-as session', async () => {
      const s = setup();
      expect(await s.typesList.execute(context('seller'), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await s.list.execute(context('seller'), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await s.edit.execute(context('seller'), editInput())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await s.edit.execute(actingAs(), editInput())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(s.saved).toEqual([]);
    });
  });

  describe('variant types', () => {
    it('lists each type with active options, counts, feature sets and language completeness', async () => {
      const s = setup();
      const result = await s.typesList.execute(context(), {});
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.items).toEqual([
        {
          id: TYPE_ID,
          code: 'size',
          status: 'active',
          names: { [locale]: 'Size' },
          displayStyle: 'buttons',
          optionOrder: 'manual',
          options: 2,
          products: 3,
          liveVariants: 7,
          featureSets: [
            {
              id: expect.any(String) as string,
              code: 'groceries',
              names: { [locale]: 'Groceries' },
            },
          ],
          languages: supported.map((l) => ({
            locale: l,
            nameMissing: l !== locale,
            optionsMissing: l === locale ? 0 : 2,
          })),
        },
      ]);
      expect(s.units).toEqual([{ market: code, options: { readOnly: true } }]);
    });

    it('refuses a query key on the list', async () => {
      const s = setup();
      expect((await s.typesList.execute(context(), { q: 'x' })).ok).toBe(false);
      expect(s.units).toEqual([]);
    });

    it('gets one type with its options in the buyers order, swatches, help and version', async () => {
      const stored = typeRecord({
        settings: {
          displayStyle: 'swatches',
          optionOrder: 'by-size',
          swatches: { kg1: '#AA0000' },
          sellerHelp: { [locale]: 'Pick one.' },
        },
        settingsVersion: 3,
      });
      const s = setup({ types: [stored] });
      const result = await s.typeGet.execute(context(), { id: TYPE_ID });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.variantType).toMatchObject({
        displayStyle: 'swatches',
        optionOrder: 'by-size',
        sellerHelp: { [locale]: 'Pick one.' },
        settingsVersion: 3,
      });
      expect(
        result.value.variantType.optionList.map((o) => [o.code, o.swatch, o.products]),
      ).toEqual([
        ['g500', null, 2],
        ['kg1', '#AA0000', 1],
        ['g250', null, 3],
      ]);
    });

    it('answers variant-type.not-found for an unknown or malformed id', async () => {
      const s = setup();
      expect(await s.typeGet.execute(context(), { id: OTHER_ID })).toEqual({
        ok: false,
        error: { code: 'variant-type.not-found' },
      });
      expect(await s.typeGet.execute(context(), { id: 'nope' })).toEqual({
        ok: false,
        error: { code: 'variant-type.not-found' },
      });
    });
  });

  describe('variants', () => {
    it('reads one page with the Market locales and the defaults, and shows the issues', async () => {
      const s = setup({
        rows: [
          row(1, {
            sellers: 0,
            gtin: null,
            ownImages: 0,
            productImages: 0,
            missingLocales: ['zz'],
            productPaused: true,
          }),
          row(2, { duplicateGtin: true }),
        ],
      });
      const result = await s.list.execute(context(), {});
      if (!result.ok) throw new Error(result.error.code);
      expect(s.queries).toEqual([
        {
          text: null,
          typeCode: null,
          issue: null,
          after: null,
          limit: 25,
          locale,
          locales: supported,
        },
      ]);
      expect(result.value.nextAfter).toBeNull();
      expect(result.value.items.map((i) => [i.status, i.label, i.issues])).toEqual([
        ['paused', '1 kg', ['no-seller-selling', 'missing-gtin', 'no-image', 'missing-language']],
        ['live', '1 kg', ['duplicate-gtin']],
      ]);
      expect(s.units).toEqual([{ market: code, options: { readOnly: true } }]);
    });

    it('passes the search, the type, the issue and the cursor through', async () => {
      const s = setup();
      const after = row(9).variantId.toUpperCase();
      await s.list.execute(context(), {
        q: '  0930  ',
        typeCode: 'size',
        issue: 'missing-gtin',
        after,
        limit: 100,
      });
      expect(s.queries[0]).toMatchObject({
        text: '0930',
        typeCode: 'size',
        issue: 'missing-gtin',
        after: after.toLowerCase(),
        limit: 100,
      });
    });

    it.each<[Record<string, unknown>, string]>([
      [{ extra: 1 }, 'extra'],
      [{ q: 5 }, 'q'],
      [{ q: 'x'.repeat(101) }, 'q'],
      [{ q: 'a\u0007b' }, 'q'],
      [{ typeCode: 'Size!' }, 'typeCode'],
      [{ issue: 'out-of-stock' }, 'issue'],
      [{ after: 'nope' }, 'after'],
      [{ limit: 0 }, 'limit'],
      [{ limit: 101 }, 'limit'],
      [{ limit: '5' }, 'limit'],
    ])('refuses the query %j before any read', async (input, field) => {
      const s = setup();
      const result = await s.list.execute(context(), input);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(field);
      expect(s.units).toEqual([]);
    });

    it('counts the issues with the type filter only', async () => {
      const s = setup();
      const result = await s.counts.execute(context(), { typeCode: 'size' });
      expect(result).toMatchObject({ ok: true });
      expect((await s.counts.execute(context(), { q: 'x' })).ok).toBe(false);
    });

    it('answers access.unavailable when the unit fails', async () => {
      const s = setup({ unitFails: true });
      expect(await s.list.execute(context(), {})).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });
  });

  describe('export', () => {
    it('streams a CSV of the filtered variants with a formula guard', async () => {
      const s = setup({ rows: [row(1, { productName: '=HYPERLINK("x")', sellers: 0 })] });
      const result = await s.exporter.execute(context(), { issue: 'no-seller-selling' });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.filename).toBe('variants-2026-11-06.csv');
      expect(result.value.contentType).toBe('text/csv; charset=utf-8');
      const csv = await text(result.value.chunks);
      expect(csv.codePointAt(0)).toBe(0xfeff);
      const lines = csv.slice(1).trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        'Product,Product code,Variant,Variant code,GTIN,Status,Sellers selling,Issues',
      );
      expect(lines[1]).toContain(`'=HYPERLINK`);
      expect(lines[1]).toContain('No seller selling');
      expect(s.queries.every((q) => q.issue === 'no-seller-selling')).toBe(true);
    });

    it('writes XLSX through the sheet writer', async () => {
      const s = setup();
      const result = await s.exporter.execute(context(), { format: 'xlsx' });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.filename).toBe('variants-2026-11-06.xlsx');
      expect(await text(result.value.chunks)).toContain('Variant code');
    });

    it('refuses an export over the cap whole, before the first byte', async () => {
      const many = Array.from({ length: VARIANTS_EXPORT_MAX_ROWS + 1 }, (_, i) => row(i + 1));
      const s = setup({ rows: many });
      expect(await s.exporter.execute(context(), {})).toEqual({
        ok: false,
        error: { code: 'batch.too-large', max: VARIANTS_EXPORT_MAX_ROWS },
      });
    });

    it('refuses an unknown format', async () => {
      const s = setup();
      expect((await s.exporter.execute(context(), { format: 'pdf' })).ok).toBe(false);
      expect(s.units).toEqual([]);
    });
  });

  describe('settings edit', () => {
    it('stores the first settings at version 1, normalised, claim-checked, with one audit row of codes and counts', async () => {
      const s = setup();
      const result = await s.edit.execute(context(), editInput());
      expect(result).toEqual({
        ok: true,
        value: {
          variantType: {
            id: TYPE_ID,
            settingsVersion: 1,
            displayStyle: 'swatches',
            optionOrder: 'by-size',
          },
        },
      });
      expect(s.saved).toEqual([{ kind: 'add', version: 1, author: expect.any(String) as string }]);
      expect(s.matched).toEqual([{ locale, text: 'Pick the weight on the pack.' }]);
      expect(s.audits).toHaveLength(1);
      const entry = JSON.stringify(s.audits[0]);
      expect(s.audits[0]).toMatchObject({
        action: 'catalog.variant-type.settings-changed',
        targetId: TYPE_ID,
      });
      expect(entry).toContain('"swatchCount":2');
      expect(entry).not.toContain('#AA0000');
      expect(entry).not.toContain('Pick the weight');
    });

    it('revises stored settings to the next version when the version read is current', async () => {
      const first = VariantTypeSettings.create({
        marketId: market.marketId,
        definitionId: TYPE_ID,
        revisionId: ids.next<'VariantTypeSettingRevision'>(),
        content: DEFAULT_VARIANT_TYPE_SETTINGS,
        optionCodes: new Set(['kg1']),
        locales: supported,
        now: T0,
      });
      if (!first.ok) throw new Error('setup');
      const s = setup({ stored: first.value });
      const result = await s.edit.execute(
        context(),
        editInput({ version: 1, swatches: {}, sellerHelp: {} }),
      );
      expect(result).toMatchObject({ ok: true, value: { variantType: { settingsVersion: 2 } } });
      expect(s.saved).toEqual([
        { kind: 'revise', version: 2, author: expect.any(String) as string },
      ]);
      expect(s.matched).toEqual([]);
    });

    it('answers variant-type.stale for an old version or a concurrent write', async () => {
      const s = setup();
      expect(await s.edit.execute(context(), editInput({ version: 4 }))).toEqual({
        ok: false,
        error: { code: 'variant-type.stale' },
      });
      const first = VariantTypeSettings.create({
        marketId: market.marketId,
        definitionId: TYPE_ID,
        revisionId: ids.next<'VariantTypeSettingRevision'>(),
        content: DEFAULT_VARIANT_TYPE_SETTINGS,
        optionCodes: new Set(['kg1']),
        locales: supported,
        now: T0,
      });
      if (!first.ok) throw new Error('setup');
      const racing = setup({ stored: first.value, staleOnSave: true });
      expect(await racing.edit.execute(context(), editInput({ version: 1 }))).toEqual({
        ok: false,
        error: { code: 'variant-type.stale' },
      });
      expect(racing.audits).toEqual([]);
    });

    it('refuses a swatch for an option the type does not have', async () => {
      const s = setup();
      expect(await s.edit.execute(context(), editInput({ swatches: { pink: '#000000' } }))).toEqual(
        {
          ok: false,
          error: {
            code: 'variant-type.invalid',
            fields: [{ path: 'swatches.pink', code: 'unknown-option' }],
          },
        },
      );
      expect(s.saved).toEqual([]);
    });

    it('refuses help that names a certification claim, without opening a unit', async () => {
      const s = setup({ claimHits: true });
      const result = await s.edit.execute(context(), editInput());
      expect(result).toMatchObject({ ok: false, error: { code: 'attribute.claim-word' } });
      expect(s.units).toEqual([]);
      expect(s.saved).toEqual([]);
    });

    it('refuses help in a locale the Market does not support before the claim check', async () => {
      const s = setup();
      const result = await s.edit.execute(
        context(),
        editInput({ sellerHelp: { 'fr-FR': 'Bonjour.' } }),
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'variant-type.invalid',
          fields: [{ path: 'sellerHelp.fr-FR', code: 'locale' }],
        },
      });
      expect(s.matched).toEqual([]);
    });

    it('answers variant-type.not-found for an unknown type', async () => {
      const s = setup();
      expect(await s.edit.execute(context(), editInput({ id: OTHER_ID }))).toEqual({
        ok: false,
        error: { code: 'variant-type.not-found' },
      });
    });

    it.each<[Record<string, unknown>, string]>([
      [{ name: 'Size' }, 'name'],
      [{ version: -1 }, 'version'],
      [{ version: '0' }, 'version'],
      [{ displayStyle: 'grid' }, 'displayStyle'],
      [{ optionOrder: 'random' }, 'optionOrder'],
      [{ swatches: [] }, 'swatches'],
      [{ swatches: { kg1: 'red' } }, 'swatches.kg1'],
      [{ sellerHelp: 'Pick one' }, 'sellerHelp'],
    ])('refuses the body %j', async (over, field) => {
      const s = setup();
      const result = await s.edit.execute(context(), editInput(over));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(field);
      expect(s.saved).toEqual([]);
    });
  });
});
