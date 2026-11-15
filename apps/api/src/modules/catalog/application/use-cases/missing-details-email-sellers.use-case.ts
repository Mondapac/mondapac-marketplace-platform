import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { MissingDetailsEmailRequestedAudit } from '../../domain/audit';
import {
  MISSING_DETAILS_EMAIL_MAX_PRODUCTS,
  MISSING_DETAILS_EMAIL_THROTTLE_DAYS,
} from '../../domain/missing-details-email';
import { editorAccountOf } from '../attributes/attribute-editor';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import { englishLocaleOf } from '../attributes/english-locale';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { MissingDetailsMailSettings } from '../ports/missing-details-mail-settings';
import type {
  MissingDetailsEmailKey,
  MissingDetailsEmailStore,
} from '../ports/missing-details-email.store';
import type { ProductDetailsGapReader } from '../ports/product-details-gap.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { missingRequiredCodes } from './products-missing-details-list.use-case';

export interface MissingDetailsEmailSellersInput {
  readonly productIds?: unknown;
  /** True: only report who would be emailed; nothing is claimed or written. */
  readonly dryRun?: unknown;
}

export type MissingDetailsEmailProductStatus = 'will-send' | 'queued' | 'recently-emailed';

export interface MissingDetailsEmailProductView {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string | null;
  /** English names of the missing details. */
  readonly missing: readonly string[];
  readonly status: MissingDetailsEmailProductStatus;
  /** When the seller was last asked about this product; null when never. */
  readonly lastRequestedAt: string | null;
}

export interface MissingDetailsEmailSellerView {
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly products: readonly MissingDetailsEmailProductView[];
}

export interface MissingDetailsEmailSellersOutput {
  readonly dryRun: boolean;
  readonly throttleDays: number;
  readonly sellers: readonly MissingDetailsEmailSellerView[];
  /** Products left out: not published, a platform product, or nothing missing any more. */
  readonly ignored: readonly {
    readonly productId: string;
    readonly reason: 'not-published' | 'platform-product' | 'nothing-missing';
  }[];
}

export type MissingDetailsEmailSellersFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'missing-details-email.unconfigured' }
  | ValidationFailure;

export interface MissingDetailsEmailSellersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly detailsGapReader: ProductDetailsGapReader;
  readonly attributes: AttributeRepository;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly familyResolver: ProductFamilyResolver;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly emailStore: MissingDetailsEmailStore;
  readonly missingDetailsMailSettings: MissingDetailsMailSettings;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const DAY_MS = 86_400_000;
const NAME_PAGE = 100;

/**
 * `catalog.missing-details-email-sellers` (attributes package A4-4): from the Missing details
 * report an admin picks products and asks their sellers to fill in the required details. The
 * products are judged again on the server, never trusted from the browser: only a published
 * seller product that still lacks a required detail counts. One mail goes to each seller, listing
 * only that seller's picked products, and a seller is asked about a product at most once in 7 days
 * (the store's guarded claim). This use case writes the requests and one audit row per seller; the
 * job `catalog.send-missing-details-emails` sends them (it alone may read a seller's address). The
 * mail is English only. `dryRun` answers who would be emailed and writes nothing. Rule:
 * `catalog.attribute.edit` (protected), the admin population, never an acting-as session. A Market
 * without the seller page link sends no such mail.
 */
