import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { MissingDetailsEmailQueuedAudit } from '../../domain/audit';
import {
  MISSING_DETAILS_EMAIL_PRODUCTS_MAX,
  MISSING_DETAILS_EMAIL_WINDOW,
  MissingDetailsEmail,
  missingDetailsEmailMail,
  planMissingDetailsEmails,
  type MissingDetailsEmailMail,
  type PlannedProduct,
  type PlannedProductStatus,
} from '../../domain/missing-details-email';
import {
  closedInput,
  editorAccountOf,
  invalid,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import { MissingDetailsJudge } from '../attributes/missing-details-judge';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { MissingDetailsEmailStore } from '../ports/missing-details-email.store';
import type { ProductDetailsGapReader } from '../ports/product-details-gap.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { SellerPanelLinks } from '../ports/seller-panel-links';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProductsMissingDetailsEmailSellersInput {
  readonly [key: string]: unknown;
}

export interface EmailSellersProduct {
  readonly productId: string;
  /** `emailed`: listed in the seller's email; the others are left out, with the reason. */
  readonly status: PlannedProductStatus;
  /** The email that throttles it (ISO instant; `throttled` only). */
  readonly lastEmailedAt: string | null;
}

export interface EmailSellersSeller {
  readonly sellerId: string;
  /** The public store name; null when the seller has none (or sellers could not tell). */
  readonly storeName: string | null;
  /** `queued`: one email goes (or would go, on a dry run); `throttled`: none, as all were emailed recently; `skipped`: nothing to send. */
  readonly status: 'queued' | 'throttled' | 'skipped';
  /** The queued email; null on a dry run and when none is queued. */
  readonly emailId: string | null;
  readonly products: readonly EmailSellersProduct[];
  /** The email as it would go (dry run only). */
  readonly preview: MissingDetailsEmailMail | null;
}

export interface ProductsMissingDetailsEmailSellersOutput {
  readonly dryRun: boolean;
  readonly sellers: readonly EmailSellersSeller[];
  /** Selected products nobody is emailed about: not a published product of the Market, or a PLATFORM one. */
  readonly notEmailed: readonly {
    readonly productId: string;
    readonly reason: 'not-found' | 'no-seller';
  }[];
}

export type ProductsMissingDetailsEmailSellersFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  /** Another request queued an email to one of these sellers at the same moment: ask again. */
  | { readonly code: 'missing-details-email.busy' }
  | ValidationFailure;

export interface ProductsMissingDetailsEmailSellersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly detailsGapReader: ProductDetailsGapReader;
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
  readonly policy: CatalogMarketPolicy;
  readonly familyResolver: ProductFamilyResolver;
  readonly detailsEmails: MissingDetailsEmailStore;
  readonly sellerNames: SellerNamesReader;
  readonly sellerLinks: SellerPanelLinks;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What the read unit found: each selected product's owner and gap, and the English names. */
interface SelectionFacts {
  readonly found: readonly PlannedProduct[];
  readonly productNames: ReadonlyMap<string, string>;
  readonly detailNames: ReadonlyMap<string, string>;
}

/**
 * The Market locale the English-only seller emails name things in: the default when it is
 * English, else the first English supported locale, else the default (names then fall back to
 * codes). Language by its BCP 47 subtag; no Market is named.
 */
export function englishLocaleOf(locales: {
  readonly default: string;
  readonly supported: readonly string[];
}): string {
  const isEnglish = (tag: string) => tag.toLowerCase().split('-')[0] === 'en';
  if (isEnglish(locales.default)) return locales.default;
  return locales.supported.find(isEnglish) ?? locales.default;
}