export class MissingDetailsEmailSellers extends UseCase<
  MissingDetailsEmailSellersInput,
  MissingDetailsEmailSellersOutput,
  MissingDetailsEmailSellersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.missing-details-email-sellers',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('MissingDetailsEmailSellers');

  constructor(
    gate: UseCaseGate,
    private readonly deps: MissingDetailsEmailSellersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MissingDetailsEmailSellersInput,
  ): Promise<Result<MissingDetailsEmailSellersOutput, MissingDetailsEmailSellersFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.missing-details-email-sellers',
      code: result.ok ? (result.value.dryRun ? 'previewed' : 'requested') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: MissingDetailsEmailSellersInput,
  ): Promise<Result<MissingDetailsEmailSellersOutput, MissingDetailsEmailSellersFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['productIds', 'dryRun']);
    if (!body.ok) return body;
    const raw = body.value['productIds'];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MISSING_DETAILS_EMAIL_MAX_PRODUCTS) {
      return invalid('productIds', 'range');
    }
    const productIds: string[] = [];
    for (const value of raw as unknown[]) {
      if (typeof value !== 'string' || !parseId(value).ok) return invalid('productIds', 'format');
      if (!productIds.includes(value)) productIds.push(value);
    }
    const rawDry = body.value['dryRun'];
    if (rawDry !== undefined && typeof rawDry !== 'boolean') return invalid('dryRun', 'type');
    const dryRun = rawDry === true;

    const { market } = context;
    const { deps } = this;
    if (deps.missingDetailsMailSettings.productsPage(market) === null) {
      return err({ code: 'missing-details-email.unconfigured' });
    }

    const judged = await this.#judge(context, market, productIds);
    if (!judged.ok) return judged;
    const { candidates, ignored, labelsByCode } = judged.value;

    const now = deps.clock.now();
    const notAfter = now.subtract({ milliseconds: MISSING_DETAILS_EMAIL_THROTTLE_DAYS * DAY_MS });
    const latest = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.emailStore.latest(
            market,
            candidates.map((c) => ({ sellerId: c.sellerId, productId: c.productId })),
          ),
        ),
      { readOnly: true },
    );
    if (!latest.ok) return err({ code: 'access.unavailable' });
    const keyOf = (key: MissingDetailsEmailKey): string => `${key.sellerId}:${key.productId}`;
    const last = new Map(latest.value.map((record) => [keyOf(record), record]));
    const recent = (c: Candidate): boolean => {
      const record = last.get(keyOf(c));
      return (
        record !== undefined &&
        (record.state === 'pending' || record.state === 'sent') &&
        record.requestedAt.epochMilliseconds > notAfter.epochMilliseconds
      );
    };

    const sellerIds = [...new Set(candidates.map((c) => c.sellerId))];
    const names = new Map<string, string>();
    for (let at = 0; at < sellerIds.length; at += NAME_PAGE) {
      const page = await deps.sellerNames.storeNames(context, sellerIds.slice(at, at + NAME_PAGE));
      for (const [id, name] of page) names.set(id, name);
    }

    const claimed = new Set<string>();
    if (!dryRun) {
      const written = await deps.unitOfWork.run(market, async () => {
        const perSeller = new Map<string, { claimed: number; skipped: number }>();
        for (const c of candidates) {
          const tally = perSeller.get(c.sellerId) ?? { claimed: 0, skipped: 0 };
          perSeller.set(c.sellerId, tally);
          if (recent(c)) {
            tally.skipped += 1;
            continue;
          }
          const won = await deps.emailStore.claim(
            market,
            {
              sellerId: c.sellerId,
              productId: c.productId,
              sellerName: names.get(c.sellerId) ?? null,
              productName: (c.name ?? c.productCode).slice(0, 200),
              missingLabels: c.missing.map((code) => labelsByCode.get(code) ?? code).slice(0, 50),
            },
            { requestedBy: accountId, now, notAfter },
          );
          if (won) {
            claimed.add(keyOf(c));
            tally.claimed += 1;
          } else tally.skipped += 1;
        }
        for (const [sellerId, tally] of perSeller) {
          if (tally.claimed === 0) continue;
          await deps.audit.record(
            context,
            MissingDetailsEmailRequestedAudit.entry(sellerId as Id<'Seller'>, {
              after: { productCount: tally.claimed, skippedCount: tally.skipped },
            }),
          );
        }
        return ok(undefined);
      });
      if (!written.ok) return err({ code: 'access.unavailable' });
    }

    const sellers = sellerIds.map((sellerId): MissingDetailsEmailSellerView => ({
      sellerId,
      sellerName: names.get(sellerId) ?? null,
      products: candidates
        .filter((c) => c.sellerId === sellerId)
        .map((c): MissingDetailsEmailProductView => {
          const sentBefore = last.get(keyOf(c));
          const status: MissingDetailsEmailProductStatus = dryRun
            ? recent(c)
              ? 'recently-emailed'
              : 'will-send'
            : claimed.has(keyOf(c))
              ? 'queued'
              : 'recently-emailed';
          return {
            productId: c.productId,
            productCode: c.productCode,
            name: c.name,
            missing: c.missing.map((code) => labelsByCode.get(code) ?? code),
            status,
            lastRequestedAt: sentBefore === undefined ? null : sentBefore.requestedAt.toString(),
          };
        }),
    }));
    return ok({
      dryRun,
      throttleDays: MISSING_DETAILS_EMAIL_THROTTLE_DAYS,
      sellers,
      ignored,
    });
  }

  /** Judges the picked products again: the published seller products that still lack details. */
  async #judge(
    context: CallContext,
    market: MarketContext,
    productIds: readonly string[],
  ): Promise<Result<Judged, MissingDetailsEmailSellersFailure>> {
    const { deps } = this;
    const locales = deps.policy.locales(market);
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    // The mail is English only: product and detail names are read in the Market's English locale,
    // not its default (ZZ: ja-JP); a name missing there falls back to the code.
    const english = englishLocaleOf(locales);
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const rows = await deps.detailsGapReader.publishedByIds(market, productIds, english);
        const definitions = await deps.attributeAdminReader.definitions(market, ATTRIBUTE_LOAD_MAX);
        const session = await deps.familyResolver.open(market);
        const schemas = new Map<string, Awaited<ReturnType<AttributeRepository['loadSchema']>>>();
        const candidates: Candidate[] = [];
        const ignored: Judged['ignored'][number][] = [];
        const found = new Set(rows.map((row) => row.productId));
        for (const id of productIds) {
          if (!found.has(id)) ignored.push({ productId: id, reason: 'not-published' });
        }
        for (const row of rows) {
          if (row.ownerSellerId === null) {
            ignored.push({ productId: row.productId, reason: 'platform-product' });
            continue;
          }
          const resolved = await session.resolve(row.primaryCategoryId);
          const familyCode = resolved.ok ? resolved.familyCode : row.revisionFamilyCode;
          if (!schemas.has(familyCode)) {
            schemas.set(familyCode, await deps.attributes.loadSchema(market, familyCode));
          }
          const schema = schemas.get(familyCode) ?? null;
          const missing =
            schema === null ? [] : missingRequiredCodes(schema, row.attributeValues, ordered);
          if (missing.length === 0) {
            ignored.push({ productId: row.productId, reason: 'nothing-missing' });
            continue;
          }
          candidates.push({
            productId: row.productId,
            productCode: row.productCode,
            name: row.name,
            sellerId: row.ownerSellerId as Id<'Seller'>,
            missing,
          });
        }
        const labelsByCode = new Map<string, string>();
        for (const definition of definitions) {
          const label = definition.revision.names[english];
          if (typeof label === 'string' && label !== '') labelsByCode.set(definition.code, label);
        }
        candidates.sort((a, b) =>
          a.sellerId === b.sellerId
            ? a.productId < b.productId
              ? -1
              : 1
            : a.sellerId < b.sellerId
              ? -1
              : 1,
        );
        return ok({ candidates, ignored, labelsByCode });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    void context;
    return ok(read.value);
  }
}

interface Candidate {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string | null;
  readonly sellerId: Id<'Seller'>;
  readonly missing: readonly string[];
}

interface Judged {
  readonly candidates: readonly Candidate[];
  readonly ignored: MissingDetailsEmailSellersOutput['ignored'][number][];
  readonly labelsByCode: ReadonlyMap<string, string>;
}