/**
 * `catalog.products-missing-details-email-sellers` (attributes A4-4, screen 06): the admin picked
 * products in the Missing details report and emails their sellers. The selected products are
 * judged again with the report's rule ({@link MissingDetailsJudge}); per seller, one email lists
 * only that seller's selected products that still lack required details, with the English
 * catalogue names of those details, in the approved English text. The same seller and product
 * are emailed at most once in 7 days (`throttled`, with the date), counted from the injected
 * Clock; a seller whose earlier email still waits is left for later (`email-pending`). A dry run
 * (`dryRun: true`) answers the same plan with each email's preview and stores nothing: the
 * confirm dialog.
 *
 * The email is queued, not sent here: `identity` gives a seller's address to the `system` actor
 * only, so the job `catalog.send-missing-details-emails` sends it (no usable address: skipped
 * there). Each queued email writes one audit row (ids and counts). Rule: the key
 * `catalog.attribute.edit`, the admin population, never in an acting-as session. A read-only unit
 * reads the selection, the store names come from `sellers` outside any unit, then one unit
 * re-reads the throttle and queues (one pending email per seller, kept by a partial unique index;
 * a concurrent request is `missing-details-email.busy`).
 */
export class ProductsMissingDetailsEmailSellers extends UseCase<
  ProductsMissingDetailsEmailSellersInput,
  ProductsMissingDetailsEmailSellersOutput,
  ProductsMissingDetailsEmailSellersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.products-missing-details-email-sellers',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('ProductsMissingDetailsEmailSellers');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductsMissingDetailsEmailSellersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductsMissingDetailsEmailSellersInput,
  ): Promise<
    Result<ProductsMissingDetailsEmailSellersOutput, ProductsMissingDetailsEmailSellersFailure>
  > {
    const result = await this.#run(context, input);
    const sellers = result.ok ? result.value.sellers : [];
    this.#logger.log({
      msg: 'catalog.products-missing-details-email-sellers',
      code: result.ok ? (result.value.dryRun ? 'previewed' : 'queued') : result.error.code,
      emails: sellers.filter((s) => s.status === 'queued').length,
      throttled: sellers.flatMap((s) => s.products).filter((p) => p.status === 'throttled').length,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: ProductsMissingDetailsEmailSellersInput,
  ): Promise<
    Result<ProductsMissingDetailsEmailSellersOutput, ProductsMissingDetailsEmailSellersFailure>
  > {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['productIds', 'dryRun']);
    if (!body.ok) return body;
    const raw = body.value['productIds'];
    if (!Array.isArray(raw)) return invalid('productIds', 'type');
    if (raw.length === 0 || raw.length > MISSING_DETAILS_EMAIL_PRODUCTS_MAX) {
      return invalid('productIds', 'range');
    }
    if (!raw.every((value): value is string => typeof value === 'string' && ID.test(value))) {
      return invalid('productIds', 'format');
    }
    const productIds = [...new Set(raw)];
    const rawDryRun = body.value['dryRun'];
    if (rawDryRun !== undefined && rawDryRun !== null && typeof rawDryRun !== 'boolean') {
      return invalid('dryRun', 'type');
    }
    const dryRun = rawDryRun === true;

    const { market } = context;
    const { deps } = this;
    const locale = englishLocaleOf(deps.policy.locales(market));
    const read = await deps.unitOfWork.run<SelectionFacts, never>(
      market,
      async () => ok(await this.#facts(context, productIds, locale)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const facts = read.value;

    // Store names are public once approved (sellers design 7.1); read outside any unit.
    const sellerIds = [
      ...new Set(facts.found.flatMap((p) => (p.sellerId === null ? [] : [p.sellerId]))),
    ] as Id<'Seller'>[];
    const storeNames =
      sellerIds.length === 0
        ? new Map<Id<'Seller'>, string>()
        : await deps.sellerNames.storeNames(context, sellerIds);
    const productsUrl = deps.sellerLinks.productsUrl(market);

    const now = deps.clock.now();
    const mailOf = (emailed: readonly PlannedProduct[], sellerId: string) =>
      missingDetailsEmailMail({
        sellerName: storeNames.get(sellerId as Id<'Seller'>) ?? null,
        products: emailed.map((product) => ({
          name: facts.productNames.get(product.productId) ?? product.productId,
          details: product.missing.map((code) => facts.detailNames.get(code) ?? code),
        })),
        productsUrl,
      });

    return deps.unitOfWork.run<
      ProductsMissingDetailsEmailSellersOutput,
      ProductsMissingDetailsEmailSellersFailure
    >(
      market,
      async () => {
        const foundIds = facts.found.map((p) => p.productId);
        const recent =
          foundIds.length === 0
            ? []
            : await deps.detailsEmails.recent(
                market,
                foundIds,
                now.subtract(MISSING_DETAILS_EMAIL_WINDOW),
              );
        const pending =
          sellerIds.length === 0
            ? new Set<string>()
            : await deps.detailsEmails.pendingSellers(market, sellerIds);
        const plan = planMissingDetailsEmails({
          requested: productIds,
          found: facts.found,
          recent,
          pendingSellers: pending,
          now,
        });
        const sellers: EmailSellersSeller[] = [];
        for (const seller of plan.sellers) {
          let emailId: string | null = null;
          let preview: MissingDetailsEmailMail | null = null;
          if (seller.status === 'queued') {
            const mail = mailOf(seller.emailed, seller.sellerId);
            if (dryRun) {
              preview = mail;
            } else {
              const email = MissingDetailsEmail.queue({
                id: deps.ids.next<'MissingDetailsEmail'>(),
                marketId: market.marketId,
                sellerId: seller.sellerId as Id<'Seller'>,
                productIds: seller.emailed.map((p) => p.productId as Id<'Product'>),
                requestedByAccountId: accountId,
                subject: mail.subject,
                text: mail.text,
                now,
              });
              if ((await deps.detailsEmails.add(market, email)) !== null) {
                return err({ code: 'missing-details-email.busy' } as const);
              }
              await deps.audit.record(
                context,
                MissingDetailsEmailQueuedAudit.entry(email.state.id, {
                  after: {
                    sellerId: email.state.sellerId,
                    productCount: seller.emailed.length,
                    throttledCount: seller.products.filter((p) => p.status === 'throttled').length,
                  },
                }),
              );
              emailId = email.state.id;
            }
          }
          sellers.push({
            sellerId: seller.sellerId,
            storeName: storeNames.get(seller.sellerId as Id<'Seller'>) ?? null,
            status: seller.status,
            emailId,
            products: seller.products.map((p) => ({
              productId: p.productId,
              status: p.status,
              lastEmailedAt: p.lastEmailedAt?.toString() ?? null,
            })),
            preview,
          });
        }
        return ok({ dryRun, sellers, notEmailed: plan.unmatched });
      },
      dryRun ? { readOnly: true } : undefined,
    );
  }

  /** Inside the read-only unit: the selected published products, their gaps and the names. */
  async #facts(
    context: CallContext,
    productIds: readonly string[],
    locale: string,
  ): Promise<SelectionFacts> {
    const { market } = context;
    const { deps } = this;
    const judge = await MissingDetailsJudge.open(market, deps);
    const rows = await deps.detailsGapReader.published(market, {
      afterId: null,
      sellerId: null,
      productIds,
      limit: productIds.length,
      locale,
    });
    const found: PlannedProduct[] = [];
    const productNames = new Map<string, string>();
    for (const row of rows) {
      const verdict = await judge.judge(row);
      // A product whose feature set cannot be read is not judged, as in the report.
      found.push({
        productId: row.productId,
        sellerId: row.ownerSellerId,
        missing: verdict?.missing ?? [],
      });
      productNames.set(row.productId, row.name ?? row.productCode);
    }
    const detailNames = new Map<string, string>();
    for (const code of new Set(found.flatMap((p) => p.missing))) {
      const definitionId = await deps.attributes.definitionIdByCode(market, code);
      const definition =
        definitionId === null ? null : await deps.attributeStore.findById(market, definitionId);
      const name = definition?.state.names[locale];
      detailNames.set(code, typeof name === 'string' && name.trim() !== '' ? name : code);
    }
    return { found, productNames, detailNames };
  }
}
